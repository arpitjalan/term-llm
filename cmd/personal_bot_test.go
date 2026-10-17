package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/agents"
	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/userservice"
	"github.com/spf13/cobra"
)

func nativePersonalBotTestHome(t *testing.T) (string, serviceEnvironment) {
	t.Helper()
	if (runtime.GOOS != "linux" && runtime.GOOS != "darwin") || os.Getuid() == 0 {
		t.Skip("native assistant preparation requires a supported normal user")
	}
	home := isolatedServiceHome(t)
	e, err := newServiceEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	return home, e
}

func TestPrepareNativePersonalBot(t *testing.T) {
	home, _ := nativePersonalBotTestHome(t)
	args, install, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{purpose: "Organize my notes.", noStart: true})
	if err != nil {
		t.Fatal(err)
	}
	agentDir := filepath.Join(home, "config", "term-llm", "agents", "personal")
	workspace := filepath.Join(home, "data", "term-llm", "personal-bot", "workspace")
	if install.nativeAgent != agentDir || install.directory != workspace || !install.custom || !install.noStart {
		t.Fatalf("unexpected install settings: %+v", install)
	}
	if len(args) == 0 || args[0] != "jobs" {
		t.Fatalf("initial assistant is missing scheduled routines: %v", args)
	}
	spec, err := parseServiceLaunch("web", args)
	if err != nil || spec.Auth != "bearer" || spec.Port != 8080 {
		t.Fatalf("launch = %+v, %v", spec, err)
	}
	if err := checkNativePersonalBotService(spec, agentDir); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{"--agent", agentDir}, {"--read-dir", workspace}, {"--write-dir", workspace}} {
		if !strings.Contains(strings.Join(args, "\x00"), pair[0]+"\x00"+pair[1]) {
			t.Fatalf("missing %v in %v", pair, args)
		}
	}
	agent, err := agents.LoadFromPath(agentDir)
	if err != nil || agent.Name != "personal" || !strings.Contains(agent.SystemPrompt, "Organize my notes.") {
		t.Fatalf("agent = %+v, %v", agent, err)
	}
	if info, err := os.Stat(workspace); err != nil || !info.IsDir() {
		t.Fatalf("workspace missing: %v", err)
	}
	for _, name := range []string{"agent.yaml", "system.md"} {
		info, err := os.Stat(filepath.Join(agentDir, name))
		if err != nil || info.Mode().Perm()&0077 != 0 {
			t.Fatalf("%s is not private: %v", name, err)
		}
	}
}

func TestNativePersonalBotAgentRefusesUnrelatedFiles(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		t.Run(map[bool]string{false: "directory", true: "symlink"}[symlink], func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "existing")
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(target, "agent.yaml")
			original := []byte("name: personal\ndescription: Mine\n")
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			dir := target
			if symlink {
				dir = filepath.Join(root, "personal")
				if err := os.Symlink(target, dir); err != nil {
					t.Fatal(err)
				}
			}
			if err := ensureNativePersonalBotAgent(dir, "Replace it"); err == nil {
				t.Fatal("accepted an unrelated agent")
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, original) {
				t.Fatalf("existing instructions changed: %q, %v", got, err)
			}
			if _, err := os.Lstat(filepath.Join(target, "system.md")); !os.IsNotExist(err) {
				t.Fatalf("created instructions for unrelated agent: %v", err)
			}
		})
	}
}

func TestPrepareNativePersonalBotPreservesSavedSetup(t *testing.T) {
	home, e := nativePersonalBotTestHome(t)
	args, first, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{})
	if err != nil {
		t.Fatal(err)
	}
	args = append(args, "--port", "18345", "--base-path", "/assistant", "--provider", "my-provider")
	spec, err := parseServiceLaunch("web", args)
	if err != nil {
		t.Fatal(err)
	}
	spec.Binary, spec.Directory = "/saved/term-llm", filepath.Join(home, "my-work")
	spec.Environment = map[string]string{"HOME": home, "XDG_DATA_HOME": filepath.Join(home, "saved-data")}
	spec.Secrets = []string{serviceTokenName("web")}
	if err := userservice.Save(e.specPath("web"), spec); err != nil {
		t.Fatal(err)
	}
	instructions := filepath.Join(first.nativeAgent, "system.md")
	if err := os.WriteFile(instructions, []byte("My edited instructions\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, install, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if install.custom || install.directory != "" || install.nativeAgent != first.nativeAgent {
		t.Fatalf("rerun would replace saved launch settings: %+v", install)
	}
	got, err := userservice.Load(e.specPath("web"))
	if err != nil || !reflect.DeepEqual(got, spec) {
		t.Fatalf("saved settings changed: %+v, %v", got, err)
	}
	if data, err := os.ReadFile(instructions); err != nil || string(data) != "My edited instructions\n" {
		t.Fatalf("edited instructions changed: %q, %v", data, err)
	}
	for _, opts := range []nativePersonalBotOptions{{purpose: "Replace it"}, {port: 8080}, {workspace: home}} {
		if _, _, err := prepareNativePersonalBot(&config.Config{}, opts); err == nil {
			t.Fatalf("accepted conflicting rerun settings: %+v", opts)
		}
	}
}

