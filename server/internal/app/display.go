package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const maxPinnedMessages = 50

type displaySettingsRequest struct {
	RoomID           string    `json:"roomId,omitempty"`
	DisplayPosition  *string   `json:"displayPosition,omitempty"`
	Position         *string   `json:"position,omitempty"`
	PinnedMessageIDs *[]string `json:"pinnedMessageIds,omitempty"`
	MessageOrder     []string  `json:"messageOrder,omitempty"`
}

func loadRoomDisplaySettings(q queryer, roomID string) (DisplaySettings, error) {
	s := DisplaySettings{DisplayPosition: "top_right", PinnedMessageIDs: []string{}, Revision: 1}
	var raw string
	e := q.QueryRow("SELECT display_position,pinned_message_ids_json,revision FROM room_display_settings WHERE room_id=?", roomID).Scan(&s.DisplayPosition, &raw, &s.Revision)
	if errors.Is(e, sql.ErrNoRows) {
		return s, nil
	}
	if e != nil {
		return s, e
	}
	if e = json.Unmarshal([]byte(raw), &s.PinnedMessageIDs); e != nil {
		return s, e
	}
	if s.PinnedMessageIDs == nil {
		s.PinnedMessageIDs = []string{}
	}
	return s, nil
}

func ensureRoomDisplaySettings(tx *sql.Tx, roomID string) (DisplaySettings, error) {
	s, e := loadRoomDisplaySettings(tx, roomID)
	if e != nil {
		return s, e
	}
	if _, e = tx.Exec("INSERT OR IGNORE INTO room_display_settings(room_id) VALUES(?)", roomID); e != nil {
		return s, e
	}
	return s, nil
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func saveRoomDisplaySettings(tx *sql.Tx, roomID string, s DisplaySettings) error {
	if s.PinnedMessageIDs == nil {
		s.PinnedMessageIDs = []string{}
	}
	_, e := tx.Exec("UPDATE room_display_settings SET display_position=?,pinned_message_ids_json=?,revision=? WHERE room_id=?", s.DisplayPosition, jsonText(s.PinnedMessageIDs), s.Revision, roomID)
	return e
}

func appendRoomDisplayEvent(tx *sql.Tx, roomID string, settings DisplaySettings) error {
	return appendEvent(tx, roomID, "room.display", obj{"displaySettings": settings})
}

func pruneRoomDisplayPins(tx *sql.Tx, roomID string, now time.Time) (DisplaySettings, bool, error) {
	s, e := ensureRoomDisplaySettings(tx, roomID)
	if e != nil {
		return s, false, e
	}
	kept := make([]string, 0, len(s.PinnedMessageIDs))
	for _, id := range s.PinnedMessageIDs {
		var valid int
		if e = tx.QueryRow("SELECT COUNT(*) FROM messages m JOIN message_rooms mr ON mr.message_id=m.id WHERE m.id=? AND mr.room_id=? AND m.status='active' AND m.expire_at>?", id, roomID, now.UnixMilli()).Scan(&valid); e != nil {
			return s, false, e
		}
		if valid == 1 {
			kept = append(kept, id)
		}
	}
	if sameStrings(kept, s.PinnedMessageIDs) {
		return s, false, nil
	}
	s.PinnedMessageIDs = kept
	s.Revision++
	if e = saveRoomDisplaySettings(tx, roomID, s); e != nil {
		return s, false, e
	}
	if e = appendRoomDisplayEvent(tx, roomID, s); e != nil {
		return s, false, e
	}
	return s, true, nil
}

func removeRoomDisplayPin(tx *sql.Tx, roomID, messageID string) (DisplaySettings, bool, error) {
	s, e := ensureRoomDisplaySettings(tx, roomID)
	if e != nil {
		return s, false, e
	}
	kept := make([]string, 0, len(s.PinnedMessageIDs))
	for _, id := range s.PinnedMessageIDs {
		if id != messageID {
			kept = append(kept, id)
		}
	}
	if sameStrings(kept, s.PinnedMessageIDs) {
		return s, false, nil
	}
	s.PinnedMessageIDs = kept
	s.Revision++
	if e = saveRoomDisplaySettings(tx, roomID, s); e != nil {
		return s, false, e
	}
	if e = appendRoomDisplayEvent(tx, roomID, s); e != nil {
		return s, false, e
	}
	return s, true, nil
}

func readRoomDisplayMessages(q queryer, roomID string, pins []string, now time.Time) ([]Message, error) {
	rows, e := q.Query("SELECT m.payload_json,m.id FROM messages m JOIN message_rooms mr ON mr.message_id=m.id WHERE mr.room_id=? AND m.status='active' AND m.expire_at>? ORDER BY m.created_at DESC,m.id DESC", roomID, now.UnixMilli())
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	byID := map[string]Message{}
	rest := []Message{}
	pinned := map[string]bool{}
	for _, id := range pins {
		pinned[id] = true
	}
	for rows.Next() {
		var raw, id string
		if e = rows.Scan(&raw, &id); e != nil {
			return nil, e
		}
		var m Message
		if e = json.Unmarshal([]byte(raw), &m); e != nil {
			return nil, e
		}
		byID[id] = m
		if !pinned[id] {
			rest = append(rest, m)
		}
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	items := make([]Message, 0, len(byID))
	for _, id := range pins {
		if m, found := byID[id]; found {
			items = append(items, m)
		}
	}
	return append(items, rest...), nil
}

func displaySettingsEnvelope(roomID string, settings DisplaySettings, messages []Message) obj {
	order := make([]string, 0, len(messages))
	for _, m := range messages {
		order = append(order, m.ID)
	}
	return obj{
		"roomId":           roomID,
		"displayPosition":  settings.DisplayPosition,
		"position":         settings.DisplayPosition,
		"pinnedMessageIds": settings.PinnedMessageIDs,
		"revision":         settings.Revision,
		"messageOrder":     order,
		"messages":         messages,
	}
}

func (a *App) getDisplaySettings(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	roomID := r.PathValue("id")
	if !ownsRoom(t, roomID) {
		return fail(403, "FORBIDDEN", "无权查看该教室的屏幕设置")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t, e = currentTeacher(tx, t.ID)
	if e != nil {
		return e
	}
	if !ownsRoom(t, roomID) {
		return fail(403, "FORBIDDEN", "教室权限已变化")
	}
	now := time.Now()
	settings, _, e := pruneRoomDisplayPins(tx, roomID, now)
	if e != nil {
		return e
	}
	messages, e := readRoomDisplayMessages(tx, roomID, settings.PinnedMessageIDs, now)
	if e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, displaySettingsEnvelope(roomID, settings, messages))
	return nil
}

func requestedDisplayPosition(in displaySettingsRequest) (*string, error) {
	var position *string
	if in.DisplayPosition != nil {
		v := strings.TrimSpace(*in.DisplayPosition)
		position = &v
	}
	if in.Position != nil {
		v := strings.TrimSpace(*in.Position)
		if position != nil && *position != v {
			return nil, bad("displayPosition", "displayPosition 与 position 不一致")
		}
		position = &v
	}
	if position != nil && *position != "top_right" && *position != "center" {
		return nil, bad("displayPosition", "显示位置只能为 top_right 或 center")
	}
	return position, nil
}

func validatePinnedIDs(ids []string) error {
	if len(ids) > maxPinnedMessages {
		return bad("pinnedMessageIds", "最多置顶50条公告")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !validID(id) {
			return bad("pinnedMessageIds", "置顶公告编号必须为正整数字符串")
		}
		if seen[id] {
			return bad("pinnedMessageIds", "置顶公告编号不可重复")
		}
		seen[id] = true
	}
	return nil
}

func (a *App) putDisplaySettings(w http.ResponseWriter, r *http.Request) error {
	t, e := a.teacher(r, true)
	if e != nil {
		return e
	}
	roomID := r.PathValue("id")
	if !ownsRoom(t, roomID) {
		return fail(403, "FORBIDDEN", "无权修改该教室的屏幕设置")
	}
	var in displaySettingsRequest
	if e = readJSON(w, r, &in); e != nil {
		return e
	}
	in.RoomID = strings.TrimSpace(in.RoomID)
	if in.RoomID != "" && in.RoomID != roomID {
		return bad("roomId", "请求教室与路径不一致")
	}
	position, e := requestedDisplayPosition(in)
	if e != nil {
		return e
	}
	if position == nil && in.PinnedMessageIDs == nil {
		return bad("request", "请提供 displayPosition 或 pinnedMessageIds")
	}
	if in.PinnedMessageIDs != nil {
		if e = validatePinnedIDs(*in.PinnedMessageIDs); e != nil {
			return e
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	t, e = currentTeacher(tx, t.ID)
	if e != nil {
		return e
	}
	if !ownsRoom(t, roomID) {
		return fail(403, "FORBIDDEN", "教室权限已变化")
	}
	now := time.Now()
	settings, _, e := pruneRoomDisplayPins(tx, roomID, now)
	if e != nil {
		return e
	}
	if position != nil {
		settings.DisplayPosition = *position
	}
	if in.PinnedMessageIDs != nil {
		pins := append([]string{}, (*in.PinnedMessageIDs)...)
		for _, id := range pins {
			var valid int
			if e = tx.QueryRow("SELECT COUNT(*) FROM messages m JOIN message_rooms mr ON mr.message_id=m.id WHERE m.id=? AND mr.room_id=? AND m.status='active' AND m.expire_at>?", id, roomID, now.UnixMilli()).Scan(&valid); e != nil {
				return e
			}
			if valid != 1 {
				return bad("pinnedMessageIds", "只能置顶该教室当前或未来有效且未撤回的公告")
			}
		}
		settings.PinnedMessageIDs = pins
	}
	settings.Revision++
	if e = saveRoomDisplaySettings(tx, roomID, settings); e != nil {
		return e
	}
	if e = appendRoomDisplayEvent(tx, roomID, settings); e != nil {
		return e
	}
	if e = audit(tx, t.ID, "display-settings.update", roomID); e != nil {
		return e
	}
	messages, e := readRoomDisplayMessages(tx, roomID, settings.PinnedMessageIDs, now)
	if e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	ok(w, 200, displaySettingsEnvelope(roomID, settings, messages))
	return nil
}

func (a *App) pruneExpiredDisplayPins() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	rows, e := tx.Query("SELECT id FROM rooms")
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
	now := time.Now()
	for _, id := range ids {
		if _, _, e = pruneRoomDisplayPins(tx, id, now); e != nil {
			return e
		}
	}
	return tx.Commit()
}
