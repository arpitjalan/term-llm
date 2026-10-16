package credentials

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/oauth"
)

func TestChatGPTSessionAtCoalescesRefreshAndIgnoresWorkerEnvironment(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv(chatGPTConnectionEnv, "/not-a-real-worker-config")
	path := filepath.Join(t.TempDir(), "chatgpt_oauth.json")
	initial := &ChatGPTCredentials{AccessToken: "old-access", RefreshToken: "old-refresh", ExpiresAt: time.Now().Add(-time.Hour).Unix(), AccountID: "account"}
	if err := saveChatGPTCredentials(path, initial); err != nil {
		t.Fatal(err)
	}
	oldRefresh := refreshChatGPTToken
	t.Cleanup(func() { refreshChatGPTToken = oldRefresh })
	entered, release := make(chan struct{}), make(chan struct{})
	var exchanges atomic.Int32
	refreshChatGPTToken = func(token string) (*oauth.ChatGPTTokenResponse, error) {
		if token != "old-refresh" {
			return nil, fmt.Errorf("unexpected refresh generation")
		}
		if exchanges.Add(1) == 1 {
			close(entered)
		}
		<-release
		return &oauth.ChatGPTTokenResponse{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresIn: 3600}, nil
	}
	type result struct {
		creds *ChatGPTCredentials
		err   error
	}
	results := make(chan result, 2)
	run := func() { c, err := ChatGPTSessionAt(path, "old-access"); results <- result{c, err} }
	go run()
	<-entered
	go run()
	close(release)
	for range 2 {
		r := <-results
		if r.err != nil || r.creds.AccessToken != "new-access" || r.creds.RefreshToken != "new-refresh" || r.creds.AccountID != "account" {
			t.Fatalf("session = %#v, %v", r.creds, r.err)
		}
	}
	if exchanges.Load() != 1 {
		t.Fatalf("refresh exchanges = %d, want 1", exchanges.Load())
	}
	stored, err := readChatGPTCredentials(path)
	if err != nil || stored.RefreshToken != "new-refresh" {
		t.Fatalf("source was not updated: %#v, %v", stored, err)
	}
	defaultPath, _ := ChatGPTCredentialsPath()
	if _, err := os.Stat(defaultPath); !os.IsNotExist(err) {
		t.Fatalf("explicit source copied into local worker store: %v", err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("source permissions = %o", info.Mode().Perm())
	}
}

func TestChatGPTSessionAtRefreshesRejectedFreshToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chatgpt_oauth.json")
	initial := &ChatGPTCredentials{AccessToken: "rejected-access", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	if err := saveChatGPTCredentials(path, initial); err != nil {
		t.Fatal(err)
	}
	oldRefresh := refreshChatGPTToken
	t.Cleanup(func() { refreshChatGPTToken = oldRefresh })
	var exchanges int
	refreshChatGPTToken = func(string) (*oauth.ChatGPTTokenResponse, error) {
		exchanges++
		return &oauth.ChatGPTTokenResponse{AccessToken: "replacement", RefreshToken: "rotated", ExpiresIn: 3600}, nil
	}
	if _, err := ChatGPTSessionAt(path, ""); err != nil || exchanges != 0 {
		t.Fatalf("fresh session exchanged: %d, %v", exchanges, err)
	}
	for range 2 {
		got, err := ChatGPTSessionAt(path, "rejected-access")
		if err != nil || got.AccessToken != "replacement" {
			t.Fatalf("rejected session = %#v, %v", got, err)
		}
	}
	if exchanges != 1 {
		t.Fatalf("exchanges = %d, want 1", exchanges)
	}
}

func TestChatGPTSessionAtSanitizesFailures(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chatgpt_oauth.json")
	if _, err := ChatGPTSessionAt(path, ""); err == nil || strings.Contains(err.Error(), path) {
		t.Fatalf("missing source error = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("missing source was created: %v", err)
	}
	if err := saveChatGPTCredentials(path, &ChatGPTCredentials{AccessToken: "access", RefreshToken: "secret-refresh"}); err != nil {
		t.Fatal(err)
	}
	oldRefresh := refreshChatGPTToken
	t.Cleanup(func() { refreshChatGPTToken = oldRefresh })
	for _, invalid := range []bool{false, true} {
		refreshChatGPTToken = func(string) (*oauth.ChatGPTTokenResponse, error) {
			if invalid {
				return nil, fmt.Errorf("secret-refresh: %w", oauth.ErrChatGPTRefreshTokenInvalid)
			}
			return nil, fmt.Errorf("secret-refresh upstream body")
		}
		_, err := ChatGPTSessionAt(path, "")
		if err == nil || strings.Contains(err.Error(), "secret-refresh") || errors.Is(err, oauth.ErrChatGPTRefreshTokenInvalid) != invalid {
			t.Fatalf("sanitized error = %v", err)
		}
	}
}
