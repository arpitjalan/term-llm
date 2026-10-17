package contain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/oauth"
	"gopkg.in/yaml.v3"
)

type fakeConnectionWorkspace struct {
	dir      string
	checkErr error
	saveErr  error
	saves    int
}

func (f *fakeConnectionWorkspace) ConnectionDir(name string) (string, error) {
	if name != "assistant" {
		return "", ErrAssistantNotFound
	}
	return f.dir, nil
}

func (f *fakeConnectionWorkspace) CheckConnection(name string) error {
	if _, err := f.ConnectionDir(name); err != nil {
		return err
	}
	return f.checkErr
}

func (f *fakeConnectionWorkspace) WithConnection(name string, save func(string) error) (ManagedAssistant, error) {
	if err := f.CheckConnection(name); err != nil {
		return ManagedAssistant{}, err
	}
	if f.saveErr != nil {
		return ManagedAssistant{}, f.saveErr
	}
	if err := save(f.dir); err != nil {
		return ManagedAssistant{}, err
	}
	f.saves++
	return ManagedAssistant{Name: name}, nil
}

func testConnectionService(t *testing.T) (*ConnectionService, *fakeConnectionWorkspace) {
	t.Helper()
	workspace := &fakeConnectionWorkspace{dir: t.TempDir()}
	service := newConnectionService(workspace)
	service.shared, _ = newTestSharedConnections(t)
	service.request = func(context.Context) (*oauth.ChatGPTDeviceCode, error) {
		return &oauth.ChatGPTDeviceCode{VerificationURL: oauth.ChatGPTDeviceVerificationURL, UserCode: "TEST-CODE"}, nil
	}
	service.authenticate = func(context.Context, *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error) {
		return nil, errors.New("unexpected authentication call")
	}
	t.Cleanup(service.Close)
	return service, workspace
}

