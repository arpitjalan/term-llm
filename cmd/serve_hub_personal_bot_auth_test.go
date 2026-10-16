package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/contain"
)

func TestHubAssistantConnectionRejectsMalformedSecretRequests(t *testing.T) {
	// Invalid requests must be rejected before reaching a provider or workspace.
	s := &hubServer{assistantConnections: &contain.ConnectionService{}}
	for _, suffix := range []string{"", "chatgpt/start", "cancel", "use"} {
		for _, tc := range []struct {
			name, contentType, body string
			want                    int
		}{
			{"form", "application/x-www-form-urlencoded", "api_key=private-value", 403},
			{"null", "application/json", "null", 400},
			{"array", "application/json", "[]", 400},
			{"trailing", "application/json", "{} {}", 400},
			{"unknown field", "application/json", `{"private-value":"do-not-echo"}`, 400},
			{"oversized", "application/json", `{"api_key":"` + strings.Repeat("private-value", 3000) + `"}`, 400},
		} {
			t.Run(suffix+"/"+tc.name, func(t *testing.T) {
				r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
				r.Header.Set("Content-Type", tc.contentType)
				w := httptest.NewRecorder()
				s.handleAssistantConnection(w, r, "assistant", suffix)
				if w.Code != tc.want {
					t.Fatalf("status = %d, want %d", w.Code, tc.want)
				}
				if strings.Contains(w.Body.String(), "private-value") || strings.Contains(w.Body.String(), "do-not-echo") {
					t.Fatal("decoder error echoed input containing secrets")
				}
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("response may be cached")
				}
			})
		}
	}
}

func TestHubAssistantConnectionProviderChoices(t *testing.T) {
	s := &hubServer{}
	w := httptest.NewRecorder()
	s.handleAssistantProviders(w, httptest.NewRequest(http.MethodGet, "/", nil))
	var response struct {
		Providers []contain.ConnectionProvider `json:"providers"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil || len(response.Providers) != 3 {
		t.Fatalf("provider response = %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	s.handleAssistantProviders(w, httptest.NewRequest(http.MethodPost, "/", nil))
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET" {
		t.Fatal("providers method guard missing")
	}
}

func TestHubAssistantConnectionPendingResponseAndUnavailableService(t *testing.T) {
	w := httptest.NewRecorder()
	writeAssistantConnection(w, contain.ConnectionStatus{State: "needs_connection", Flow: &contain.ConnectionFlow{State: "pending"}}, nil)
	if w.Code != http.StatusAccepted {
		t.Fatalf("pending response status = %d", w.Code)
	}
	w = httptest.NewRecorder()
	s := &hubServer{}
	s.handleAssistantConnection(w, httptest.NewRequest(http.MethodGet, "/", nil), "assistant", "")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status = %d", w.Code)
	}
}
