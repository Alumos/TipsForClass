package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"mime/multipart"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func (x *testAPI) teacherForRooms(id string, roomIDs ...string) string {
	x.t.Helper()
	_, e := x.a.db.Exec("INSERT INTO teachers(id,openid,name,role,status) VALUES(?,?,?,'teacher','active')", id, "openid-"+id, "教师"+id)
	if e != nil {
		x.t.Fatal(e)
	}
	for _, roomID := range roomIDs {
		if _, e = x.a.db.Exec("INSERT INTO teacher_rooms VALUES(?,?)", id, roomID); e != nil {
			x.t.Fatal(e)
		}
	}
	token := randomToken("t_")
	if _, e = x.a.db.Exec("INSERT INTO teacher_sessions VALUES(?,?,?)", x.a.tokenHash(token), id, time.Now().Add(time.Hour).UnixMilli()); e != nil {
		x.t.Fatal(e)
	}
	return token
}

func (x *testAPI) notice(token, roomID, title string, expireAt time.Time) string {
	x.t.Helper()
	payload := obj{
		"clientToken": uuid(), "type": "notice", "roomIds": []string{roomID},
		"studentIds": []string{}, "title": title, "body": "", "broadcastTimes": 0,
		"expireAt": stamp(expireAt),
	}
	_, body := x.req("POST", "/messages", token, payload, 201)
	return body["data"].(map[string]any)["id"].(string)
}

func (x *testAPI) uploadXLSX(classID, filename string, data []byte, want int) obj {
	x.t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if e := writer.WriteField("classId", classID); e != nil {
		x.t.Fatal(e)
	}
	part, e := writer.CreateFormFile("file", filename)
	if e != nil {
		x.t.Fatal(e)
	}
	if _, e = part.Write(data); e != nil {
		x.t.Fatal(e)
	}
	if e = writer.Close(); e != nil {
		x.t.Fatal(e)
	}
	r := httptest.NewRequest("POST", "/api/v1/admin/rosters/xlsx", &body)
	r.Header.Set("Authorization", "Bearer "+x.token)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	x.h.ServeHTTP(w, r)
	var response obj
	if e = json.Unmarshal(w.Body.Bytes(), &response); e != nil {
		x.t.Fatalf("decode XLSX response: %v body=%s", e, w.Body.String())
	}
	if w.Code != want {
		x.t.Fatalf("POST /admin/rosters/xlsx: got %d want %d; %s", w.Code, want, w.Body.String())
	}
	return response
}

func TestDisplaySettingsSharedScopedAndSnapshotOrdered(t *testing.T) {
	x := newTest(t)
	device := x.bind("1", "display-settings-device")
	firstTeacher := x.teacherForRooms("10", "1")
	secondTeacher := x.teacherForRooms("11", "1")
	roomTwoTeacher := x.teacherForRooms("12", "2")
	expiry := time.Now().Add(time.Hour)
	m1 := x.notice(firstTeacher, "1", "第一条", expiry)
	m2 := x.notice(firstTeacher, "1", "第二条", expiry)
	m3 := x.notice(firstTeacher, "1", "第三条", expiry)
	m4 := x.notice(firstTeacher, "1", "第四条", expiry)
	_, body := x.req("PUT", "/rooms/1/display-settings", firstTeacher, obj{
		"roomId": "1", "position": "center", "pinnedMessageIds": []string{m2, m1},
		"messageOrder": []string{m4, m3, m2, m1},
	}, 200)
	data := body["data"].(map[string]any)
	if data["displayPosition"] != "center" || data["position"] != "center" || data["revision"].(float64) != 2 {
		t.Fatalf("unexpected PUT response: %#v", data)
	}
	_, body = x.req("GET", "/rooms/1/display-settings", secondTeacher, nil, 200)
	data = body["data"].(map[string]any)
	pins := data["pinnedMessageIds"].([]any)
	if len(pins) != 2 || pins[0] != m2 || pins[1] != m1 || data["displayPosition"] != "center" {
		t.Fatalf("shared settings not visible: %#v", data)
	}
	x.req("GET", "/rooms/1/display-settings", roomTwoTeacher, nil, 403)
	x.req("PUT", "/rooms/1/display-settings", roomTwoTeacher, obj{"position": "top_right"}, 403)
	x.req("GET", "/rooms/2/display-settings", secondTeacher, nil, 403)

	_, body = x.req("GET", "/device/snapshot", device, nil, 200)
	snapshot := body["data"].(map[string]any)
	display := snapshot["displaySettings"].(map[string]any)
	if display["displayPosition"] != "center" || display["revision"].(float64) != 2 {
		t.Fatalf("snapshot display settings missing: %#v", display)
	}
	got := []string{}
	for _, item := range snapshot["messages"].([]any) {
		got = append(got, item.(map[string]any)["id"].(string))
	}
	want := []string{m2, m1, m4, m3}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("snapshot order got %v want %v", got, want)
	}
	var raw string
	if e := x.a.db.QueryRow("SELECT payload_json FROM events WHERE room_id='1' AND event_type='room.display' ORDER BY seq DESC LIMIT 1").Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var event struct {
		DisplaySettings DisplaySettings `json:"displaySettings"`
	}
	if e := json.Unmarshal([]byte(raw), &event); e != nil || event.DisplaySettings.Revision != 2 || !sameStrings(event.DisplaySettings.PinnedMessageIDs, []string{m2, m1}) {
		t.Fatalf("room.display payload=%s err=%v", raw, e)
	}
}

