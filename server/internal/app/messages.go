package app

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type createRequest struct {
	ClientToken     string   `json:"clientToken"`
	Type            string   `json:"type"`
	ClassIDs        []string `json:"classIds"`
	StudentIDs      []string `json:"studentIds"`
	Title           string   `json:"title,omitempty"`
	Destination     string   `json:"destination,omitempty"`
	Body            string   `json:"body"`
	DisplayPosition string   `json:"displayPosition,omitempty"`
	DisplayMinutes  int      `json:"displayMinutes,omitempty"`
	BroadcastTimes  int      `json:"broadcastTimes"`
	StartAt         string   `json:"startAt,omitempty"`
	ExpireAt        string   `json:"expireAt"`
}

type updateRequest struct {
	ClientToken     *string         `json:"clientToken,omitempty"`
	Kind            *string         `json:"kind,omitempty"`
	Type            *string         `json:"type,omitempty"`
	Title           *string         `json:"title,omitempty"`
	Content         *string         `json:"content,omitempty"`
	Body            *string         `json:"body,omitempty"`
	Destination     *string         `json:"destination,omitempty"`
	ClassIDs        *[]string       `json:"classIds,omitempty"`
	StudentIDs      *[]string       `json:"studentIds,omitempty"`
	Broadcast       json.RawMessage `json:"broadcast,omitempty"`
	BroadcastTimes  *int            `json:"broadcastTimes,omitempty"`
	StartAt         *string         `json:"startAt,omitempty"`
	ExpireAt        *string         `json:"expireAt,omitempty"`
	DisplayPosition *string         `json:"displayPosition,omitempty"`
}
type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
	Query(query string, args ...any) (*sql.Rows, error)
}

func normalizeDisplayPosition(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "top_right", nil
	}
	if value != "top_right" && value != "center" {
		return "", bad("displayPosition", "展示位置只能为 top_right 或 center")
	}
	return value, nil
}

func (in updateRequest) empty() bool {
	return in.Kind == nil && in.Type == nil && in.Title == nil && in.Content == nil && in.Body == nil &&
		in.Destination == nil && in.StudentIDs == nil && len(in.Broadcast) == 0 && in.BroadcastTimes == nil &&
		in.StartAt == nil && in.ExpireAt == nil && in.DisplayPosition == nil
}

func normalizeUpdateRequest(in *updateRequest) error {
	if in.ClientToken == nil {
		return nil
	}
	token := strings.ToLower(strings.TrimSpace(*in.ClientToken))
	if !validUUID(token) {
		return bad("clientToken", "请使用 UUID 防重复凭据")
	}
	in.ClientToken = &token
	return nil
}

func updateAliasString(primary, alias *string, field, aliasName string) (*string, error) {
	if primary == nil {
		return alias, nil
	}
	if alias == nil {
		return primary, nil
	}
	if strings.TrimSpace(*primary) != strings.TrimSpace(*alias) {
		return nil, bad(field, field+" 与 "+aliasName+" 不一致")
	}
	return primary, nil
}

func updateBroadcastTimes(raw json.RawMessage, direct *int) (int, bool, error) {
	if len(raw) == 0 && direct == nil {
		return 0, false, nil
	}
	fromRaw := 0
	rawSet := len(raw) > 0
	if rawSet {
		trimmed := strings.TrimSpace(string(raw))
		switch trimmed {
		case "null", "false":
			fromRaw = 0
		case "true":
			fromRaw = 1
		default:
			var value int
			if e := json.Unmarshal(raw, &value); e == nil {
				fromRaw = value
			} else {
				var object struct {
					Times *int `json:"times"`
				}
				if e = json.Unmarshal(raw, &object); e != nil || object.Times == nil {
					return 0, false, bad("broadcast", "播报设置应为次数或包含 times 的对象")
				}
				fromRaw = *object.Times
			}
		}
	}
	if fromRaw < 0 || fromRaw > 2 {
		return 0, false, bad("broadcast", "播报次数只能为0、1或2")
	}
	if direct != nil {
		if *direct < 0 || *direct > 2 {
			return 0, false, bad("broadcastTimes", "播报次数只能为0、1或2")
		}
		if rawSet && fromRaw != *direct {
			return 0, false, bad("broadcast", "broadcast 与 broadcastTimes 不一致")
		}
		return *direct, true, nil
	}
	return fromRaw, true, nil
}

