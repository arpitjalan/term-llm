package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/samsaffron/term-llm/internal/hub"
)

func testHubConnectionRequest(t *testing.T, s *hubServer, url, token string) hub.Status {
	t.Helper()
	body, err := json.Marshal(addNodeRequest{URL: url, Token: token})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/nodes/test", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("connection test status = %d: %s", w.Code, w.Body.String())
	}
	if token != "" && strings.Contains(w.Body.String(), token) {
		t.Fatal("connection test exposed the submitted bearer token")
	}
	var result struct {
		Status hub.Status `json:"status"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Status
}

func TestHubConnectionTestVerifiesAssistantAccess(t *testing.T) {
	for _, tc := range []struct {
		name, token string
		requireAuth bool
		wantAccess  bool
	}{
		{name: "correct bearer", token: "node-private-token", requireAuth: true, wantAccess: true},
		{name: "wrong bearer", token: "incorrect-private-token", requireAuth: true},
		{name: "missing bearer", requireAuth: true},
		{name: "no auth", wantAccess: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var healthCalls, accessCalls atomic.Int32
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/chat/healthz":
					healthCalls.Add(1)
					_, _ = io.WriteString(w, `{"status":"ok"}`)
				case "/chat/v1/capabilities":
					accessCalls.Add(1)
					if healthCalls.Load() != 1 {
						t.Error("API access checked before public health")
					}
					if tc.requireAuth && r.Header.Get("Authorization") != "Bearer node-private-token" {
						w.WriteHeader(http.StatusUnauthorized)
						_, _ = io.WriteString(w, "private upstream response: "+tc.token)
						return
					}
					_, _ = io.WriteString(w, `{"jobs":{"enabled":true}}`)
				default:
					t.Errorf("unexpected backend path: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer backend.Close()
			path := filepath.Join(t.TempDir(), "nodes.json")
			store := hub.NewStore(path)
			s := newHubServer(hub.NewRegistry(store), store)
			status := testHubConnectionRequest(t, s, backend.URL+"/chat", tc.token)
			if status.Reachable != tc.wantAccess {
				t.Fatalf("reachable = %v, want %v: %+v", status.Reachable, tc.wantAccess, status)
			}
			if !tc.wantAccess && (status.State != "error 401" || !strings.Contains(status.Error, "bearer token")) {
				t.Fatalf("authentication failure was not explained: %+v", status)
			}
			if strings.Contains(status.Error, "private upstream response") || healthCalls.Load() != 1 || accessCalls.Load() != 1 {
				t.Fatalf("unexpected checks or leaked backend body: status=%+v health=%d access=%d", status, healthCalls.Load(), accessCalls.Load())
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("connection test persisted a node: %v", err)
			}
		})
	}
}

func TestHubConnectionTestDoesNotFollowAPIRedirects(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		if r.Header.Get("Authorization") != "" {
			t.Error("redirect leaked the node bearer token")
		}
	}))
	defer target.Close()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/healthz" {
			_, _ = io.WriteString(w, `{"status":"ok"}`)
			return
		}
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer backend.Close()
	s := newHubServer(hub.NewRegistry(), nil)
	status := testHubConnectionRequest(t, s, backend.URL+"/chat", "redirect-private-token")
	if status.Reachable || status.State != "error 302" || redirected.Load() != 0 {
		t.Fatalf("API redirect was not rejected: status=%+v target calls=%d", status, redirected.Load())
	}
}

func TestHubConnectionTestSkipsAPIAfterHealthFailure(t *testing.T) {
	var accessCalls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/healthz" {
			accessCalls.Add(1)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer backend.Close()
	s := newHubServer(hub.NewRegistry(), nil)
	status := testHubConnectionRequest(t, s, backend.URL+"/chat", "")
	if status.Reachable || status.State != "error 503" || accessCalls.Load() != 0 {
		t.Fatalf("API checked after public health failed: status=%+v API calls=%d", status, accessCalls.Load())
	}
}
