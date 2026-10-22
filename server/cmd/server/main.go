package main

import (
	"classroom-notice/server/internal/app"
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	origins := os.Getenv("ALLOWED_ORIGINS")
	if origins == "" {
		origins = "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173"
	}
	mode := os.Getenv("APP_MODE")
	if mode == "" {
		mode = "production"
	}
	a, e := app.New(app.Config{Mode: mode, DBPath: os.Getenv("DATABASE_PATH"), BindSecret: os.Getenv("TOKEN_PEPPER"), BootstrapCode: os.Getenv("BOOTSTRAP_CODE"), WXAppID: os.Getenv("WECHAT_APP_ID"), WXAppSecret: os.Getenv("WECHAT_APP_SECRET"), SyncEpoch: os.Getenv("SYNC_EPOCH"), Origins: strings.Split(origins, ",")})
	if e != nil {
		slog.Error("startup failed", "error", e)
		os.Exit(1)
	}
	defer a.Close()
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	s := &http.Server{Addr: addr, Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Shutdown(c)
	}()
	slog.Info("classroom notice API ready", "address", addr, "mode", mode)
	if e = s.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		slog.Error("server stopped", "error", e)
		os.Exit(1)
	}
}
