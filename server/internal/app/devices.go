package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type ticket struct {
	Device  Device
	Expires time.Time
}
type peer struct {
	device Device
	conn   *websocket.Conn
	send   chan []byte
	cancel context.CancelFunc
}

func (a *App) device(r *http.Request) (Device, error) {
	var d Device
	token := bearer(r)
	if !strings.HasPrefix(token, "d_") {
		return d, fail(401, "AUTH_EXPIRED", "大屏凭据失效，请重新绑定")
	}
	e := a.db.QueryRow("SELECT d.id,d.room_id,d.label,d.token_expires_at FROM devices d JOIN rooms r ON r.id=d.room_id WHERE d.token_hash=? AND d.revoked_at IS NULL AND d.token_expires_at>? AND r.status='active'", a.tokenHash(token), time.Now().UnixMilli()).Scan(&d.ID, &d.RoomID, &d.Label, &d.ExpiresAt)
	if errors.Is(e, sql.ErrNoRows) {
		return d, fail(401, "AUTH_EXPIRED", "大屏授权已失效，请联系管理员重新绑定")
	}
	return d, e
}
func (a *App) bindDevice(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		BindCode       string `json:"bindCode"`
		InstallationID string `json:"installationId"`
		Label          string `json:"label"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	in.BindCode = strings.TrimSpace(in.BindCode)
	in.InstallationID = strings.TrimSpace(in.InstallationID)
	in.Label = strings.TrimSpace(in.Label)
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !a.allow("bind-ip:"+ip, 5, time.Minute) || !a.allow("bind-install:"+in.InstallationID, 5, time.Minute) {
		return fail(429, "RATE_LIMITED", "绑定尝试过于频繁，请一分钟后重试")
	}
	if len(in.BindCode) != 6 || len(in.InstallationID) < 8 || len(in.InstallationID) > 128 || count(in.Label) < 1 || count(in.Label) > 40 {
		return bad("bindCode", "请输入6位绑定码、有效安装标识和1–40字设备名称")
	}
	for _, c := range in.BindCode {
		if c < '0' || c > '9' {
			return bad("bindCode", "绑定码应为6位数字")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var codeID, rid, rname string
	e = tx.QueryRow("SELECT b.id,b.room_id,r.name FROM bind_codes b JOIN rooms r ON r.id=b.room_id WHERE b.code_hash=? AND b.consumed_at IS NULL AND b.expires_at>? AND r.status='active'", a.bindHash(in.BindCode), time.Now().UnixMilli()).Scan(&codeID, &rid, &rname)
	if errors.Is(e, sql.ErrNoRows) {
		return bad("bindCode", "绑定码无效、已使用或已过期")
	}
	if e != nil {
		return e
	}
	var existing string
	e = tx.QueryRow("SELECT id FROM devices WHERE installation_id=?", in.InstallationID).Scan(&existing)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	token := randomToken("d_")
	expiry := time.Now().Add(90 * 24 * time.Hour)
	var did string
	if existing != "" {
		_, e = tx.Exec("UPDATE devices SET room_id=?,label=?,token_hash=?,token_expires_at=?,revoked_at=NULL,last_seen_at=?,tts_status='unknown' WHERE id=?", rid, in.Label, a.tokenHash(token), expiry.UnixMilli(), time.Now().UnixMilli(), existing)
		did = existing
	} else {
		res, er := tx.Exec("INSERT INTO devices(room_id,installation_id,label,token_hash,token_expires_at,last_seen_at) VALUES(?,?,?,?,?,?)", rid, in.InstallationID, in.Label, a.tokenHash(token), expiry.UnixMilli(), time.Now().UnixMilli())
		e = er
		if e == nil {
			id, er := res.LastInsertId()
			e = er
			did = sid(id)
		}
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE bind_codes SET consumed_at=? WHERE id=?", time.Now().UnixMilli(), codeID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	a.disconnect(did)
	ok(w, 200, obj{"deviceToken": token, "device": obj{"id": did, "label": in.Label}, "room": obj{"id": rid, "name": rname}, "tokenExpiresAt": stamp(expiry)})
	return nil
}
func (a *App) bindCode(w http.ResponseWriter, r *http.Request) error {
	t, e := a.admin(r)
	if e != nil {
		return e
	}
	rid := r.PathValue("id")
	a.mu.Lock()
	defer a.mu.Unlock()
	if e = activeAdmin(a.db, t.ID); e != nil {
		return e
	}
	var n int
	if e = a.db.QueryRow("SELECT COUNT(*) FROM rooms WHERE id=? AND status='active'", rid).Scan(&n); e != nil {
		return e
	}
	if n != 1 {
		return fail(404, "NOT_FOUND", "教室不存在")
	}
	for i := 0; i < 10; i++ {
		n, e := rand.Int(rand.Reader, big.NewInt(1000000))
		if e != nil {
			return e
		}
		code := strconv.FormatInt(n.Int64()+1000000, 10)[1:]
		expiry := time.Now().Add(10 * time.Minute)
		_, e = a.db.Exec("INSERT INTO bind_codes(room_id,code_hash,expires_at,created_by) VALUES(?,?,?,?)", rid, a.bindHash(code), expiry.UnixMilli(), t.ID)
		if e == nil {
			ok(w, 201, obj{"bindCode": code, "expiresAt": stamp(expiry)})
			return nil
		}
	}
	return fail(503, "TEMPORARILY_UNAVAILABLE", "无法生成绑定码，请重试")
}
func (a *App) snapshot(w http.ResponseWriter, r *http.Request) error {
	d, e := a.device(r)
	if e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.BeginTx(r.Context(), nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	now := time.Now()
	displaySettings, _, e := pruneRoomDisplayPins(tx, d.RoomID, now)
	if e != nil {
		return e
	}
	messages, e := readRoomDisplayMessages(tx, d.RoomID, displaySettings.PinnedMessageIDs, now)
	if e != nil {
		return e
	}
	var watermark int64
	if e = tx.QueryRow("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)").Scan(&watermark); e != nil {
		return e
	}
	settings, e := readSettings(tx)
	if e != nil {
		return e
	}
	var rname string
	if e = tx.QueryRow("SELECT name FROM rooms WHERE id=?", d.RoomID).Scan(&rname); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, obj{"syncEpoch": a.epoch, "protocolVersion": 1, "watermark": sid(watermark), "serverTime": stamp(now), "room": obj{"id": d.RoomID, "name": rname}, "settings": settings, "displaySettings": displaySettings, "messages": messages})
	return nil
}
func (a *App) heartbeat(w http.ResponseWriter, r *http.Request) error {
	d, e := a.device(r)
	if e != nil {
		return e
	}
	var in struct {
		LastAppliedSeq string `json:"lastAppliedSeq"`
		AppVersion     string `json:"appVersion"`
		TTSStatus      string `json:"ttsStatus"`
		SyncEpoch      string `json:"syncEpoch"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	seq, e := strconv.ParseInt(in.LastAppliedSeq, 10, 64)
	if e != nil || seq < 0 {
		return bad("lastAppliedSeq", "同步序号无效")
	}
	if len(in.AppVersion) > 64 || len(in.TTSStatus) > 80 {
		return bad("appVersion", "版本或语音状态过长")
	}
	now := time.Now()
	if _, e = a.db.Exec("UPDATE devices SET last_seen_at=?,app_version=?,tts_status=? WHERE id=?", now.UnixMilli(), in.AppVersion, in.TTSStatus, d.ID); e != nil {
		return e
	}
	var latest int64
	if e = a.db.QueryRow("SELECT COALESCE(MAX(seq),0) FROM events WHERE room_id=?", d.RoomID).Scan(&latest); e != nil {
		return e
	}
	ok(w, 200, obj{"serverTime": stamp(now), "needResync": in.SyncEpoch != a.epoch || seq < latest, "syncEpoch": a.epoch, "protocolVersion": 1})
	return nil
}

