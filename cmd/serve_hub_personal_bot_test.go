package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/samsaffron/term-llm/internal/contain"
	"github.com/samsaffron/term-llm/internal/hub"
	"github.com/samsaffron/term-llm/internal/serveui"
)

func TestHubPersonalBotAssetsAreOptInAndAuthenticated(t *testing.T) {
	s := newHubServer(hub.NewRegistry(), nil)
	s.requireAuth, s.token, s.basePath = true, "operator-secret", "/company/bot"
	for _, asset := range []string{"personal-bot.js", "personal-bot.css"} {
		path := "/company/bot/dist/" + asset
		r := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s: %d", asset, w.Code)
		}
		r.Header.Set("Authorization", "Bearer operator-secret")
		w = httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatalf("disabled %s: %d", asset, w.Code)
		}
		s.assistantManager = &contain.Manager{}
		for _, version := range []string{"", "wrong", serveui.PersonalBotAssetVersion()} {
			r = httptest.NewRequest(http.MethodGet, path+"?v="+version, nil)
			r.Header.Set("Authorization", "Bearer operator-secret")
			w = httptest.NewRecorder()
			s.handler().ServeHTTP(w, r)
			if w.Code != http.StatusOK || w.Body.Len() == 0 {
				t.Fatalf("enabled %s: %d %s", asset, w.Code, w.Body.String())
			}
			want := "no-cache"
			if version == serveui.PersonalBotAssetVersion() {
				want = "public, max-age=31536000, immutable"
			}
			if w.Header().Get("Cache-Control") != want || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("incorrect asset headers: %v", w.Header())
			}
		}
		s.assistantManager = nil
	}
	s.assistantManager = &contain.Manager{}
	r := httptest.NewRequest(http.MethodGet, "/company/bot/", nil)
	r.Header.Set("Authorization", "Bearer operator-secret")
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), "/company/bot/dist/personal-bot.js?v=") || strings.Contains(w.Body.String(), "/dist/hub.js?v=") {
		t.Fatal("Personal Bot dashboard did not select its independent entry")
	}
}

func TestHubAssistantReadyRequiresReachableContainRoute(t *testing.T) {
	var probes atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes.Add(1)
		if r.Header.Get("Authorization") != "Bearer worker-private" || r.URL.Path != "/chat/healthz" {
			t.Errorf("unexpected probe: %s %s", r.URL.Path, r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer backend.Close()
	s := newHubServer(hub.NewRegistry(fakeHubResolver{nodes: []hub.Node{
		{ID: "ready", Source: hub.SourceContain, URL: backend.URL, BasePath: "/chat", Token: "worker-private"},
		{ID: "collision", Source: hub.SourceLocal, URL: backend.URL, BasePath: "/chat", Token: "worker-private"},
	}}), nil)
	s.basePath = "/company/bot"
	views := s.assistantViews(context.Background(), []contain.ManagedAssistant{
		{Name: "ready", NodeID: "ready", State: "running"},
		{Name: "stopped", NodeID: "stopped", State: "stopped"},
		{Name: "collision", NodeID: "collision", State: "running"},
	})
	if !views[0].Ready || views[0].UIURL != "/company/bot/node/ready/" {
		t.Fatalf("ready assistant = %+v", views[0])
	}
	if views[1].Ready || views[2].Ready || views[2].Error == "" || probes.Load() != 1 {
		t.Fatalf("unsafe readiness: %+v, probes=%d", views, probes.Load())
	}
	data, _ := json.Marshal(views)
	if strings.Contains(string(data), "worker-private") {
		t.Fatal("worker token leaked into management response")
	}
}

func TestHubAssistantManagementOptIn(t *testing.T) {
	s := newHubServer(hub.NewRegistry(), nil)
	for _, path := range []string{"/api/assistants", "/api/assistants/environment", "/api/assistants/any/connection"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, w.Code)
		}
	}
	for _, enabled := range []bool{false, true} {
		if enabled {
			s.assistantManager = &contain.Manager{}
		}
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
		body := w.Body.String()
		if got := strings.Contains(body, "personalBot&#34;:true") || strings.Contains(body, "personalBot&quot;:true"); got != enabled {
			t.Errorf("personalBot shell config present = %v, want %v: %s", got, enabled, body)
		}
	}
}

func TestHubAssistantManagementRequiresOperator(t *testing.T) {
	s := newHubServer(hub.NewRegistry(), nil)
	s.assistantManager = &contain.Manager{}
	s.requireAuth, s.token = true, "operator-secret"
	for _, path := range []string{"/api/assistants", "/api/assistants/demo/start", "/api/assistants/demo/connection", "/api/assistants/demo/connection/chatgpt/start"} {
		for _, nodeHeader := range []string{"", "demo"} {
			r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer node-secret")
			r.Header.Set(hubNodeIDHeader, nodeHeader)
			w := httptest.NewRecorder()
			s.handler().ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s with node header %q: status = %d, want 401", path, nodeHeader, w.Code)
			}
		}
	}
}

func TestHubAssistantManagementRejectsCrossOriginAndInvalidJSON(t *testing.T) {
	s := newHubServer(hub.NewRegistry(), nil)
	s.assistantManager = &contain.Manager{}
	s.requireAuth, s.token = true, "operator-secret"
	s.basePath = "/company/bot"
	cases := []struct {
		name, contentType, origin, site, body string
		want                                  int
	}{
		{"cross origin", "application/json", "https://other.example", "", `{}`, 403},
		{"same site", "application/json", "", "same-site", `{}`, 403},
		{"cross site", "application/json", "", "cross-site", `{}`, 403},
		{"form", "application/x-www-form-urlencoded", "", "", `{}`, 403},
		{"almost JSON", "application/json-evil", "", "", `{}`, 403},
		{"unknown key", "application/json", "", "", `{"secret":"do-not-echo"}`, 400},
		{"two objects", "application/json", "", "", `{} {}`, 400},
		{"null", "application/json", "", "", `null`, 400},
		{"array", "application/json", "", "", `[]`, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://hub.example/company/bot/api/assistants", strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer operator-secret")
			r.Header.Set("Content-Type", tc.contentType)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			w := httptest.NewRecorder()
			s.handler().ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "do-not-echo") {
				t.Fatal("request secret reflected in error")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("management response can be cached")
			}
		})
	}
}

func TestDecodeAssistantRequestBoundsAndFields(t *testing.T) {
	for _, body := range []string{`{"name":"demo","purpose":"Useful assistant"}`, " \n{\"name\":\"demo\"} \n"} {
		var request contain.CreateAssistantRequest
		w := httptest.NewRecorder()
		if !decodeAssistantRequest(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)), &request) || request.Name != "demo" {
			t.Fatalf("valid body rejected: %s", w.Body.String())
		}
	}
	var request contain.CreateAssistantRequest
	w := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{"purpose": strings.Repeat("x", 40<<10)})
	if decodeAssistantRequest(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(body))), &request) {
		t.Fatal("oversized request accepted")
	}
}
