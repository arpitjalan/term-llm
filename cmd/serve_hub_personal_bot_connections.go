package cmd

import (
	"context"
	"net/http"
	"time"
)

// These are operator-only routes dispatched after the shared same-origin and
// JSON guards. Sources are server-discovered IDs, never browser-supplied paths.
func (s *hubServer) handleAssistantSharedConnections(w http.ResponseWriter, r *http.Request, path string) {
	if s.assistantConnections == nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "setup_unavailable", "Reusable connections are unavailable.")
		return
	}
	if path == "connections/import" {
		s.handleAssistantImportConnection(w, r)
		return
	}
	if r.Method != http.MethodGet {
		assistantMethodNotAllowed(w, "GET")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if path == "connection-sources" {
		sources, err := s.assistantConnections.ImportSources(ctx)
		if err != nil {
			writeAssistantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sources": sources})
		return
	}
	connections, err := s.assistantConnections.SharedConnections(ctx)
	if err != nil {
		writeAssistantError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": connections})
}

func (s *hubServer) handleAssistantImportConnection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		assistantMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		SourceID string `json:"source_id"`
		Name     string `json:"name,omitempty"`
	}
	if !decodeAssistantRequest(w, r, &request) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	connection, err := s.assistantConnections.ImportConnection(ctx, request.SourceID, request.Name)
	if err != nil {
		writeAssistantError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, connection)
}
