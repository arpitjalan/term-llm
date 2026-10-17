package cmd

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/samsaffron/term-llm/internal/passkeyauth"
	"github.com/spf13/cobra"
)

//go:embed server_setup.sh
var serverSetupScript []byte

func init() {
	server := &cobra.Command{Use: "server", Short: "Set up a public Hub on a fresh Linux server"}
	var domain, email string
	var acceptTerms bool
	setup := &cobra.Command{
		Use: "setup", Short: "Configure HTTPS and an automatically started Personal Bot Hub",
		Long: `Set up a fresh Debian/Ubuntu systemd server with Nginx, a Let's Encrypt
certificate, Docker, and the existing managed Hub service under a dedicated account.
Point your domain at this server and allow inbound ports 80 and 443 first.
Administrator access is required. Existing unrelated deployments are preserved.
The final private setup link lets you enroll a passkey without entering a token.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if runtime.GOOS != "linux" {
				return fmt.Errorf("server setup requires a Debian/Ubuntu Linux server with systemd")
			}
			domain = strings.ToLower(strings.TrimSpace(domain))
			if err := validateServerSetupDomain(domain); err != nil {
				return err
			}
			if !acceptTerms {
				return fmt.Errorf("HTTPS certificate registration requires --accept-acme-tos (Let's Encrypt subscriber agreement)")
			}
			return runServerSetup(cmd, domain, email)
		},
	}
	setup.Flags().StringVar(&domain, "domain", "", "Public DNS hostname pointing to this server")
	setup.Flags().StringVar(&email, "email", "", "Optional certificate account email")
	setup.Flags().BoolVar(&acceptTerms, "accept-acme-tos", false, "Accept the Let's Encrypt subscriber agreement for certificate registration")
	_ = setup.MarkFlagRequired("domain")
	server.AddCommand(setup)
	rootCmd.AddCommand(server)
}

func validateServerSetupDomain(domain string) error {
	endpoint, err := passkeyauth.ParseEndpoint(passkeyauth.EndpointOptions{PublicURL: "https://" + domain + "/"})
	if err != nil || !strings.Contains(domain, ".") || endpoint.URL.Host != domain || endpoint.BasePath != "" {
		return fmt.Errorf("--domain must be a DNS hostname, such as hub.example.com, without a scheme, port or path")
	}
	return nil
}

func runServerSetup(cmd *cobra.Command, domain, email string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return fmt.Errorf("resolve server executable: %w", err)
	}
	dir, err := os.MkdirTemp("", "term-llm-server-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	script := filepath.Join(dir, "setup.sh")
	if err := os.WriteFile(script, serverSetupScript, 0o600); err != nil {
		return err
	}
	program := "sh"
	args := []string{script, "--domain", domain, "--binary", binary, "--accept-acme-tos"}
	if email != "" {
		args = append(args, "--email", email)
	}
	if os.Geteuid() != 0 {
		program = "sudo"
		args = append([]string{"-H", "--", "sh"}, args...)
	}
	run := exec.CommandContext(cmd.Context(), program, args...)
	run.Stdin, run.Stdout, run.Stderr = cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr()
	if err := run.Run(); err != nil {
		return fmt.Errorf("server setup did not finish; correct the reported problem and rerun: %w", err)
	}
	return nil
}
