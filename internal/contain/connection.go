package contain

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/llm"
	"github.com/samsaffron/term-llm/internal/oauth"
	"github.com/samsaffron/term-llm/internal/restart"
	"gopkg.in/yaml.v3"
)

const connectionStateFile = ".connection.json"

// ConnectionProvider describes a supported onboarding choice without consulting
// the operator's config, environment, or credential stores.
type ConnectionProvider struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Auth         string   `json:"auth"`
	DefaultModel string   `json:"default_model"`
	Models       []string `json:"models"`
}

func ConnectionProviders() []ConnectionProvider {
	providers := make([]ConnectionProvider, 0, 3)
	for _, choice := range []struct{ id, name, auth string }{
		{"chatgpt", "ChatGPT (Codex)", "device_code"},
		{"openai", "OpenAI API", "api_key"},
		{"anthropic", "Anthropic API", "api_key"},
	} {
		model := config.DefaultProviderModel(choice.id)
		// Use the built-in catalog; model discovery caches belong to the host
		// operator and must not influence an isolated assistant's setup.
		models := make([]string, 0, len(llm.ProviderModels[choice.id]))
		for _, entry := range llm.ProviderModels[choice.id] {
			models = append(models, entry.ID)
		}
		if model != "" && !slices.Contains(models, model) {
			models = append([]string{model}, models...)
		}
		providers = append(providers, ConnectionProvider{choice.id, choice.name, choice.auth, model, models})
	}
	return providers
}

// ConnectionStatus never contains API keys or OAuth credentials. Authorized
// means the device exchange succeeded, not that inference has been tested.
type ConnectionStatus struct {
	State          string          `json:"state"`
	Provider       string          `json:"provider,omitempty"`
	Model          string          `json:"model,omitempty"`
	Message        string          `json:"message"`
	Flow           *ConnectionFlow `json:"flow,omitempty"`
	ConnectionID   string          `json:"connection_id,omitempty"`
	ConnectionName string          `json:"connection_name,omitempty"`
}

type ConnectionFlow struct {
	ID              string    `json:"id"`
	State           string    `json:"state"`
	VerificationURL string    `json:"verification_url,omitempty"`
	UserCode        string    `json:"user_code,omitempty"`
	ExpiresAt       time.Time `json:"expires_at"`
	Message         string    `json:"message,omitempty"`
}

type connectionWorkspace interface {
	ConnectionDir(string) (string, error)
	CheckConnection(string) error
	WithConnection(string, func(string) error) (ManagedAssistant, error)
}

type deviceConnection struct {
	view       ConnectionFlow
	model      string
	cancel     context.CancelFunc
	release    func()
	finishedAt time.Time
}

// ConnectionService owns bounded device-auth operations independently of HTTP
// request lifetimes. Every credential commit is serialized by the Manager and
// can only target a stopped, managed workspace.
type ConnectionService struct {
	shared       *SharedConnections
	workspaces   connectionWorkspace
	coordinator  *restart.Coordinator
	request      func(context.Context) (*oauth.ChatGPTDeviceCode, error)
	authenticate func(context.Context, *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error)
	now          func() time.Time
	mu           sync.Mutex
	flows        map[string]*deviceConnection
	closed       bool
	wg           sync.WaitGroup
}

func NewConnectionService(manager *Manager) (*ConnectionService, error) {
	service := newConnectionService(manager)
	service.coordinator = manager.opts.Coordinator
	shared, err := NewSharedConnections(manager)
	if err != nil {
		return nil, err
	}
	service.shared = shared
	return service, nil
}

func newConnectionService(workspaces connectionWorkspace) *ConnectionService {
	return &ConnectionService{
		workspaces: workspaces, request: oauth.RequestChatGPTDeviceCode,
		authenticate: oauth.AuthenticateChatGPTDevice, now: time.Now,
		flows: make(map[string]*deviceConnection),
	}
}

