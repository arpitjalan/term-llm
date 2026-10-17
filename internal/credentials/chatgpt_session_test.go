package credentials

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/filelock"
	"github.com/samsaffron/term-llm/internal/oauth"
)

func TestChatGPTSessionRequestLimits(t *testing.T) {
	for _, tc := range []struct {
		name, body, token string
		valid             bool
	}{
		{"maximum token", `{"rejected_access_token":"` + strings.Repeat("a", 16<<10) + `"}`, strings.Repeat("a", 16<<10), true},
		{"oversized token", `{"rejected_access_token":"` + strings.Repeat("a", (16<<10)+1) + `"}`, "", false},
		{"maximum request", `{}` + strings.Repeat(" ", (32<<10)-2), "", true},
		{"oversized request", `{}` + strings.Repeat(" ", (32<<10)-1), "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request, err := ReadChatGPTSessionRequest(strings.NewReader(tc.body))
			if (err == nil) != tc.valid {
				t.Fatalf("request accepted = %t, want %t: %v", err == nil, tc.valid, err)
			}
			if request.RejectedAccessToken != tc.token {
				t.Fatal("request returned an unexpected rejected token")
			}
		})
	}
}

func TestChatGPTSessionAtCancelsCredentialWaits(t *testing.T) {
	for _, lock := range []string{".refresh.lock", ".lock", "mutex"} {
		t.Run(lock, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "chatgpt_oauth.json")
			if err := saveChatGPTCredentials(path, &ChatGPTCredentials{AccessToken: "access", ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
				t.Fatal(err)
			}
			var unlock func() error
			if lock == "mutex" {
				if err := chatGPTCredentialsMu.Acquire(context.Background(), 1); err != nil {
					t.Fatal(err)
				}
				unlock = func() error { chatGPTCredentialsMu.Release(1); return nil }
			} else {
				var err error
				unlock, err = filelock.Lock(path + lock)
				if err != nil {
					t.Fatal(err)
				}
			}
			defer unlock()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			started, result := make(chan struct{}), make(chan error, 1)
			go func() {
				close(started)
				_, err := ChatGPTSessionAt(ctx, path, "")
				result <- err
			}()
			<-started
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancelled credential request: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("credential request ignored cancellation while waiting for ownership")
			}
		})
	}
}

func TestChatGPTSessionAtCancelsOAuthRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chatgpt_oauth.json")
	initial := &ChatGPTCredentials{AccessToken: "expired", RefreshToken: "original-refresh"}
	if err := saveChatGPTCredentials(path, initial); err != nil {
		t.Fatal(err)
	}
	oldRefresh := refreshChatGPTToken
	t.Cleanup(func() { refreshChatGPTToken = oldRefresh })
	entered := make(chan struct{})
	refreshChatGPTToken = func(ctx context.Context, _ string) (*oauth.ChatGPTTokenResponse, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := ChatGPTSessionAt(ctx, path, ""); result <- err }()
	<-entered
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled refresh: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OAuth refresh ignored cancellation")
	}
	stored, err := readChatGPTCredentials(path)
	if err != nil || !sameChatGPTCredentialGeneration(stored, initial) {
		t.Fatalf("cancelled exchange changed credentials: %#v, %v", stored, err)
	}
}

func TestChatGPTSessionAtCommitsSuccessfulRotationAfterCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chatgpt_oauth.json")
	if err := saveChatGPTCredentials(path, &ChatGPTCredentials{AccessToken: "expired", RefreshToken: "original-refresh"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	oldRefresh := refreshChatGPTToken
	t.Cleanup(func() { refreshChatGPTToken = oldRefresh })
	refreshChatGPTToken = func(context.Context, string) (*oauth.ChatGPTTokenResponse, error) {
		cancel()
		return &oauth.ChatGPTTokenResponse{AccessToken: "replacement", RefreshToken: "rotated", ExpiresIn: 3600}, nil
	}
	if _, err := ChatGPTSessionAt(ctx, path, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled session: %v", err)
	}
	stored, err := readChatGPTCredentials(path)
	if err != nil || stored.RefreshToken != "rotated" || stored.AccessToken != "replacement" {
		t.Fatalf("successful refresh rotation was lost: %#v, %v", stored, err)
	}
}

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
	refreshChatGPTToken = func(_ context.Context, token string) (*oauth.ChatGPTTokenResponse, error) {
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
	run := func() {
		c, err := ChatGPTSessionAt(context.Background(), path, "old-access")
		results <- result{c, err}
	}
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
	refreshChatGPTToken = func(_ context.Context, _ string) (*oauth.ChatGPTTokenResponse, error) {
		exchanges++
		return &oauth.ChatGPTTokenResponse{AccessToken: "replacement", RefreshToken: "rotated", ExpiresIn: 3600}, nil
	}
	if _, err := ChatGPTSessionAt(context.Background(), path, ""); err != nil || exchanges != 0 {
		t.Fatalf("fresh session exchanged: %d, %v", exchanges, err)
	}
	for range 2 {
		got, err := ChatGPTSessionAt(context.Background(), path, "rejected-access")
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
	if _, err := ChatGPTSessionAt(context.Background(), path, ""); err == nil || strings.Contains(err.Error(), path) {
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
		refreshChatGPTToken = func(_ context.Context, _ string) (*oauth.ChatGPTTokenResponse, error) {
			if invalid {
				return nil, fmt.Errorf("secret-refresh: %w", oauth.ErrChatGPTRefreshTokenInvalid)
			}
			return nil, fmt.Errorf("secret-refresh upstream body")
		}
		_, err := ChatGPTSessionAt(context.Background(), path, "")
		if err == nil || strings.Contains(err.Error(), "secret-refresh") || errors.Is(err, oauth.ErrChatGPTRefreshTokenInvalid) != invalid {
			t.Fatalf("sanitized error = %v", err)
		}
	}
}