func uniqIDs(ids []string) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		if !validID(id) {
			return nil, bad("ids", "编号必须为正整数字符串")
		}
		if seen[id] {
			return nil, bad("ids", "编号不可重复")
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool {
		x, _ := strconv.ParseInt(out[i], 10, 64)
		y, _ := strconv.ParseInt(out[j], 10, 64)
		return x < y
	})
	return out, nil
}
func normalizeCreate(in *createRequest) error {
	in.ClientToken = strings.ToLower(strings.TrimSpace(in.ClientToken))
	if !validUUID(in.ClientToken) {
		return bad("clientToken", "请使用 UUID 防重复凭据")
	}
	in.Type = strings.TrimSpace(in.Type)
	in.Title = strings.TrimSpace(in.Title)
	in.Destination = strings.TrimSpace(in.Destination)
	in.Body = strings.TrimSpace(in.Body)
	var e error
	in.DisplayPosition, e = normalizeDisplayPosition(in.DisplayPosition)
	if e != nil {
		return e
	}
	in.ClassIDs, e = uniqIDs(in.ClassIDs)
	if e != nil {
		return e
	}
	in.StudentIDs, e = uniqIDs(in.StudentIDs)
	if e != nil {
		return e
	}
	if count(in.Body) > 300 {
		return bad("body", "正文最多300字")
	}
	if count(in.Title) > 60 {
		return bad("title", "标题最多60字")
	}
	if count(in.Destination) > 40 {
		return bad("destination", "地点最多40字")
	}
	if len(in.ClassIDs) == 0 || len(in.ClassIDs) > 20 {
		return bad("classIds", "请选择1–20个班级")
	}
	if in.BroadcastTimes < 0 || in.BroadcastTimes > 2 {
		return bad("broadcastTimes", "播报次数只能为0、1或2")
	}
	switch in.Type {
	case "notice":
		if len(in.StudentIDs) > 0 || in.Destination != "" || in.BroadcastTimes != 0 {
			return bad("type", "普通通知不选择学生和地点，也不语音播报")
		}
		if in.Title == "" {
			return bad("title", "请填写通知标题")
		}
	case "call", "batch":
		max := 60
		if in.Type == "call" {
			max = 3
		}
		if len(in.ClassIDs) != 1 || len(in.StudentIDs) < 1 || len(in.StudentIDs) > max {
			return bad("studentIds", "呼叫和作业仅限同一班级，学生数量不符合该类型限制")
		}
		if in.Destination == "" {
			return bad("destination", "请填写地点")
		}
		if in.Title != "" {
			return bad("title", "呼叫和作业标题由服务端生成")
		}
	default:
		return bad("type", "请选择有效公告类型")
	}
	for _, field := range []struct {
		name string
		p    *string
	}{{"startAt", &in.StartAt}, {"expireAt", &in.ExpireAt}} {
		if *field.p == "" && field.name == "startAt" {
			continue
		}
		t, e := time.Parse(time.RFC3339Nano, *field.p)
		if e != nil {
			return bad(field.name, "请使用带时区的 ISO8601 时间")
		}
		*field.p = stamp(t)
	}
	return nil
}
func (a *App) assemble(q queryer, t Teacher, in createRequest, now time.Time) (Message, []string, error) {
	return a.assembleWithOptions(q, t, in, now, assembleOptions{})
}

type assembleOptions struct {
	excludeMessageID string
	allowedPastStart string
}