func (s *ConnectionService) Close() {
	s.mu.Lock()
	s.closed = true
	for _, flow := range s.flows {
		flow.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	if s.shared != nil {
		_ = s.shared.Close()
	}
}

func (s *ConnectionService) Status(name string) (ConnectionStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	return s.statusLocked(name)
}

func (s *ConnectionService) statusLocked(name string) (ConnectionStatus, error) {
	dir, err := s.workspaces.ConnectionDir(name)
	if err != nil {
		return ConnectionStatus{}, err
	}
	status := ConnectionStatus{State: "needs_connection", Message: "Choose a provider to connect this assistant."}
	data, err := readConnectionFile(filepath.Join(dir, connectionStateFile), 8192)
	if err == nil {
		if len(data) > 8192 || json.Unmarshal(data, &status) != nil {
			return ConnectionStatus{}, fmt.Errorf("%w: connection status is unreadable", ErrAssistantUnavailable)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ConnectionStatus{}, fmt.Errorf("%w: connection status is unavailable", ErrAssistantUnavailable)
	}
	if flow := s.flows[name]; flow != nil {
		view := flow.view
		status.Flow = &view
	}
	return status, nil
}

func (s *ConnectionService) SaveAPIKey(name, provider, model, apiKey string) (ConnectionStatus, error) {
	if provider != "openai" && provider != "anthropic" {
		return ConnectionStatus{}, fmt.Errorf("%w: choose OpenAI or Anthropic for API-key setup", ErrAssistantInvalid)
	}
	model, err := connectionModel(provider, model)
	if err != nil {
		return ConnectionStatus{}, err
	}
	apiKey = strings.TrimSpace(apiKey)
	if !literalConnectionValue(apiKey, 4096) || len(apiKey) < 8 {
		return ConnectionStatus{}, fmt.Errorf("%w: enter a valid API key without spaces or credential-reference syntax", ErrAssistantInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ConnectionStatus{}, fmt.Errorf("%w: provider setup is shutting down", ErrAssistantUnavailable)
	}
	status := ConnectionStatus{State: "saved_unverified", Provider: provider, Model: model,
		Message: "API key saved privately. It has not been validated; start the assistant and send a message to check model access."}
	if err := s.persistLocked(name, status, apiKey, nil); err != nil {
		return ConnectionStatus{}, err
	}
	if s.shared != nil {
		if err := s.shared.Detach(name); err != nil {
			return ConnectionStatus{}, err
		}
	}
	s.cancelLocked(name, "cancelled", "Replaced by API-key setup.")
	return s.statusLocked(name)
}

func connectionModel(provider, model string) (string, error) {
	model = strings.TrimSpace(model)
	if model == "" {
		model = config.DefaultProviderModel(provider)
	}
	if !literalConnectionValue(model, 256) {
		return "", fmt.Errorf("%w: choose a valid model name", ErrAssistantInvalid)
	}
	return model, nil
}

// Values are literal secrets/model IDs, never config's deferred expressions.
func literalConnectionValue(value string, limit int) bool {
	return value != "" && len(value) <= limit && !strings.ContainsAny(value, "$`") &&
		!strings.Contains(value, "://") && strings.IndexFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) < 0
}

func (s *ConnectionService) persistLocked(name string, status ConnectionStatus, apiKey string, creds *oauth.ChatGPTCredentials) error {
	_, err := s.workspaces.WithConnection(name, func(dir string) error {
		return writeConnectionSeed(dir, status, apiKey, creds, nil)
	})
	return err
}

func writeConnectionSeed(dir string, status ConnectionStatus, apiKey string, creds *oauth.ChatGPTCredentials, bridge []byte) error {
	provider := map[string]string{"model": status.Model}
	if apiKey != "" {
		provider["api_key"] = apiKey
	}
	data, err := yaml.Marshal(map[string]any{
		"default_provider": status.Provider, "provider_discovery": "config",
		"providers": map[string]any{status.Provider: provider},
	})
	if err != nil {
		return fmt.Errorf("%w: could not prepare provider configuration", ErrAssistantUnavailable)
	}
	files := []connectionSeedFile{{name: "config.yaml", data: data}}
	var credentialData []byte
	if creds != nil {
		credentialData, err = json.Marshal(map[string]any{
			"access_token": creds.AccessToken, "refresh_token": creds.RefreshToken,
			"expires_at": creds.ExpiresAt, "account_id": creds.AccountID,
		})
		if err != nil {
			return fmt.Errorf("%w: could not prepare provider credentials", ErrAssistantUnavailable)
		}
	}
	files = append(files, connectionSeedFile{name: "chatgpt_oauth.json", data: credentialData})
	files = append(files, connectionSeedFile{name: "chatgpt_connection.json", data: bridge})
	status.Flow = nil
	data, err = json.Marshal(status)
	if err != nil {
		return fmt.Errorf("%w: could not prepare connection status", ErrAssistantUnavailable)
	}
	files = append(files, connectionSeedFile{name: connectionStateFile, data: data})
	return replaceConnectionFiles(dir, files)
}

func connectionFlowID() string {
	var data [24]byte
	if _, err := rand.Read(data[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(data[:])
}