func TestDisplayRevisionPersistsAcrossRestart(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "restart.db")
	a1, e := New(Config{Mode: "demo", DBPath: dbPath})
	if e != nil {
		t.Fatal(e)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			_ = a1.Close()
		}
	})
	x1 := &testAPI{a: a1, h: a1.Handler(), t: t}
	_, body := x1.req("POST", "/auth/demo-login", "", obj{}, 200)
	x1.token = body["data"].(map[string]any)["token"].(string)
	x1.bind("1", "restart-display-device")
	messageID := x1.notice(x1.token, "1", "重启后仍置顶", time.Now().Add(time.Hour))
	_, body = x1.req("PUT", "/rooms/1/display-settings", x1.token, obj{"displayPosition": "center", "pinnedMessageIds": []string{messageID}}, 200)
	revision := body["data"].(map[string]any)["revision"].(float64)
	if e = a1.Close(); e != nil {
		t.Fatal(e)
	}
	closed = true
	a2, e := New(Config{Mode: "demo", DBPath: dbPath})
	if e != nil {
		t.Fatal(e)
	}
	defer a2.Close()
	x2 := &testAPI{a: a2, h: a2.Handler(), t: t}
	_, body = x2.req("GET", "/rooms/1/display-settings", x1.token, nil, 200)
	data := body["data"].(map[string]any)
	if data["revision"].(float64) != revision || data["displayPosition"] != "center" || data["pinnedMessageIds"].([]any)[0] != messageID {
		t.Fatalf("display settings did not persist: %#v", data)
	}
}

func TestRevocationAndExpiryRemoveDisplayPins(t *testing.T) {
	x := newTest(t)
	x.bind("1", "pin-cleanup-device")
	revokedID := x.notice(x.token, "1", "将撤回", time.Now().Add(time.Hour))
	expiringID := x.notice(x.token, "1", "将过期", time.Now().Add(time.Hour))
	_, body := x.req("PUT", "/rooms/1/display-settings", x.token, obj{"pinnedMessageIds": []string{revokedID, expiringID}}, 200)
	if body["data"].(map[string]any)["revision"].(float64) != 2 {
		t.Fatal("initial pin revision missing")
	}
	x.req("POST", "/messages/"+revokedID+"/revoke", x.token, obj{}, 200)
	_, body = x.req("GET", "/rooms/1/display-settings", x.token, nil, 200)
	pins := body["data"].(map[string]any)["pinnedMessageIds"].([]any)
	if len(pins) != 1 || pins[0] != expiringID {
		t.Fatalf("revoked pin remained: %v", pins)
	}
	if _, e := x.a.db.Exec("UPDATE messages SET start_at=?,expire_at=? WHERE id=?", time.Now().Add(-2*time.Minute).UnixMilli(), time.Now().Add(-time.Second).UnixMilli(), expiringID); e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, body = x.req("GET", "/rooms/1/display-settings", x.token, nil, 200)
		data := body["data"].(map[string]any)
		if len(data["pinnedMessageIds"].([]any)) == 0 {
			if data["revision"].(float64) != 4 {
				t.Fatalf("revision after automatic cleanup=%v", data["revision"])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expired pin was not removed by background pruning")
		}
		time.Sleep(100 * time.Millisecond)
	}
	var displayEvents int
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM events WHERE room_id='1' AND event_type='room.display'").Scan(&displayEvents); e != nil || displayEvents != 3 {
		t.Fatalf("room.display events=%d err=%v", displayEvents, e)
	}
}

