package contain

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/restart"
)

type assistantTestRunner struct {
	mu           sync.Mutex
	runs         [][]string
	outputs      [][]string
	ps           []byte
	dockerError  error
	composeError error
	dockerInfo   []byte
	runError     error
	imageExists  bool
	started      chan struct{}
	block        bool
}

func (r *assistantTestRunner) Run(ctx context.Context, command string, args []string, _ RunOptions) error {
	r.mu.Lock()
	r.runs = append(r.runs, append([]string{command}, args...))
	err, block, started := r.runError, r.block, r.started
	r.mu.Unlock()
	if block {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	return err
}

func (r *assistantTestRunner) Output(_ context.Context, command string, args []string, _ RunOptions) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.outputs = append(r.outputs, append([]string{command}, args...))
	if r.dockerError != nil {
		return nil, r.dockerError
	}
	if args[0] == "info" {
		if r.dockerInfo != nil {
			return r.dockerInfo, nil
		}
		return []byte("linux/aarch64\n"), nil
	}
	if args[0] == "compose" && r.composeError != nil {
		return nil, r.composeError
	}
	if len(args) > 1 && args[0] == "image" && !r.imageExists {
		return nil, errors.New("image missing")
	}
	if args[0] == "ps" {
		return append([]byte(nil), r.ps...), nil
	}
	return nil, nil
}

