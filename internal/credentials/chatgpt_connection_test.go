package credentials

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/oauth"
)

func writeTestChatGPTConnection(t *testing.T, server *httptest.Server) string {
	t.Helper()
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	cfg := chatGPTConnectionConfig{URL: server.URL + "/connection", Token: "private-bearer", CACert: string(cert)}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "connection.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(chatGPTConnectionEnv, path)
	return path
}

func TestChatGPTConnectionRoutesAllCredentialOperations(t *testing.T) {
	t.Setenv(chatGPTConnectionEnv, "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	local := &ChatGPTCredentials{AccessToken: "local-access", RefreshToken: "local-refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	if err := SaveChatGPTCredentials(local); err != nil {
		t.Fatal(err)
	}
	localPath, _ := ChatGPTCredentialsPath()
	before, _ := os.ReadFile(localPath)
	rejected := make(chan string, 3)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connection/session" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer private-bearer" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected session request: %s %s", r.Method, r.URL.Path)
		}
		var req struct {
			Rejected string `json:"rejected_access_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		rejected <- req.Rejected
		_ = json.NewEncoder(w).Encode(ChatGPTSession{AccessToken: "remote-access", ExpiresAt: time.Now().Add(time.Hour).Unix(), AccountID: "remote-account"})
	}))
	defer server.Close()
	writeTestChatGPTConnection(t, server)
	// A configured system proxy must never receive bearer/session credentials.
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	if !ChatGPTCredentialsExist() || !ChatGPTConnectionConfigured() {
		t.Fatal("private connection was not recognized")
	}
	creds, err := GetChatGPTCredentials()
	if err != nil || creds.RefreshToken != "" || creds.AccessToken != "remote-access" || creds.AccountID != "remote-account" {
		t.Fatalf("shared credentials = %#v, %v", creds, err)
	}
	if err := RefreshChatGPTCredentials(creds); err != nil {
		t.Fatal(err)
	}
	if err := RefreshRejectedChatGPTCredentials(creds, "old-access"); err != nil {
		t.Fatal(err)
	}
	gotRejected := []string{<-rejected, <-rejected, <-rejected}
	if !reflect.DeepEqual(gotRejected, []string{"", "remote-access", "old-access"}) {
		t.Fatalf("rejections = %v", gotRejected)
	}
	if err := SaveChatGPTCredentials(local); err == nil {
		t.Fatal("worker saved local credentials")
	}
	if err := ClearChatGPTCredentials(); err == nil {
		t.Fatal("worker could clear credentials")
	}
	if err := ClearChatGPTCredentialsIfRefreshToken("local-refresh"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(localPath)
	if string(before) != string(after) {
		t.Fatal("worker mutated existing local credentials")
	}
	t.Setenv(chatGPTConnectionEnv, filepath.Join(t.TempDir(), "missing.json"))
	if _, err := GetChatGPTCredentials(); err == nil {
		t.Fatal("unavailable bridge fell back to existing local credentials")
	}
}

func TestChatGPTConnectionConcurrentWorkersAdoptSingleRefresh(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source.json")
	if err := saveChatGPTCredentials(source, &ChatGPTCredentials{AccessToken: "rejected-access", RefreshToken: "source-only-refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	oldRefresh := refreshChatGPTToken
	t.Cleanup(func() { refreshChatGPTToken = oldRefresh })
	var exchanges atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	refreshChatGPTToken = func(_ context.Context, token string) (*oauth.ChatGPTTokenResponse, error) {
		if token != "source-only-refresh" {
			return nil, fmt.Errorf("wrong source generation")
		}
		if exchanges.Add(1) == 1 {
			close(entered)
		}
		<-release
		return &oauth.ChatGPTTokenResponse{AccessToken: "replacement-access", RefreshToken: "source-only-rotated", ExpiresIn: 3600}, nil
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Rejected string `json:"rejected_access_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		creds, err := ChatGPTSessionAt(r.Context(), source, request.Rejected)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(ChatGPTSession{AccessToken: creds.AccessToken, ExpiresAt: creds.ExpiresAt, AccountID: creds.AccountID})
	}))
	defer server.Close()
	writeTestChatGPTConnection(t, server)
	first := &ChatGPTCredentials{AccessToken: "rejected-access"}
	second := &ChatGPTCredentials{AccessToken: "rejected-access"}
	errs := make(chan error, 2)
	go func() { errs <- RefreshRejectedChatGPTCredentials(first, first.AccessToken) }()
	<-entered
	go func() { errs <- RefreshRejectedChatGPTCredentials(second, second.AccessToken) }()
	close(release)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if exchanges.Load() != 1 {
		t.Fatalf("refresh exchanges = %d", exchanges.Load())
	}
	for _, worker := range []*ChatGPTCredentials{first, second} {
		if worker.AccessToken != "replacement-access" || worker.RefreshToken != "" {
			t.Fatalf("worker session = %#v", worker)
		}
	}
	stored, err := readChatGPTCredentials(source)
	if err != nil || stored.RefreshToken != "source-only-rotated" {
		t.Fatalf("source = %#v, %v", stored, err)
	}
}