func assertPrivateConnectionFile(t *testing.T, dir, name string) []byte {
	t.Helper()
	path := filepath.Join(dir, name)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("%s mode = %o; want 600", name, info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertNoConnectionSecrets(t *testing.T, status ConnectionStatus, secrets ...string) {
	t.Helper()
	data, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range secrets {
		if strings.Contains(string(data), secret) {
			t.Fatal("connection response exposed a credential")
		}
	}
}

func TestConnectionAPIKeyIsPrivateAndExplicitlyUnverified(t *testing.T) {
	service, workspace := testConnectionService(t)
	// A fake host configuration must neither be read nor changed by onboarding.
	hostDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", hostDir)
	t.Setenv("OPENAI_API_KEY", "host-key-must-not-be-used")
	if err := os.WriteFile(filepath.Join(hostDir, "sentinel"), []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, err := service.SaveAPIKey("assistant", "openai", "", "test-private-api-key")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "saved_unverified" || status.Provider != "openai" || status.Model != config.DefaultProviderModel("openai") {
		t.Fatalf("unexpected status: %+v", status)
	}
	assertNoConnectionSecrets(t, status, "test-private-api-key", "host-key-must-not-be-used")
	data := assertPrivateConnectionFile(t, workspace.dir, "config.yaml")
	var cfg struct {
		DefaultProvider   string `yaml:"default_provider"`
		ProviderDiscovery string `yaml:"provider_discovery"`
		Providers         map[string]struct {
			Model  string `yaml:"model"`
			APIKey string `yaml:"api_key"`
		} `yaml:"providers"`
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultProvider != "openai" || cfg.ProviderDiscovery != "config" || cfg.Providers["openai"].APIKey != "test-private-api-key" || len(cfg.Providers) != 1 {
		t.Fatal("saved configuration did not isolate the selected provider")
	}
	assertPrivateConnectionFile(t, workspace.dir, connectionStateFile)
	entries, err := os.ReadDir(hostDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "sentinel" {
		t.Fatal("provider setup changed host configuration")
	}
	// Status survives Hub restart without retaining secrets in memory.
	restarted := newConnectionService(workspace)
	defer restarted.Close()
	got, err := restarted.Status("assistant")
	if err != nil || got.State != "saved_unverified" || got.Provider != "openai" {
		t.Fatalf("restored status = %+v, %v", got, err)
	}
}

func TestConnectionRejectsReferencesAndInvalidInputWithoutWrites(t *testing.T) {
	for _, tc := range []struct{ name, provider, model, key string }{
		{"provider", "debug", "", "test-api-key"},
		{"key command", "openai", "", "$(secret-command)"},
		{"key variable", "openai", "", "${OPENAI_API_KEY}"},
		{"key file", "openai", "", "file:///host/secret"},
		{"key newline", "openai", "", "test-api\nkey"},
		{"key oversized", "openai", "", strings.Repeat("k", 4097)},
		{"key short", "openai", "", "key"},
		{"model command", "openai", "$(host-command)", "test-api-key"},
		{"model oversized", "openai", strings.Repeat("m", 257), "test-api-key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, workspace := testConnectionService(t)
			_, err := service.SaveAPIKey("assistant", tc.provider, tc.model, tc.key)
			if !errors.Is(err, ErrAssistantInvalid) || workspace.saves != 0 {
				t.Fatalf("invalid input: err=%v writes=%d", err, workspace.saves)
			}
			entries, _ := os.ReadDir(workspace.dir)
			if len(entries) != 0 {
				t.Fatal("invalid input wrote files")
			}
		})
	}
}

func TestConnectionSwitchRemovesOldOAuthAndPreservesProfile(t *testing.T) {
	service, workspace := testConnectionService(t)
	if err := os.WriteFile(filepath.Join(workspace.dir, "chatgpt_oauth.json"), []byte("old-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace.dir, "agents"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveAPIKey("assistant", "anthropic", "", "test-api-key"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(workspace.dir, "chatgpt_oauth.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old OAuth seed was retained")
	}
	if _, err := os.Stat(filepath.Join(workspace.dir, "agents")); err != nil {
		t.Fatal("assistant profile was removed")
	}
}

func TestConnectionUnsafeSeedFailsBeforeChangingPriorConfig(t *testing.T) {
	service, workspace := testConnectionService(t)
	if _, err := service.SaveAPIKey("assistant", "openai", "", "original-api-key"); err != nil {
		t.Fatal(err)
	}
	original := assertPrivateConnectionFile(t, workspace.dir, "config.yaml")
	outside := filepath.Join(t.TempDir(), "credential")
	if err := os.WriteFile(outside, []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace.dir, "chatgpt_oauth.json")); err != nil {
		t.Fatal(err)
	}
	_, err := service.SaveAPIKey("assistant", "anthropic", "", "replacement-api-key")
	if !errors.Is(err, ErrAssistantUnavailable) || strings.Contains(err.Error(), "outside-secret") {
		t.Fatalf("unsafe seed error = %v", err)
	}
	if got := assertPrivateConnectionFile(t, workspace.dir, "config.yaml"); string(got) != string(original) {
		t.Fatal("failed switch changed prior configuration")
	}
	got, _ := os.ReadFile(outside)
	if string(got) != "outside-secret" {
		t.Fatal("followed credential symlink")
	}
}

func TestConnectionWorkspaceAndClosedServiceGuardWrites(t *testing.T) {
	service, workspace := testConnectionService(t)
	if _, err := service.SaveAPIKey("unmanaged", "openai", "", "test-api-key"); !errors.Is(err, ErrAssistantNotFound) {
		t.Fatalf("unknown workspace: %v", err)
	}
	workspace.checkErr = ErrAssistantBusy
	if _, err := service.SaveAPIKey("assistant", "openai", "", "test-api-key"); !errors.Is(err, ErrAssistantBusy) {
		t.Fatalf("running workspace: %v", err)
	}
	service.Close()
	if _, err := service.SaveAPIKey("assistant", "openai", "", "test-api-key"); !errors.Is(err, ErrAssistantUnavailable) {
		t.Fatalf("closed service: %v", err)
	}
	if workspace.saves != 0 {
		t.Fatal("guard allowed a credential write")
	}
}

func TestConnectionProvidersUseBuiltInDefaults(t *testing.T) {
	providers := ConnectionProviders()
	if len(providers) != 3 {
		t.Fatalf("got %d provider choices", len(providers))
	}
	for _, provider := range providers {
		if provider.DefaultModel != config.DefaultProviderModel(provider.ID) || len(provider.Models) == 0 {
			t.Fatalf("provider missing built-in model defaults: %+v", provider)
		}
	}
}

func testChatGPTCredentials() *oauth.ChatGPTCredentials {
	return &oauth.ChatGPTCredentials{AccessToken: "private-test-access-token", RefreshToken: "private-test-refresh-token", ExpiresAt: time.Now().Add(time.Hour).Unix(), AccountID: "test-account"}
}

func awaitConnectionContext(t *testing.T, channel <-chan context.Context) context.Context {
	t.Helper()
	select {
	case ctx := <-channel:
		return ctx
	case <-time.After(5 * time.Second):
		t.Fatal("device worker did not start")
		return nil
	}
}

func mustStartConnection(t *testing.T, service *ConnectionService) ConnectionStatus {
	t.Helper()
	status, err := service.StartChatGPT(context.Background(), "assistant", "")
	if err != nil || status.Flow == nil || status.Flow.State != "pending" {
		t.Fatalf("start status=%+v error=%v", status, err)
	}
	return status
}

func connectionStatus(t *testing.T, service *ConnectionService, state string) ConnectionStatus {
	t.Helper()
	status, err := service.Status("assistant")
	if err != nil || status.Flow == nil || status.Flow.State != state {
		t.Fatalf("expected %s: status=%+v err=%v", state, status, err)
	}
	assertNoConnectionSecrets(t, status, "private-test-access-token", "private-test-refresh-token")
	return status
}

func TestConnectionDeviceFlowOutlivesRequestAndPersistsPrivateCredentials(t *testing.T) {
	service, workspace := testConnectionService(t)
	started := make(chan context.Context, 1)
	finish := make(chan struct{})
	service.authenticate = func(ctx context.Context, _ *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error) {
		started <- ctx
		select {
		case <-finish:
			return testChatGPTCredentials(), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	requestCtx, cancel := context.WithCancel(context.Background())
	status, err := service.StartChatGPT(requestCtx, "assistant", "")
	if err != nil || status.Flow == nil || status.Flow.UserCode != "TEST-CODE" || status.Flow.VerificationURL != oauth.ChatGPTDeviceVerificationURL {
		t.Fatalf("device start = %+v, %v", status, err)
	}
	ctx := awaitConnectionContext(t, started)
	cancel()
	if ctx.Err() != nil {
		t.Fatal("browser request cancellation stopped provider sign-in")
	}
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > deviceConnectionLifetime {
		t.Fatal("device flow lacks bounded lifetime")
	}
	close(finish)
	service.wg.Wait()
	status = connectionStatus(t, service, "succeeded")
	if status.State != "authorized" || status.Provider != "chatgpt" || status.Flow.UserCode != "" || status.Flow.VerificationURL != "" {
		t.Fatalf("completed status = %+v", status)
	}
	if status.ConnectionID == "" || status.ConnectionName == "" {
		t.Fatal("device sign-in did not assign a reusable connection")
	}
	data := assertPrivateConnectionFile(t, service.shared.root, status.ConnectionID+".json")
	var saved oauth.ChatGPTCredentials
	if err := json.Unmarshal(data, &saved); err != nil || saved.RefreshToken != testChatGPTCredentials().RefreshToken {
		t.Fatal("OAuth credentials were not stored at the shared authority")
	}
	if _, err := os.Stat(filepath.Join(workspace.dir, "chatgpt_oauth.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("OAuth credentials were copied into the worker seed")
	}
	bridgeData := assertPrivateConnectionFile(t, workspace.dir, "chatgpt_connection.json")
	var bridge struct{ Token string }
	if err := json.Unmarshal(bridgeData, &bridge); err != nil {
		t.Fatal(err)
	}
	if _, ok := service.shared.authorize(bridge.Token); !ok {
		t.Fatal("device sign-in did not authorize its worker connection")
	}
	assertNoConnectionSecrets(t, status, bridge.Token)
	assertPrivateConnectionFile(t, workspace.dir, "config.yaml")
}

func TestConnectionDeviceCancelAndReplacementSuppressStaleSuccess(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(fmt.Sprint("replace=", replace), func(t *testing.T) {
			service, workspace := testConnectionService(t)
			finish := make(chan struct{})
			started := make(chan context.Context, 1)
			service.authenticate = func(ctx context.Context, _ *oauth.ChatGPTDeviceCode) (*oauth.ChatGPTCredentials, error) {
				started <- ctx
				<-finish // Simulate a network completion racing with cancellation.
				return testChatGPTCredentials(), nil
			}
			status := mustStartConnection(t, service)
			ctx := awaitConnectionContext(t, started)
			if _, err := service.Cancel("assistant", "stale-id"); !errors.Is(err, ErrAssistantBusy) {
				t.Fatalf("stale cancellation error = %v", err)
			}
			if replace {
				_, err := service.SaveAPIKey("assistant", "openai", "", "replacement-api-key")
				if err != nil {
					t.Fatal(err)
				}
			} else if _, err := service.Cancel("assistant", status.Flow.ID); err != nil {
				t.Fatal(err)
			}
			if !errors.Is(ctx.Err(), context.Canceled) {
				t.Fatal("worker not cancelled")
			}
			close(finish)
			service.wg.Wait()
			status = connectionStatus(t, service, "cancelled")
			if _, err := os.Stat(filepath.Join(workspace.dir, "chatgpt_oauth.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("stale OAuth result overwrote connection")
			}
			if replace && status.Provider != "openai" {
				t.Fatal("replacement connection lost")
			}
		})
	}
}
