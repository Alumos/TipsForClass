package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

func secureEqual(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

type wechatClient struct {
	appID, secret, baseURL string
	http                   *http.Client
	mu                     sync.Mutex
	token                  string
	expires                time.Time
}

func (c *wechatClient) call(ctx context.Context, path string, q url.Values, payload any, out any) error {
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		body = bytes.NewReader([]byte(jsonText(payload)))
	}
	method := http.MethodGet
	if payload != nil {
		method = http.MethodPost
	}
	req, e := http.NewRequestWithContext(ctx, method, c.baseURL+path+"?"+q.Encode(), body)
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := c.http.Do(req)
	if e != nil {
		return fail(503, "TEMPORARILY_UNAVAILABLE", "微信服务连接失败，请稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fail(503, "TEMPORARILY_UNAVAILABLE", "微信服务暂不可用")
	}
	if e = json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(out); e != nil {
		return fail(503, "TEMPORARILY_UNAVAILABLE", "微信响应无法解析")
	}
	return nil
}
func (c *wechatClient) login(ctx context.Context, code string) (string, error) {
	var res struct {
		OpenID  string `json:"openid"`
		ErrCode int    `json:"errcode"`
	}
	e := c.call(ctx, "/sns/jscode2session", url.Values{"appid": {c.appID}, "secret": {c.secret}, "js_code": {code}, "grant_type": {"authorization_code"}}, nil, &res)
	if e != nil {
		return "", e
	}
	if res.ErrCode != 0 || res.OpenID == "" {
		return "", fail(401, "AUTH_EXPIRED", "微信登录凭据失效，请重新登录")
	}
	return res.OpenID, nil
}
func (c *wechatClient) accessToken(ctx context.Context, refresh bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !refresh && c.token != "" && time.Now().Before(c.expires) {
		return c.token, nil
	}
	var res struct {
		Token   string `json:"access_token"`
		Expires int    `json:"expires_in"`
		ErrCode int    `json:"errcode"`
	}
	e := c.call(ctx, "/cgi-bin/token", url.Values{"grant_type": {"client_credential"}, "appid": {c.appID}, "secret": {c.secret}}, nil, &res)
	if e != nil {
		return "", e
	}
	if res.ErrCode != 0 || res.Token == "" || res.Expires <= 0 {
		return "", fail(503, "TEMPORARILY_UNAVAILABLE", "微信审核凭据获取失败")
	}
	c.token = res.Token
	c.expires = time.Now().Add(time.Duration(res.Expires)*time.Second - time.Minute)
	return c.token, nil
}
func (a *App) moderate(ctx context.Context, t Teacher, m Message) error {
	if a.cfg.Mode == "demo" {
		return nil
	}
	content := m.Title + "\n" + m.Body + "\n" + m.SpeechText
	for _, v := range m.Targets {
		content += "\n" + v.Name
	}
	for attempt := 0; attempt < 2; attempt++ {
		token, e := a.wx.accessToken(ctx, false)
		if e != nil {
			return e
		}
		var res struct {
			ErrCode int `json:"errcode"`
			Result  *struct {
				Suggest string `json:"suggest"`
				Label   int    `json:"label"`
			} `json:"result"`
		}
		e = a.wx.call(ctx, "/wxa/msg_sec_check", url.Values{"access_token": {token}}, obj{"version": 2, "scene": 2, "openid": t.OpenID, "content": content}, &res)
		if e != nil {
			return e
		}
		if attempt == 0 && (res.ErrCode == 40001 || res.ErrCode == 40014 || res.ErrCode == 42001) {
			a.wx.mu.Lock()
			if a.wx.token == token {
				a.wx.expires = time.Time{}
			}
			a.wx.mu.Unlock()
			continue
		}
		if res.ErrCode == 87014 {
			return fail(422, "CONTENT_REJECTED", "内容未通过审核，请修改公告内容")
		}
		if res.ErrCode != 0 || res.Result == nil {
			return fail(503, "TEMPORARILY_UNAVAILABLE", "内容检测暂不可用，公告尚未发布")
		}
		if res.Result.Suggest != "pass" {
			return fail(422, "CONTENT_REJECTED", "内容需要修改后再发布")
		}
		return nil
	}
	return fail(503, "TEMPORARILY_UNAVAILABLE", "内容检测凭据失效")
}
func (a *App) bindHash(s string) string {
	h := hmac.New(sha256.New, []byte(a.cfg.BindSecret))
	_, _ = fmt.Fprint(h, s)
	return fmt.Sprintf("%x", h.Sum(nil))
}
