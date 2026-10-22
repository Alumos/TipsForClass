package app

import (
	"encoding/json"
	"testing"
	"time"
)

func noticePayloadWithPosition(token, title, position string) obj {
	payload := obj{
		"clientToken": token, "type": "notice", "roomIds": []string{"1"},
		"studentIds": []string{}, "title": title, "body": "", "broadcastTimes": 0,
		"expireAt": stamp(time.Now().Add(time.Hour)),
	}
	if position != "" {
		payload["displayPosition"] = position
	}
	return payload
}

func TestMessageDisplayPositionDefaultsAndLegacyCompatibility(t *testing.T) {
	x := newTest(t)
	x.bind("1", "display-position-device")

	_, body := x.req("POST", "/messages", x.token, noticePayloadWithPosition(uuid(), "默认右上角", ""), 201)
	defaultID := body["data"].(map[string]any)["id"].(string)
	message, _, e := loadMessage(x.a.db, defaultID)
	if e != nil {
		t.Fatal(e)
	}
	if message.DisplayPosition != "top_right" {
		t.Fatalf("default displayPosition=%q", message.DisplayPosition)
	}

	_, body = x.req("POST", "/messages", x.token, noticePayloadWithPosition(uuid(), "居中公告", "center"), 201)
	centerID := body["data"].(map[string]any)["id"].(string)
	message, _, e = loadMessage(x.a.db, centerID)
	if e != nil {
		t.Fatal(e)
	}
	if message.DisplayPosition != "center" {
		t.Fatalf("center displayPosition=%q", message.DisplayPosition)
	}

	x.req("POST", "/messages", x.token, noticePayloadWithPosition(uuid(), "非法位置", "bottom_left"), 400)

	var raw string
	if e = x.a.db.QueryRow("SELECT payload_json FROM messages WHERE id=?", centerID).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var legacy obj
	if e = json.Unmarshal([]byte(raw), &legacy); e != nil {
		t.Fatal(e)
	}
	delete(legacy, "displayPosition")
	if _, e = x.a.db.Exec("UPDATE messages SET payload_json=? WHERE id=?", jsonText(legacy), centerID); e != nil {
		t.Fatal(e)
	}
	_, body = x.req("GET", "/messages/"+centerID, x.token, nil, 200)
	if body["data"].(map[string]any)["displayPosition"] != "top_right" {
		t.Fatalf("legacy message was not normalized: %#v", body["data"])
	}
}