func TestPrepareNativePersonalBotRefusesUnrelatedService(t *testing.T) {
	for _, native := range []bool{false, true} {
		t.Run(map[bool]string{false: "saved service", true: "unmanaged native service"}[native], func(t *testing.T) {
			home, e := nativePersonalBotTestHome(t)
			path := e.specPath("web")
			if native {
				path = e.native.Path("web")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("my existing service\n"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				spec, err := parseServiceLaunch("web", nil)
				if err != nil {
					t.Fatal(err)
				}
				spec.Binary, spec.Directory = "/saved/term-llm", home
				if err := userservice.Save(path, spec); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{}); err == nil {
				t.Fatal("accepted unrelated service")
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("unrelated service changed: %v", err)
			}
			for _, dir := range []string{filepath.Join(home, "config", "term-llm", "agents"), filepath.Join(home, "data")} {
				if _, err := os.Lstat(dir); !os.IsNotExist(err) {
					t.Fatalf("refusal wrote assistant files at %s: %v", dir, err)
				}
			}
		})
	}
}

func TestPrepareNativePersonalBotRecoversAfterFailedInstall(t *testing.T) {
	_, _ = nativePersonalBotTestHome(t)
	args, first, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{purpose: "My first purpose"})
	if err != nil {
		t.Fatal(err)
	}
	// No service was saved, as when the service manager is unavailable.
	again, next, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{})
	if err != nil || !reflect.DeepEqual(args, again) || first.nativeAgent != next.nativeAgent {
		t.Fatalf("could not resume prepared files: %v", err)
	}
	agent, err := agents.LoadFromPath(first.nativeAgent)
	if err != nil || !strings.Contains(agent.SystemPrompt, "My first purpose") {
		t.Fatalf("retry replaced instructions: %+v, %v", agent, err)
	}
}

func TestPrepareNativePersonalBotValidatesPortBeforeWriting(t *testing.T) {
	for _, port := range []int{-1, 65536} {
		t.Run(strconv.Itoa(port), func(t *testing.T) {
			home, _ := nativePersonalBotTestHome(t)
			if _, _, err := prepareNativePersonalBot(&config.Config{}, nativePersonalBotOptions{port: port}); err == nil {
				t.Fatal("accepted invalid port")
			}
			if entries, err := os.ReadDir(home); err != nil || len(entries) != 0 {
				t.Fatalf("invalid setup wrote files: %v, %v", entries, err)
			}
		})
	}
}

func TestNativePersonalBotSecrets(t *testing.T) {
	for name, value := range map[string]string{"OPENAI_API_KEY": " main-key ", "ANTHROPIC_API_KEY": "guardian-key", "GEMINI_API_KEY": "fast-key", "TERM_LLM_SERVE_TOKEN": "unrelated-token", "UNRELATED_API_KEY": "unrelated-key"} {
		t.Setenv(name, value)
	}
	cfg := &config.Config{DefaultProvider: "main", Guardian: config.GuardianConfig{Provider: "guard"}, Providers: map[string]config.ProviderConfig{
		"main":  {Type: config.ProviderTypeOpenAI, FastProvider: "fast"},
		"guard": {Type: config.ProviderTypeAnthropic},
		"fast":  {Type: config.ProviderTypeGemini},
	}}
	want := map[string]string{"OPENAI_API_KEY": "main-key", "ANTHROPIC_API_KEY": "guardian-key", "GEMINI_API_KEY": "fast-key"}
	if got, err := nativePersonalBotSecrets(cfg); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("needed credentials = %v, %v; want %v", got, err, want)
	}
	if got, err := nativePersonalBotSecrets(&config.Config{}); err != nil || len(got) != 0 {
		t.Fatalf("empty provider selection imported credentials: %v, %v", got, err)
	}
}