func (a *App) assembleWithOptions(q queryer, t Teacher, in createRequest, now time.Time, options assembleOptions) (Message, []string, error) {
	minutes := in.DisplayMinutes
	if minutes == 0 {
		minutes = 1
	}
	if minutes < 1 || minutes > 60 {
		return Message{}, nil, bad("displayMinutes", "大屏显示时长需为 1–60 分钟")
	}
	m := Message{Revision: 1, Type: in.Type, Body: in.Body, Destination: in.Destination, DisplayPosition: in.DisplayPosition, DisplayMinutes: minutes, Targets: []Target{}, ClassIDs: in.ClassIDs, TeacherName: t.Name, Status: "active", CreatedAt: stamp(now)}
	var status, role string
	if e := q.QueryRow("SELECT status,role FROM teachers WHERE id=?", t.ID).Scan(&status, &role); e != nil {
		return m, nil, e
	}
	if status != "active" {
		return m, nil, fail(403, "FORBIDDEN", "账号权限已经变化")
	}
	devices := []string{}
	for _, cid := range in.ClassIDs {
		var n int
		e := q.QueryRow("SELECT COUNT(*) FROM classes c WHERE c.id=? AND c.status='active' AND (?='admin' OR EXISTS(SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id=? AND tc.class_id=c.id))", cid, role, t.ID).Scan(&n)
		if e != nil {
			return m, nil, e
		}
		if n != 1 {
			return m, nil, fail(403, "FORBIDDEN", "没有目标班级发布权限")
		}
		rows, e := q.Query("SELECT id FROM devices WHERE class_id=? AND revoked_at IS NULL AND token_expires_at>?", cid, now.UnixMilli())
		if e != nil {
			return m, nil, e
		}
		classDevices := 0
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return m, nil, e
			}
			devices = append(devices, id)
			classDevices++
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return m, nil, e
		}
		if classDevices == 0 {
			return m, nil, bad("classIds", "目标班级尚未绑定有效设备，请先绑定大屏或移除该班级")
		}
		activeQuery := "SELECT COUNT(*) FROM messages m JOIN message_classes mc ON mc.message_id=m.id WHERE mc.class_id=? AND m.status='active' AND m.expire_at>?"
		activeArgs := []any{cid, now.UnixMilli()}
		if options.excludeMessageID != "" {
			activeQuery += " AND m.id<>?"
			activeArgs = append(activeArgs, options.excludeMessageID)
		}
		var active int
		if e = q.QueryRow(activeQuery, activeArgs...).Scan(&active); e != nil {
			return m, nil, e
		}
		if active >= 50 {
			return m, nil, bad("classIds", "目标班级已达50条有效或未来公告，请先撤回部分公告")
		}
	}
	start := now
	if in.StartAt != "" {
		start, _ = time.Parse(time.RFC3339Nano, in.StartAt)
		pastStartAllowed := options.allowedPastStart != "" && in.StartAt == options.allowedPastStart
		if (!pastStartAllowed && start.Before(now.Add(-time.Minute))) || start.After(now.Add(7*24*time.Hour)) {
			return m, nil, bad("startAt", "生效时间需在当前至未来7天内")
		}
	}
	expire, _ := time.Parse(time.RFC3339Nano, in.ExpireAt)
	if !expire.After(start) || !expire.After(now) || expire.Sub(start) > 7*24*time.Hour {
		return m, nil, bad("expireAt", "下屏时间必须晚于生效和当前时间，有效期最多7天")
	}
	m.StartAt = stamp(start)
	m.ExpireAt = stamp(expire)
	if in.Type == "notice" {
		m.Title = in.Title
	} else {
		names := []string{}
		for _, id := range in.StudentIDs {
			var target Target
			var no string
			target.StudentID = id
			e := q.QueryRow("SELECT s.name,c.name,s.student_no FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.active=1 AND c.id=?", id, in.ClassIDs[0]).Scan(&target.Name, &target.ClassName, &no)
			if errors.Is(e, sql.ErrNoRows) {
				return m, nil, bad("studentIds", "学生已停用或不属于目标班级，请重新选择")
			}
			if e != nil {
				return m, nil, e
			}
			runes := []rune(no)
			if len(runes) > 4 {
				runes = runes[len(runes)-4:]
			}
			target.StudentNoSuffix = string(runes)
			m.Targets = append(m.Targets, target)
			names = append(names, target.Name)
		}
		m.Priority = 1
		m.Title = "呼叫 · 到 " + in.Destination
		m.SpeechText = "请" + strings.Join(names, "、") + "同学到" + in.Destination + "。"
		if in.Type == "batch" {
			m.Title = "批量作业 · " + strconv.Itoa(len(names)) + "人 · " + in.Destination
			m.SpeechText = "请名单中的" + strconv.Itoa(len(names)) + "位同学到" + in.Destination + "。"
		}
		if in.Body != "" {
			m.SpeechText += in.Body + "。"
		}
	}
	if in.BroadcastTimes > 0 {
		deadline := start.Add(5 * time.Minute)
		if expire.Before(deadline) {
			deadline = expire
		}
		m.Broadcast = &Broadcast{Times: in.BroadcastTimes, NotBefore: stamp(start), DeadlineAt: stamp(deadline)}
	}
	return m, devices, nil
}
func appendEvent(tx *sql.Tx, classID, event string, data any) error {
	_, e := tx.Exec("INSERT INTO events(class_id,event_type,payload_json,created_at) VALUES(?,?,?,?)", classID, event, jsonText(data), time.Now().UnixMilli())
	return e
}
func loadMessageState(q queryer, id string) (Message, string, int, error) {
	var raw, teacher string
	var m Message
	var generation int
	e := q.QueryRow("SELECT payload_json,teacher_id,generation FROM messages WHERE id=?", id).Scan(&raw, &teacher, &generation)
	if errors.Is(e, sql.ErrNoRows) {
		return m, "", 0, fail(404, "NOT_FOUND", "公告不存在或无权访问")
	}
	if e != nil {
		return m, "", 0, e
	}
	e = json.Unmarshal([]byte(raw), &m)
	return m, teacher, generation, e
}