func TestUpdateMessagePreservesIdentityTargetsAndBroadcastState(t *testing.T) {
	x := newTest(t)
	device := x.bind("1", "update-message-device")
	_, body := x.req("POST", "/messages", x.token, createPayload(uuid()), 201)
	id := body["data"].(map[string]any)["id"].(string)
	original, _, e := loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	var targetDevices int
	if e = x.a.db.QueryRow("SELECT COUNT(*) FROM message_devices WHERE message_id=?", id).Scan(&targetDevices); e != nil {
		t.Fatal(e)
	}

	updateToken := uuid()
	firstUpdate := obj{
		"clientToken": updateToken, "roomIds": []string{"1"}, "kind": "batch", "content": "请带新作业", "studentIds": []string{"1", "2"},
		"destination": "图书馆", "broadcast": obj{"times": 1}, "displayPosition": "center",
	}
	_, body = x.req("POST", "/messages/"+id+"/update", x.token, firstUpdate, 200)
	updatedResponse := body["data"].(map[string]any)
	if updatedResponse["id"] != id || updatedResponse["revision"].(float64) != 2 || updatedResponse["type"] != "batch" || updatedResponse["displayPosition"] != "center" {
		t.Fatalf("unexpected update response: %#v", updatedResponse)
	}
	_, body = x.req("POST", "/messages/"+id+"/update", x.token, firstUpdate, 200)
	if body["data"].(map[string]any)["revision"].(float64) != 2 {
		t.Fatalf("update retry was not idempotent: %#v", body)
	}
	var updateEvents int
	if e = x.a.db.QueryRow("SELECT COUNT(*) FROM events WHERE room_id='1' AND event_type='message.upsert' AND json_extract(payload_json,'$.revision')=2").Scan(&updateEvents); e != nil || updateEvents != 1 {
		t.Fatalf("update retry emitted %d revision-2 events: %v", updateEvents, e)
	}
	updated, _, e := loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if updated.ID != original.ID || updated.CreatedAt != original.CreatedAt || updated.TeacherName != original.TeacherName || !sameStrings(updated.RoomIDs, original.RoomIDs) {
		t.Fatalf("identity or target room changed: before=%#v after=%#v", original, updated)
	}
	if updated.Title != "批量作业 · 2人 · 图书馆" || updated.Body != "请带新作业" || updated.DisplayPosition != "center" {
		t.Fatalf("publication content not updated: %#v", updated)
	}
	if updated.Broadcast == nil || updated.Broadcast.Generation != 1 || updated.Broadcast.Times != 1 {
		t.Fatalf("broadcast not regenerated: %#v", updated.Broadcast)
	}
	var jobs int
	if e = x.a.db.QueryRow("SELECT COUNT(*) FROM broadcast_jobs WHERE message_id=? AND generation=? AND times=?", id, 1, 1).Scan(&jobs); e != nil || jobs != 1 {
		t.Fatalf("broadcast jobs=%d err=%v", jobs, e)
	}
	var afterTargetDevices int
	if e = x.a.db.QueryRow("SELECT COUNT(*) FROM message_devices WHERE message_id=?", id).Scan(&afterTargetDevices); e != nil || afterTargetDevices != targetDevices {
		t.Fatalf("target devices changed from %d to %d: %v", targetDevices, afterTargetDevices, e)
	}

	var eventRaw string
	if e = x.a.db.QueryRow("SELECT payload_json FROM events WHERE room_id='1' AND event_type='message.upsert' ORDER BY seq DESC LIMIT 1").Scan(&eventRaw); e != nil {
		t.Fatal(e)
	}
	var eventMessage Message
	if e = json.Unmarshal([]byte(eventRaw), &eventMessage); e != nil {
		t.Fatal(e)
	}
	if eventMessage.ID != id || eventMessage.Revision != 2 || eventMessage.DisplayPosition != "center" || eventMessage.Body != "请带新作业" {
		t.Fatalf("unexpected upsert event: %#v", eventMessage)
	}

	_, body = x.req("GET", "/device/snapshot", device, nil, 200)
	found := false
	for _, item := range body["data"].(map[string]any)["messages"].([]any) {
		message := item.(map[string]any)
		if message["id"] == id {
			found = true
			if message["revision"].(float64) != 2 || message["displayPosition"] != "center" || message["body"] != "请带新作业" {
				t.Fatalf("snapshot has stale message: %#v", message)
			}
		}
	}
	if !found {
		t.Fatal("updated message missing from device snapshot")
	}

	_, body = x.req("POST", "/messages/"+id+"/update", x.token, obj{
		"title": "自定义作业提醒", "body": "最终正文", "broadcastTimes": 1, "displayPosition": "top_right",
	}, 200)
	updated, _, e = loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if updated.Revision != 3 || updated.Title != "自定义作业提醒" || updated.Body != "最终正文" || updated.DisplayPosition != "top_right" {
		t.Fatalf("second update mismatch: %#v", updated)
	}
	if updated.Broadcast == nil || updated.Broadcast.Generation != 1 {
		t.Fatalf("unchanged broadcast generation moved: %#v", updated.Broadcast)
	}

	_, body = x.req("POST", "/messages/"+id+"/update", x.token, obj{"broadcast": false}, 200)
	updated, _, e = loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if updated.Broadcast != nil || updated.Revision != 4 {
		t.Fatalf("broadcast was not disabled: %#v", updated)
	}
	if e = x.a.db.QueryRow("SELECT COUNT(*) FROM broadcast_jobs WHERE message_id=?", id).Scan(&jobs); e != nil || jobs != 0 {
		t.Fatalf("disabled broadcast left jobs=%d err=%v", jobs, e)
	}

	_, body = x.req("POST", "/messages/"+id+"/update", x.token, obj{"broadcast": obj{"times": 1}}, 200)
	updated, _, e = loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if updated.Revision != 5 || updated.Broadcast == nil || updated.Broadcast.Generation != 3 {
		t.Fatalf("broadcast generation did not advance after disable: %#v", updated)
	}
	if e = x.a.db.QueryRow("SELECT COUNT(*) FROM broadcast_jobs WHERE message_id=? AND generation=3", id).Scan(&jobs); e != nil || jobs != 1 {
		t.Fatalf("re-enabled broadcast jobs=%d err=%v", jobs, e)
	}

	x.req("POST", "/messages/"+id+"/update", x.token, obj{"title": "不应保存", "roomIds": []string{"2"}}, 400)
	x.req("POST", "/messages/"+id+"/update", x.token, obj{"title": "不应保存", "unexpected": true}, 400)
	unchanged, _, e := loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if unchanged.Revision != 5 || unchanged.Title == "不应保存" || !sameStrings(unchanged.RoomIDs, []string{"1"}) {
		t.Fatalf("invalid target-room edit changed message: %#v", unchanged)
	}
}

