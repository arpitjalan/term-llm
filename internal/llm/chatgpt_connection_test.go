package llm

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestChatGPTSharedConnectionFailureDoesNotPromptLocalLogin(t *testing.T) {
	t.Setenv("TERM_LLM_CHATGPT_CONNECTION_FILE", filepath.Join(t.TempDir(), "missing.json"))
	_, err := NewChatGPTProviderWithOptions("gpt-5", ChatGPTProviderOptions{})
	if err == nil || !strings.Contains(err.Error(), "shared ChatGPT connection is unavailable") {
		t.Fatalf("broker outage should be actionable without starting OAuth: %v", err)
	}
}
