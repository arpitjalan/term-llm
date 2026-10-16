package contain

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/filelock"
	"github.com/samsaffron/term-llm/internal/restart"
)

var (
	ErrAssistantNotFound    = errors.New("managed assistant not found")
	ErrAssistantBusy        = errors.New("assistant has an operation in progress")
	ErrAssistantInvalid     = errors.New("invalid assistant request")
	ErrAssistantUnavailable = errors.New("assistant environment unavailable")
)

// ManagerOptions are administrator settings, never browser request fields.
type ManagerOptions struct {
	Runner      Runner
	Image       string
	BinaryPath  string
	Coordinator *restart.Coordinator
}

type CreateAssistantRequest struct {
	Name    string `json:"name"`
	Purpose string `json:"purpose"`
}

type ManagedAssistant struct {
	Name            string    `json:"name"`
	Purpose         string    `json:"purpose"`
	State           string    `json:"state"`
	NeedsConnection bool      `json:"needs_connection"`
	NodeID          string    `json:"node_id"`
	CreatedAt       time.Time `json:"created_at"`
	OperationID     string    `json:"operation_id,omitempty"`
	Error           string    `json:"error,omitempty"`
}

type Operation struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Action     string     `json:"action"`
	State      string     `json:"state"`
	Error      string     `json:"error,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

type Environment struct {
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
	CanBuild  bool   `json:"can_build"`
	BuildHint string `json:"build_hint,omitempty"`
}

type assistantRecord struct {
	Version   int              `json:"version"`
	Assistant ManagedAssistant `json:"assistant"`
	Operation Operation        `json:"operation"`
}

// Manager owns only workspaces bearing its private metadata. Existing contain
// workspaces remain visible in Hub, but cannot be mutated through this manager.
type Manager struct {
	mu         sync.Mutex
	buildMu    sync.Mutex
	wg         sync.WaitGroup
	ctx        context.Context
	cancel     context.CancelFunc
	closed     bool
	opts       ManagerOptions
	root       string
	operations map[string]Operation
	latest     map[string]string
	busy       map[string]bool
	unlock     func() error
}

func NewManager(opts ManagerOptions) (*Manager, error) {
	if opts.Runner == nil {
		opts.Runner = OSRunner{}
	}
	root, err := ContainersRoot()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("could not create managed assistant storage")
	}
	unlock, err := filelock.TryLock(filepath.Join(root, ".personal-bot.lock"))
	if err != nil {
		return nil, fmt.Errorf("another server is managing these assistants, or assistant storage is unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{opts: opts, root: root, ctx: ctx, cancel: cancel, operations: map[string]Operation{}, latest: map[string]string{}, busy: map[string]bool{}, unlock: unlock}
	if err := m.recoverOperations(); err != nil {
		cancel()
		_ = unlock()
		return nil, err
	}
	return m, nil
}

func (m *Manager) Close() error {
	m.mu.Lock()
	m.closed = true
	m.cancel()
	m.mu.Unlock()
	m.wg.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unlock != nil {
		err := m.unlock()
		m.unlock = nil
		return err
	}
	return nil
}

var assistantNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

func validateAssistantName(name string) error {
	if !assistantNamePattern.MatchString(name) || strings.HasSuffix(name, "-") {
		return fmt.Errorf("%w: use up to 48 lowercase letters, numbers and hyphens", ErrAssistantInvalid)
	}
	switch name {
	case "environment", "operations", "providers", "connections", "connection-sources":
		return fmt.Errorf("%w: this assistant name is reserved", ErrAssistantInvalid)
	}
	return nil
}

// Create reserves a private workspace. Docker and provider connections are not
// required until Start; there are no host path, image, or command request fields.
func (m *Manager) Create(req CreateAssistantRequest) (Operation, error) {
	if err := validateAssistantName(req.Name); err != nil {
		return Operation{}, err
	}
	req.Purpose = strings.TrimSpace(req.Purpose)
	if req.Purpose == "" || len(req.Purpose) > 16000 {
		return Operation{}, fmt.Errorf("%w: purpose is required and must be at most 16000 bytes", ErrAssistantInvalid)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.canBegin(req.Name); err != nil {
		return Operation{}, err
	}
	if _, err := os.Lstat(filepath.Join(m.root, req.Name)); !os.IsNotExist(err) {
		return Operation{}, fmt.Errorf("%w: this workspace name is already in use", ErrAssistantInvalid)
	}
	ctx, release, err := m.operationContext()
	if err != nil {
		return Operation{}, err
	}
	op := newAssistantOperation(req.Name, "create")
	m.busy[req.Name] = true
	m.operations[op.ID] = op
	m.wg.Add(1)
	go func() {
		defer release()
		m.create(ctx, req, op)
	}()
	return op, nil
}

func (m *Manager) canBegin(name string) error {
	if m.closed {
		return fmt.Errorf("%w: manager is shutting down", ErrAssistantUnavailable)
	}
	if m.busy[name] {
		return ErrAssistantBusy
	}
	return nil
}

func newAssistantOperation(name, action string) Operation {
	return Operation{ID: uuid.NewString(), Name: name, Action: action, State: "running", StartedAt: time.Now().UTC()}
}

func (m *Manager) Operation(id string) (Operation, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	op, ok := m.operations[id]
	return op, ok
}

// List returns saved assistants even if Docker is unavailable. In that case the
// caller receives both the records and a sanitized environment error.
func (m *Manager) List(ctx context.Context) ([]ManagedAssistant, error) {
	m.mu.Lock()
	records, err := m.records()
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	entries, dockerErr := List(ctx, m.opts.Runner, io.Discard)
	states := map[string]string{}
	for _, entry := range entries {
		states[entry.Name] = entry.Status
	}
	assistants := make([]ManagedAssistant, 0, len(records))
	for _, record := range records {
		a := record.Assistant
		a.State = managedAssistantState(a.NeedsConnection, states[a.Name], dockerErr)
		assistants = append(assistants, a)
	}
	sort.Slice(assistants, func(i, j int) bool { return assistants[i].Name < assistants[j].Name })
	if dockerErr != nil {
		return assistants, fmt.Errorf("%w: Docker is unavailable; check that the Docker service is running and accessible", ErrAssistantUnavailable)
	}
	return assistants, nil
}

func managedAssistantState(needsConnection bool, dockerState string, dockerErr error) string {
	if dockerErr == nil && dockerState == "running" {
		return "running"
	}
	if needsConnection {
		return "needs_connection"
	}
	if dockerErr != nil || dockerState == "invalid" || dockerState == "orphaned" {
		return "unavailable"
	}
	return "stopped"
}

func (m *Manager) Get(ctx context.Context, name string) (ManagedAssistant, error) {
	if err := validateAssistantName(name); err != nil {
		return ManagedAssistant{}, err
	}
	assistants, err := m.List(ctx)
	for _, assistant := range assistants {
		if assistant.Name == name {
			return assistant, err
		}
	}
	return ManagedAssistant{}, ErrAssistantNotFound
}

func (m *Manager) Environment(ctx context.Context) Environment {
	_, platform, err := m.imageSource()
	if err != nil {
		return Environment{Error: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for _, args := range [][]string{{"info", "--format", "{{.ServerVersion}}"}, {"compose", "version", "--short"}} {
		if _, err := m.opts.Runner.Output(ctx, "docker", args, RunOptions{Stderr: io.Discard}); err != nil {
			return Environment{Error: "Docker Engine and Docker Compose v2 must be installed, running and accessible on this server"}
		}
	}
	hint := "Uses the administrator-configured container image"
	if platform != "" {
		hint = "Builds the current server version for " + platform + "; the first start needs internet access"
	}
	return Environment{Available: true, CanBuild: platform != "", BuildHint: hint}
}

// ConnectionDir is a trusted, server-only path. Never return it in API JSON.
func (m *Manager) ConnectionDir(name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.readRecord(name); err != nil {
		return "", err
	}
	return filepath.Join(m.root, name, "connection", "term-llm"), nil
}

func (m *Manager) CheckConnection(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.checkConnection(name)
}

func (m *Manager) checkConnection(name string) error {
	if err := m.canBegin(name); err != nil {
		return err
	}
	if _, err := m.readRecord(name); err != nil {
		return err
	}
	dir := filepath.Join(m.root, name)
	info, err := ReadComposeInfo(filepath.Join(dir, "compose.yaml"))
	if err != nil || info.Invalid {
		return fmt.Errorf("%w: the assistant container definition must be valid before changing its connection", ErrAssistantUnavailable)
	}
	ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
	defer cancel()
	output, err := DockerPS(ctx, m.opts.Runner, io.Discard)
	if err != nil {
		return fmt.Errorf("%w: Docker status must be available before changing a connection", ErrAssistantUnavailable)
	}
	for _, container := range parseDockerPSLines(output) {
		if container.Labels["org.term-llm.contain.name"] != name && container.Labels["org.term-llm.contain.config_dir"] != dir {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(container.State)) {
		case "exited", "dead", "created":
			continue
		default:
			return fmt.Errorf("%w: stop the assistant and wait for it to finish before changing its connection", ErrAssistantBusy)
		}
	}
	return nil
}

// WithConnection serializes credential writes against lifecycle operations.
// A new seed revision is copied into the private runtime home on the next start;
// ordinary restarts preserve tokens refreshed inside that home.
func (m *Manager) WithConnection(name string, save func(configDir string) error) (ManagedAssistant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.checkConnection(name); err != nil {
		return ManagedAssistant{}, err
	}
	record, err := m.readRecord(name)
	if err != nil {
		return ManagedAssistant{}, err
	}
	dir := filepath.Join(m.root, name, "connection", "term-llm")
	previousSeed, err := snapshotConnectionFiles(dir, connectionTransactionFiles, 64<<10)
	if err != nil {
		return ManagedAssistant{}, err
	}
	workspace := filepath.Join(m.root, name)
	previousRecord, err := snapshotConnectionFiles(workspace, []string{assistantMetadataFile}, 256<<10)
	if err != nil {
		return ManagedAssistant{}, err
	}
	record, err = m.saveConnection(record, dir, save)
	if err != nil {
		seedErr := restoreConnectionFiles(dir, previousSeed)
		recordErr := restoreConnectionFiles(workspace, previousRecord)
		if seedErr != nil || recordErr != nil {
			return ManagedAssistant{}, fmt.Errorf("%w: connection could not be fully restored; reconnect before starting", ErrAssistantUnavailable)
		}
		return ManagedAssistant{}, connectionTransactionError(err)
	}
	return record.Assistant, nil
}

func (m *Manager) saveConnection(record assistantRecord, dir string, save func(string) error) (assistantRecord, error) {
	if err := save(dir); err != nil {
		return record, err
	}
	if err := config.WriteFileAtomicallyNoFollow(filepath.Join(dir, ".revision"), []byte(uuid.NewString()), 0o600); err != nil {
		return record, err
	}
	record.Assistant.NeedsConnection = false
	record.Assistant.State = "stopped"
	record.Assistant.Error = ""
	if err := m.writeRecord(record); err != nil {
		return record, err
	}
	return record, nil
}

func connectionTransactionError(cause error) error {
	// Keep useful HTTP classifications without exposing filesystem paths,
	// credential contents, or errors supplied by a provider's save callback.
	for _, kind := range []error{ErrAssistantNotFound, ErrAssistantBusy, ErrAssistantInvalid} {
		if errors.Is(cause, kind) {
			return fmt.Errorf("%w: connection was not saved; previous settings were restored", kind)
		}
	}
	return fmt.Errorf("%w: connection was not saved; previous settings were restored", ErrAssistantUnavailable)
}
