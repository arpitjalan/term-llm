package contain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/credentials"
	"github.com/samsaffron/term-llm/internal/filelock"
)

func TestSharedConnectionFileSessionCancellationReleasesBrokerSlot(t *testing.T) {
	b, _ := newTestSharedConnections(t)
	connection := createSharedTestConnection(t, b, "Cancellation fixture")
	source := b.state.Connections[connection.ID].Source
	unlock, err := filelock.Lock(source.Path + ".refresh.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	entered := make(chan struct{})
	b.session = func(ctx context.Context, path, rejected string) (*credentials.ChatGPTCredentials, error) {
		close(entered)
		return credentials.ChatGPTSessionAt(ctx, path, rejected)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := b.resolveSession(ctx, source, ""); result <- err }()
	<-entered
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled broker request returned a session")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled request remained blocked by the source credential lock")
	}
	if len(b.slots) != 0 {
		t.Fatal("cancelled request retained broker capacity")
	}
}

type sharedVolumeTestRunner struct {
	volumeAvailable bool
	helperResponse  []byte
	helperError     error
	runs            [][]string
	inputs          [][]byte
}

func (r *sharedVolumeTestRunner) Output(_ context.Context, _ string, args []string, _ RunOptions) ([]byte, error) {
	switch args[0] {
	case "ps":
		return []byte(`{"Names":"sammy-app-1","State":"exited","Labels":"org.term-llm.contain=true,org.term-llm.contain.name=sammy,org.term-llm.contain.user=agent"}`), nil
	case "inspect":
		return []byte(`{"labels":{"org.term-llm.contain":"true","org.term-llm.contain.name":"sammy","org.term-llm.contain.user":"agent"},"mounts":[{"Type":"volume","Name":"original-sammy-home","Destination":"/home/agent"}]}`), nil
	case "volume":
		if !r.volumeAvailable {
			return nil, errors.New("volume missing")
		}
		return []byte("original-sammy-home"), nil
	default:
		return nil, nil
	}
}

func (r *sharedVolumeTestRunner) Run(_ context.Context, _ string, args []string, opts RunOptions) error {
	r.runs = append(r.runs, append([]string(nil), args...))
	if args[0] == "rm" {
		return nil
	}
	data, err := io.ReadAll(opts.Stdin)
	if err != nil {
		return err
	}
	r.inputs = append(r.inputs, data)
	if r.helperError != nil {
		return r.helperError
	}
	_, err = io.Copy(opts.Stdout, bytes.NewReader(r.helperResponse))
	return err
}

func volumeSharedFixture(t *testing.T) (*SharedConnections, *sharedVolumeTestRunner, string) {
	t.Helper()
	b, manager := newTestSharedConnections(t)
	dir := writeComposeForDockerTest(t, "sammy", "")
	runner := &sharedVolumeTestRunner{volumeAvailable: true}
	runner.helperResponse, _ = json.Marshal(map[string]any{"access_token": "volume-access", "account_id": "volume-account", "expires_at": time.Now().Add(time.Hour).Unix()})
	manager.opts.Runner = runner
	b.session = func(context.Context, string, string) (*credentials.ChatGPTCredentials, error) {
		t.Fatal("volume source used host credential file")
		return nil, nil
	}
	return b, runner, dir
}

func findVolumeImport(t *testing.T, b *SharedConnections) ConnectionImportSource {
	t.Helper()
	sources, err := b.ImportSources(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range sources {
		if source.Kind == "assistant" && source.Name == "sammy" {
			return source
		}
	}
	t.Fatalf("original assistant missing from sources: %+v", sources)
	return ConnectionImportSource{}
}

func TestSharedConnectionVolumeImportUsesOriginalHomeAndCleansHelper(t *testing.T) {
	b, runner, _ := volumeSharedFixture(t)
	source := findVolumeImport(t, b)
	connection, err := b.Import(context.Background(), source.ID, "Sammy's sign-in")
	if err != nil {
		t.Fatal(err)
	}
	record := b.state.Connections[connection.ID]
	if record.Source.Kind != "volume" || record.Source.Volume != "original-sammy-home" || record.Source.Path != "" {
		t.Fatalf("source authority was copied or replaced: %+v", record.Source)
	}
	if len(runner.runs) != 2 || runner.runs[0][0] != "run" || runner.runs[1][0] != "rm" {
		t.Fatalf("helper was not scoped and cleaned: %#v", runner.runs)
	}
	command := strings.Join(runner.runs[0], " ")
	for _, expected := range []string{"--interactive", "--pull never", "--user 1000:1000", "type=volume,source=original-sammy-home,target=/home/agent", "--entrypoint /usr/local/bin/term-llm", "auth chatgpt-session"} {
		if !strings.Contains(command, expected) {
			t.Fatalf("helper missing required setting %q: %s", expected, command)
		}
	}
	if strings.Contains(command, "volume-access") || strings.Contains(command, b.root) {
		t.Fatal("helper command contains credentials or broker file authority")
	}
	if _, err := b.resolveSession(context.Background(), record.Source, "rejected-session"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(runner.inputs[len(runner.inputs)-1], []byte("rejected-session")) {
		t.Fatal("rejected access token was not sent privately on stdin")
	}
	if strings.Contains(strings.Join(runner.runs[len(runner.runs)-2], " "), "rejected-session") {
		t.Fatal("rejected session leaked to process arguments")
	}
	runner.volumeAvailable = false
	before := len(runner.runs)
	if _, err := b.resolveSession(context.Background(), record.Source, ""); err == nil || len(runner.runs) != before {
		t.Fatal("missing source volume was recreated by helper")
	}
}

func TestSharedConnectionVolumeHelperRejectsUnexpectedOrOversizedSecrets(t *testing.T) {
	for _, response := range [][]byte{
		[]byte(`{"access_token":"a","refresh_token":"must-not-export","account_id":"account","expires_at":9999999999}`),
		[]byte(strings.Repeat("a", 65<<10)),
		[]byte(`{"access_token":"a","account_id":"account","expires_at":9999999999} {}`),
	} {
		b, runner, _ := volumeSharedFixture(t)
		runner.helperResponse = response
		_, err := b.Import(context.Background(), findVolumeImport(t, b).ID, "Work")
		if err == nil || strings.Contains(err.Error(), "must-not-export") {
			t.Fatalf("unsafe helper output accepted: %v", err)
		}
		if len(runner.runs) != 2 || runner.runs[1][0] != "rm" {
			t.Fatal("failed helper was not cleaned")
		}
		_ = b.Close()
		_ = b.manager.Close()
	}
}

func TestSharedConnectionDoesNotImportBrokerWorkersRecursively(t *testing.T) {
	b, _, dir := volumeSharedFixture(t)
	seed := filepath.Join(dir, "connection", "term-llm")
	if err := os.MkdirAll(seed, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(seed, connectionStateFile), []byte(`{"connection_id":"already-shared"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sources, err := b.ImportSources(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range sources {
		if source.Kind == "assistant" {
			t.Fatal("broker worker offered as independent sign-in authority")
		}
	}
}
