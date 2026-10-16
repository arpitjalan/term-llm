package contain

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/credentials"
	"github.com/samsaffron/term-llm/internal/filelock"
	"github.com/samsaffron/term-llm/internal/oauth"
)

type SharedConnection struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Source    string `json:"source"`
	Available bool   `json:"available"`
}

type ConnectionImportSource struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Available bool   `json:"available"`
	Message   string `json:"message,omitempty"`
}

// BridgeConnection contains private worker configuration, never an HTTP API
// response. A failed seed write must call RollbackAttachment before returning.
type BridgeConnection struct {
	Data           []byte
	ConnectionID   string
	ConnectionName string
	grant          sharedGrant
	previous       *sharedGrant
}

type sharedSource struct {
	Kind   string `json:"kind"`
	Path   string `json:"path,omitempty"`
	Volume string `json:"volume,omitempty"`
	Name   string `json:"name"`
}

type sharedRecord struct {
	Connection SharedConnection `json:"connection"`
	Source     sharedSource     `json:"source"`
}

type sharedGrant struct {
	Assistant    string `json:"assistant"`
	ConnectionID string `json:"connection_id"`
	TokenHash    string `json:"token_hash"`
}

type sharedState struct {
	Version     int                     `json:"version"`
	Port        int                     `json:"port"`
	Connections map[string]sharedRecord `json:"connections"`
	Grants      map[string]sharedGrant  `json:"grants"` // assistant name -> grant
}

type SharedConnections struct {
	mu      sync.Mutex
	manager *Manager
	root    string
	state   sharedState
	ca      []byte
	server  *http.Server
	listen  net.Listener
	cancel  context.CancelFunc
	done    chan struct{}
	unlock  func() error
	closed  bool
	slots   chan struct{}
	session func(string, string) (*credentials.ChatGPTCredentials, error)
}

func NewSharedConnections(manager *Manager) (*SharedConnections, error) {
	root := filepath.Join(filepath.Dir(manager.root), "personal-bot-connections")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, sharedUnavailable("could not create shared connection storage")
	}
	unlock, err := filelock.TryLock(filepath.Join(root, ".broker.lock"))
	if err != nil {
		return nil, sharedUnavailable("shared connections are already managed by another server")
	}
	b := &SharedConnections{manager: manager, root: root, unlock: unlock, session: credentials.ChatGPTSessionAt, slots: make(chan struct{}, 8)}
	if err := b.load(); err != nil {
		_ = unlock()
		return nil, err
	}
	if err := b.start(); err != nil {
		_ = unlock()
		return nil, err
	}
	return b, nil
}

func sharedUnavailable(message string) error {
	return fmt.Errorf("%w: %s", ErrAssistantUnavailable, message)
}

func (b *SharedConnections) load() error {
	b.state = sharedState{Version: 1, Connections: map[string]sharedRecord{}, Grants: map[string]sharedGrant{}}
	data, err := readConnectionFile(filepath.Join(b.root, "broker.json"), 4<<20)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || json.Unmarshal(data, &b.state) != nil || b.state.Version != 1 || b.state.Port < 1 || b.state.Port > 65535 {
		return sharedUnavailable("shared connection metadata is unreadable")
	}
	if b.state.Connections == nil || b.state.Grants == nil {
		return sharedUnavailable("shared connection metadata is incomplete")
	}
	return nil
}

func (b *SharedConnections) saveLocked() error {
	data, err := json.MarshalIndent(b.state, "", "  ")
	if err != nil {
		return sharedUnavailable("could not encode shared connection metadata")
	}
	if err := config.WriteFileAtomicallyNoFollow(filepath.Join(b.root, "broker.json"), data, 0o600); err != nil {
		return sharedUnavailable("could not save shared connection metadata")
	}
	return nil
}

func (b *SharedConnections) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	b.cancel()
	b.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = b.server.Shutdown(ctx)
	_ = b.server.Close()
	<-b.done
	return b.unlock()
}

func (b *SharedConnections) List(ctx context.Context) ([]SharedConnection, error) {
	b.mu.Lock()
	records := make([]sharedRecord, 0, len(b.state.Connections))
	for _, record := range b.state.Connections {
		records = append(records, record)
	}
	b.mu.Unlock()
	connections := make([]SharedConnection, 0, len(records))
	for _, record := range records {
		view := record.Connection
		view.Available = b.sourceAvailable(ctx, record.Source)
		connections = append(connections, view)
	}
	sort.Slice(connections, func(i, j int) bool { return connections[i].Name < connections[j].Name })
	return connections, nil
}