func TestDeleteRoutesRevokeAndRetainMessages(t *testing.T) {
	x := newTest(t)
	device := x.bind("1", "delete-message-device")
	first := x.notice(x.token, "1", "通过 DELETE 删除", time.Now().Add(time.Hour))
	second := x.notice(x.token, "1", "通过 POST delete 删除", time.Now().Add(time.Hour))

	_, body := x.req("DELETE", "/messages/"+first, x.token, nil, 200)
	if body["data"].(map[string]any)["status"] != "revoked" || body["data"].(map[string]any)["revision"].(float64) != 2 {
		t.Fatalf("DELETE response=%#v", body)
	}
	_, body = x.req("POST", "/messages/"+second+"/delete", x.token, obj{}, 200)
	if body["data"].(map[string]any)["status"] != "revoked" || body["data"].(map[string]any)["revision"].(float64) != 2 {
		t.Fatalf("POST delete response=%#v", body)
	}

	var retained, revoked, rooms int
	if e := x.a.db.QueryRow("SELECT COUNT(*),SUM(status='revoked') FROM messages").Scan(&retained, &revoked); e != nil || retained != 2 || revoked != 2 {
		t.Fatalf("retained=%d revoked=%d err=%v", retained, revoked, e)
	}
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM message_rooms WHERE message_id IN (?,?)", first, second).Scan(&rooms); e != nil || rooms != 2 {
		t.Fatalf("message-room records=%d err=%v", rooms, e)
	}
	for _, id := range []string{first, second} {
		message, _, e := loadMessage(x.a.db, id)
		if e != nil {
			t.Fatal(e)
		}
		if message.Status != "revoked" || message.Revision != 2 {
			t.Fatalf("message %s not retained as revoked: %#v", id, message)
		}
	}

	_, body = x.req("GET", "/device/snapshot", device, nil, 200)
	if len(body["data"].(map[string]any)["messages"].([]any)) != 0 {
		t.Fatalf("deleted messages remained on display: %#v", body["data"])
	}
	_, body = x.req("DELETE", "/messages/"+first, x.token, nil, 200)
	if body["data"].(map[string]any)["revision"].(float64) != 2 {
		t.Fatalf("repeated delete was not idempotent: %#v", body)
	}
	x.req("POST", "/messages/"+first+"/update", x.token, obj{"title": "不能编辑"}, 409)
}