func TestCallTitleOmitsStudentNameAndIncludesDestination(t *testing.T) {
	x := newTest(t)
	x.bind("1", "call-title-device")
	_, body := x.req("POST", "/messages", x.token, createPayload(uuid()), 201)
	id := body["data"].(map[string]any)["id"].(string)
	message, _, e := loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if message.Destination != "办公室" || message.Title != "呼叫 · 到 办公室" {
		t.Fatalf("destination/title=%q/%q", message.Destination, message.Title)
	}
	if strings.Contains(message.Title, message.Targets[0].Name) || strings.Contains(message.Title, "李明") {
		t.Fatalf("call title leaks student name: %q", message.Title)
	}
}

func TestDeleteClassSafetyAndPreviewCleanup(t *testing.T) {
	x := newTest(t)
	_, body := x.req("POST", "/admin/classes", x.token, obj{"name": "临时空班", "roomId": "1"}, 201)
	classID := body["data"].(map[string]any)["id"].(string)
	x.req("POST", "/admin/rosters/preview", x.token, obj{"classId": classID, "rows": []obj{{"studentNo": "9001", "name": "预览学生"}}}, 200)
	x.req("DELETE", "/admin/classes/"+classID, x.token, nil, 200)
	x.req("DELETE", "/admin/classes/"+classID, x.token, nil, 404)
	var previews int
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM roster_previews WHERE class_id=?", classID).Scan(&previews); e != nil || previews != 0 {
		t.Fatalf("preview cleanup count=%d err=%v", previews, e)
	}
	_, body = x.req("DELETE", "/admin/classes/1", x.token, nil, 409)
	if body["code"] != "CLASS_IN_USE" {
		t.Fatalf("class-in-use response=%#v", body)
	}
}

type testXLSXSheet struct {
	Name   string
	Target string
	XML    string
}

func xlsxText(value string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(value))
	return b.String()
}