func newAssistantTestManager(t *testing.T) (*Manager, *assistantTestRunner) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	r := &assistantTestRunner{}
	m, err := NewManager(ManagerOptions{Runner: r, Image: "test-personal-bot:local"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m, r
}

func waitAssistantOperation(t *testing.T, m *Manager, op Operation) Operation {
	t.Helper()
	m.wg.Wait()
	result, ok := m.Operation(op.ID)
	if !ok || result.State == "running" {
		t.Fatalf("operation did not finish: %+v", result)
	}
	return result
}

func createTestAssistant(t *testing.T, m *Manager, name string) ManagedAssistant {
	t.Helper()
	op, err := m.Create(CreateAssistantRequest{Name: name, Purpose: "Help with everyday work"})
	if err != nil {
		t.Fatal(err)
	}
	if got := waitAssistantOperation(t, m, op); got.State != "succeeded" {
		t.Fatal(got.Error)
	}
	a, err := m.Get(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func connectTestAssistant(t *testing.T, m *Manager, name string) {
	t.Helper()
	_, err := m.WithConnection(name, func(dir string) error {
		return config.WriteFileAtomicallyNoFollow(filepath.Join(dir, "config.yaml"), []byte("default_provider: debug\n"), 0o600)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPersonalBotCreatePrivateWorkspaceAndPurpose(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	t.Setenv("OPENAI_API_KEY", "never-copy-host-key")
	purpose := "Prepare a daily report.\n{{not_a_template}}\nservices:\n  malicious: true"
	op, err := m.Create(CreateAssistantRequest{Name: "reports", Purpose: purpose})
	if err != nil {
		t.Fatal(err)
	}
	if got := waitAssistantOperation(t, m, op); got.State != "succeeded" {
		t.Fatal(got.Error)
	}
	a, err := m.Get(context.Background(), "reports")
	if err != nil || a.State != "needs_connection" || !a.NeedsConnection || a.NodeID != "reports" {
		t.Fatalf("assistant: %+v, %v", a, err)
	}
	dir := filepath.Join(m.root, "reports")
	for path, mode := range map[string]os.FileMode{".": 0o700, ".env": 0o600, assistantMetadataFile: 0o600, "connection/term-llm/agents/reports/system.md": 0o600} {
		info, err := os.Stat(filepath.Join(dir, path))
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("private mode for %s: %v, %v", path, info, err)
		}
	}
	system, _ := os.ReadFile(filepath.Join(dir, "connection/term-llm/agents/reports/system.md"))
	if !strings.Contains(string(system), purpose) {
		t.Fatalf("purpose missing from actual system instructions: %s", system)
	}
	compose, _ := os.ReadFile(filepath.Join(dir, "compose.yaml"))
	for _, expected := range []string{"127.0.0.1:${WEB_PORT}:8081", "home:/home/agent", "workspace:/workspace", "connection/term-llm:/run/personal-bot-connection:ro"} {
		if !strings.Contains(string(compose), expected) {
			t.Fatalf("missing isolation setting %q", expected)
		}
	}
	env, _ := os.ReadFile(filepath.Join(dir, ".env"))
	if strings.Contains(string(env), "never-copy-host-key") {
		t.Fatal("host provider key leaked to assistant")
	}
	web, err := ReadWebConfig("reports")
	if err != nil || len(web.Token) != 64 || web.BasePath != "/chat" {
		t.Fatalf("Hub discovery: %+v, %v", web, err)
	}
	encoded, _ := json.Marshal(a)
	if strings.Contains(string(encoded), web.Token) || strings.Contains(string(encoded), m.root) {
		t.Fatalf("public response leaked private data: %s", encoded)
	}
}

func TestPersonalBotMetadataWriteReplacesSymlink(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	record, err := m.readRecord("helper")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "keep-private")
	if err := os.WriteFile(target, []byte("keep this content"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(m.root, "helper", assistantMetadataFile)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := m.writeRecord(record); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "keep this content" {
		t.Fatalf("metadata write changed linked target: %q, %v", data, err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("metadata was not replaced with a private regular file: %v, %v", info, err)
	}
}

func TestPersonalBotNameOwnershipAndPortReservation(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	for _, name := range []string{"../escape", "UPPER", "environment", "operations", "providers", "trailing-", strings.Repeat("a", 49)} {
		if _, err := m.Create(CreateAssistantRequest{Name: name, Purpose: "Work"}); !errors.Is(err, ErrAssistantInvalid) {
			t.Fatalf("name %q accepted: %v", name, err)
		}
	}
	writeComposeForDockerTest(t, "old.bot", "")
	op, err := m.Create(CreateAssistantRequest{Name: "old-bot", Purpose: "Work"})
	if err != nil {
		t.Fatal(err)
	}
	if result := waitAssistantOperation(t, m, op); result.State != "failed" || !strings.Contains(result.Error, "conflicts") {
		t.Fatalf("Compose project collision accepted: %+v", result)
	}
	if _, err := m.Start("old.bot"); err == nil {
		t.Fatal("unmanaged workspace accepted")
	}
	createTestAssistant(t, m, "one")
	createTestAssistant(t, m, "two")
	one, _ := ReadWebConfig("one")
	two, _ := ReadWebConfig("two")
	if one.Port == two.Port || one.Token == two.Token {
		t.Fatal("assistants shared their reserved port or login token")
	}
	if _, err := m.Create(CreateAssistantRequest{Name: "one", Purpose: "Replace"}); !errors.Is(err, ErrAssistantInvalid) {
		t.Fatalf("existing workspace not preserved: %v", err)
	}
}

func TestPersonalBotLifecycleAndConnections(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	if _, err := m.Start("helper"); !errors.Is(err, ErrAssistantInvalid) {
		t.Fatalf("start without connection: %v", err)
	}
	connectTestAssistant(t, m, "helper")
	for _, action := range []struct {
		call func(string) (Operation, error)
		tail []string
	}{{m.Start, []string{"up", "-d"}}, {m.Stop, []string{"stop"}}, {m.Restart, []string{"restart"}}} {
		op, err := action.call("helper")
		if err != nil {
			t.Fatal(err)
		}
		if got := waitAssistantOperation(t, m, op); got.State != "succeeded" {
			t.Fatal(got.Error)
		}
		args := runner.runs[len(runner.runs)-1]
		if !reflect.DeepEqual(args[len(args)-len(action.tail):], action.tail) {
			t.Fatalf("unexpected lifecycle command: %#v", args)
		}
	}
	runner.ps = []byte(`{"State":"running","Labels":"org.term-llm.contain.name=helper,org.term-llm.contain=true"}`)
	if err := m.CheckConnection("helper"); !errors.Is(err, ErrAssistantBusy) {
		t.Fatalf("running assistant allowed new connection: %v", err)
	}
	called := false
	_, err := m.WithConnection("helper", func(string) error { called = true; return nil })
	if !errors.Is(err, ErrAssistantBusy) || called {
		t.Fatalf("running assistant credentials changed: %v, %v", err, called)
	}
}

func TestPersonalBotUnavailableDockerPreservesRecordsAndRedactsErrors(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	runner.dockerError = errors.New("docker printed secret-api-key")
	assistants, err := m.List(context.Background())
	if len(assistants) != 1 || assistants[0].State != "needs_connection" || !errors.Is(err, ErrAssistantUnavailable) {
		t.Fatalf("saved assistants lost: %+v, %v", assistants, err)
	}
	if strings.Contains(err.Error(), "secret-api-key") {
		t.Fatal("Docker error leaked private output")
	}
	runner.dockerError = nil
	connectTestAssistant(t, m, "helper")
	runner.runError = errors.New("docker printed secret-api-key")
	op, err := m.Start("helper")
	if err != nil {
		t.Fatal(err)
	}
	result := waitAssistantOperation(t, m, op)
	if result.State != "failed" || strings.Contains(result.Error, "secret-api-key") {
		t.Fatalf("unsafe operation failure: %+v", result)
	}
}

func TestPersonalBotCloseCancelsAndBusyPreventsConcurrentMutation(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	connectTestAssistant(t, m, "helper")
	runner.block = true
	runner.started = make(chan struct{})
	op, err := m.Start("helper")
	if err != nil {
		t.Fatal(err)
	}
	<-runner.started
	if _, err := m.Stop("helper"); !errors.Is(err, ErrAssistantBusy) {
		t.Fatalf("concurrent lifecycle allowed: %v", err)
	}
	if err := m.CheckConnection("helper"); !errors.Is(err, ErrAssistantBusy) {
		t.Fatalf("concurrent credential change allowed: %v", err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if result, _ := m.Operation(op.ID); result.State != "failed" {
		t.Fatalf("shutdown left busy operation: %+v", result)
	}
}

func TestPersonalBotManagerLockAndInterruptedOperationRecovery(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	if second, err := NewManager(ManagerOptions{Runner: runner}); err == nil {
		second.Close()
		t.Fatal("two managers acquired the same assistant root")
	}
	record, err := m.readRecord("helper")
	if err != nil {
		t.Fatal(err)
	}
	record.Operation = newAssistantOperation("helper", "start")
	record.Assistant.OperationID = record.Operation.ID
	if err := m.writeRecord(record); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewManager(ManagerOptions{Runner: runner, Image: "test-personal-bot:local"})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	op, ok := reopened.Operation(record.Operation.ID)
	if !ok || op.State != "failed" || !strings.Contains(op.Error, "server restarted") {
		t.Fatalf("interrupted operation was not recovered: %+v", op)
	}
}

func TestPersonalBotBuildUsesConfiguredLinuxBinary(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	connectTestAssistant(t, m, "helper")
	// An ELF header is enough for platform inspection. Docker itself is faked.
	header := make([]byte, 64)
	copy(header, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(header[16:], 2)
	binary.LittleEndian.PutUint16(header[18:], 183)
	binary.LittleEndian.PutUint32(header[20:], 1)
	binary.LittleEndian.PutUint16(header[52:], 64)
	path := filepath.Join(t.TempDir(), "term-llm-linux")
	if err := os.WriteFile(path, header, 0o755); err != nil {
		t.Fatal(err)
	}
	m.opts.Image = ""
	m.opts.BinaryPath = path
	op, err := m.Start("helper")
	if err != nil {
		t.Fatal(err)
	}
	if result := waitAssistantOperation(t, m, op); result.State != "succeeded" {
		t.Fatal(result.Error)
	}
	if len(runner.runs) != 2 || !reflect.DeepEqual(runner.runs[0][:4], []string{"docker", "build", "--platform", "linux/arm64"}) {
		t.Fatalf("unexpected image build: %#v", runner.runs)
	}
	buildDir := runner.runs[0][len(runner.runs[0])-1]
	staged, _ := os.ReadFile(filepath.Join(buildDir, "term-llm"))
	if !reflect.DeepEqual(staged, header) || !strings.Contains(buildDir, "personal-bot-images") {
		t.Fatal("configured binary was not staged in dedicated image assets")
	}
	dockerfile, _ := os.ReadFile(filepath.Join(buildDir, "Dockerfile"))
	if strings.Contains(string(dockerfile), "releases") || !strings.Contains(string(dockerfile), "COPY term-llm") {
		t.Fatal("image downloads unrelated release instead of using server binary")
	}
}

func TestPersonalBotReloadWaitsForOperationSettlement(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	coordinator := &restart.Coordinator{InterruptAfter: time.Nanosecond}
	m.opts.Coordinator = coordinator
	createTestAssistant(t, m, "helper")
	connectTestAssistant(t, m, "helper")
	runner.block = true
	runner.started = make(chan struct{})
	op, err := m.Start("helper")
	if err != nil {
		t.Fatal(err)
	}
	<-runner.started
	settled := make(chan Operation, 1)
	unbind, err := coordinator.Bind(context.Background(), func(context.Context) error {
		result, _ := m.Operation(op.ID)
		settled <- result
		return errors.New("replacement intentionally not executed in test")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unbind()
	coordinator.Request()
	result := <-settled
	if result.State != "failed" || !strings.Contains(result.Error, "interrupted") {
		t.Fatalf("reload reached replacement before terminal persistence: %+v", result)
	}
}

func TestPersonalBotOperationHistoryIsBounded(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	latest := m.latest["helper"]
	for i := 0; i < 300; i++ {
		op := newAssistantOperation("helper", "stop")
		op.State = "succeeded"
		m.operations[op.ID] = op
	}
	running := newAssistantOperation("helper", "start")
	m.operations[running.ID] = running
	m.pruneOperations()
	if len(m.operations) != 258 {
		t.Fatalf("history retained %d operations, want 256 history + latest + running", len(m.operations))
	}
	if _, ok := m.operations[latest]; !ok {
		t.Fatal("latest persisted operation was evicted")
	}
	if _, ok := m.operations[running.ID]; !ok {
		t.Fatal("running operation was evicted")
	}
}

func TestPersonalBotFailedInitializationRemovesOnlyNewWorkspace(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	existing := writeComposeForDockerTest(t, "keep-existing", "")
	template := t.TempDir()
	if err := os.WriteFile(filepath.Join(template, "compose.yaml"), []byte("services:\n  assistant:\n    image: test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Force initialization to fail after CreateWorkspace succeeds, without
	// relying on filesystem permissions or the test process's user identity.
	if err := os.WriteFile(filepath.Join(template, "connection"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	record := assistantRecord{Version: 1, Assistant: ManagedAssistant{Name: "broken", Purpose: "Test"}}
	if err := m.renderWorkspace(record, template); err == nil {
		t.Fatal("expected profile initialization to fail")
	}
	if _, err := os.Stat(filepath.Join(m.root, "broken")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unusable workspace was left behind: %v", err)
	}
	if _, err := os.Stat(filepath.Join(existing, "compose.yaml")); err != nil {
		t.Fatalf("unrelated workspace was changed: %v", err)
	}
}

func TestPersonalBotFailedCreationCannotAdoptExistingWorkspace(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	dir := writeComposeForDockerTest(t, "external", "")
	op := newAssistantOperation("external", "create")
	record := assistantRecord{Version: 1, Operation: op, Assistant: ManagedAssistant{Name: "external", OperationID: op.ID}}
	m.finish(record, errors.New("workspace was created concurrently"))
	if _, err := os.Stat(filepath.Join(dir, assistantMetadataFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed creation claimed an external workspace: %v", err)
	}
	if _, err := m.Start("external"); !errors.Is(err, ErrAssistantNotFound) {
		t.Fatalf("external workspace became manageable: %v", err)
	}
}

func TestPersonalBotConnectionRequiresProvenStoppedContainer(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	for _, state := range []string{"running", "restarting", "paused", "removing", ""} {
		runner.ps, _ = json.Marshal(map[string]any{"State": state, "Labels": map[string]string{"org.term-llm.contain.name": "helper"}})
		if err := m.CheckConnection("helper"); !errors.Is(err, ErrAssistantBusy) {
			t.Fatalf("state %q allowed credential changes: %v", state, err)
		}
	}
	for _, state := range []string{"exited", "dead", "created"} {
		runner.ps, _ = json.Marshal(map[string]any{"State": state, "Labels": map[string]string{"org.term-llm.contain.name": "helper"}})
		if err := m.CheckConnection("helper"); err != nil {
			t.Fatalf("stopped state %q rejected: %v", state, err)
		}
	}
	if err := os.WriteFile(filepath.Join(m.root, "helper", "compose.yaml"), []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.CheckConnection("helper"); !errors.Is(err, ErrAssistantUnavailable) {
		t.Fatalf("invalid container definition accepted: %v", err)
	}
}
