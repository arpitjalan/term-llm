package contain

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPersonalBotBootstrapPreservesImportedRefreshAuthority(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("container bootstrap requires a POSIX shell")
	}
	bootstrap, err := personalBotAssets.ReadFile("personal-bot/bootstrap.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, seedOAuth, seedBridge, expectedOAuth string
		sameRevision                               bool
	}{
		{name: "switch to API key", expectedOAuth: "original-refreshed-authority"},
		{name: "switch to shared connection", seedBridge: `{"token":"synthetic-worker-token"}`, expectedOAuth: "original-refreshed-authority"},
		{name: "restart preserves rotated token", seedOAuth: "older-seed-token", expectedOAuth: "original-refreshed-authority", sameRevision: true},
		{name: "explicit legacy OAuth seed replaces credentials", seedOAuth: "replacement-seed-token", expectedOAuth: "replacement-seed-token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			seed, home, workspace := filepath.Join(root, "seed"), filepath.Join(root, "home"), filepath.Join(root, "workspace")
			configDir, bin := filepath.Join(home, ".config", "term-llm"), filepath.Join(root, "bin")
			for _, dir := range []string{seed, configDir, bin} {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			write := func(path, value string, mode os.FileMode) {
				t.Helper()
				if err := os.WriteFile(path, []byte(value), mode); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(seed, "config.yaml"), "default_provider: openai\n", 0600)
			write(filepath.Join(seed, ".revision"), "new-revision", 0600)
			previousRevision := "old-revision"
			if tc.sameRevision {
				previousRevision = "new-revision"
			}
			write(filepath.Join(configDir, ".revision"), previousRevision, 0600)
			write(filepath.Join(configDir, "chatgpt_oauth.json"), "original-refreshed-authority", 0600)
			if tc.seedOAuth != "" {
				write(filepath.Join(seed, "chatgpt_oauth.json"), tc.seedOAuth, 0600)
			}
			if tc.seedBridge != "" {
				write(filepath.Join(seed, "chatgpt_connection.json"), tc.seedBridge, 0600)
			}
			if !tc.sameRevision {
				write(filepath.Join(configDir, "chatgpt_connection.json"), "old-worker-token", 0600)
			}
			// Execute the actual bootstrap with only its absolute container paths
			// remapped to fixtures. Ownership and server startup are inert shims;
			// real copy/remove/revision behavior is exercised without Docker/root.
			script := strings.NewReplacer("/run/personal-bot-connection", seed, "/home/agent", home, "/workspace", workspace).Replace(string(bootstrap))
			write(filepath.Join(root, "bootstrap.sh"), script, 0700)
			write(filepath.Join(bin, "chown"), "#!/bin/sh\nexit 0\n", 0700)
			write(filepath.Join(bin, "gosu"), "#!/bin/sh\nprintf '%s' \"${TERM_LLM_CHATGPT_CONNECTION_FILE:-}\"\n", 0700)
			cmd := exec.Command("sh", filepath.Join(root, "bootstrap.sh"))
			cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin", "HOME=" + home, "AGENT_NAME=fixture", "WEB_TOKEN=synthetic-web-token", "TERM_LLM_CHATGPT_CONNECTION_FILE=/must-be-cleared"}
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("bootstrap failed: %v: %s", err, output)
			}
			authority, err := os.ReadFile(filepath.Join(configDir, "chatgpt_oauth.json"))
			if err != nil || string(authority) != tc.expectedOAuth {
				t.Fatalf("source authority = %q, %v", authority, err)
			}
			wantBridge := ""
			if tc.seedBridge != "" {
				wantBridge = filepath.Join(configDir, "chatgpt_connection.json")
				bridge, err := os.ReadFile(wantBridge)
				if err != nil || string(bridge) != tc.seedBridge {
					t.Fatalf("worker bridge = %q, %v", bridge, err)
				}
			} else if _, err := os.Stat(filepath.Join(configDir, "chatgpt_connection.json")); !os.IsNotExist(err) {
				t.Fatalf("old worker bridge retained: %v", err)
			}
			if string(output) != wantBridge {
				t.Fatalf("worker connection environment = %q, want %q", output, wantBridge)
			}
		})
	}
}
