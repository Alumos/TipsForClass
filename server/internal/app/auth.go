package app

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *App) tokenHash(s string) string { return hash(a.cfg.BindSecret + ":" + s) }
func bearer(r *http.Request) string {
	s := r.Header.Get("Authorization")
	if !strings.HasPrefix(s, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(s, "Bearer ")
}
func (a *App) teacher(r *http.Request, active bool) (Teacher, error) {
	var t Teacher
	token := bearer(r)
	if !strings.HasPrefix(token, "t_") {
		return t, fail(401, "AUTH_EXPIRED", "请重新登录")
	}
	e := a.db.QueryRowContext(r.Context(), "SELECT t.id,t.name,t.role,t.status,t.openid FROM teachers t JOIN teacher_sessions s ON s.teacher_id=t.id WHERE s.token_hash=? AND s.expires_at>?", a.tokenHash(token), time.Now().UnixMilli()).Scan(&t.ID, &t.Name, &t.Role, &t.Status, &t.OpenID)
	if errors.Is(e, sql.ErrNoRows) {
		return t, fail(401, "AUTH_EXPIRED", "登录已过期，请重新登录")
	}
	if e != nil {
		return t, e
	}
	if t.Status == "disabled" {
		return t, fail(403, "FORBIDDEN", "账号已停用，请联系学校管理员")
	}
	if active && t.Status != "active" {
		return t, fail(403, "FORBIDDEN", "账号正在等待学校管理员审核")
	}
	t.RoomIDs = []string{}
	q := "SELECT tr.room_id FROM teacher_rooms tr JOIN rooms r ON r.id=tr.room_id WHERE tr.teacher_id=? AND r.status='active' ORDER BY tr.room_id"
	if t.Role == "admin" {
		q = "SELECT id FROM rooms WHERE status='active' AND ? IS NOT NULL ORDER BY id"
	}
	rows, e := a.db.QueryContext(r.Context(), q, t.ID)
	if e != nil {
		return t, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			return t, e
		}
		t.RoomIDs = append(t.RoomIDs, id)
	}
	return t, rows.Err()
}
func (a *App) admin(r *http.Request) (Teacher, error) {
	t, e := a.teacher(r, true)
	if e == nil && t.Role != "admin" {
		e = fail(403, "FORBIDDEN", "需要学校管理员权限")
	}
	return t, e
}
func ownsRoom(t Teacher, id string) bool {
	for _, v := range t.RoomIDs {
		if v == id {
			return true
		}
	}
	return false
}
func (a *App) session(w http.ResponseWriter, t Teacher) error {
	token := randomToken("t_")
	expiry := time.Now().Add(7 * 24 * time.Hour)
	_, e := a.db.Exec("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at) VALUES(?,?,?)", a.tokenHash(token), t.ID, expiry.UnixMilli())
	if e != nil {
		return e
	}
	ok(w, 200, obj{"token": token, "teacher": t, "expiresAt": stamp(expiry)})
	return nil
}
func (a *App) demoLogin(w http.ResponseWriter, r *http.Request) error {
	if a.cfg.Mode != "demo" {
		return fail(404, "NOT_FOUND", "接口不存在")
	}
	if !a.allow("demo:"+r.RemoteAddr, 30, time.Minute) {
		return fail(429, "RATE_LIMITED", "登录过于频繁")
	}
	return a.session(w, Teacher{ID: "1", Name: "演示管理员", Role: "admin", Status: "active", RoomIDs: []string{"1", "2"}})
}
func (a *App) wxLogin(w http.ResponseWriter, r *http.Request) error {
	if a.cfg.WXAppID == "" || a.cfg.WXAppSecret == "" {
		return fail(503, "TEMPORARILY_UNAVAILABLE", "尚未配置微信登录，请使用明确启用的演示入口或联系管理员")
	}
	if !a.allow("wx:"+r.RemoteAddr, 30, time.Minute) {
		return fail(429, "RATE_LIMITED", "登录过于频繁")
	}
	var in struct {
		Code string `json:"code"`
	}
	if e := readJSON(w, r, &in); e != nil {
		return e
	}
	if in.Code == "" || len(in.Code) > 512 {
		return bad("code", "微信登录凭据无效")
	}
	openid, e := a.wx.login(r.Context(), in.Code)
	if e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, e = a.db.Exec("INSERT OR IGNORE INTO teachers(openid,name,role,status) VALUES(?,?,'teacher','pending')", openid, "待审核教师")
	if e != nil {
		return e
	}
	var t Teacher
	e = a.db.QueryRow("SELECT id,name,role,status FROM teachers WHERE openid=?", openid).Scan(&t.ID, &t.Name, &t.Role, &t.Status)
	if e != nil {
		return e
	}
	if t.Status == "disabled" {
		return fail(403, "FORBIDDEN", "账号已停用，请联系学校管理员")
	}
	return a.session(w, t)
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.teacher(r, false); e != nil {
		return e
	}
	_, e := a.db.Exec("DELETE FROM teacher_sessions WHERE token_hash=?", a.tokenHash(bearer(r)))
	if e != nil {
		return e
	}
	ok(w, 200, obj{})
	return nil
}
func (a *App) me(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, false)
	if e != nil {
		return e
	}
	var name, tz string
	if e = a.db.QueryRow("SELECT name,timezone FROM schools WHERE id=1").Scan(&name, &tz); e != nil {
		return e
	}
	ok(w, 200, obj{"id": t.ID, "name": t.Name, "role": t.Role, "status": t.Status, "roomIds": t.RoomIDs, "school": obj{"id": "1", "name": name, "timezone": tz}, "mode": a.cfg.Mode})
	return nil
}
func (a *App) setup(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, false)
	if e != nil {
		return e
	}
	var in struct {
		BootstrapCode string `json:"bootstrapCode"`
		Name          string `json:"name"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if !a.allow("setup:"+t.ID, 5, time.Minute) {
		return fail(429, "RATE_LIMITED", "尝试过于频繁")
	}
	if a.cfg.BootstrapCode == "" || !secureEqual(in.BootstrapCode, a.cfg.BootstrapCode) {
		return fail(403, "FORBIDDEN", "引导码无效")
	}
	in.Name = strings.TrimSpace(in.Name)
	if count(in.Name) < 1 || count(in.Name) > 40 {
		return bad("name", "请输入1–40字姓名")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var n int
	if e = tx.QueryRow("SELECT COUNT(*) FROM teachers WHERE role='admin' AND status='active'").Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return fail(409, "ALREADY_INITIALIZED", "管理员已初始化，请联系现有管理员")
	}
	if _, e = tx.Exec("UPDATE teachers SET name=?,role='admin',status='active' WHERE id=?", in.Name, t.ID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	t.Name = in.Name
	t.Role = "admin"
	t.Status = "active"
	ok(w, 200, t)
	return nil
}
func (a *App) rooms(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	items := []obj{}
	for _, id := range t.RoomIDs {
		var name string
		var total, online int
		var last sql.NullInt64
		e = a.db.QueryRow("SELECT r.name,COUNT(d.id),COALESCE(SUM(CASE WHEN d.last_seen_at>? AND d.revoked_at IS NULL AND d.token_expires_at>? THEN 1 ELSE 0 END),0),MAX(d.last_seen_at) FROM rooms r LEFT JOIN devices d ON d.room_id=r.id AND d.revoked_at IS NULL AND d.token_expires_at>? WHERE r.id=? GROUP BY r.id", time.Now().Add(-90*time.Second).UnixMilli(), time.Now().UnixMilli(), time.Now().UnixMilli(), id).Scan(&name, &total, &online, &last)
		if e != nil {
			return e
		}
		var ls any
		if last.Valid {
			ls = msstamp(last.Int64)
		}
		items = append(items, obj{"id": id, "name": name, "onlineDeviceCount": online, "deviceCount": total, "lastSeenAt": ls})
	}
	ok(w, 200, obj{"items": items})
	return nil
}
func (a *App) classes(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	room := r.URL.Query().Get("roomId")
	if !ownsRoom(t, room) {
		return fail(403, "FORBIDDEN", "无权查看该教室")
	}
	rows, e := a.db.Query("SELECT id,name,room_id FROM classes WHERE room_id=? ORDER BY id", room)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []obj{}
	for rows.Next() {
		var id, name, rid string
		if e = rows.Scan(&id, &name, &rid); e != nil {
			return e
		}
		items = append(items, obj{"id": id, "name": name, "roomId": rid})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	ok(w, 200, obj{"items": items})
	return nil
}
func (a *App) students(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	cid := r.URL.Query().Get("classId")
	var rid string
	if e = a.db.QueryRow("SELECT room_id FROM classes WHERE id=?", cid).Scan(&rid); e != nil {
		return fail(404, "NOT_FOUND", "班级不存在")
	}
	if !ownsRoom(t, rid) {
		return fail(403, "FORBIDDEN", "无权查看该班级")
	}
	limit := queryLimit(r, 50, 100)
	cursor := r.URL.Query().Get("cursor")
	if cursor == "" {
		cursor = "0"
	}
	q := "%" + r.URL.Query().Get("q") + "%"
	rows, e := a.db.Query("SELECT s.id,s.name,s.student_no,s.class_id,c.name FROM students s JOIN classes c ON c.id=s.class_id WHERE s.class_id=? AND s.active=1 AND (s.name LIKE ? OR s.student_no LIKE ?) AND s.id>? ORDER BY s.id LIMIT ?", cid, q, q, cursor, limit+1)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []obj{}
	for rows.Next() {
		var id, name, no, cl, cn string
		if e = rows.Scan(&id, &name, &no, &cl, &cn); e != nil {
			return e
		}
		items = append(items, obj{"id": id, "name": name, "studentNo": no, "classId": cl, "className": cn})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	var next any
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1]["id"]
	}
	ok(w, 200, obj{"items": items, "nextCursor": next})
	return nil
}
