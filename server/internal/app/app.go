package app

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	_ "modernc.org/sqlite"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed schema.sql
var schema string

type Config struct {
	Mode          string
	DBPath        string
	BindSecret    string
	BootstrapCode string
	WXAppID       string
	WXAppSecret   string
	SyncEpoch     string
	Origins       []string
}
type App struct {
	db            *sql.DB
	mu            sync.Mutex
	cfg           Config
	epoch         string
	initialCursor int64
	wx            *wechatClient
	hubMu         sync.Mutex
	peers         map[string]*peer
	tickets       map[string]ticket
	rateMu        sync.Mutex
	rates         map[string][]time.Time
	cancel        context.CancelFunc
	done          chan struct{}
}
type endpoint func(http.ResponseWriter, *http.Request) error

func New(cfg Config) (*App, error) {
	if cfg.Mode != "demo" && cfg.Mode != "production" {
		return nil, errors.New("APP_MODE 必须显式设置为 demo 或 production")
	}
	if cfg.DBPath == "" {
		cfg.DBPath = "data/notice.db"
	}
	if cfg.Mode == "production" && (len(cfg.BindSecret) < 32 || cfg.WXAppID == "" || cfg.WXAppSecret == "" || len(cfg.BootstrapCode) < 16) {
		return nil, errors.New("生产模式需要 TOKEN_PEPPER(至少32字符)、WECHAT_APP_ID、WECHAT_APP_SECRET、BOOTSTRAP_CODE(至少16字符)")
	}
	if !strings.HasPrefix(cfg.DBPath, "file:") && cfg.DBPath != ":memory:" {
		if e := os.MkdirAll(filepath.Dir(cfg.DBPath), 0700); e != nil {
			return nil, e
		}
	}
	db, e := sql.Open("sqlite", cfg.DBPath)
	if e != nil {
		return nil, e
	}
	success := false
	defer func() {
		if !success {
			db.Close()
		}
	}()
	db.SetMaxOpenConns(1)
	// schema 只做 CREATE TABLE IF NOT EXISTS，不会改造已有表。
	// 旧版本（教室+班级两张表）的库直接跑会报列不存在，这里提前拦下并说明怎么处理。
	var dbVersion int
	if e = db.QueryRow("PRAGMA user_version").Scan(&dbVersion); e != nil {
		db.Close()
		return nil, e
	}
	if dbVersion != 0 && dbVersion != 3 {
		db.Close()
		return nil, fmt.Errorf("数据库结构版本为 %d，当前程序需要版本 3；请清空数据后重启：docker compose down -v && docker compose up -d", dbVersion)
	}
	for _, s := range []string{"PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000", schema} {
		if _, e = db.Exec(s); e != nil {
			db.Close()
			return nil, e
		}
	}
	a := &App{db: db, cfg: cfg, peers: map[string]*peer{}, tickets: map[string]ticket{}, rates: map[string][]time.Time{}, done: make(chan struct{})}
	a.wx = &wechatClient{appID: cfg.WXAppID, secret: cfg.WXAppSecret, http: &http.Client{Timeout: 8 * time.Second}, baseURL: "https://api.weixin.qq.com"}
	tx, e := db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT OR IGNORE INTO schools(id,name) VALUES(1,?)", "班级公告示范学校"); e != nil {
		return nil, e
	}
	a.epoch = uuid()
	_, e = tx.Exec("INSERT OR IGNORE INTO metadata(key,value) VALUES('sync_epoch',?)", a.epoch)
	if e != nil {
		return nil, e
	}
	if e = tx.QueryRow("SELECT value FROM metadata WHERE key='sync_epoch'").Scan(&a.epoch); e != nil {
		return nil, e
	}
	if cfg.SyncEpoch != "" {
		if !validUUID(cfg.SyncEpoch) {
			return nil, errors.New("SYNC_EPOCH 必须为UUID")
		}
		a.epoch = cfg.SyncEpoch
		if _, e = tx.Exec("UPDATE metadata SET value=? WHERE key='sync_epoch'", a.epoch); e != nil {
			return nil, e
		}
	}
	var existingMode string
	e = tx.QueryRow("SELECT value FROM metadata WHERE key='app_mode'").Scan(&existingMode)
	if e == nil && existingMode != cfg.Mode {
		return nil, errors.New("禁止混用演示与生产数据库，请选择独立 DATABASE_PATH")
	}
	if _, e = tx.Exec("INSERT OR IGNORE INTO metadata(key,value) VALUES('app_mode',?)", cfg.Mode); e != nil {
		return nil, e
	}
	if cfg.BindSecret == "" {
		var sec string
		e = tx.QueryRow("SELECT value FROM metadata WHERE key='demo_bind_secret'").Scan(&sec)
		if errors.Is(e, sql.ErrNoRows) {
			sec = randomToken("")
			_, e = tx.Exec("INSERT INTO metadata(key,value) VALUES('demo_bind_secret',?)", sec)
		}
		if e != nil {
			return nil, e
		}
		a.cfg.BindSecret = sec
	}
	if cfg.Mode == "demo" {
		for _, q := range []string{"INSERT OR IGNORE INTO classes(id,school_id,name) VALUES(1,1,'高三（2）班'),(2,1,'高三（5）班')", "INSERT OR IGNORE INTO teachers(id,openid,name,role,status) VALUES(1,'demo-admin','演示管理员','admin','active')", "INSERT OR IGNORE INTO teacher_classes VALUES(1,1),(1,2)", "INSERT OR IGNORE INTO students(id,class_id,student_no,name) VALUES(1,1,'00321','李明（示例）'),(2,1,'00322','王小雨（示例）'),(3,1,'00323','陈晨（示例）'),(4,2,'00501','张晓（示例）')"} {
			if _, e = tx.Exec(q); e != nil {
				return nil, e
			}
		}
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	if e = db.QueryRow("SELECT COALESCE(MAX(seq),0) FROM events").Scan(&a.initialCursor); e != nil {
		return nil, e
	}
	success = true
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	go a.dispatch(ctx)
	return a, nil
}
func (a *App) Close() error {
	a.cancel()
	<-a.done
	a.hubMu.Lock()
	for _, p := range a.peers {
		p.cancel()
	}
	a.hubMu.Unlock()
	return a.db.Close()
}
func (a *App) wrap(fn endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := uuid()
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		defer func() {
			if v := recover(); v != nil {
				slog.Error("request panic", "requestId", id)
				a.writeError(w, id, fail(500, "INTERNAL_ERROR", "服务发生错误"))
			}
		}()
		if e := fn(w, r); e != nil {
			a.writeError(w, id, e)
		}
	}
}
func (a *App) writeError(w http.ResponseWriter, id string, e error) {
	var ae *APIError
	if !errors.As(e, &ae) {
		slog.Error("request failed", "requestId", id, "errorType", fmt.Sprintf("%T", e))
		ae = &APIError{Status: 503, Code: "TEMPORARILY_UNAVAILABLE", Message: "服务暂不可用，请稍后重试"}
	}
	if ae.Status == 429 {
		w.Header().Set("Retry-After", "30")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(ae.Status)
	_, _ = w.Write([]byte(jsonText(obj{"code": ae.Code, "message": ae.Message, "errors": ae.Errors, "requestId": id})))
}
func ok(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(jsonText(obj{"code": 0, "message": "ok", "data": data, "requestId": w.Header().Get("X-Request-ID")})))
}
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	for p, f := range map[string]endpoint{
		"GET /healthz": a.health, "GET /readyz": a.health, "POST /api/v1/auth/demo-login": a.demoLogin, "POST /api/v1/auth/wx-login": a.wxLogin, "POST /api/v1/auth/logout": a.logout, "POST /api/v1/admin/setup": a.setup, "POST /api/v1/auth/activate-admin": a.setup, "GET /api/v1/me": a.me,
		"GET /api/v1/classes": a.classes, "GET /api/v1/classes/{id}/display-settings": a.getDisplaySettings, "PUT /api/v1/classes/{id}/display-settings": a.putDisplaySettings, "GET /api/v1/students": a.students, "POST /api/v1/messages": a.createMessage, "GET /api/v1/messages": a.listMessages, "GET /api/v1/messages/{id}": a.messageDetail, "GET /api/v1/messages/{id}/delivery": a.delivery, "POST /api/v1/messages/{id}/update": a.updateMessage, "POST /api/v1/messages/{id}/revoke": a.revokeMessage, "DELETE /api/v1/messages/{id}": a.revokeMessage, "POST /api/v1/messages/{id}/delete": a.revokeMessage, "POST /api/v1/messages/{id}/rebroadcast": a.rebroadcast,
		"POST /api/v1/devices/bind": a.bindDevice, "GET /api/v1/device/snapshot": a.snapshot, "POST /api/v1/device/heartbeat": a.heartbeat, "POST /api/v1/device/ws-ticket": a.wsTicket, "POST /api/v1/device/receipts": a.receipts, "GET /ws/device": a.websocket,
		"GET /api/v1/admin/teachers": a.adminTeachers, "GET /api/v1/admin/teacher-requests": a.adminTeachers, "PATCH /api/v1/admin/teachers/{id}": a.patchTeacher, "POST /api/v1/admin/teachers/{id}/update": a.patchTeacher, "POST /api/v1/admin/teachers/{id}/approve": a.approveTeacher, "PUT /api/v1/admin/teachers/{id}/classes": a.teacherClasses,
		"GET /api/v1/admin/classes": a.adminClasses, "POST /api/v1/admin/classes": a.addClass, "DELETE /api/v1/admin/classes/{id}": a.deleteClass, "PATCH /api/v1/admin/classes/{id}": a.patchClass, "POST /api/v1/admin/classes/{id}/update": a.patchClass, "POST /api/v1/admin/classes/{id}/bind-codes": a.bindCode,
		"GET /api/v1/admin/devices": a.adminDevices, "POST /api/v1/admin/devices/{id}/revoke": a.revokeDevice, "DELETE /api/v1/admin/devices/revoked": a.clearRevokedDevices, "POST /api/v1/admin/reset": a.resetData, "GET /api/v1/admin/settings": a.getSettings, "PUT /api/v1/admin/settings": a.putSettings, "POST /api/v1/admin/rosters/preview": a.rosterPreview, "POST /api/v1/admin/rosters/xlsx": a.rosterXLSX, "POST /api/v1/admin/rosters/commit": a.rosterCommit, "GET /api/v1/admin/messages": a.listMessages, "POST /api/v1/admin/messages/{id}/revoke": a.revokeMessage, "POST /api/v1/messages/{id}/cancel-broadcast": a.cancelBroadcast,
	} {
		mux.HandleFunc(p, a.wrap(f))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			allowed := false
			for _, v := range a.cfg.Origins {
				if origin == v {
					allowed = true
					break
				}
			}
			if !allowed {
				id := uuid()
				a.writeError(w, id, fail(403, "FORBIDDEN", "不允许此访问来源"))
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *App) health(w http.ResponseWriter, r *http.Request) error {
	if e := a.db.PingContext(r.Context()); e != nil {
		return e
	}
	ok(w, 200, obj{"mode": a.cfg.Mode, "version": "0.2.0", "ready": true})
	return nil
}
func (a *App) allow(key string, max int, d time.Duration) bool {
	a.rateMu.Lock()
	defer a.rateMu.Unlock()
	now := time.Now()
	old := a.rates[key]
	var kept []time.Time
	for _, t := range old {
		if now.Sub(t) < d {
			kept = append(kept, t)
		}
	}
	if len(kept) >= max {
		a.rates[key] = kept
		return false
	}
	a.rates[key] = append(kept, now)
	if len(a.rates) > 10000 {
		for k, v := range a.rates {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > 10*time.Minute {
				delete(a.rates, k)
			}
		}
	}
	return true
}
