package contain

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/credentials"
	"github.com/samsaffron/term-llm/internal/oauth"
)

func newTestSharedConnections(t *testing.T) (*SharedConnections, *Manager) {
	t.Helper()
	m, _ := newAssistantTestManager(t)
	b, err := NewSharedConnections(m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	b.session = func(string, string) (*credentials.ChatGPTCredentials, error) {
		return &credentials.ChatGPTCredentials{AccessToken: "short-lived-session", RefreshToken: "refresh-must-stay-private", AccountID: "account", ExpiresAt: time.Now().Add(time.Hour).Unix()}, nil
	}
	return b, m
}

func createSharedTestConnection(t *testing.T, b *SharedConnections, name string) SharedConnection {
	t.Helper()
	connection, err := b.CreateChatGPT(&oauth.ChatGPTCredentials{AccessToken: "source-access", RefreshToken: "source-refresh", AccountID: "account", ExpiresAt: time.Now().Add(time.Hour).Unix()}, name)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func bridgeToken(t *testing.T, bridge BridgeConnection) string {
	t.Helper()
	var value map[string]string
	if err := json.Unmarshal(bridge.Data, &value); err != nil {
		t.Fatal(err)
	}
	return value["token"]
}

func brokerRequest(t *testing.T, b *SharedConnections, token, path, body string) (int, []byte) {
	t.Helper()
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(b.ca) {
		t.Fatal("invalid broker CA")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	request, _ := http.NewRequest(http.MethodPost, b.brokerURL()+path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("credential response can be cached")
	}
	return response.StatusCode, data
}

func TestSharedConnectionTLSIssuesOnlyScopedAccessSession(t *testing.T) {
	b, _ := newTestSharedConnections(t)
	connection := createSharedTestConnection(t, b, "Work account")
	bridge, err := b.Attach("helper", connection.ID, "model")
	if err != nil {
		t.Fatal(err)
	}
	var rejected string
	b.session = func(path, value string) (*credentials.ChatGPTCredentials, error) {
		rejected = value
		if path != filepath.Join(b.root, connection.ID+".json") {
			t.Fatalf("wrong refresh authority: %s", path)
		}
		return &credentials.ChatGPTCredentials{AccessToken: "new-access", RefreshToken: "never-export-refresh", AccountID: "account", ExpiresAt: time.Now().Add(time.Hour).Unix()}, nil
	}
	status, data := brokerRequest(t, b, bridgeToken(t, bridge), "/session", `{"rejected_access_token":"old-access"}`)
	if status != http.StatusOK || rejected != "old-access" || !bytes.Contains(data, []byte("new-access")) || bytes.Contains(data, []byte("refresh")) {
		t.Fatalf("unsafe session response %d: %s", status, data)
	}
	for _, path := range []string{"/connections", "/session/other", "/"} {
		if status, _ := brokerRequest(t, b, bridgeToken(t, bridge), path, `{}`); status != http.StatusNotFound {
			t.Fatalf("broker exposed management route %s: %d", path, status)
		}
	}
	if status, _ := brokerRequest(t, b, bridgeToken(t, bridge), "/session", `{"connection_id":"another-account"}`); status != http.StatusBadRequest {
		t.Fatal("caller could select a different source")
	}
	stored, _ := os.ReadFile(filepath.Join(b.root, "broker.json"))
	if bytes.Contains(stored, []byte("source-refresh")) || bytes.Contains(stored, []byte(bridgeToken(t, bridge))) {
		t.Fatal("broker index stored refresh credentials or a plaintext worker token")
	}
	for _, file := range []string{"broker.json", "server-key.pem", connection.ID + ".json"} {
		info, err := os.Stat(filepath.Join(b.root, file))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("private broker file %s has unsafe mode: %v", file, err)
		}
	}
}

type forbiddenBodyRead struct{ t *testing.T }

func (r forbiddenBodyRead) Read([]byte) (int, error) {
	r.t.Fatal("unauthorized request body was read")
	return 0, io.EOF
}
func (r forbiddenBodyRead) Close() error { return nil }

func TestSharedConnectionRejectsBeforeBodyAndBoundsAuthorizedInput(t *testing.T) {
	b, _ := newTestSharedConnections(t)
	request := httptest.NewRequest(http.MethodPost, "/session", nil)
	request.Body = forbiddenBodyRead{t}
	response := httptest.NewRecorder()
	b.serveSession(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", response.Code)
	}
	connection := createSharedTestConnection(t, b, "Work")
	bridge, err := b.Attach("helper", connection.ID, "model")
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`null`, `[]`, `{} {}`, `{"rejected_access_token":"` + strings.Repeat("a", 40<<10) + `"}`, `{"unknown":true}`} {
		status, _ := brokerRequest(t, b, bridgeToken(t, bridge), "/session", body)
		if status != http.StatusBadRequest {
			t.Fatalf("invalid body accepted: %d", status)
		}
	}
}

func TestSharedConnectionTokenRotationRollbackAndRestart(t *testing.T) {
	b, manager := newTestSharedConnections(t)
	connection := createSharedTestConnection(t, b, "Work")
	first, err := b.Attach("helper", connection.ID, "model")
	if err != nil {
		t.Fatal(err)
	}
	second, err := b.Attach("helper", connection.ID, "model")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := b.authorize(bridgeToken(t, first)); ok {
		t.Fatal("replaced worker token still accepted")
	}
	if err := b.RollbackAttachment(second); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.authorize(bridgeToken(t, first)); !ok {
		t.Fatal("failed seed write did not restore prior worker token")
	}
	port, ca := b.state.Port, string(b.ca)
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewSharedConnections(manager)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.state.Port != port || string(reopened.ca) != ca {
		t.Fatal("restart changed durable broker address or trust root")
	}
	if _, ok := reopened.authorize(bridgeToken(t, first)); !ok {
		t.Fatal("restart lost worker authorization")
	}
	if err := reopened.Detach("helper"); err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.authorize(bridgeToken(t, first)); ok {
		t.Fatal("detached worker token still accepted")
	}
}

func TestSharedConnectionHostImportReferencesOriginalAuthority(t *testing.T) {
	b, _ := newTestSharedConnections(t)
	path, err := credentials.ChatGPTCredentialsPath()
	if err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"access_token":"host-access","refresh_token":"host-refresh","account_id":"host","expires_at":9999999999}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	var resolved string
	b.session = func(path, _ string) (*credentials.ChatGPTCredentials, error) {
		resolved = path
		return &credentials.ChatGPTCredentials{AccessToken: "host-access", RefreshToken: "host-refresh", AccountID: "host", ExpiresAt: time.Now().Add(time.Hour).Unix()}, nil
	}
	sources, err := b.ImportSources(context.Background())
	if err != nil || len(sources) != 1 || !sources[0].Available || strings.Contains(sources[0].ID, path) {
		t.Fatalf("host sources: %+v, %v", sources, err)
	}
	connection, err := b.Import(context.Background(), sources[0].ID, "Existing work sign-in")
	if err != nil || resolved != path {
		t.Fatalf("source authority was not used: %q, %v", resolved, err)
	}
	duplicate, err := b.Import(context.Background(), sources[0].ID, "Duplicate")
	if err != nil || duplicate.ID != connection.ID {
		t.Fatalf("source import not deduplicated: %+v, %v", duplicate, err)
	}
	stored, _ := os.ReadFile(filepath.Join(b.root, "broker.json"))
	if bytes.Contains(stored, []byte("host-refresh")) || bytes.Contains(stored, []byte("host-access")) {
		t.Fatal("host credentials were copied into broker index")
	}
	if _, err := os.Stat(filepath.Join(b.root, connection.ID+".json")); !os.IsNotExist(err) {
		t.Fatal("host import copied refresh authority to a second file")
	}
	if _, err := b.Import(context.Background(), "../../untrusted-path", "Wrong"); !errors.Is(err, ErrAssistantNotFound) {
		t.Fatalf("arbitrary import source accepted: %v", err)
	}
}