func loadMessage(q queryer, id string) (Message, string, error) {
	m, teacher, _, e := loadMessageState(q, id)
	return m, teacher, e
}
func (a *App) createMessage(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	var in createRequest
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if e = normalizeCreate(&in); e != nil {
		return e
	}
	requestHash := hash(jsonText(in))
	// The durable key is checked before rate limiting and remote moderation so retries remain safe.
	a.mu.Lock()
	old, found, e := a.createdResult(t.ID, in.ClientToken, requestHash)
	a.mu.Unlock()
	if e != nil {
		return e
	}
	if found {
		ok(w, 200, old)
		return nil
	}
	if !a.allow("create:"+t.ID, 10, time.Minute) {
		return fail(429, "RATE_LIMITED", "每分钟最多发布10条公告，请稍后重试")
	}
	a.mu.Lock()
	m, _, e := a.assemble(a.db, t, in, time.Now())
	a.mu.Unlock()
	if e != nil {
		return e
	}
	if e = a.moderate(r.Context(), t, m); e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	old, found, e = a.createdResult(t.ID, in.ClientToken, requestHash)
	if e != nil {
		return e
	}
	if found {
		ok(w, 200, old)
		return nil
	}
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	validated, devices, e := a.assemble(tx, t, in, time.Now())
	if e != nil {
		return e
	}
	if validated.Title != m.Title || validated.SpeechText != m.SpeechText || jsonText(validated.Targets) != jsonText(m.Targets) {
		return fail(409, "DATA_CHANGED", "学生资料已变化，请重新确认后提交")
	}
	m = validated
	start, _ := time.Parse(time.RFC3339Nano, m.StartAt)
	expire, _ := time.Parse(time.RFC3339Nano, m.ExpireAt)
	created, _ := time.Parse(time.RFC3339Nano, m.CreatedAt)
	res, e := tx.Exec("INSERT INTO messages(teacher_id,kind,start_at,expire_at,created_at,client_token,request_hash,payload_json) VALUES(?,?,?,?,?,?,?,?)", t.ID, m.Type, start.UnixMilli(), expire.UnixMilli(), created.UnixMilli(), in.ClientToken, requestHash, "{}")
	if e != nil {
		return e
	}
	id, e := res.LastInsertId()
	if e != nil {
		return e
	}
	m.ID = sid(id)
	if _, e = tx.Exec("UPDATE messages SET payload_json=? WHERE id=?", jsonText(m), m.ID); e != nil {
		return e
	}
	for _, cid := range m.ClassIDs {
		if _, e = tx.Exec("INSERT INTO message_classes VALUES(?,?)", m.ID, cid); e != nil {
			return e
		}
		if e = appendEvent(tx, cid, "message.upsert", m); e != nil {
			return e
		}
	}
	for _, did := range devices {
		if _, e = tx.Exec("INSERT INTO message_devices VALUES(?,?)", m.ID, did); e != nil {
			return e
		}
	}
	if m.Broadcast != nil {
		d, _ := time.Parse(time.RFC3339Nano, m.Broadcast.DeadlineAt)
		if _, e = tx.Exec("INSERT INTO broadcast_jobs VALUES(?,?,?,?,?)", m.ID, 0, m.Broadcast.Times, start.UnixMilli(), d.UnixMilli()); e != nil {
			return e
		}
	}
	if e = audit(tx, t.ID, "message.create", m.ID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 201, obj{"id": m.ID, "revision": 1, "status": "active", "targetDeviceCount": len(devices)})
	return nil
}
func (a *App) createdResult(teacher, token, h string) (obj, bool, error) {
	var id, oldHash, status string
	var rev, n int
	e := a.db.QueryRow("SELECT id,request_hash,status,revision FROM messages WHERE teacher_id=? AND client_token=?", teacher, token).Scan(&id, &oldHash, &status, &rev)
	if errors.Is(e, sql.ErrNoRows) {
		var nh int
		e = a.db.QueryRow("SELECT COUNT(*) FROM operation_keys WHERE teacher_id=? AND client_token=?", teacher, token).Scan(&nh)
		if e != nil {
			return nil, false, e
		}
		if nh > 0 {
			return nil, false, fail(409, "IDEMPOTENCY_CONFLICT", "该防重复凭据已用于其他操作")
		}
		return nil, false, nil
	}
	if e != nil {
		return nil, false, e
	}
	if oldHash != h {
		return nil, false, fail(409, "IDEMPOTENCY_CONFLICT", "防重复凭据对应内容已变化，请重新生成")
	}
	if e = a.db.QueryRow("SELECT COUNT(*) FROM message_devices WHERE message_id=?", id).Scan(&n); e != nil {
		return nil, false, e
	}
	return obj{"id": id, "revision": 1, "status": "active", "targetDeviceCount": n}, true, nil
}
func (a *App) teacherMessage(r *http.Request) (Teacher, Message, error) {
	t, e := a.teacher(r, true)
	if e != nil {
		return t, Message{}, e
	}
	m, owner, e := loadMessage(a.db, r.PathValue("id"))
	if e != nil {
		return t, m, e
	}
	isAdminPath := strings.HasPrefix(r.URL.Path, "/api/v1/admin/")
	if isAdminPath && t.Role != "admin" {
		return t, m, fail(403, "FORBIDDEN", "需要管理员权限")
	}
	if owner != t.ID && !(isAdminPath && t.Role == "admin") {
		return t, m, fail(404, "NOT_FOUND", "公告不存在或无权访问")
	}
	return t, m, nil
}

func messageBroadcastTimes(m Message) int {
	if m.Broadcast == nil {
		return 0
	}
	return m.Broadcast.Times
}

func messageStudentIDs(m Message) []string {
	ids := make([]string, 0, len(m.Targets))
	for _, target := range m.Targets {
		ids = append(ids, target.StudentID)
	}
	return ids
}

func messageUpdateFingerprint(m Message) string {
	return hash(jsonText(obj{
		"type":            m.Type,
		"title":           m.Title,
		"body":            m.Body,
		"destination":     m.Destination,
		"displayPosition": m.DisplayPosition,
		"targets":         m.Targets,
		"classIds":        m.ClassIDs,
		"speechText":      m.SpeechText,
		"priority":        m.Priority,
		"startAt":         m.StartAt,
		"expireAt":        m.ExpireAt,
		"broadcastTimes":  messageBroadcastTimes(m),
	}))
}

func messageUpdateHash(messageID string, in updateRequest) string {
	return hash(jsonText(obj{"operation": "message.update", "messageId": messageID, "request": in}))
}

func messageUpdateOperation(q queryer, teacherID, clientToken, requestHash string) (obj, bool, error) {
	if clientToken == "" {
		return nil, false, nil
	}
	var oldHash, response string
	e := q.QueryRow("SELECT request_hash,response_json FROM operation_keys WHERE teacher_id=? AND client_token=?", teacherID, clientToken).Scan(&oldHash, &response)
	if e == nil {
		if oldHash != requestHash {
			return nil, false, fail(409, "IDEMPOTENCY_CONFLICT", "防重复凭据对应内容已变化")
		}
		var stored struct {
			Message obj `json:"message"`
		}
		if e = json.Unmarshal([]byte(response), &stored); e != nil {
			return nil, false, e
		}
		return stored.Message, true, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, false, e
	}
	var used int
	if e = q.QueryRow("SELECT COUNT(*) FROM messages WHERE teacher_id=? AND client_token=?", teacherID, clientToken).Scan(&used); e != nil {
		return nil, false, e
	}
	if used > 0 {
		return nil, false, fail(409, "IDEMPOTENCY_CONFLICT", "该防重复凭据已用于创建公告")
	}
	return nil, false, nil
}

