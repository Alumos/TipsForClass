package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testAPI struct {
	a     *App
	h     http.Handler
	t     *testing.T
	token string
}

func newTest(t *testing.T) *testAPI {
	t.Helper()
	a, e := New(Config{Mode: "demo", DBPath: filepath.Join(t.TempDir(), "test.db")})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = a.Close() })
	x := &testAPI{a: a, h: a.Handler(), t: t}
	_, body := x.req("POST", "/auth/demo-login", "", obj{}, 200)
	x.token = body["data"].(map[string]any)["token"].(string)
	return x
}
func (x *testAPI) req(method, path, token string, payload any, want int) (int, obj) {
	x.t.Helper()
	var raw []byte
	if payload != nil {
		raw = []byte(jsonText(payload))
	}
	r := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(raw))
	r.RemoteAddr = "127.0.0.1:10001"
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	x.h.ServeHTTP(w, r)
	var body obj
	if e := json.Unmarshal(w.Body.Bytes(), &body); e != nil {
		x.t.Fatalf("decode %s: %v body=%s", path, e, w.Body.String())
	}
	if w.Code != want {
		x.t.Errorf("%s %s: got %d want %d; %s", method, path, w.Code, want, w.Body.String())
	}
	return w.Code, body
}
func (x *testAPI) bind(room, install string) string {
	x.t.Helper()
	_, b := x.req("POST", "/admin/rooms/"+room+"/bind-codes", x.token, obj{}, 201)
	code := b["data"].(map[string]any)["bindCode"]
	_, b = x.req("POST", "/devices/bind", "", obj{"bindCode": code, "installationId": install, "label": "测试大屏"}, 200)
	return b["data"].(map[string]any)["deviceToken"].(string)
}
func createPayload(token string) obj {
	return obj{"clientToken": token, "type": "call", "roomIds": []string{"1"}, "studentIds": []string{"1"}, "destination": "办公室", "body": "请带作业", "broadcastTimes": 2, "expireAt": stamp(time.Now().Add(time.Hour))}
}
func TestConcurrentCreateIdempotencyAndRollback(t *testing.T) {
	x := newTest(t)
	x.bind("1", "test-device-idem")
	p := createPayload(uuid())
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("POST", "/api/v1/messages", strings.NewReader(jsonText(p)))
			r.Header.Set("Authorization", "Bearer "+x.token)
			w := httptest.NewRecorder()
			x.h.ServeHTTP(w, r)
			if w.Code != 200 && w.Code != 201 {
				t.Errorf("create status=%d %s", w.Code, w.Body.String())
				return
			}
			var body struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			ids <- body.Data.ID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for v := range ids {
		if id != "" && v != id {
			t.Errorf("different IDs %s vs %s", id, v)
		}
		id = v
	}
	var n int
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&n); e != nil || n != 1 {
		t.Fatalf("messages=%d err=%v", n, e)
	}
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM events").Scan(&n); e != nil || n != 1 {
		t.Fatalf("events=%d err=%v", n, e)
	}
	p["body"] = "不同正文"
	x.req("POST", "/messages", x.token, p, 409)
	p = createPayload(uuid())
	p["studentIds"] = []string{"4"}
	x.req("POST", "/messages", x.token, p, 400)
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&n); e != nil || n != 1 {
		t.Fatalf("invalid student transaction persisted")
	}
}
func TestDeviceReceiptsAreIndependentAndScoped(t *testing.T) {
	x := newTest(t)
	d1 := x.bind("1", "test-device-room1")
	d2 := x.bind("2", "test-device-room2")
	_, b := x.req("POST", "/messages", x.token, createPayload(uuid()), 201)
	id := b["data"].(map[string]any)["id"].(string)
	receipt := obj{"syncEpoch": x.a.epoch, "items": []obj{{"messageId": id, "kind": "delivery", "state": "received", "revision": 1}}}
	x.req("POST", "/device/receipts", d2, receipt, 403)
	x.req("POST", "/device/receipts", d1, receipt, 200)
	x.req("POST", "/device/receipts", d1, receipt, 200)
	_, b = x.req("GET", "/messages/"+id+"/delivery", x.token, nil, 200)
	if b["data"].(map[string]any)["displayedDeviceCount"].(float64) != 0 {
		t.Fatal("received was treated as displayed")
	}
	receipt["items"] = []obj{{"messageId": id, "kind": "delivery", "state": "displayed", "revision": 1}, {"messageId": id, "kind": "broadcast", "generation": 0, "round": 1, "status": "skipped", "reason": "device_muted"}}
	x.req("POST", "/device/receipts", d1, receipt, 200)
	_, b = x.req("GET", "/messages/"+id+"/delivery", x.token, nil, 200)
	data := b["data"].(map[string]any)
	if data["displayedDeviceCount"].(float64) != 1 {
		t.Fatal("displayed missing")
	}
	device := data["devices"].([]any)[0].(map[string]any)
	if device["playedRounds"].(float64) != 0 {
		t.Fatal("muted round falsely played")
	}
	receipt["items"] = []obj{{"messageId": id, "kind": "broadcast", "generation": 99, "round": 1, "status": "played"}}
	x.req("POST", "/device/receipts", d1, receipt, 400)
	receipt["syncEpoch"] = uuid()
	x.req("POST", "/device/receipts", d1, receipt, 409)
}
func TestBindingCodeConsumedAtomically(t *testing.T) {
	x := newTest(t)
	_, b := x.req("POST", "/admin/rooms/1/bind-codes", x.token, obj{}, 201)
	code := b["data"].(map[string]any)["bindCode"]
	var success atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := httptest.NewRequest("POST", "/api/v1/devices/bind", strings.NewReader(jsonText(obj{"bindCode": code, "installationId": fmt.Sprintf("concurrent-device-%d", i), "label": "并发测试"})))
			r.RemoteAddr = fmt.Sprintf("127.0.0.%d:1000", i+1)
			w := httptest.NewRecorder()
			x.h.ServeHTTP(w, r)
			if w.Code == 200 {
				success.Add(1)
			} else if w.Code != 400 {
				t.Errorf("unexpected code %d", w.Code)
			}
		}(i)
	}
	wg.Wait()
	if success.Load() != 1 {
		t.Fatalf("binding successes=%d", success.Load())
	}
}
func TestSnapshotWatermarkPersistsAfterEventCleanup(t *testing.T) {
	x := newTest(t)
	d := x.bind("1", "snapshot-device")
	_, b := x.req("POST", "/messages", x.token, createPayload(uuid()), 201)
	id := b["data"].(map[string]any)["id"].(string)
	_, b = x.req("POST", "/messages/"+id+"/revoke", x.token, obj{}, 200)
	if _, e := x.a.db.Exec("DELETE FROM events"); e != nil {
		t.Fatal(e)
	}
	_, b = x.req("GET", "/device/snapshot", d, nil, 200)
	data := b["data"].(map[string]any)
	if data["watermark"] != "2" {
		t.Fatalf("watermark moved backwards: %v", data["watermark"])
	}
	if len(data["messages"].([]any)) != 0 {
		t.Fatal("revoked message reappeared")
	}
}
func TestRebroadcastGenerationQuietHoursAndPermissions(t *testing.T) {
	x := newTest(t)
	x.bind("1", "rebroadcast-device")
	_, b := x.req("POST", "/messages", x.token, createPayload(uuid()), 201)
	id := b["data"].(map[string]any)["id"].(string)
	token := uuid()
	_, b = x.req("POST", "/messages/"+id+"/rebroadcast", x.token, obj{"clientToken": token, "times": 1}, 200)
	if b["data"].(map[string]any)["generation"].(float64) != 1 {
		t.Fatal("new generation missing")
	}
	x.req("POST", "/messages/"+id+"/rebroadcast", x.token, obj{"clientToken": token, "times": 1}, 200)
	m, _, e := loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	start, _ := time.Parse(time.RFC3339Nano, m.Broadcast.NotBefore)
	end, _ := time.Parse(time.RFC3339Nano, m.Broadcast.DeadlineAt)
	if end.Sub(start) != 2*time.Minute {
		t.Fatalf("replay window %s", end.Sub(start))
	}
	x.req("POST", "/messages/"+id+"/rebroadcast", x.token, obj{"clientToken": uuid(), "times": 2}, 429)
	var jobs int
	_ = x.a.db.QueryRow("SELECT COUNT(*) FROM broadcast_jobs WHERE message_id=?", id).Scan(&jobs)
	if jobs != 2 {
		t.Fatalf("unexpected jobs=%d", jobs)
	}
	loc, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Now().In(loc)
	day := int(now.Weekday())
	if day == 0 {
		day = 7
	}
	s := Settings{Timezone: "Asia/Shanghai", QuietHours: []QuietHour{{Days: []int{day}, Start: "00:00", End: "23:59"}}}
	if now.Format("15:04") != "23:59" && !quietNow(s, time.Now()) {
		t.Fatal("quiet hours not respected")
	}
}
func TestTeacherScopeAndLastAdmin(t *testing.T) {
	x := newTest(t)
	x.bind("1", "permissions-device")
	_, b := x.req("POST", "/messages", x.token, createPayload(uuid()), 201)
	id := b["data"].(map[string]any)["id"].(string)
	_, e := x.a.db.Exec("INSERT INTO teachers(id,openid,name,role,status) VALUES(2,'another','另一位教师','teacher','active')")
	if e != nil {
		t.Fatal(e)
	}
	_, e = x.a.db.Exec("INSERT INTO teacher_rooms VALUES(2,2)")
	if e != nil {
		t.Fatal(e)
	}
	token := randomToken("t_")
	_, e = x.a.db.Exec("INSERT INTO teacher_sessions VALUES(?,?,?)", x.a.tokenHash(token), "2", time.Now().Add(time.Hour).UnixMilli())
	if e != nil {
		t.Fatal(e)
	}
	x.req("GET", "/messages/"+id, token, nil, 404)
	x.req("POST", "/messages/"+id+"/revoke", token, obj{}, 404)
	x.req("GET", "/students?classId=1", token, nil, 403)
	x.req("GET", "/admin/teachers", token, nil, 403)
	x.req("PATCH", "/admin/teachers/1", x.token, obj{"status": "disabled"}, 400)
	x.req("PATCH", "/admin/teachers/1", x.token, obj{"role": "teacher"}, 400)
}
func TestRosterPreviewPreservesZerosAndRefusesDuplicates(t *testing.T) {
	x := newTest(t)
	_, b := x.req("POST", "/admin/rosters/preview", x.token, obj{"classId": "1", "rows": []obj{{"studentNo": "00001", "name": "甲"}, {"studentNo": "00001", "name": "乙"}}}, 200)
	data := b["data"].(map[string]any)
	if data["valid"].(bool) {
		t.Fatal("duplicate roster marked valid")
	}
	x.req("POST", "/admin/rosters/commit", x.token, obj{"importId": data["importId"]}, 400)
	_, b = x.req("POST", "/admin/rosters/preview", x.token, obj{"classId": "1", "rows": []obj{{"studentNo": "00001", "name": "甲"}}}, 200)
	data = b["data"].(map[string]any)
	x.req("POST", "/admin/rosters/commit", x.token, obj{"importId": data["importId"]}, 200)
	x.req("POST", "/admin/rosters/commit", x.token, obj{"importId": data["importId"]}, 200)
	var no string
	if e := x.a.db.QueryRow("SELECT student_no FROM students WHERE name='甲'").Scan(&no); e != nil || no != "00001" {
		t.Fatalf("studentNo=%q err=%v", no, e)
	}
}
func TestMalformedTrailingJSONAndBatchSummary(t *testing.T) {
	x := newTest(t)
	r := httptest.NewRequest("POST", "/api/v1/messages", strings.NewReader("{} garbage"))
	r.Header.Set("Authorization", "Bearer "+x.token)
	w := httptest.NewRecorder()
	x.h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("trailing garbage accepted: %d", w.Code)
	}
	x.bind("1", "batch-summary-device")
	p := createPayload(uuid())
	p["type"] = "batch"
	p["studentIds"] = []string{"1", "2", "3"}
	_, b := x.req("POST", "/messages", x.token, p, 201)
	id := b["data"].(map[string]any)["id"].(string)
	m, _, e := loadMessage(x.a.db, id)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(m.SpeechText, "李明") || !strings.Contains(m.SpeechText, "3位同学") {
		t.Fatalf("batch must use summary: %s", m.SpeechText)
	}
	if len(m.Targets) != 3 {
		t.Fatal("full target roster missing")
	}
}
func TestProductionConfigurationIsolationAndContentFailClosed(t *testing.T) {
	if a, e := New(Config{Mode: "production", DBPath: filepath.Join(t.TempDir(), "prod.db")}); e == nil {
		a.Close()
		t.Fatal("production accepted missing secrets")
	}
	cfg := Config{Mode: "production", DBPath: filepath.Join(t.TempDir(), "prod.db"), BindSecret: strings.Repeat("p", 32), WXAppID: "app-id", WXAppSecret: "app-secret", BootstrapCode: strings.Repeat("b", 16)}
	a, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	r := httptest.NewRequest("POST", "/api/v1/auth/demo-login", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("production demo route: %d", w.Code)
	}
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cgi-bin/token":
			_, _ = w.Write([]byte(`{"access_token":"test-token","expires_in":7200}`))
		case "/wxa/msg_sec_check":
			_, _ = w.Write([]byte(`{"errcode":0,"result":{"suggest":"review","label":0}}`))
		}
	}))
	defer fake.Close()
	a.wx.baseURL = fake.URL
	if e = a.moderate(context.Background(), Teacher{OpenID: "openid"}, Message{Title: "测试"}); e == nil {
		t.Fatal("review conclusion incorrectly allowed")
	}
	fake.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"errcode":0}`)) })
	if e = a.moderate(context.Background(), Teacher{OpenID: "openid"}, Message{Title: "测试"}); e == nil {
		t.Fatal("missing conclusion incorrectly allowed")
	}
}
func TestQuietHoursBoundary(t *testing.T) {
	s := Settings{Timezone: "Asia/Shanghai", QuietHours: []QuietHour{{Days: []int{1}, Start: "08:00", End: "08:45"}}}
	for _, v := range []struct {
		at   string
		want bool
	}{{"2026-10-26T07:59:59+08:00", false}, {"2026-10-26T08:00:00+08:00", true}, {"2026-10-26T08:44:59+08:00", true}, {"2026-10-26T08:45:00+08:00", false}, {"2026-10-27T08:15:00+08:00", false}} {
		at, _ := time.Parse(time.RFC3339, v.at)
		if got := quietNow(s, at); got != v.want {
			t.Errorf("%s=%v want %v", v.at, got, v.want)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func jsonResponse(s string) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(s))}
}
func TestPermissionRecheckedAfterModeration(t *testing.T) {
	x := newTest(t)
	x.bind("1", "permission-race-device")
	x.a.cfg.Mode = "production"
	x.a.wx.http = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/cgi-bin/token" {
			return jsonResponse(`{"access_token":"test-token","expires_in":7200}`), nil
		}
		if _, e := x.a.db.Exec("UPDATE teachers SET status='disabled' WHERE id=1"); e != nil {
			t.Error(e)
		}
		return jsonResponse(`{"errcode":0,"result":{"suggest":"pass"}}`), nil
	})}
	x.req("POST", "/messages", x.token, createPayload(uuid()), 403)
	var count int
	if e := x.a.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count); e != nil || count != 0 {
		t.Fatalf("unauthorized message persisted count=%d err=%v", count, e)
	}
}
func TestModerationRefreshesInvalidTokenOnceAndSingleFlight(t *testing.T) {
	var tokens, checks atomic.Int32
	wx := &wechatClient{appID: "id", secret: "secret", baseURL: "https://api.weixin.qq.com"}
	wx.http = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/cgi-bin/token" {
			n := tokens.Add(1)
			return jsonResponse(fmt.Sprintf(`{"access_token":"token-%d","expires_in":7200}`, n)), nil
		}
		checks.Add(1)
		if r.URL.Query().Get("access_token") == "token-1" {
			return jsonResponse(`{"errcode":40014}`), nil
		}
		return jsonResponse(`{"errcode":0,"result":{"suggest":"pass"}}`), nil
	})}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := wx.accessToken(context.Background(), false); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if tokens.Load() != 1 {
		t.Fatalf("token fetch was not merged: %d", tokens.Load())
	}
	a := &App{cfg: Config{Mode: "production"}, wx: wx}
	if e := a.moderate(context.Background(), Teacher{OpenID: "openid"}, Message{Title: "测试公告"}); e != nil {
		t.Fatal(e)
	}
	if tokens.Load() != 2 || checks.Load() != 2 {
		t.Fatalf("token refresh count=%d audit retries=%d", tokens.Load(), checks.Load())
	}
}
