package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/samsaffron/term-llm/internal/credentials"
	"github.com/spf13/cobra"
)

func TestAuthChatGPTSessionReturnsOnlyAccessSession(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("TERM_LLM_CHATGPT_CONNECTION_FILE", "/must-not-follow-worker-bridge")
	path, err := credentials.ChatGPTCredentialsPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	creds := credentials.ChatGPTCredentials{AccessToken: "fake-access", RefreshToken: "never-output-refresh", ExpiresAt: time.Now().Add(time.Hour).Unix(), AccountID: "fake-account"}
	data, _ := json.Marshal(creds)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetIn(strings.NewReader(`{"rejected_access_token":"older-access"}`))
	cmd.SetOut(&out)
	if err := runAuthChatGPTSession(cmd, nil); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 3 || result["access_token"] != "fake-access" || result["account_id"] != "fake-account" || result["expires_at"] != float64(creds.ExpiresAt) {
		t.Fatalf("session = %#v", result)
	}
	if strings.Contains(out.String(), "refresh") {
		t.Fatal("helper leaked refresh credentials")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(data, after) {
		t.Fatal("fresh source was unnecessarily mutated")
	}
}

func TestAuthChatGPTSessionRejectsInvalidInputWithoutOutput(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	for _, input := range []string{"", "null", "[]", `{`, `{} {}`, `{"refresh_token":"secret"}`, `{"rejected_access_token":1}`, `{"rejected_access_token":"` + strings.Repeat("s", 16385) + `"}`, strings.Repeat(" ", 32769)} {
		var out bytes.Buffer
		cmd := &cobra.Command{}
		cmd.SetIn(strings.NewReader(input))
		cmd.SetOut(&out)
		err := runAuthChatGPTSession(cmd, nil)
		if err == nil || strings.Contains(err.Error(), "secret") || out.Len() != 0 {
			t.Fatalf("invalid input result: %v, output %q", err, out.String())
		}
	}
}

func TestAuthChatGPTSessionMissingSourceIsSafe(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	var out bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetIn(strings.NewReader(`{}`))
	cmd.SetOut(&out)
	err := runAuthChatGPTSession(cmd, nil)
	if err == nil || strings.Contains(err.Error(), configHome) || out.Len() != 0 {
		t.Fatalf("missing source result: %v, output %q", err, out.String())
	}
	if !authChatGPTSessionCmd.Hidden || authChatGPTSessionCmd.Args(authChatGPTSessionCmd, []string{"secret"}) == nil {
		t.Fatal("helper accepts arguments or is public")
	}
}