func (a *App) buildMessageUpdate(q queryer, t Teacher, old Message, in updateRequest, now time.Time) (Message, bool, error) {
	kind, e := updateAliasString(in.Kind, in.Type, "kind", "type")
	if e != nil {
		return Message{}, false, e
	}
	title, e := updateAliasString(in.Title, nil, "title", "")
	if e != nil {
		return Message{}, false, e
	}
	content, e := updateAliasString(in.Content, in.Body, "content", "body")
	if e != nil {
		return Message{}, false, e
	}
	times, broadcastSpecified, e := updateBroadcastTimes(in.Broadcast, in.BroadcastTimes)
	if e != nil {
		return Message{}, false, e
	}
	if in.ClassIDs != nil {
		classIDs, e := uniqIDs(*in.ClassIDs)
		if e != nil {
			return Message{}, false, bad("classIds", "目标班级必须为不重复的正整数编号")
		}
		if !sameStrings(classIDs, old.ClassIDs) {
			return Message{}, false, bad("classIds", "编辑公告时不能更改目标班级")
		}
	}

	kindValue := old.Type
	if kind != nil {
		kindValue = *kind
	}
	titleValue := old.Title
	if title != nil {
		titleValue = *title
	}
	bodyValue := old.Body
	if content != nil {
		bodyValue = *content
	}
	destination := old.Destination
	if in.Destination != nil {
		destination = *in.Destination
	}
	studentIDs := messageStudentIDs(old)
	if in.StudentIDs != nil {
		studentIDs = append([]string(nil), (*in.StudentIDs)...)
	}
	displayPosition := old.DisplayPosition
	if in.DisplayPosition != nil {
		displayPosition = *in.DisplayPosition
	}
	startAt := old.StartAt
	if in.StartAt != nil {
		startAt = *in.StartAt
	}
	expireAt := old.ExpireAt
	if in.ExpireAt != nil {
		expireAt = *in.ExpireAt
	}
	oldTimes := messageBroadcastTimes(old)
	if !broadcastSpecified {
		times = oldTimes
	}

	// Notices cannot carry audience, destination, or speech fields. Clearing the
	// inherited values keeps a kind-only edit valid; explicit incompatible values
	// are still rejected by the shared create validator below.
	if strings.TrimSpace(kindValue) == "notice" {
		if in.StudentIDs == nil {
			studentIDs = []string{}
		}
		if in.Destination == nil {
			destination = ""
		}
		if !broadcastSpecified {
			times = 0
		}
	}

	assembledTitle := titleValue
	if strings.TrimSpace(kindValue) != "notice" {
		// The server derives call/batch titles. An explicitly edited title is
		// applied after assembly so it can still be changed by the editor.
		assembledTitle = ""
	}
	input := createRequest{
		ClientToken:     uuid(),
		Type:            kindValue,
		ClassIDs:        append([]string(nil), old.ClassIDs...),
		StudentIDs:      studentIDs,
		Title:           assembledTitle,
		Destination:     destination,
		Body:            bodyValue,
		DisplayPosition: displayPosition,
		BroadcastTimes:  times,
		StartAt:         startAt,
		ExpireAt:        expireAt,
	}
	if e = normalizeCreate(&input); e != nil {
		return Message{}, false, e
	}
	updated, _, e := a.assembleWithOptions(q, t, input, now, assembleOptions{excludeMessageID: old.ID, allowedPastStart: old.StartAt})
	if e != nil {
		return Message{}, false, e
	}
	if input.Type != "notice" && title != nil && strings.TrimSpace(*title) != "" {
		updated.Title = strings.TrimSpace(*title)
	}
	updated.ID = old.ID
	updated.Revision = old.Revision + 1
	updated.CreatedAt = old.CreatedAt
	updated.TeacherName = old.TeacherName
	scheduleChanged := updated.StartAt != old.StartAt || updated.ExpireAt != old.ExpireAt
	broadcastChanged := times != oldTimes || (times > 0 && scheduleChanged)
	return updated, broadcastChanged, nil
}

func ensureMessageEditable(m Message, now time.Time) error {
	if m.Status != "active" {
		return fail(409, "MESSAGE_NOT_EDITABLE", "已撤回公告不能编辑")
	}
	expire, e := time.Parse(time.RFC3339Nano, m.ExpireAt)
	if e != nil {
		return e
	}
	if !now.Before(expire) {
		return fail(409, "MESSAGE_NOT_EDITABLE", "已到期公告不能编辑")
	}
	return nil
}