func sharedLabel(label, fallback string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		label = fallback
	}
	if len(label) > 160 || strings.IndexFunc(label, unicode.IsControl) >= 0 {
		return "", fmt.Errorf("%w: connection name must be at most 160 bytes without control characters", ErrAssistantInvalid)
	}
	return label, nil
}

func (b *SharedConnections) CreateChatGPT(creds *oauth.ChatGPTCredentials, label string) (SharedConnection, error) {
	if creds == nil || creds.AccessToken == "" || creds.RefreshToken == "" || creds.AccountID == "" {
		return SharedConnection{}, fmt.Errorf("%w: ChatGPT sign-in did not return a complete connection", ErrAssistantInvalid)
	}
	name, err := sharedLabel(label, "ChatGPT connection")
	if err != nil {
		return SharedConnection{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return SharedConnection{}, sharedUnavailable("shared connections are shutting down")
	}
	id := uuid.NewString()
	path := filepath.Join(b.root, id+".json")
	data, err := json.Marshal(creds)
	if err != nil {
		return SharedConnection{}, sharedUnavailable("could not prepare ChatGPT connection")
	}
	if err := config.WriteFileAtomicallyNoFollow(path, data, 0o600); err != nil {
		return SharedConnection{}, sharedUnavailable("could not save ChatGPT connection")
	}
	record := sharedRecord{Connection: SharedConnection{ID: id, Name: name, Provider: "chatgpt", Source: "New sign-in", Available: true}, Source: sharedSource{Kind: "file", Path: path, Name: "New sign-in"}}
	b.state.Connections[id] = record
	if err := b.saveLocked(); err != nil {
		delete(b.state.Connections, id)
		_ = os.Remove(path)
		return SharedConnection{}, err
	}
	return record.Connection, nil
}

// Attach is called inside Manager.WithConnection, after its stopped guard. It
// does not reacquire the manager mutex or return any source credential.
func (b *SharedConnections) Attach(name, id, model string) (BridgeConnection, error) {
	if err := validateAssistantName(name); err != nil {
		return BridgeConnection{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return BridgeConnection{}, sharedUnavailable("shared connections are shutting down")
	}
	record, ok := b.state.Connections[id]
	if !ok {
		return BridgeConnection{}, fmt.Errorf("%w: shared connection not found", ErrAssistantNotFound)
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return BridgeConnection{}, sharedUnavailable("could not create assistant connection token")
	}
	token := hex.EncodeToString(secret[:])
	grant := sharedGrant{Assistant: name, ConnectionID: id, TokenHash: hashBrokerToken(token)}
	bridge := BridgeConnection{ConnectionID: id, ConnectionName: record.Connection.Name, grant: grant}
	if previous, ok := b.state.Grants[name]; ok {
		bridge.previous = &previous
	}
	bridge.Data, _ = json.Marshal(map[string]string{"url": fmt.Sprintf("https://host.docker.internal:%d", b.state.Port), "token": token, "ca_cert": string(b.ca)})
	b.state.Grants[name] = grant
	if err := b.saveLocked(); err != nil {
		b.restoreGrantLocked(bridge)
		return BridgeConnection{}, err
	}
	return bridge, nil
}

func hashBrokerToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

func (b *SharedConnections) restoreGrantLocked(bridge BridgeConnection) {
	if bridge.previous == nil {
		delete(b.state.Grants, bridge.grant.Assistant)
	} else {
		b.state.Grants[bridge.grant.Assistant] = *bridge.previous
	}
}

func (b *SharedConnections) RollbackAttachment(bridge BridgeConnection) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	current := b.state.Grants[bridge.grant.Assistant]
	if current.TokenHash != bridge.grant.TokenHash {
		return nil
	}
	b.restoreGrantLocked(bridge)
	return b.saveLocked()
}

// Detach revokes a worker grant when it switches away from shared credentials.
func (b *SharedConnections) Detach(name string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	previous, ok := b.state.Grants[name]
	if !ok {
		return nil
	}
	delete(b.state.Grants, name)
	if err := b.saveLocked(); err != nil {
		b.state.Grants[name] = previous
		return err
	}
	return nil
}