type receiptItem struct {
	MessageID  string `json:"messageId"`
	Revision   int    `json:"revision"`
	Kind       string `json:"kind"`
	State      string `json:"state"`
	Generation int    `json:"generation"`
	Round      int    `json:"round"`
	Status     string `json:"status"`
	Reason     string `json:"reason"`
}

func (a *App) receipts(w http.ResponseWriter, r *http.Request) error {
	d, e := a.device(r)
	if e != nil {
		return e
	}
	var in struct {
		SyncEpoch       string        `json:"syncEpoch"`
		ProtocolVersion int           `json:"protocolVersion,omitempty"`
		Items           []receiptItem `json:"items"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if in.SyncEpoch != a.epoch {
		return fail(409, "SYNC_EPOCH_CHANGED", "服务器数据版本已变化，请重新同步")
	}
	if len(in.Items) < 1 || len(in.Items) > 50 {
		return bad("items", "每次提交1–50条回执")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for _, item := range in.Items {
		var n int
		if e = tx.QueryRow("SELECT COUNT(*) FROM message_rooms WHERE message_id=? AND room_id=?", item.MessageID, d.RoomID).Scan(&n); e != nil {
			return e
		}
		if n != 1 {
			return fail(403, "FORBIDDEN", "回执公告不属于该设备教室")
		}
		m, _, e := loadMessage(tx, item.MessageID)
		if e != nil {
			return e
		}
		now := time.Now()
		switch item.Kind {
		case "delivery":
			if item.Revision < 1 || item.Revision > m.Revision {
				return bad("revision", "公告版本无效")
			}
			if !strings.Contains("|received|displayed|revoked|expired|suppressed|", "|"+item.State+"|") || item.State == "" {
				return bad("state", "展示回执状态无效")
			}
			if item.State == "revoked" && m.Status != "revoked" {
				return bad("state", "公告尚未撤回")
			}
			start, _ := time.Parse(time.RFC3339Nano, m.StartAt)
			expire, _ := time.Parse(time.RFC3339Nano, m.ExpireAt)
			if item.State == "displayed" && now.Before(start) {
				return bad("state", "未生效公告不能标记为已展示")
			}
			if item.State == "expired" && now.Before(expire) {
				return bad("state", "公告尚未过期")
			}
			_, e = tx.Exec("INSERT OR IGNORE INTO delivery_receipts VALUES(?,?,?,?,?)", item.MessageID, d.ID, item.Revision, item.State, now.UnixMilli())
			if e != nil {
				return e
			}
		case "broadcast":
			if item.Generation < 0 || item.Round < 1 || item.Round > 2 || count(item.Reason) > 120 {
				return bad("round", "播报轮次或原因无效")
			}
			if item.Status != "played" && item.Status != "skipped" && item.Status != "failed" {
				return bad("status", "播报结果无效")
			}
			var times int
			var notBefore int64
			e = tx.QueryRow("SELECT times,not_before FROM broadcast_jobs WHERE message_id=? AND generation=?", item.MessageID, item.Generation).Scan(&times, &notBefore)
			if errors.Is(e, sql.ErrNoRows) || item.Round > times {
				return bad("generation", "播报任务不存在或轮次超出范围")
			}
			if e != nil {
				return e
			}
			if item.Status == "played" && now.UnixMilli() < notBefore {
				return bad("status", "尚未到播报时间")
			}
			_, e = tx.Exec("INSERT OR IGNORE INTO broadcast_receipts VALUES(?,?,?,?,?,?,?)", item.MessageID, d.ID, item.Generation, item.Round, item.Status, item.Reason, now.UnixMilli())
			if e != nil {
				return e
			}
		default:
			return bad("kind", "回执类型无效")
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, obj{"accepted": len(in.Items), "syncEpoch": a.epoch, "protocolVersion": 1})
	return nil
}
func (a *App) wsTicket(w http.ResponseWriter, r *http.Request) error {
	d, e := a.device(r)
	if e != nil {
		return e
	}
	if !a.allow("ws-ticket:"+d.ID, 30, time.Minute) {
		return fail(429, "RATE_LIMITED", "连接请求过于频繁，请稍后重试")
	}
	key := randomToken("ws_")
	expiry := time.Now().Add(30 * time.Second)
	a.hubMu.Lock()
	for k, v := range a.tickets {
		if time.Now().After(v.Expires) {
			delete(a.tickets, k)
		}
	}
	a.tickets[hash(key)] = ticket{d, expiry}
	a.hubMu.Unlock()
	ok(w, 200, obj{"ticket": key, "expiresAt": stamp(expiry)})
	return nil
}
func (a *App) websocket(w http.ResponseWriter, r *http.Request) error {
	key := hash(r.URL.Query().Get("ticket"))
	a.hubMu.Lock()
	t, found := a.tickets[key]
	delete(a.tickets, key)
	a.hubMu.Unlock()
	if !found || time.Now().After(t.Expires) {
		return fail(401, "AUTH_EXPIRED", "连接票据已失效，请重新获取")
	}
	var valid int
	if e := a.db.QueryRow("SELECT COUNT(*) FROM devices d JOIN rooms r ON r.id=d.room_id WHERE d.id=? AND d.revoked_at IS NULL AND d.token_expires_at>? AND r.status='active'", t.Device.ID, time.Now().UnixMilli()).Scan(&valid); e != nil {
		return e
	}
	if valid != 1 {
		return fail(401, "AUTH_EXPIRED", "设备已被吊销")
	}
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if e != nil {
		return nil
	}
	conn.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer conn.CloseNow()
	p := &peer{device: t.Device, conn: conn, send: make(chan []byte, 256), cancel: cancel}
	p.send <- []byte(jsonText(obj{"event": "ready", "syncEpoch": a.epoch, "protocolVersion": 1, "serverTime": stamp(time.Now())}))
	a.hubMu.Lock()
	if old := a.peers[t.Device.ID]; old != nil {
		old.cancel()
	}
	a.peers[t.Device.ID] = p
	a.hubMu.Unlock()
	defer func() {
		a.hubMu.Lock()
		if a.peers[t.Device.ID] == p {
			delete(a.peers, t.Device.ID)
		}
		a.hubMu.Unlock()
	}()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, raw, e := conn.Read(ctx)
			if e != nil {
				cancel()
				return
			}
			var msg obj
			if json.Unmarshal(raw, &msg) == nil && msg["event"] == "ping" {
				select {
				case p.send <- []byte(jsonText(obj{"event": "pong", "serverTime": stamp(time.Now()), "syncEpoch": a.epoch, "protocolVersion": 1})):
				default:
					cancel()
					return
				}
			}
		}
	}()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case raw := <-p.send:
			wc, stop := context.WithTimeout(ctx, 5*time.Second)
			e = conn.Write(wc, websocket.MessageText, raw)
			stop()
			if e != nil {
				return nil
			}
		case <-ticker.C:
			var valid int
			if er := a.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM devices d JOIN rooms r ON r.id=d.room_id WHERE d.id=? AND d.room_id=? AND d.revoked_at IS NULL AND d.token_expires_at>? AND r.status='active'", p.device.ID, p.device.RoomID, time.Now().UnixMilli()).Scan(&valid); er != nil || valid != 1 {
				return nil
			}
			pc, stop := context.WithTimeout(ctx, 10*time.Second)
			e = conn.Ping(pc)
			stop()
			if e != nil {
				return nil
			}
		}
	}
}
func (a *App) disconnect(id string) {
	a.hubMu.Lock()
	defer a.hubMu.Unlock()
	if p := a.peers[id]; p != nil {
		p.cancel()
	}
	for key, t := range a.tickets {
		if t.Device.ID == id {
			delete(a.tickets, key)
		}
	}
}
func (a *App) dispatch(ctx context.Context) {
	defer close(a.done)
	cursor := a.initialCursor
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	pruneTicker := time.NewTicker(time.Second)
	defer pruneTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-pruneTicker.C:
			if e := a.pruneExpiredDisplayPins(); e != nil {
				if ctx.Err() != nil {
					return
				}
				panic("display pin expiry database failure")
			}
			continue
		}
		rows, e := a.db.QueryContext(ctx, "SELECT seq,room_id,event_type,payload_json,created_at FROM events WHERE seq>? ORDER BY seq LIMIT 256", cursor)
		if e != nil {
			if ctx.Err() != nil {
				return
			}
			panic("event dispatcher database failure")
		}
		type evt struct {
			seq              int64
			room, event, raw string
			created          int64
		}
		events := []evt{}
		for rows.Next() {
			var v evt
			if e = rows.Scan(&v.seq, &v.room, &v.event, &v.raw, &v.created); e != nil {
				rows.Close()
				panic("event dispatcher scan failure")
			}
			events = append(events, v)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			if ctx.Err() != nil {
				return
			}
			panic("event dispatcher read failure")
		}
		a.hubMu.Lock()
		for _, v := range events {
			raw := []byte(jsonText(obj{"seq": sid(v.seq), "event": v.event, "syncEpoch": a.epoch, "protocolVersion": 1, "serverTime": msstamp(v.created), "data": json.RawMessage(v.raw)}))
			for _, p := range a.peers {
				if p.device.RoomID == v.room {
					if len(raw) > 64<<10 || len(p.send) >= 32 {
						p.cancel()
						continue
					}
					select {
					case p.send <- raw:
					default:
						p.cancel()
					}
				}
			}
			cursor = v.seq
		}
		a.hubMu.Unlock()
	}
}
