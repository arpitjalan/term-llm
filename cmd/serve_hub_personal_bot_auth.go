package cmd

import (
	"net/http"

	"github.com/samsaffron/term-llm/internal/contain"
)

func (s *hubServer) handleAssistantProviders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		assistantMethodNotAllowed(w, "GET")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": contain.ConnectionProviders()})
}

// Operator authentication and origin checks are enforced by handleAssistantItem.
// Keep JSON/content checks here too: credential mutations must never accept a
// browser form, extra fields, trailing objects, or reflected decoder errors.
func (s *hubServer) handleAssistantConnection(w http.ResponseWriter, r *http.Request, name, suffix string) {
	w.Header().Set("Cache-Control", "no-store")
	if s.assistantConnections == nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "setup_unavailable", "Provider setup is unavailable.")
		return
	}
	if r.Method != http.MethodGet && !hasJSONContentType(r) {
		writeOpenAIError(w, http.StatusForbidden, "invalid_request", "JSON request required")
		return
	}
	switch suffix {
	case "":
		s.handleAssistantConnectionStatusOrKey(w, r, name)
	case "chatgpt/start":
		s.handleAssistantChatGPTStart(w, r, name)
	case "cancel":
		s.handleAssistantConnectionCancel(w, r, name)
	case "use":
		s.handleAssistantUseConnection(w, r, name)
	default:
		http.NotFound(w, r)
	}
}

func (s *hubServer) handleAssistantUseConnection(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPost {
		assistantMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		ConnectionID string `json:"connection_id"`
		Model        string `json:"model,omitempty"`
	}
	if !decodeAssistantRequest(w, r, &request) {
		return
	}
	status, err := s.assistantConnections.UseSharedConnection(name, request.ConnectionID, request.Model)
	writeAssistantConnection(w, status, err)
}

func (s *hubServer) handleAssistantConnectionStatusOrKey(w http.ResponseWriter, r *http.Request, name string) {
	var status contain.ConnectionStatus
	var err error
	switch r.Method {
	case http.MethodGet:
		status, err = s.assistantConnections.Status(name)
	case http.MethodPost:
		var request struct {
			Provider string `json:"provider"`
			Model    string `json:"model,omitempty"`
			APIKey   string `json:"api_key"`
		}
		if !decodeAssistantRequest(w, r, &request) {
			return
		}
		status, err = s.assistantConnections.SaveAPIKey(name, request.Provider, request.Model, request.APIKey)
	default:
		assistantMethodNotAllowed(w, "GET, POST")
		return
	}
	writeAssistantConnection(w, status, err)
}

func (s *hubServer) handleAssistantChatGPTStart(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPost {
		assistantMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		Model string `json:"model,omitempty"`
	}
	if !decodeAssistantRequest(w, r, &request) {
		return
	}
	status, err := s.assistantConnections.StartChatGPT(r.Context(), name, request.Model)
	writeAssistantConnection(w, status, err)
}

func (s *hubServer) handleAssistantConnectionCancel(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPost {
		assistantMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		FlowID string `json:"flow_id"`
	}
	if !decodeAssistantRequest(w, r, &request) {
		return
	}
	status, err := s.assistantConnections.Cancel(name, request.FlowID)
	writeAssistantConnection(w, status, err)
}

func writeAssistantConnection(w http.ResponseWriter, status contain.ConnectionStatus, err error) {
	if err != nil {
		writeAssistantError(w, err)
		return
	}
	code := http.StatusOK
	if status.Flow != nil && status.Flow.State == "pending" {
		code = http.StatusAccepted
	}
	writeJSON(w, code, status)
}
