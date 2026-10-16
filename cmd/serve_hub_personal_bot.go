package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/samsaffron/term-llm/internal/contain"
	"github.com/samsaffron/term-llm/internal/hub"
)

type hubAssistantView struct {
	contain.ManagedAssistant
	Ready bool   `json:"ready"`
	UIURL string `json:"ui_url"`
}

// Management is opt-in and always passes through the Hub's operator auth.
// A container's node credentials do not authorize host-level management.
func (s *hubServer) assistantRequestAllowed(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if s.assistantManager == nil {
		http.NotFound(w, r)
		return false
	}
	if hubContainsEncodedSeparator(r.URL.EscapedPath()) || hubHasDotDotSegment(r.URL.Path) {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "invalid assistant path")
		return false
	}
	mutation := r.Method != http.MethodGet && r.Method != http.MethodHead
	if !hubBrowserRequestAllowed(r, mutation) || (mutation && !hasJSONContentType(r)) {
		writeOpenAIError(w, http.StatusForbidden, "invalid_request", "same-origin JSON request required")
		return false
	}
	return true
}

func (s *hubServer) handleAssistants(w http.ResponseWriter, r *http.Request) {
	if !s.assistantRequestAllowed(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		assistants, err := s.assistantManager.List(ctx)
		response := map[string]any{"assistants": s.assistantViews(ctx, assistants)}
		if err != nil {
			response["warning"] = "Container status is unavailable. Check Docker on the server, then refresh."
		}
		writeJSON(w, http.StatusOK, response)
	case http.MethodPost:
		var request contain.CreateAssistantRequest
		if !decodeAssistantRequest(w, r, &request) {
			return
		}
		if _, exists := s.registry.Lookup(request.Name); exists {
			writeOpenAIError(w, http.StatusConflict, "assistant_exists", "That name is already used by an assistant. Choose another name.")
			return
		}
		op, err := s.assistantManager.Create(request)
		writeAssistantOperation(w, op, err)
	default:
		assistantMethodNotAllowed(w, "GET, POST")
	}
}

func (s *hubServer) handleAssistantItem(w http.ResponseWriter, r *http.Request) {
	if !s.assistantRequestAllowed(w, r) {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/assistants/")
	if path == "connections" || path == "connections/import" || path == "connection-sources" {
		s.handleAssistantSharedConnections(w, r, path)
		return
	}
	if path == "environment" {
		s.handleAssistantEnvironment(w, r)
		return
	}
	if path == "providers" {
		s.handleAssistantProviders(w, r)
		return
	}
	if id, ok := strings.CutPrefix(path, "operations/"); ok {
		s.handleAssistantOperation(w, r, id)
		return
	}
	name, suffix, _ := strings.Cut(path, "/")
	if err := contain.ValidateName(name); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "invalid assistant name")
		return
	}
	if suffix == "connection" || strings.HasPrefix(suffix, "connection/") {
		s.handleAssistantConnection(w, r, name, strings.TrimPrefix(strings.TrimPrefix(suffix, "connection"), "/"))
		return
	}
	if suffix == "" {
		s.handleGetAssistant(w, r, name)
		return
	}
	s.handleAssistantAction(w, r, name, suffix)
}

func (s *hubServer) handleGetAssistant(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodGet {
		assistantMethodNotAllowed(w, "GET")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	assistant, err := s.assistantManager.Get(ctx, name)
	if err != nil {
		writeAssistantError(w, err)
		return
	}
	views := s.assistantViews(ctx, []contain.ManagedAssistant{assistant})
	writeJSON(w, http.StatusOK, views[0])
}

func (s *hubServer) handleAssistantEnvironment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		assistantMethodNotAllowed(w, "GET")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.assistantManager.Environment(ctx))
}

func (s *hubServer) handleAssistantOperation(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		assistantMethodNotAllowed(w, "GET")
		return
	}
	op, ok := s.assistantManager.Operation(id)
	if !ok {
		writeOpenAIError(w, http.StatusNotFound, "not_found", "operation not found; refresh assistant status")
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (s *hubServer) handleAssistantAction(w http.ResponseWriter, r *http.Request, name, action string) {
	var run func(string) (contain.Operation, error)
	switch action {
	case "start":
		run = s.assistantManager.Start
	case "stop":
		run = s.assistantManager.Stop
	case "restart":
		run = s.assistantManager.Restart
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		assistantMethodNotAllowed(w, "POST")
		return
	}
	var empty struct{}
	if !decodeAssistantRequest(w, r, &empty) {
		return
	}
	op, err := run(name)
	writeAssistantOperation(w, op, err)
}

// A running container is only ready to open once its authenticated web service
// responds. The probe does not validate provider billing or model access.
func (s *hubServer) assistantViews(ctx context.Context, assistants []contain.ManagedAssistant) []hubAssistantView {
	views := make([]hubAssistantView, len(assistants))
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	slots := make(chan struct{}, 8)
	for i, assistant := range assistants {
		views[i] = hubAssistantView{ManagedAssistant: assistant, UIURL: s.hubPath("/node/" + assistant.NodeID + "/")}
		if assistant.State != "running" {
			continue
		}
		node, ok := s.registry.Lookup(assistant.NodeID)
		if !ok || node.Source != hub.SourceContain {
			views[i].Error = "The assistant's browser route is unavailable. Check Hub discovery for a duplicate name."
			continue
		}
		wg.Add(1)
		go func(index int, n hub.Node) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-ctx.Done():
				return
			}
			views[index].Ready = s.prober.Probe(ctx, n).Reachable
		}(i, node)
	}
	wg.Wait()
	return views
}

func decodeAssistantRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	// Decode a RawMessage first so null and arrays cannot masquerade as an
	// empty action request. Never echo decoder errors, which may contain secrets.
	var body json.RawMessage
	if err := decoder.Decode(&body); err != nil || len(body) == 0 || body[0] != '{' {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "expected a JSON object")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "expected one JSON object")
		return false
	}
	fields := json.NewDecoder(strings.NewReader(string(body)))
	fields.DisallowUnknownFields()
	if err := fields.Decode(dst); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "invalid assistant request fields")
		return false
	}
	return true
}

func assistantMethodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request", "method not allowed")
}

func writeAssistantOperation(w http.ResponseWriter, op contain.Operation, err error) {
	if err != nil {
		writeAssistantError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}

func writeAssistantError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "Unable to manage this assistant. Refresh and try again."
	switch {
	case errors.Is(err, contain.ErrAssistantNotFound):
		status, message = http.StatusNotFound, "managed assistant not found"
	case errors.Is(err, contain.ErrAssistantBusy):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, contain.ErrAssistantInvalid):
		status, message = http.StatusBadRequest, err.Error()
	case errors.Is(err, contain.ErrAssistantUnavailable):
		status, message = http.StatusServiceUnavailable, err.Error()
	}
	writeOpenAIError(w, status, "assistant_error", message)
}