func (a *App) updateMessage(w http.ResponseWriter, r *http.Request) error {
	t, old, e := a.teacherMessage(r)
	if e != nil {
		return e
	}
	var in updateRequest
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if e = normalizeUpdateRequest(&in); e != nil {
		return e
	}
	if in.empty() {
		return bad("request", "请至少提供一个可更新字段")
	}
	clientToken := ""
	requestHash := ""
	if in.ClientToken != nil {
		clientToken = *in.ClientToken
		requestHash = messageUpdateHash(r.PathValue("id"), in)
		a.mu.Lock()
		previous, found, operationErr := messageUpdateOperation(a.db, t.ID, clientToken, requestHash)
		a.mu.Unlock()
		if operationErr != nil {
			return operationErr
		}
		if found {
			ok(w, 200, previous)
			return nil
		}
	}
	if e = ensureMessageEditable(old, time.Now()); e != nil {
		return e
	}

	a.mu.Lock()
	preview, _, e := a.buildMessageUpdate(a.db, t, old, in, time.Now())
	a.mu.Unlock()
	if e != nil {
		return e
	}
	if e = a.moderate(r.Context(), t, preview); e != nil {
		return e
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	current, owner, generation, e := loadMessageState(tx, r.PathValue("id"))
	if e != nil {
		return e
	}
	t, e = currentTeacher(tx, t.ID)
	if e != nil {
		return e
	}
	isAdminPath := strings.HasPrefix(r.URL.Path, "/api/v1/admin/")
	if isAdminPath && t.Role != "admin" {
		return fail(403, "FORBIDDEN", "管理员权限已变化")
	}
	if owner != t.ID && !(isAdminPath && t.Role == "admin") {
		return fail(404, "NOT_FOUND", "公告不存在或无权访问")
	}
	if previous, found, operationErr := messageUpdateOperation(tx, t.ID, clientToken, requestHash); operationErr != nil {
		return operationErr
	} else if found {
		ok(w, 200, previous)
		return nil
	}
	now := time.Now()
	if e = ensureMessageEditable(current, now); e != nil {
		return e
	}
	updated, broadcastChanged, e := a.buildMessageUpdate(tx, t, current, in, now)
	if e != nil {
		return e
	}
	if messageUpdateFingerprint(updated) != messageUpdateFingerprint(preview) {
		return fail(409, "DATA_CHANGED", "公告或学生资料已变化，请刷新后重试")
	}

	if broadcastChanged {
		generation++
		if messageBroadcastTimes(updated) > 0 {
			start, _ := time.Parse(time.RFC3339Nano, updated.StartAt)
			expire, _ := time.Parse(time.RFC3339Nano, updated.ExpireAt)
			notBefore := now
			if start.After(notBefore) {
				notBefore = start
			}
			deadline := notBefore.Add(5 * time.Minute)
			if expire.Before(deadline) {
				deadline = expire
			}
			updated.Broadcast = &Broadcast{
				Generation: generation,
				Times:      messageBroadcastTimes(updated),
				NotBefore:  stamp(notBefore),
				DeadlineAt: stamp(deadline),
			}
		} else {
			updated.Broadcast = nil
		}
	} else {
		updated.Broadcast = current.Broadcast
	}

	start, _ := time.Parse(time.RFC3339Nano, updated.StartAt)
	expire, _ := time.Parse(time.RFC3339Nano, updated.ExpireAt)
	if _, e = tx.Exec("UPDATE messages SET kind=?,start_at=?,expire_at=?,revision=?,generation=?,payload_json=? WHERE id=?", updated.Type, start.UnixMilli(), expire.UnixMilli(), updated.Revision, generation, jsonText(updated), updated.ID); e != nil {
		return e
	}
	if broadcastChanged {
		if _, e = tx.Exec("DELETE FROM broadcast_jobs WHERE message_id=?", updated.ID); e != nil {
			return e
		}
		if updated.Broadcast != nil {
			deadline, _ := time.Parse(time.RFC3339Nano, updated.Broadcast.DeadlineAt)
			notBefore, _ := time.Parse(time.RFC3339Nano, updated.Broadcast.NotBefore)
			if _, e = tx.Exec("INSERT INTO broadcast_jobs VALUES(?,?,?,?,?)", updated.ID, generation, updated.Broadcast.Times, notBefore.UnixMilli(), deadline.UnixMilli()); e != nil {
				return e
			}
		}
	}
	for _, cid := range updated.ClassIDs {
		if e = appendEvent(tx, cid, "message.upsert", updated); e != nil {
			return e
		}
	}
	if e = audit(tx, t.ID, "message.update", updated.ID); e != nil {
		return e
	}
	if in.ClientToken != nil {
		response := obj{"message": updated}
		if _, e = tx.Exec("INSERT INTO operation_keys VALUES(?,?,?,?,?)", t.ID, clientToken, requestHash, jsonText(response), now.UnixMilli()); e != nil {
			return e
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, updated)
	return nil
}

func (a *App) messageDetail(w http.ResponseWriter, r *http.Request) error {
	_, m, e := a.teacherMessage(r)
	if e != nil {
		return e
	}
	ok(w, 200, m)
	return nil
}
func queryLimit(r *http.Request, def, max int) int {
	n, e := strconv.Atoi(r.URL.Query().Get("limit"))
	if e != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}
func (a *App) listMessages(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	adminPath := strings.HasPrefix(r.URL.Path, "/api/v1/admin/")
	if adminPath && t.Role != "admin" {
		return fail(403, "FORBIDDEN", "需要管理员权限")
	}
	q := "SELECT m.payload_json,m.created_at,m.id FROM messages m WHERE 1=1"
	args := []any{}
	if !adminPath {
		q += " AND m.teacher_id=?"
		args = append(args, t.ID)
	}
	if status := r.URL.Query().Get("status"); status != "" {
		switch status {
		case "active":
			q += " AND m.status='active' AND m.expire_at>?"
			args = append(args, time.Now().UnixMilli())
		case "revoked":
			q += " AND m.status='revoked'"
		case "expired":
			q += " AND m.status='active' AND m.expire_at<=?"
			args = append(args, time.Now().UnixMilli())
		default:
			return bad("status", "状态筛选无效")
		}
	}
	if cid := r.URL.Query().Get("classId"); cid != "" {
		q += " AND EXISTS(SELECT 1 FROM message_classes mc WHERE mc.message_id=m.id AND mc.class_id=?)"
		args = append(args, cid)
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		raw, e := base64.RawURLEncoding.DecodeString(cursor)
		if e != nil {
			return bad("cursor", "分页游标无效")
		}
		parts := strings.Split(string(raw), ":")
		if len(parts) != 2 {
			return bad("cursor", "分页游标无效")
		}
		ts, e := strconv.ParseInt(parts[0], 10, 64)
		if e != nil || !validID(parts[1]) {
			return bad("cursor", "分页游标无效")
		}
		q += " AND (m.created_at<? OR (m.created_at=? AND m.id<?))"
		args = append(args, ts, ts, parts[1])
	}
	limit := queryLimit(r, 20, 100)
	q += " ORDER BY m.created_at DESC,m.id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, e := a.db.Query(q, args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []Message{}
	var next any
	var lastTime int64
	var lastID string
	for rows.Next() {
		var raw, id string
		var ts int64
		if e = rows.Scan(&raw, &ts, &id); e != nil {
			return e
		}
		if len(items) == limit {
			next = base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(lastTime, 10) + ":" + lastID))
			break
		}
		var m Message
		if e = json.Unmarshal([]byte(raw), &m); e != nil {
			return e
		}
		items = append(items, m)
		lastTime = ts
		lastID = id
	}
	if e = rows.Err(); e != nil {
		return e
	}
	ok(w, 200, obj{"items": items, "nextCursor": next})
	return nil
}
func (a *App) revokeMessage(w http.ResponseWriter, r *http.Request) error {
	t, _, e := a.teacherMessage(r)
	if e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	m, _, e := loadMessage(tx, r.PathValue("id"))
	if e != nil {
		return e
	}
	t, e = currentTeacher(tx, t.ID)
	if e != nil {
		return e
	}
	if strings.HasPrefix(r.URL.Path, "/api/v1/admin/") && t.Role != "admin" {
		return fail(403, "FORBIDDEN", "管理员权限已变化")
	}
	if m.Status != "revoked" {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/admin/") {
			for _, cid := range m.ClassIDs {
				if !ownsClass(t, cid) {
					return fail(403, "FORBIDDEN", "班级权限已变化，请由学校管理员撤回")
				}
			}
		}
		m.Status = "revoked"
		m.Revision++
		if _, e = tx.Exec("UPDATE messages SET status='revoked',revision=?,payload_json=? WHERE id=?", m.Revision, jsonText(m), m.ID); e != nil {
			return e
		}
		for _, cid := range m.ClassIDs {
			if _, _, e = removeClassDisplayPin(tx, cid, m.ID); e != nil {
				return e
			}
			if e = appendEvent(tx, cid, "message.revoked", obj{"id": m.ID, "revision": m.Revision}); e != nil {
				return e
			}
		}
		if _, e = tx.Exec("INSERT INTO audit_logs(actor_id,action,target,created_at) VALUES(?,'message.revoke',?,?)", t.ID, m.ID, time.Now().UnixMilli()); e != nil {
			return e
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, obj{"id": m.ID, "status": m.Status, "revision": m.Revision})
	return nil
}
func (a *App) rebroadcast(w http.ResponseWriter, r *http.Request) error {
	t, _, e := a.teacherMessage(r)
	if e != nil {
		return e
	}
	var in struct {
		ClientToken string `json:"clientToken"`
		Times       int    `json:"times"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	in.ClientToken = strings.ToLower(strings.TrimSpace(in.ClientToken))
	if !validUUID(in.ClientToken) || in.Times < 1 || in.Times > 2 {
		return bad("times", "重播需要 UUID 凭据和1–2次播报次数")
	}
	h := hash(jsonText(obj{"messageId": r.PathValue("id"), "times": in.Times}))
	a.mu.Lock()
	defer a.mu.Unlock()
	var oldH, resp string
	e = a.db.QueryRow("SELECT request_hash,response_json FROM operation_keys WHERE teacher_id=? AND client_token=?", t.ID, in.ClientToken).Scan(&oldH, &resp)
	if e == nil {
		if oldH != h {
			return fail(409, "IDEMPOTENCY_CONFLICT", "防重复凭据对应内容已变化")
		}
		var data obj
		_ = json.Unmarshal([]byte(resp), &data)
		ok(w, 200, data)
		return nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	var used int
	if e = a.db.QueryRow("SELECT COUNT(*) FROM messages WHERE teacher_id=? AND client_token=?", t.ID, in.ClientToken).Scan(&used); e != nil {
		return e
	}
	if used > 0 {
		return fail(409, "IDEMPOTENCY_CONFLICT", "该防重复凭据已用于创建公告")
	}
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	m, _, generation, e := loadMessageState(tx, r.PathValue("id"))
	if e != nil {
		return e
	}
	t, e = currentTeacher(tx, t.ID)
	if e != nil {
		return e
	}
	now := time.Now()
	start, _ := time.Parse(time.RFC3339Nano, m.StartAt)
	expire, _ := time.Parse(time.RFC3339Nano, m.ExpireAt)
	if m.Type == "notice" || m.Status != "active" || now.Before(start) || !now.Before(expire) {
		return bad("message", "仅当前有效呼叫或作业公告可重播")
	}
	for _, cid := range m.ClassIDs {
		if !ownsClass(t, cid) {
			return fail(403, "FORBIDDEN", "目标班级权限已变化")
		}
	}
	settings, e := readSettings(tx)
	if e != nil {
		return e
	}
	if quietNow(settings, now) {
		return fail(409, "QUIET_HOURS", "当前为静默时段，请在静默结束后重播")
	}
	var last int64
	if e = tx.QueryRow("SELECT COALESCE(MAX(created_at),0) FROM operation_keys WHERE teacher_id=? AND json_extract(response_json,'$.id')=?", t.ID, m.ID).Scan(&last); e != nil {
		return e
	}
	if now.UnixMilli()-last < 30000 {
		return fail(429, "RATE_LIMITED", "同一公告30秒内最多重播一次")
	}
	generation++
	m.Revision++
	deadline := now.Add(2 * time.Minute)
	if expire.Before(deadline) {
		deadline = expire
	}
	m.Broadcast = &Broadcast{Generation: generation, Times: in.Times, NotBefore: stamp(now), DeadlineAt: stamp(deadline)}
	if _, e = tx.Exec("UPDATE messages SET revision=?,generation=?,payload_json=? WHERE id=?", m.Revision, generation, jsonText(m), m.ID); e != nil {
		return e
	}
	if _, e = tx.Exec("INSERT INTO broadcast_jobs VALUES(?,?,?,?,?)", m.ID, generation, in.Times, now.UnixMilli(), deadline.UnixMilli()); e != nil {
		return e
	}
	for _, cid := range m.ClassIDs {
		if e = appendEvent(tx, cid, "message.replay", m); e != nil {
			return e
		}
	}
	data := obj{"id": m.ID, "generation": generation, "revision": m.Revision}
	if _, e = tx.Exec("INSERT INTO operation_keys VALUES(?,?,?,?,?)", t.ID, in.ClientToken, h, jsonText(data), now.UnixMilli()); e != nil {
		return e
	}
	if e = audit(tx, t.ID, "message.rebroadcast", m.ID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, data)
	return nil
}
func (a *App) delivery(w http.ResponseWriter, r *http.Request) error {
	_, m, e := a.teacherMessage(r)
	if e != nil {
		return e
	}
	rows, e := a.db.Query("SELECT d.id,d.label,c.id,c.name,d.last_seen_at,d.tts_status,d.revoked_at,d.token_expires_at FROM message_devices md JOIN devices d ON d.id=md.device_id JOIN classes c ON c.id=d.class_id WHERE md.message_id=? ORDER BY d.id", m.ID)
	if e != nil {
		return e
	}
	devices := []obj{}
	for rows.Next() {
		var id, label, cid, cn, tts string
		var last, rev sql.NullInt64
		var expiry int64
		if e = rows.Scan(&id, &label, &cid, &cn, &last, &tts, &rev, &expiry); e != nil {
			rows.Close()
			return e
		}
		devices = append(devices, obj{"id": id, "label": label, "classId": cid, "className": cn, "online": last.Valid && time.Now().UnixMilli()-last.Int64 < 90000 && !rev.Valid && expiry > time.Now().UnixMilli(), "receivedAt": nil, "displayedAt": nil, "revokedAt": nil, "playedRounds": 0, "generation": 0, "ttsStatus": tts, "lastSeenAt": nil})
		if last.Valid {
			devices[len(devices)-1]["lastSeenAt"] = msstamp(last.Int64)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	displayed := 0
	for _, d := range devices {
		for _, state := range []string{"received", "displayed", "revoked"} {
			var ts sql.NullInt64
			if e = a.db.QueryRow("SELECT MIN(received_at) FROM delivery_receipts WHERE message_id=? AND device_id=? AND state=?", m.ID, d["id"], state).Scan(&ts); e != nil {
				return e
			}
			if ts.Valid {
				d[state+"At"] = msstamp(ts.Int64)
				if state == "displayed" {
					displayed++
				}
			}
		}
		gen := 0
		if m.Broadcast != nil {
			gen = m.Broadcast.Generation
		}
		var played int
		if e = a.db.QueryRow("SELECT COUNT(*) FROM broadcast_receipts WHERE message_id=? AND device_id=? AND generation=? AND status='played'", m.ID, d["id"], gen).Scan(&played); e != nil {
			return e
		}
		d["playedRounds"] = played
		d["generation"] = gen
		broadcastReceipts := []obj{}
		br, er := a.db.Query("SELECT round,status,reason,received_at FROM broadcast_receipts WHERE message_id=? AND device_id=? AND generation=? ORDER BY round", m.ID, d["id"], gen)
		if er != nil {
			return er
		}
		for br.Next() {
			var round int
			var status, reason string
			var received int64
			if er = br.Scan(&round, &status, &reason, &received); er != nil {
				br.Close()
				return er
			}
			broadcastReceipts = append(broadcastReceipts, obj{"round": round, "status": status, "reason": reason, "receivedAt": msstamp(received)})
		}
		er = br.Err()
		br.Close()
		if er != nil {
			return er
		}
		d["broadcastReceipts"] = broadcastReceipts
	}
	ok(w, 200, obj{"messageId": m.ID, "targetDeviceCount": len(devices), "displayedDeviceCount": displayed, "devices": devices, "status": m.Status})
	return nil
}