func makeTestXLSX(t *testing.T, sheets []testXLSXSheet, shared []string) []byte {
	t.Helper()
	var body bytes.Buffer
	zw := zip.NewWriter(&body)
	write := func(name, content string) {
		w, e := zw.Create(name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = w.Write([]byte(content)); e != nil {
			t.Fatal(e)
		}
	}
	var workbook strings.Builder
	workbook.WriteString(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	var rels strings.Builder
	rels.WriteString(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i, sheet := range sheets {
		relID := fmt.Sprintf("rId%d", i+1)
		fmt.Fprintf(&workbook, `<sheet name="%s" sheetId="%d" r:id="%s"/>`, xlsxText(sheet.Name), i+1, relID)
		fmt.Fprintf(&rels, `<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="%s"/>`, relID, xlsxText(sheet.Target))
		write("xl/"+sheet.Target, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`+sheet.XML+`</sheetData></worksheet>`)
	}
	workbook.WriteString(`</sheets></workbook>`)
	rels.WriteString(`</Relationships>`)
	write("xl/workbook.xml", workbook.String())
	write("xl/_rels/workbook.xml.rels", rels.String())
	if shared != nil {
		var stringsXML strings.Builder
		stringsXML.WriteString(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
		for _, value := range shared {
			stringsXML.WriteString(`<si><t>` + xlsxText(value) + `</t></si>`)
		}
		stringsXML.WriteString(`</sst>`)
		write("xl/sharedStrings.xml", stringsXML.String())
	}
	if e := zw.Close(); e != nil {
		t.Fatal(e)
	}
	return body.Bytes()
}

func TestRosterXLSXHeadersWorksheetSparseCellsAndLeadingZeros(t *testing.T) {
	x := newTest(t)
	firstSheet := `<row r="1"><c r="C1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row><row r="2"><c r="C2"><v>00042</v></c><c r="D2" t="inlineStr"><is><t>甲</t></is></c></row>`
	notSelected := `<row r="1"><c r="A1" t="inlineStr"><is><t>wrong</t></is></c></row>`
	data := makeTestXLSX(t, []testXLSXSheet{
		{Name: "First", Target: "worksheets/sheet2.xml", XML: firstSheet},
		{Name: "Second", Target: "worksheets/sheet1.xml", XML: notSelected},
	}, []string{"学号", "姓名"})
	body := x.uploadXLSX("1", "中文表头.xlsx", data, 200)
	preview := body["data"].(map[string]any)
	if !preview["valid"].(bool) || preview["newCount"].(float64) != 1 {
		t.Fatalf("Chinese header preview=%#v", preview)
	}
	row := preview["rows"].([]any)[0].(map[string]any)
	if row["studentNo"] != "00042" || row["name"] != "甲" {
		t.Fatalf("sparse/leading-zero row=%#v", row)
	}

	englishSheet := `<row r="1"><c r="A1" t="inlineStr"><is><t>Student Number</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c></row><row r="2"><c r="A2"><v>00043</v></c><c r="B2" t="inlineStr"><is><t>乙</t></is></c></row>`
	english := makeTestXLSX(t, []testXLSXSheet{{Name: "Roster", Target: "worksheets/sheet1.xml", XML: englishSheet}}, nil)
	body = x.uploadXLSX("1", "english.xlsx", english, 200)
	preview = body["data"].(map[string]any)
	row = preview["rows"].([]any)[0].(map[string]any)
	if !preview["valid"].(bool) || row["studentNo"] != "00043" || row["name"] != "乙" {
		t.Fatalf("English header preview=%#v", preview)
	}
}

func TestRosterXLSXRejectsTooManyRowsAndOversizedFile(t *testing.T) {
	x := newTest(t)
	var sheet strings.Builder
	sheet.WriteString(`<row r="1"><c r="A1" t="inlineStr"><is><t>学号</t></is></c><c r="B1" t="inlineStr"><is><t>姓名</t></is></c></row>`)
	for i := 1; i <= 1001; i++ {
		fmt.Fprintf(&sheet, `<row r="%d"><c r="A%d"><v>%06d</v></c><c r="B%d" t="inlineStr"><is><t>学生%d</t></is></c></row>`, i+1, i+1, i, i+1, i)
	}
	data := makeTestXLSX(t, []testXLSXSheet{{Name: "Roster", Target: "worksheets/sheet1.xml", XML: sheet.String()}}, nil)
	x.uploadXLSX("1", "too-many.xlsx", data, 400)
	x.uploadXLSX("1", "too-large.xlsx", bytes.Repeat([]byte{'x'}, int(maxRosterXLSXSize)+1), 413)
}

func TestRosterXLSXDefaultsToColumnsABWithoutHeader(t *testing.T) {
	x := newTest(t)
	sheet := `<row r="1"><c r="A1"><v>00044</v></c><c r="B1" t="inlineStr"><is><t>丙</t></is></c></row>`
	data := makeTestXLSX(t, []testXLSXSheet{{Name: "Roster", Target: "worksheets/sheet1.xml", XML: sheet}}, nil)
	body := x.uploadXLSX("1", "default-columns.xlsx", data, 200)
	preview := body["data"].(map[string]any)
	row := preview["rows"].([]any)[0].(map[string]any)
	if row["studentNo"] != "00044" || row["name"] != "丙" {
		t.Fatalf("default columns row=%#v", row)
	}
}

func TestRosterXLSXFormulaCellsAreNotEvaluated(t *testing.T) {
	x := newTest(t)
	sheet := `<row r="1"><c r="A1" t="inlineStr"><is><t>学号</t></is></c><c r="B1" t="inlineStr"><is><t>姓名</t></is></c></row><row r="2"><c r="A2"><f>1+1</f><v>999</v></c><c r="B2" t="inlineStr"><is><t>公式行</t></is></c></row>`
	data := makeTestXLSX(t, []testXLSXSheet{{Name: "Roster", Target: "worksheets/sheet1.xml", XML: sheet}}, nil)
	body := x.uploadXLSX("1", "formula.xlsx", data, 200)
	preview := body["data"].(map[string]any)
	if preview["valid"].(bool) {
		t.Fatalf("formula row should remain invalid: %#v", preview)
	}
	row := preview["rows"].([]any)[0].(map[string]any)
	if row["studentNo"] != "" || row["name"] != "公式行" {
		t.Fatalf("formula cached value was used: %#v", row)
	}
}

func TestXLSXColumnParsing(t *testing.T) {
	for input, want := range map[string]int{"A1": 0, "Z99": 25, "AA7": 26, "XFD1048576": 16383} {
		got, e := xlsxColumn(input)
		if e != nil || got != want {
			t.Fatalf("xlsxColumn(%q)=%d,%v want %d", input, got, e, want)
		}
	}
	if _, e := xlsxColumn("1A"); e == nil {
		t.Fatal("invalid cell reference accepted")
	}
	if got := normalizeXLSXHeader("  STUDENT   NUMBER "); got != "student number" {
		t.Fatalf("normalized header=%q", got)
	}
}
