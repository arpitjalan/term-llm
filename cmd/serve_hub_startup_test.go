package cmd

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestValidateHubPersonalBotOptions(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		personalBot, contain        bool
		image, binary, errorMessage string
	}{
		{name: "ordinary Hub"},
		{name: "Personal Bot", personalBot: true, contain: true},
		{name: "image and binary", personalBot: true, contain: true, image: "runtime:v1", binary: "runtime"},
		{name: "requires discovery", personalBot: true, errorMessage: "requires contain discovery"},
		{name: "image requires Personal Bot", image: "runtime:v1", errorMessage: "require --personal-bot"},
		{name: "binary requires Personal Bot", binary: "runtime", errorMessage: "require --personal-bot"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateHubPersonalBotOptions(tc.personalBot, tc.contain, tc.image, tc.binary)
			if tc.errorMessage == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.errorMessage) {
				t.Fatalf("error = %v, want %q", err, tc.errorMessage)
			}
		})
	}
}

func TestHubPersonalBotStartupSummary(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("TERM_LLM_HUB_TOKEN", "synthetic-hub-secret")
	t.Setenv("OPENAI_API_KEY", "synthetic-provider-secret")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(home, "runtime", "term-llm-linux")
	for _, tc := range []struct {
		name, configHome, dataHome, image, binary, runtime string
	}{
		{name: "default directories and executable", runtime: "current executable: " + executable},
		{name: "explicit profile", configHome: filepath.Join(home, "profile", "config"), dataHome: filepath.Join(home, "profile", "data"), binary: binary, runtime: "binary: " + binary},
		{name: "image takes precedence", image: "runtime:v1", binary: binary, runtime: "image: runtime:v1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", tc.configHome)
			t.Setenv("XDG_DATA_HOME", tc.dataHome)
			got, err := hubPersonalBotStartupSummary(tc.image, tc.binary)
			if err != nil {
				t.Fatal(err)
			}
			configHome, dataHome := tc.configHome, tc.dataHome
			if configHome == "" {
				configHome = filepath.Join(home, ".config")
			}
			if dataHome == "" {
				dataHome = filepath.Join(home, ".local", "share")
			}
			want := fmt.Sprintf("  config directory: %s\n  assistant store: %s\n  data directory: %s\n  assistant runtime %s\n",
				filepath.Join(configHome, "term-llm"), filepath.Join(configHome, "term-llm", "containers"), filepath.Join(dataHome, "term-llm"), tc.runtime)
			if got != want {
				t.Fatalf("startup summary = %q, want %q", got, want)
			}
			if strings.Contains(got, "synthetic-hub-secret") || strings.Contains(got, "synthetic-provider-secret") {
				t.Fatal("startup summary exposed credentials")
			}
		})
	}
}

func TestServeHubOccupiedPortDoesNotAnnounceListening(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	oldHost, oldPort := serveHubHost, serveHubPort
	oldAuth, oldConfig, oldNodes := serveHubAuthMode, serveHubConfig, serveHubNodesFile
	oldContain, oldPersonalBot := serveHubContain, serveHubPersonalBot
	oldImage, oldBinary := serveHubPersonalBotImage, serveHubPersonalBotBinary
	t.Cleanup(func() {
		serveHubHost, serveHubPort = oldHost, oldPort
		serveHubAuthMode, serveHubConfig, serveHubNodesFile = oldAuth, oldConfig, oldNodes
		serveHubContain, serveHubPersonalBot = oldContain, oldPersonalBot
		serveHubPersonalBotImage, serveHubPersonalBotBinary = oldImage, oldBinary
	})
	serveHubHost, serveHubPort = "127.0.0.1", listener.Addr().(*net.TCPAddr).Port
	serveHubAuthMode, serveHubConfig, serveHubNodesFile = "none", "", filepath.Join(t.TempDir(), "nodes.json")
	serveHubContain, serveHubPersonalBot = false, false
	serveHubPersonalBotImage, serveHubPersonalBotBinary = "", ""
	var out bytes.Buffer
	command := &cobra.Command{}
	command.SetOut(&out)
	command.SetErr(&out)

	err = runServeHub(command, nil)
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("listen for Hub on %s", listener.Addr())) {
		t.Fatalf("occupied-port error = %v", err)
	}
	if strings.Contains(out.String(), "listening") {
		t.Fatalf("failed Hub announced a listener: %q", out.String())
	}
}