func TestSharedConnectionErrorsNeverExposeSourceSecrets(t *testing.T) {
	b, _ := newTestSharedConnections(t)
	connection := createSharedTestConnection(t, b, "Work")
	bridge, err := b.Attach("helper", connection.ID, "model")
	if err != nil {
		t.Fatal(err)
	}
	b.session = func(string, string) (*credentials.ChatGPTCredentials, error) {
		return nil, errors.New("secret-refresh-and-host-path")
	}
	status, data := brokerRequest(t, b, bridgeToken(t, bridge), "/session", `{}`)
	if status != http.StatusBadGateway || bytes.Contains(data, []byte("secret-refresh")) || bytes.Contains(data, []byte(b.root)) {
		t.Fatalf("unsafe error response: %d %s", status, data)
	}
}

func TestSharedConnectionSessionConcurrencyIsBoundedAndWaitIsCancellable(t *testing.T) {
	b, _ := newTestSharedConnections(t)
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	b.session = func(string, string) (*credentials.ChatGPTCredentials, error) {
		entered <- struct{}{}
		<-release
		return &credentials.ChatGPTCredentials{AccessToken: "session", AccountID: "account", ExpiresAt: time.Now().Add(time.Hour).Unix()}, nil
	}
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, _ = b.resolveSession(context.Background(), sharedSource{Kind: "file", Path: "/test-authority"}, "")
		}()
	}
	for i := 0; i < 8; i++ {
		<-entered
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.resolveSession(ctx, sharedSource{Kind: "file", Path: "/test-authority"}, ""); err == nil {
		t.Fatal("cancelled ninth session entered the source authority")
	}
	select {
	case <-entered:
		t.Fatal("more than eight concurrent source sessions were admitted")
	default:
	}
	close(release)
	workers.Wait()
	if len(b.slots) != 0 {
		t.Fatal("completed sessions leaked broker slots")
	}
	b.manager.buildMu.Lock()
	defer b.manager.buildMu.Unlock()
	if _, err := b.helperImage(ctx); err == nil {
		t.Fatal("cancelled image-lock waiter was admitted")
	}
}
