package cmd

import (
	"bytes"
	"net/url"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/userservice"
	"github.com/spf13/cobra"
)

func TestServiceEnrollmentLinkDisclosure(t *testing.T) {
	terminal := hubOutputIsTerminal
	t.Cleanup(func() { hubOutputIsTerminal = terminal })
	const secret = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567"
	for _, tc := range []struct {
		name                                string
		tty, printCode, printLink, recovery bool
	}{
		{name: "redirected output"},
		{name: "interactive", tty: true},
		{name: "explicit link", printLink: true},
		{name: "explicit code", printCode: true},
		{name: "recovery code", printCode: true, recovery: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hubOutputIsTerminal = func(any) bool { return tc.tty }
			cmd := &cobra.Command{}
			cmd.Flags().Bool("print-setup-code", tc.printCode, "")
			cmd.Flags().Bool("print-setup-link", tc.printLink, "")
			var output bytes.Buffer
			cmd.SetOut(&output)
			printServiceEnrollment(cmd, userservice.Spec{Kind: "hub", URL: "https://bot.example.com/hub/"}, secret, tc.recovery)
			exposed := tc.tty || tc.printCode || tc.printLink
			if strings.Contains(output.String(), secret) != exposed {
				t.Fatalf("unexpected secret disclosure for %s", tc.name)
			}
			if !exposed {
				if !strings.Contains(output.String(), "not printed") {
					t.Fatalf("missing safe enrollment guidance: %s", &output)
				}
				return
			}
			if tc.recovery {
				if !strings.Contains(output.String(), "/auth/recover") || strings.Contains(output.String(), "#setup=") {
					t.Fatal("changed manual recovery semantics")
				}
				return
			}
			fields := strings.Fields(output.String())
			if len(fields) < 2 || fields[0] != "Open" {
				t.Fatal("missing setup link")
			}
			link, err := url.Parse(fields[1])
			if err != nil || link.Path != "/hub/auth/setup" || link.RawQuery != "" || link.Fragment != "setup="+secret {
				t.Fatalf("invalid setup link: %v", err)
			}
			if strings.Contains(link.RequestURI(), secret) {
				t.Fatal("setup code would be sent in an HTTP request URL")
			}
		})
	}
}
