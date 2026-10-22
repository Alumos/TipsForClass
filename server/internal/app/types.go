package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type obj = map[string]any

type Target struct {
	StudentID       string `json:"studentId"`
	Name            string `json:"name"`
	ClassName       string `json:"className"`
	StudentNoSuffix string `json:"studentNoSuffix"`
}
type Broadcast struct {
	Generation int    `json:"generation"`
	Times      int    `json:"times"`
	NotBefore  string `json:"notBefore"`
	DeadlineAt string `json:"deadlineAt"`
}
type Message struct {
	ID              string     `json:"id"`
	Revision        int        `json:"revision"`
	Type            string     `json:"type"`
	Title           string     `json:"title"`
	Body            string     `json:"body"`
	Destination     string     `json:"destination,omitempty"`
	DisplayPosition string     `json:"displayPosition"`
	Targets         []Target   `json:"targets"`
	RoomIDs         []string   `json:"roomIds"`
	TeacherName     string     `json:"teacherName"`
	SpeechText      string     `json:"speechText"`
	Priority        int        `json:"priority"`
	StartAt         string     `json:"startAt"`
	ExpireAt        string     `json:"expireAt"`
	CreatedAt       string     `json:"createdAt"`
	Status          string     `json:"status"`
	Broadcast       *Broadcast `json:"broadcast"`
}

// UnmarshalJSON keeps messages written before displayPosition was introduced
// compatible with the current message contract.
func (m *Message) UnmarshalJSON(data []byte) error {
	type messageAlias Message
	var decoded messageAlias
	if e := json.Unmarshal(data, &decoded); e != nil {
		return e
	}
	*m = Message(decoded)
	if m.DisplayPosition != "center" {
		m.DisplayPosition = "top_right"
	}
	return nil
}

type QuietHour struct {
	Days  []int  `json:"days"`
	Start string `json:"start"`
	End   string `json:"end"`
}
type Settings struct {
	SchoolName     string      `json:"schoolName"`
	Timezone       string      `json:"timezone"`
	QuietHours     []QuietHour `json:"quietHours"`
	ConfigRevision int         `json:"configRevision"`
}
type DisplaySettings struct {
	DisplayPosition  string   `json:"displayPosition"`
	PinnedMessageIDs []string `json:"pinnedMessageIds"`
	Revision         int      `json:"revision"`
}
type Teacher struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Role    string   `json:"role"`
	Status  string   `json:"status"`
	OpenID  string   `json:"-"`
	RoomIDs []string `json:"roomIds"`
}
type Device struct {
	ID        string
	RoomID    string
	Label     string
	ExpiresAt int64
}
type APIError struct {
	Status  int
	Code    string
	Message string
	Errors  map[string]string
}

func (e *APIError) Error() string { return e.Message }
func bad(field, msg string) error {
	return &APIError{400, "VALIDATION_ERROR", msg, map[string]string{field: msg}}
}
func fail(status int, code, msg string) error {
	return &APIError{Status: status, Code: code, Message: msg}
}
func sid(i int64) string       { return strconv.FormatInt(i, 10) }
func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func msstamp(i int64) string   { return stamp(time.UnixMilli(i)) }
func randomToken(prefix string) string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return prefix + hex.EncodeToString(b)
}
func uuid() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func hash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func jsonText(v any) string {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return string(b)
}
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	limit := int64(64 << 10)
	if strings.HasSuffix(r.URL.Path, "/rosters/preview") {
		limit = 2 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return bad("request", "请求 JSON 格式不正确或包含不支持字段")
	}
	var extra any
	if e := d.Decode(&extra); !errors.Is(e, io.EOF) {
		return bad("request", "请求只能包含一个 JSON 对象且不能有尾随内容")
	}
	return nil
}
func validID(s string) bool {
	n, e := strconv.ParseInt(s, 10, 64)
	return e == nil && n > 0 && sid(n) == s
}
func validUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}
func count(s string) int { return len([]rune(s)) }
