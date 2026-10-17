package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/samsaffron/term-llm/internal/agents"
	"github.com/samsaffron/term-llm/internal/appdata"
	"github.com/samsaffron/term-llm/internal/config"
	"github.com/samsaffron/term-llm/internal/llm"
	"github.com/samsaffron/term-llm/internal/ui"
	"github.com/samsaffron/term-llm/internal/userservice"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"gopkg.in/yaml.v3"
)

const nativePersonalBotHeader = "# Created by term-llm personal-bot setup\n"

type nativePersonalBotOptions struct {
	workspace, purpose string
	port               int
	noStart            bool
}

func init() {
	personal := &cobra.Command{Use: "personal-bot", Short: "Set up a personal assistant on this computer"}
	var opts nativePersonalBotOptions
	setup := &cobra.Command{
		Use: "setup", Short: "Create or resume one native assistant using the managed Web service",
		Long: `Set up browser chat and scheduled routines using this account's provider
configuration and stored data. The assistant uses a dedicated working folder and
the existing Web user service, with a stable bearer token. Required terminal API
keys are saved privately for the service; OAuth sign-ins stay in their existing stores.
Existing unrelated Web services and agent files are preserved.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := loadConfigWithSetup()
			if err != nil {
				return err
			}
			return setupNativePersonalBot(cmd, cfg, opts)
		},
	}
	setup.Flags().StringVar(&opts.workspace, "workspace", "", "Initial working folder (default: <data-dir>/personal-bot/workspace)")
	setup.Flags().StringVar(&opts.purpose, "purpose", "", "Initial assistant instructions")
	setup.Flags().IntVar(&opts.port, "port", 0, "Initial browser port (default: 8080)")
	setup.Flags().BoolVar(&opts.noStart, "no-start", false, "Prepare the assistant and service without starting it")
	personal.AddCommand(setup)
	rootCmd.AddCommand(personal)
}

// Only interactive query/chat entry points call this wrapper. Servers keep using
// loadConfigWithSetup, so their provider setup cannot recursively install a service.
func loadConfigWithNativeSetup(cmd *cobra.Command) (*config.Config, error) {
	firstRun := config.NeedsSetup() && ui.HasTTY()
	cfg, err := loadConfigWithSetup()
	if err == nil && firstRun {
		offerNativePersonalBot(cmd, cfg)
	}
	return cfg, err
}

func offerNativePersonalBot(cmd *cobra.Command, cfg *config.Config) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return
	}
	// Keep query output clean when stdout is redirected, like the provider wizard.
	out := cmd.ErrOrStderr()
	fmt.Fprint(out, "Set up a personal assistant with browser chat and routines on this computer?\nUses your account's provider and data, saves required API keys privately, and runs at login. [y/N] ")
	var answer string
	if _, err := fmt.Fscanln(cmd.InOrStdin(), &answer); err != nil || (strings.ToLower(answer) != "y" && strings.ToLower(answer) != "yes") {
		fmt.Fprintln(out, "You can set it up later with: term-llm personal-bot setup")
		return
	}
	setup := &cobra.Command{}
	setup.SetContext(cmd.Context())
	setup.SetIn(cmd.InOrStdin())
	setup.SetOut(out)
	setup.SetErr(out)
	if err := setupNativePersonalBot(setup, cfg, nativePersonalBotOptions{}); err != nil {
		fmt.Fprintf(out, "Personal assistant setup did not finish: %v\nRetry with: term-llm personal-bot setup\n", err)
	}
}

func setupNativePersonalBot(cmd *cobra.Command, cfg *config.Config, opts nativePersonalBotOptions) error {
	args, install, err := prepareNativePersonalBot(cfg, opts)
	if err != nil {
		return err
	}
	if !opts.noStart {
		// Complete subscription sign-in in this terminal, before the background
		// process tries to use the account. Construction makes no model request.
		for _, name := range nativePersonalBotProviders(cfg) {
			providerType := config.InferProviderType(name, cfg.Providers[name].Type)
			if providerType == config.ProviderTypeChatGPT || providerType == config.ProviderTypeGrok || providerType == config.ProviderTypeCopilot {
				if _, err := llm.NewProviderByName(cfg, name, ""); err != nil {
					return fmt.Errorf("prepare assistant provider %q: %w", name, err)
				}
			}
		}
	}
	if err := installUserService(cmd, "web", args, install); err != nil {
		return fmt.Errorf("set up native assistant (saved files are kept for retry): %w", err)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Check status with: term-llm service status web (also: start, stop, logs, open)")
	fmt.Fprintln(cmd.OutOrStdout(), "Sign in or connect it to a Hub using: term-llm service token web")
	return nil
}

// The existing service spec is the launch definition; the profile header only
// distinguishes files created here from a user's unrelated personal agent.
func prepareNativePersonalBot(cfg *config.Config, opts nativePersonalBotOptions) ([]string, serviceInstallOptions, error) {
	install := serviceInstallOptions{noStart: opts.noStart, yes: true}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return nil, install, fmt.Errorf("native assistant setup requires Linux/systemd or macOS/launchd")
	}
	e, err := newServiceEnvironment()
	if err != nil {
		return nil, install, err
	}
	configDir, err := config.GetConfigDir()
	if err != nil {
		return nil, install, err
	}
	agentDir, err := filepath.Abs(filepath.Join(configDir, "agents", "personal"))
	if err != nil {
		return nil, install, err
	}
	install.nativeAgent = agentDir
	if opts.workspace != "" {
		opts.workspace, err = filepath.Abs(opts.workspace)
		if err != nil {
			return nil, install, err
		}
	}
	old, oldErr := userservice.Load(e.specPath("web"))
	if oldErr != nil && !os.IsNotExist(oldErr) {
		return nil, install, oldErr
	}
	if oldErr == nil {
		if err := checkNativePersonalBotService(old, agentDir); err != nil {
			return nil, install, err
		}
		if opts.purpose != "" || (opts.port != 0 && opts.port != old.Port) || (opts.workspace != "" && filepath.Clean(opts.workspace) != old.Directory) {
			return nil, install, fmt.Errorf("assistant already exists; edit its agent files or use service install web to change its saved settings")
		}
	}
	if err := e.native.CheckOwned("web", e.specPath("web")); err != nil {
		return nil, install, err
	}
	workspace := opts.workspace
	if oldErr == nil {
		workspace = old.Directory
	} else if workspace == "" {
		data, err := appdata.GetDataDir()
		if err != nil {
			return nil, install, err
		}
		workspace = filepath.Join(data, "personal-bot", "workspace")
	}
	workspace, err = filepath.Abs(workspace)
	if err != nil {
		return nil, install, err
	}
	port := opts.port
	if port == 0 {
		port = 8080
	}
	args := []string{"jobs", "--personal-bot", "--agent", agentDir, "--auth", "bearer", "--no-projects", "--port", strconv.Itoa(port), "--read-dir", workspace, "--write-dir", workspace}
	// Validate before creating any files; installation repeats this under its lock.
	if _, err := parseServiceLaunch("web", args); err != nil {
		return nil, install, err
	}
	install.initialSecrets, err = nativePersonalBotSecrets(cfg)
	if err != nil {
		return nil, install, err
	}
	if err := ensureNativePersonalBotAgent(agentDir, opts.purpose); err != nil {
		return nil, install, err
	}
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return nil, install, fmt.Errorf("create assistant working folder: %w", err)
	}
	if oldErr != nil {
		install.directory, install.custom = workspace, true
	}
	return args, install, nil
}

func checkNativePersonalBotService(spec userservice.Spec, agentDir string) error {
	flags := pflag.NewFlagSet("native assistant", pflag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.ParseErrorsWhitelist.UnknownFlags = true
	agent := flags.String("agent", "", "")
	personal := flags.Bool("personal-bot", false, "")
	if err := flags.Parse(spec.Args); err != nil || spec.Kind != "web" || spec.Auth != "bearer" || !*personal || *agent != agentDir {
		return fmt.Errorf("an unrelated Web service is already installed; it was left unchanged (inspect with term-llm service status web)")
	}
	return nil
}

func ensureNativePersonalBotAgent(dir, purpose string) (result error) {
	if info, err := os.Lstat(dir); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("personal agent already exists and was left unchanged: %s", dir)
		}
		data, readErr := os.ReadFile(filepath.Join(dir, "agent.yaml"))
		if readErr != nil || !strings.HasPrefix(string(data), nativePersonalBotHeader) {
			return fmt.Errorf("personal agent already exists and was left unchanged: %s", dir)
		}
		_, err = agents.LoadFromPath(dir)
		return err
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return err
	}
	defer func() {
		if result != nil {
			_ = os.RemoveAll(dir) // Only the directory reserved by this invocation.
		}
	}()
	grounding := true
	data, err := yaml.Marshal(agents.Agent{
		Name: "personal", Description: "Personal assistant on this computer", MaxTurns: 100, TimeGrounding: &grounding,
		Tools: agents.ToolsConfig{Enabled: []string{"read_file", "write_file", "edit_file", "glob", "grep", "shell", "ask_user", "update_plan"}},
	})
	if err != nil {
		return err
	}
	if strings.TrimSpace(purpose) == "" {
		purpose = "Help with everyday work, keep useful files in the working folder, and follow through on recurring responsibilities."
	}
	for name, data := range map[string][]byte{
		"agent.yaml": append([]byte(nativePersonalBotHeader), data...),
		"system.md":  []byte("You are a persistent personal assistant. Use your configured working folder for useful work and deliverables.\n\n" + purpose + "\n"),
	} {
		if err := config.WriteFileAtomicallyNoFollow(filepath.Join(dir, name), data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func nativePersonalBotProviders(cfg *config.Config) []string {
	return []string{cfg.DefaultProvider, cfg.Guardian.Provider, cfg.Providers[cfg.DefaultProvider].FastProvider}
}

func nativePersonalBotSecrets(cfg *config.Config) (map[string]string, error) {
	secrets := map[string]string{}
	for _, name := range nativePersonalBotProviders(cfg) {
		if name == "" {
			continue
		}
		pc := cfg.Providers[name]
		keys := map[string]bool{}
		providerType := config.InferProviderType(name, pc.Type)
		if provider, ok := config.BuiltinProviderOfType(providerType); ok && provider.APIKeyEnv != "" {
			keys[provider.APIKeyEnv] = true
		} else if providerType == config.ProviderTypeOpenAICompat || providerType == config.ProviderTypeVLLM {
			keys[strings.ToUpper(name)+"_API_KEY"] = true
		}
		// Keep explicit api_key environment references working outside the shell.
		os.Expand(pc.APIKey, func(key string) string { keys[key] = true; return "" })
		for key := range keys {
			if value := strings.TrimSpace(os.Getenv(key)); value != "" {
				if !userservice.SecretName(key) {
					return nil, fmt.Errorf("provider %q uses %s; service credential names must end in _API_KEY, _TOKEN or another supported secret suffix", name, key)
				}
				secrets[key] = value
			}
		}
	}
	return secrets, nil
}