func TestNativePersonalBotCustomProviderSecrets(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("CUSTOM_API_KEY", "custom-key")
	t.Setenv("LOCAL_API_KEY", "local-key")
	for _, tc := range []struct {
		name, provider, key string
		config              config.ProviderConfig
	}{
		{"compatible fallback", "custom", "CUSTOM_API_KEY", config.ProviderConfig{Type: config.ProviderTypeOpenAICompat}},
		{"vllm fallback", "local", "LOCAL_API_KEY", config.ProviderConfig{Type: config.ProviderTypeVLLM}},
		{"explicit reference", "main", "CUSTOM_API_KEY", config.ProviderConfig{Type: config.ProviderTypeOpenAI, APIKey: "${CUSTOM_API_KEY}"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &config.Config{DefaultProvider: tc.provider, Providers: map[string]config.ProviderConfig{tc.provider: tc.config}}
			want := map[string]string{tc.key: os.Getenv(tc.key)}
			if got, err := nativePersonalBotSecrets(cfg); err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("custom credentials = %v, %v; want %v", got, err, want)
			}
		})
	}
}

func TestNativePersonalBotRefusesUnsupportedCredentialNames(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("CUSTOM_CREDENTIAL", "do-not-print-this-key")
	cfg := &config.Config{DefaultProvider: "main", Providers: map[string]config.ProviderConfig{
		"main": {Type: config.ProviderTypeOpenAI, APIKey: "${CUSTOM_CREDENTIAL}"},
	}}
	_, err := nativePersonalBotSecrets(cfg)
	if err == nil || !strings.Contains(err.Error(), "CUSTOM_CREDENTIAL") {
		t.Fatalf("missing supported credential name guidance: %v", err)
	}
	if strings.Contains(err.Error(), "do-not-print-this-key") {
		t.Fatal("credential refusal leaked its value")
	}
}

func TestOfferNativePersonalBotDeclineKeepsQueryOutputClean(t *testing.T) {
	for _, answer := range []string{"n\n", "\n", "", "later\n"} {
		t.Run(strings.TrimSpace(answer), func(t *testing.T) {
			home := isolatedServiceHome(t)
			var stdout, stderr bytes.Buffer
			cmd := &cobra.Command{}
			cmd.SetIn(strings.NewReader(answer))
			cmd.SetOut(&stdout)
			cmd.SetErr(&stderr)
			offerNativePersonalBot(cmd, &config.Config{})
			if stdout.Len() != 0 {
				t.Fatalf("onboarding polluted query output: %s", stdout.String())
			}
			if (runtime.GOOS == "linux" || runtime.GOOS == "darwin") && !strings.Contains(stderr.String(), "personal-bot setup") {
				t.Fatalf("missing optional retry guidance: %s", stderr.String())
			}
			if entries, err := os.ReadDir(home); err != nil || len(entries) != 0 {
				t.Fatalf("decline wrote files: %v, %v", entries, err)
			}
		})
	}
}

func TestNativePersonalBotServiceCompatibility(t *testing.T) {
	agent := "/saved/agents/personal"
	for _, tc := range []struct {
		name string
		args []string
		bad  bool
	}{
		{"initial", []string{"jobs", "--personal-bot", "--agent", agent, "--auth", "bearer"}, false},
		{"reordered", []string{"--personal-bot", "--agent", agent, "--auth", "bearer", "jobs"}, false},
		{"boolean before jobs", []string{"--personal-bot", "--agent", agent, "--no-projects", "jobs", "--auth", "bearer"}, false},
		{"customized platforms", []string{"--personal-bot", "--agent", agent}, false},
		{"different agent", []string{"jobs", "--personal-bot", "--agent", "/other"}, true},
		{"last agent differs", []string{"jobs", "--personal-bot", "--agent", agent, "--agent", "/other"}, true},
		{"disabled personal bot", []string{"jobs", "--personal-bot=false", "--agent", agent}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := checkNativePersonalBotService(userservice.Spec{Kind: "web", Auth: "bearer", Args: tc.args}, agent)
			if (err != nil) != tc.bad {
				t.Fatalf("compatibility error = %v, want error %v", err, tc.bad)
			}
		})
	}
}
