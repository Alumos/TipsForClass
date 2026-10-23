package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func readSettings(q queryer) (Settings, error) {
	var s Settings
	var raw string
	e := q.QueryRow("SELECT name,timezone,quiet_hours_json,config_revision FROM schools WHERE id=1").Scan(&s.SchoolName, &s.Timezone, &raw, &s.ConfigRevision)
	if e != nil {
		return s, e
	}
	e = json.Unmarshal([]byte(raw), &s.QuietHours)
	return s, e
}
func quietNow(s Settings, now time.Time) bool {
	loc, e := time.LoadLocation(s.Timezone)
	if e != nil {
		return true
	}
	now = now.In(loc)
	day := int(now.Weekday())
	if day == 0 {
		day = 7
	}
	clock := now.Format("15:04")
	for _, q := range s.QuietHours {
		for _, d := range q.Days {
			if d == day && clock >= q.Start && clock < q.End {
				return true
			}
		}
	}
	return false
}
func currentTeacher(q queryer, id string) (Teacher, error) {
	var t Teacher
	t.ID = id
	e := q.QueryRow("SELECT name,role,status FROM teachers WHERE id=?", id).Scan(&t.Name, &t.Role, &t.Status)
	if e != nil {
		return t, e
	}
	if t.Status != "active" {
		return t, fail(403, "FORBIDDEN", "账号权限已经变化，请刷新登录状态")
	}
	t.ClassIDs = []string{}
	qry := "SELECT tc.class_id FROM teacher_classes tc JOIN classes c ON c.id=tc.class_id WHERE tc.teacher_id=? AND c.status='active'"
	if t.Role == "admin" {
		qry = "SELECT id FROM classes WHERE status='active' AND ? IS NOT NULL"
	}
	rows, e := q.Query(qry, id)
	if e != nil {
		return t, e
	}
	defer rows.Close()
	for rows.Next() {
		var cid string
		if e = rows.Scan(&cid); e != nil {
			return t, e
		}
		t.ClassIDs = append(t.ClassIDs, cid)
	}
	return t, rows.Err()
}
func activeAdmin(q queryer, id string) error {
	var role, status string
	if e := q.QueryRow("SELECT role,status FROM teachers WHERE id=?", id).Scan(&role, &status); e != nil {
		return e
	}
	if role != "admin" || status != "active" {
		return fail(403, "FORBIDDEN", "管理员权限已变化")
	}
	return nil
}
func audit(tx *sql.Tx, id, action, target string) error {
	_, e := tx.Exec("INSERT INTO audit_logs(actor_id,action,target,created_at) VALUES(?,?,?,?)", id, action, target, time.Now().UnixMilli())
	return e
}
func (a *App) adminTeachers(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	q := "SELECT id,name,role,status FROM teachers"
	if strings.HasSuffix(r.URL.Path, "teacher-requests") {
		q += " WHERE status='pending'"
	}
	q += " ORDER BY id"
	rows, e := a.db.Query(q)
	if e != nil {
		return e
	}
	items := []Teacher{}
	for rows.Next() {
		var t Teacher
		t.ClassIDs = []string{}
		if e = rows.Scan(&t.ID, &t.Name, &t.Role, &t.Status); e != nil {
			rows.Close()
			return e
		}
		items = append(items, t)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for i := range items {
		rows, e = a.db.Query("SELECT class_id FROM teacher_classes WHERE teacher_id=? ORDER BY class_id", items[i].ID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			items[i].ClassIDs = append(items[i].ClassIDs, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
	}
	ok(w, 200, obj{"items": items})
	return nil
}
func (a *App) patchTeacher(w http.ResponseWriter, r *http.Request) error {
	return a.updateTeacher(w, r, false)
}
func (a *App) approveTeacher(w http.ResponseWriter, r *http.Request) error {
	return a.updateTeacher(w, r, true)
}
func (a *App) updateTeacher(w http.ResponseWriter, r *http.Request, approve bool) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		Name   *string `json:"name"`
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if approve {
		s := "active"
		in.Status = &s
	}
	if in.Name != nil {
		v := strings.TrimSpace(*in.Name)
		in.Name = &v
		if count(v) < 1 || count(v) > 40 {
			return bad("name", "姓名需为1–40字")
		}
	}
	if in.Role != nil && *in.Role != "teacher" && *in.Role != "admin" {
		return bad("role", "角色无效")
	}
	if in.Status != nil && *in.Status != "pending" && *in.Status != "active" && *in.Status != "disabled" {
		return bad("status", "账号状态无效")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	var t Teacher
	t.ID = r.PathValue("id")
	e = tx.QueryRow("SELECT name,role,status FROM teachers WHERE id=?", t.ID).Scan(&t.Name, &t.Role, &t.Status)
	if errors.Is(e, sql.ErrNoRows) {
		return fail(404, "NOT_FOUND", "教师不存在")
	}
	if e != nil {
		return e
	}
	wasAdmin := t.Role == "admin" && t.Status == "active"
	if in.Name != nil {
		t.Name = *in.Name
	}
	if in.Role != nil {
		t.Role = *in.Role
	}
	if in.Status != nil {
		t.Status = *in.Status
	}
	if wasAdmin && (t.Role != "admin" || t.Status != "active") {
		var n int
		if e = tx.QueryRow("SELECT COUNT(*) FROM teachers WHERE role='admin' AND status='active'").Scan(&n); e != nil {
			return e
		}
		if n <= 1 {
			return bad("role", "不能停用或降级最后一位管理员")
		}
	}
	if _, e = tx.Exec("UPDATE teachers SET name=?,role=?,status=? WHERE id=?", t.Name, t.Role, t.Status, t.ID); e != nil {
		return e
	}
	if e = audit(tx, actor.ID, "teacher.update", t.ID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	t.ClassIDs = []string{}
	ok(w, 200, t)
	return nil
}
func (a *App) teacherClasses(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		ClassIDs []string `json:"classIds"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	in.ClassIDs, e = uniqIDs(in.ClassIDs)
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
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	var n int
	if e = tx.QueryRow("SELECT COUNT(*) FROM teachers WHERE id=?", r.PathValue("id")).Scan(&n); e != nil {
		return e
	}
	if n != 1 {
		return fail(404, "NOT_FOUND", "教师不存在")
	}
	for _, cid := range in.ClassIDs {
		if e = tx.QueryRow("SELECT COUNT(*) FROM classes WHERE id=? AND status='active'", cid).Scan(&n); e != nil {
			return e
		}
		if n != 1 {
			return bad("classIds", "班级不存在或已停用")
		}
	}
	if _, e = tx.Exec("DELETE FROM teacher_classes WHERE teacher_id=?", r.PathValue("id")); e != nil {
		return e
	}
	for _, cid := range in.ClassIDs {
		if _, e = tx.Exec("INSERT INTO teacher_classes VALUES(?,?)", r.PathValue("id"), cid); e != nil {
			return e
		}
	}
	if e = audit(tx, actor.ID, "teacher.classes", r.PathValue("id")); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, obj{})
	return nil
}
func (a *App) adminClasses(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	rows, e := a.db.Query("SELECT id,name,status,display_position,pinned_message_ids_json,display_revision FROM classes ORDER BY id")
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []obj{}
	for rows.Next() {
		var id, name, status string
		var settings DisplaySettings
		var raw string
		if e = rows.Scan(&id, &name, &status, &settings.DisplayPosition, &raw, &settings.Revision); e != nil {
			return e
		}
		if e = json.Unmarshal([]byte(raw), &settings.PinnedMessageIDs); e != nil {
			return e
		}
		if settings.PinnedMessageIDs == nil {
			settings.PinnedMessageIDs = []string{}
		}
		items = append(items, obj{"id": id, "name": name, "status": status, "displaySettings": settings})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	ok(w, 200, obj{"items": items})
	return nil
}
func (a *App) addClass(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		Name   string  `json:"name"`
		Status *string `json:"status"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	in.Name = strings.TrimSpace(in.Name)
	if count(in.Name) < 1 || count(in.Name) > 60 {
		return bad("name", "班级名称需为1–60字")
	}
	status := "active"
	if in.Status != nil {
		if *in.Status != "active" && *in.Status != "disabled" {
			return bad("status", "班级状态无效")
		}
		status = *in.Status
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if e = activeAdmin(a.db, actor.ID); e != nil {
		return e
	}
	var n int
	if e = a.db.QueryRow("SELECT COUNT(*) FROM classes WHERE name=?", in.Name).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return bad("name", "班级名称已存在")
	}
	res, e := a.db.Exec("INSERT INTO classes(school_id,name,status) VALUES(1,?,?)", in.Name, status)
	if e != nil {
		return e
	}
	id, e := res.LastInsertId()
	if e != nil {
		return e
	}
	ok(w, 201, obj{"id": sid(id), "name": in.Name, "status": status})
	return nil
}
func (a *App) deleteClass(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	classID := r.PathValue("id")
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	var n int
	if e = tx.QueryRow("SELECT COUNT(*) FROM classes WHERE id=?", classID).Scan(&n); e != nil {
		return e
	}
	if n != 1 {
		return fail(404, "NOT_FOUND", "班级不存在")
	}
	if e = tx.QueryRow("SELECT COUNT(*) FROM students WHERE class_id=?", classID).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		if r.URL.Query().Get("force") != "1" {
			return fail(409, "CLASS_IN_USE", "班级仍有"+strconv.Itoa(n)+" 名学生，确认后可连同名册一起删除")
		}
		if _, e = tx.Exec("DELETE FROM students WHERE class_id=?", classID); e != nil {
			return e
		}
	}
	if e = tx.QueryRow("SELECT COUNT(*) FROM devices WHERE class_id=?", classID).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return fail(409, "CLASS_IN_USE", "班级仍绑定大屏设备，不能删除")
	}
	for _, q := range []string{"DELETE FROM bind_codes WHERE class_id=?", "DELETE FROM teacher_classes WHERE class_id=?", "DELETE FROM message_classes WHERE class_id=?", "DELETE FROM events WHERE class_id=?", "DELETE FROM roster_previews WHERE class_id=?"} {
		if _, e = tx.Exec(q, classID); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("DELETE FROM classes WHERE id=?", classID); e != nil {
		return e
	}
	if e = audit(tx, actor.ID, "class.delete", classID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, obj{"id": classID})
	return nil
}
func (a *App) patchClass(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		Name          *string `json:"name"`
		Status        *string `json:"status"`
		ConfirmImpact bool    `json:"confirmImpact"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	if in.Name != nil {
		v := strings.TrimSpace(*in.Name)
		in.Name = &v
		if count(v) < 1 || count(v) > 60 {
			return bad("name", "班级名称需为1–60字")
		}
	}
	if in.Status != nil && *in.Status != "active" && *in.Status != "disabled" {
		return bad("status", "班级状态无效")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	var name, status string
	e = tx.QueryRow("SELECT name,status FROM classes WHERE id=?", r.PathValue("id")).Scan(&name, &status)
	if errors.Is(e, sql.ErrNoRows) {
		return fail(404, "NOT_FOUND", "班级不存在")
	}
	if e != nil {
		return e
	}
	if in.Name != nil && *in.Name != name {
		var n int
		if e = tx.QueryRow("SELECT COUNT(*) FROM classes WHERE name=?", *in.Name).Scan(&n); e != nil {
			return e
		}
		if n > 0 {
			return bad("name", "班级名称已存在")
		}
		name = *in.Name
	}
	if in.Status != nil {
		status = *in.Status
	}
	if status == "disabled" {
		var n int
		if e = tx.QueryRow("SELECT COUNT(*) FROM devices WHERE class_id=? AND revoked_at IS NULL", r.PathValue("id")).Scan(&n); e != nil {
			return e
		}
		var msgs int
		if e = tx.QueryRow("SELECT COUNT(*) FROM messages m JOIN message_classes mc ON mc.message_id=m.id WHERE mc.class_id=? AND m.status='active' AND m.expire_at>?", r.PathValue("id"), time.Now().UnixMilli()).Scan(&msgs); e != nil {
			return e
		}
		if (n > 0 || msgs > 0) && !in.ConfirmImpact {
			return bad("confirmImpact", "此班级仍有设备或有效公告，需明确确认停用影响")
		}
		if _, e = tx.Exec("UPDATE devices SET revoked_at=? WHERE class_id=? AND revoked_at IS NULL", time.Now().UnixMilli(), r.PathValue("id")); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("UPDATE classes SET name=?,status=? WHERE id=?", name, status, r.PathValue("id")); e != nil {
		return e
	}
	if e = audit(tx, actor.ID, "class.update", r.PathValue("id")); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	if status == "disabled" {
		a.hubMu.Lock()
		for _, p := range a.peers {
			if p.device.ClassID == r.PathValue("id") {
				p.cancel()
			}
		}
		a.hubMu.Unlock()
	}
	ok(w, 200, obj{"id": r.PathValue("id"), "name": name, "status": status})
	return nil
}
func (a *App) adminDevices(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	rows, e := a.db.Query("SELECT d.id,d.label,d.class_id,c.name,d.last_seen_at,d.tts_status,d.revoked_at,d.token_expires_at,d.app_version FROM devices d JOIN classes c ON c.id=d.class_id ORDER BY d.id")
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []obj{}
	for rows.Next() {
		var id, label, cid, cn, tts, version string
		var last, rev sql.NullInt64
		var expiry int64
		if e = rows.Scan(&id, &label, &cid, &cn, &last, &tts, &rev, &expiry, &version); e != nil {
			return e
		}
		var ls, rv any
		if last.Valid {
			ls = msstamp(last.Int64)
		}
		if rev.Valid {
			rv = msstamp(rev.Int64)
		}
		items = append(items, obj{"id": id, "label": label, "classId": cid, "className": cn, "lastSeenAt": ls, "online": last.Valid && time.Now().UnixMilli()-last.Int64 < 90000 && !rev.Valid && expiry > time.Now().UnixMilli(), "ttsStatus": tts, "revokedAt": rv, "tokenExpiresAt": msstamp(expiry), "appVersion": version})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	ok(w, 200, obj{"items": items})
	return nil
}
func (a *App) revokeDevice(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
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
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	res, e := tx.Exec("UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?", time.Now().UnixMilli(), r.PathValue("id"))
	if e != nil {
		return e
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fail(404, "NOT_FOUND", "设备不存在")
	}
	if e = audit(tx, actor.ID, "device.revoke", r.PathValue("id")); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	a.disconnect(r.PathValue("id"))
	ok(w, 200, obj{})
	return nil
}
func (a *App) getSettings(w http.ResponseWriter, r *http.Request) error {
	if _, e := a.admin(r); e != nil {
		return e
	}
	s, e := readSettings(a.db)
	if e != nil {
		return e
	}
	ok(w, 200, s)
	return nil
}
func (a *App) putSettings(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in Settings
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	in.SchoolName = strings.TrimSpace(in.SchoolName)
	if count(in.SchoolName) < 1 || count(in.SchoolName) > 80 {
		return bad("schoolName", "学校名称需为1–80字")
	}
	if in.Timezone != "Asia/Shanghai" {
		return bad("timezone", "试点版本使用 Asia/Shanghai 时区")
	}
	if len(in.QuietHours) > 30 {
		return bad("quietHours", "静默时段最多30组")
	}
	if in.QuietHours == nil {
		in.QuietHours = []QuietHour{}
	}
	for _, q := range in.QuietHours {
		if len(q.Days) == 0 {
			return bad("quietHours", "请选择静默日期")
		}
		for _, d := range q.Days {
			if d < 1 || d > 7 {
				return bad("quietHours", "星期需为1至7")
			}
		}
		for _, v := range []string{q.Start, q.End} {
			t, e := time.Parse("15:04", v)
			if e != nil || t.Format("15:04") != v {
				return bad("quietHours", "时间需为 HH:mm")
			}
		}
		if q.Start >= q.End {
			return bad("quietHours", "结束时间需晚于开始，跨午夜请拆为两段")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE schools SET name=?,timezone=?,quiet_hours_json=?,config_revision=config_revision+1 WHERE id=1", in.SchoolName, in.Timezone, jsonText(in.QuietHours)); e != nil {
		return e
	}
	s, e := readSettings(tx)
	if e != nil {
		return e
	}
	rows, e := tx.Query("SELECT id FROM classes WHERE status='active'")
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range ids {
		if e = appendEvent(tx, id, "class.config", s); e != nil {
			return e
		}
	}
	if e = audit(tx, actor.ID, "settings.update", "1"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, s)
	return nil
}

type rosterRow struct {
	StudentNo string `json:"studentNo"`
	Name      string `json:"name"`
	RowNumber int    `json:"-"`
}

func (a *App) previewRoster(actor Teacher, classID string, rows []rosterRow) (obj, error) {
	if len(rows) == 0 || len(rows) > 1000 {
		return nil, bad("rows", "每次导入1–1000行")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	if e = activeAdmin(tx, actor.ID); e != nil {
		return nil, e
	}
	var n int
	if e = tx.QueryRow("SELECT COUNT(*) FROM classes WHERE id=?", classID).Scan(&n); e != nil {
		return nil, e
	}
	if n != 1 {
		return nil, bad("classId", "班级不存在")
	}
	errs := []obj{}
	seen := map[string]bool{}
	newCount, updateCount := 0, 0
	for i := range rows {
		v := &rows[i]
		v.StudentNo = strings.TrimSpace(v.StudentNo)
		v.Name = strings.TrimSpace(v.Name)
		msg := ""
		if count(v.StudentNo) < 1 || count(v.StudentNo) > 64 || count(v.Name) < 1 || count(v.Name) > 40 {
			msg = "学号需为1–64字，姓名需为1–40字"
		}
		if strings.ContainsAny(v.StudentNo+v.Name, "\r\n\x00") {
			msg = "学号和姓名不可包含换行或空字符"
		}
		if seen[v.StudentNo] {
			msg = "文件内学号重复"
		}
		seen[v.StudentNo] = true
		if msg != "" {
			rowNumber := v.RowNumber
			if rowNumber <= 0 {
				rowNumber = i + 1
			}
			errs = append(errs, obj{"row": rowNumber, "message": msg})
			continue
		}
		if e = tx.QueryRow("SELECT COUNT(*) FROM students WHERE class_id=? AND student_no=?", classID, v.StudentNo).Scan(&n); e != nil {
			return nil, e
		}
		if n > 0 {
			updateCount++
		} else {
			newCount++
		}
	}
	id := uuid()
	now := time.Now()
	if _, e = tx.Exec("DELETE FROM roster_previews WHERE expires_at<?", now.UnixMilli()); e != nil {
		return nil, e
	}
	if _, e = tx.Exec("INSERT INTO roster_previews(id,teacher_id,class_id,rows_json,expires_at,valid) VALUES(?,?,?,?,?,?)", id, actor.ID, classID, jsonText(rows), now.Add(24*time.Hour).UnixMilli(), len(errs) == 0); e != nil {
		return nil, e
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return obj{"importId": id, "valid": len(errs) == 0, "rows": rows, "errors": errs, "newCount": newCount, "updateCount": updateCount}, nil
}

func (a *App) rosterPreview(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		ClassID string      `json:"classId"`
		Rows    []rosterRow `json:"rows"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	data, e := a.previewRoster(actor, in.ClassID, in.Rows)
	if e != nil {
		return e
	}
	ok(w, 200, data)
	return nil
}
func (a *App) rosterCommit(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	var in struct {
		ImportID string `json:"importId"`
	}
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = activeAdmin(tx, actor.ID); e != nil {
		return e
	}
	var cid, raw string
	var expiry int64
	var valid bool
	var committed sql.NullString
	e = tx.QueryRow("SELECT class_id,rows_json,expires_at,valid,committed_json FROM roster_previews WHERE id=? AND teacher_id=?", in.ImportID, actor.ID).Scan(&cid, &raw, &expiry, &valid, &committed)
	if errors.Is(e, sql.ErrNoRows) {
		return fail(404, "NOT_FOUND", "导入预检不存在")
	}
	if e != nil {
		return e
	}
	if committed.Valid {
		var data obj
		_ = json.Unmarshal([]byte(committed.String), &data)
		ok(w, 200, data)
		return nil
	}
	if expiry < time.Now().UnixMilli() {
		return bad("importId", "预检已过期，请重新上传")
	}
	if !valid {
		return bad("importId", "预检仍有错误，不能导入")
	}
	var rows []rosterRow
	if e = json.Unmarshal([]byte(raw), &rows); e != nil {
		return e
	}
	created, updated := 0, 0
	sort.Slice(rows, func(i, j int) bool { return rows[i].StudentNo < rows[j].StudentNo })
	for _, v := range rows {
		var n int
		if e = tx.QueryRow("SELECT COUNT(*) FROM students WHERE class_id=? AND student_no=?", cid, v.StudentNo).Scan(&n); e != nil {
			return e
		}
		if n > 0 {
			updated++
		} else {
			created++
		}
		if _, e = tx.Exec("INSERT INTO students(class_id,student_no,name) VALUES(?,?,?) ON CONFLICT(class_id,student_no) DO UPDATE SET name=excluded.name,active=1", cid, v.StudentNo, v.Name); e != nil {
			return e
		}
	}
	data := obj{"created": created, "updated": updated}
	if _, e = tx.Exec("UPDATE roster_previews SET rows_json='[]',committed_json=? WHERE id=?", jsonText(data), in.ImportID); e != nil {
		return e
	}
	if e = audit(tx, actor.ID, "roster.commit", cid+":"+strconv.Itoa(len(rows))); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, data)
	return nil
}
