package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/contain"
	"github.com/samsaffron/term-llm/internal/hub"
)

func TestHubSharedConnectionsRequireOperatorAndSameOrigin(t *testing.T) {
	s := newHubServer(hub.NewRegistry(), nil)
	s.requireAuth, s.token, s.basePath = true, "operator-token", "/bot"
	s.assistantManager, s.assistantConnections = &contain.Manager{}, &contain.ConnectionService{}
	for _, path := range []string{"connections", "connection-sources", "connections/import", "assistant/connection/use"} {
		req := httptest.NewRequest(http.MethodPost, "/bot/api/assistants/"+path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s without operator: %d", path, w.Code)
		}
		req = httptest.NewRequest(http.MethodPost, "/bot/api/assistants/"+path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer operator-token")
		req.Header.Set("Origin", "https://outside.example")
		w = httptest.NewRecorder()
		s.handler().ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s cross-origin: %d", path, w.Code)
		}
	}
}

func TestHubSharedImportAcceptsOnlyDiscoveredSourceFields(t *testing.T) {
	s := &hubServer{assistantConnections: &contain.ConnectionService{}}
	for _, body := range []string{"null", `{"source_id":"server","path":"private-value"}`, `{"source_id":"server"} {}`, `{"source_id":"` + strings.Repeat("x", 32768) + `"}`} {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		w := httptest.NewRecorder()
		s.handleAssistantImportConnection(w, req)
		if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "private-value") {
			t.Fatalf("malformed import: %d", w.Code)
		}
	}
}

func TestHubPersonalBotSecurityUsesAuthenticatedStandaloneHub(t *testing.T) {
	s := newTestPasskeyHub(t, "/bot")
	s.assistantManager = &contain.Manager{}
	issued, err := s.passkey.sessions.Create("credential")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://backend/bot/auth/security?return=/bot/", nil)
	req.AddCookie(&http.Cookie{Name: hubSessionCookieName, Value: issued.Token})
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "/bot/dist/hub.js?v=") || strings.Contains(w.Body.String(), "/dist/personal-bot.js") {
		t.Fatalf("security page: %d", w.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "http://backend/bot/auth/security", nil)
	w = httptest.NewRecorder()
	s.handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous security: %d", w.Code)
	}
}