func TestChatGPTConnectionRejectsUnsafeResponses(t *testing.T) {
	valid := fmt.Sprintf(`{"access_token":"access","expires_at":%d,"account_id":"account"}`, time.Now().Add(time.Hour).Unix())
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"refresh token", strings.TrimSuffix(valid, "}") + `,"refresh_token":"secret-refresh"}`, 200},
		{"trailing", valid + ` {}`, 200},
		{"null", "null", 200},
		{"oversize", strings.Repeat("x", 65537), 200},
		{"expired", `{"access_token":"access","expires_at":1}`, 200},
		{"empty", `{}`, 200},
		{"secret error", `secret-refresh private-bearer`, 401},
		{"server error", `secret-refresh`, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			writeTestChatGPTConnection(t, server)
			_, err := GetChatGPTCredentials()
			if err == nil {
				t.Fatal("unsafe response accepted")
			}
			for _, secret := range []string{"secret-refresh", "private-bearer", server.URL} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("error leaked %q: %v", secret, err)
				}
			}
		})
	}
}

func TestChatGPTConnectionPinsAuthorityAndNeverRedirects(t *testing.T) {
	var received atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { received.Add(1); _, _ = io.WriteString(w, `{}`) }))
	defer target.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	writeTestChatGPTConnection(t, server)
	if _, err := GetChatGPTCredentials(); err == nil {
		t.Fatal("redirect accepted")
	}
	if received.Load() != 0 {
		t.Fatal("private session request followed redirect")
	}
	client, err := newChatGPTConnectionClient(string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})))
	if err != nil {
		t.Fatal(err)
	}
	transport := client.Transport.(*http.Transport)
	if transport.Proxy != nil || client.Timeout <= 0 || transport.TLSClientConfig.RootCAs == nil || transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("unsafe connection transport")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, public, private)
	if err != nil {
		t.Fatal(err)
	}
	path := writeTestChatGPTConnection(t, target)
	cfg, err := readChatGPTConnectionConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.CACert = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	target.Config.ErrorLog = log.New(io.Discard, "", 0)
	if _, err := GetChatGPTCredentials(); err == nil {
		t.Fatal("untrusted server certificate accepted")
	}
	if received.Load() != 0 {
		t.Fatal("credentials reached untrusted authority")
	}
}

func TestChatGPTConnectionRejectsNonPrivateOrInvalidConfig(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid configuration reached server") }))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	defer server.Close()
	path := writeTestChatGPTConnection(t, server)
	original, _ := os.ReadFile(path)
	for _, tc := range []struct {
		name, body string
		mode       os.FileMode
	}{
		{"public", string(original), 0644},
		{"unknown", `{"secret":"private-bearer"}`, 0600},
		{"null", `null`, 0600},
		{"trailing", string(original) + `{}`, 0600},
		{"http", strings.Replace(string(original), "https://", "http://", 1), 0600},
		{"invalid CA", `{"url":"https://example.invalid","token":"private-bearer","ca_cert":"invalid"}`, 0600},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(tc.body), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, tc.mode); err != nil {
				t.Fatal(err)
			}
			if _, err := GetChatGPTCredentials(); err == nil || strings.Contains(err.Error(), "private-bearer") {
				t.Fatalf("invalid configuration result: %v", err)
			}
		})
	}
}
