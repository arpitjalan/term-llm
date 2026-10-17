package cmd

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestServeHubRejectsInvalidBrokerOptionsBeforeStartup(t *testing.T) {
	oldPersonal, oldContain, oldHost := serveHubPersonalBot, serveHubContain, serveHubPersonalBotBrokerHost
	t.Cleanup(func() {
		serveHubPersonalBot, serveHubContain, serveHubPersonalBotBrokerHost = oldPersonal, oldContain, oldHost
	})
	serveHubContain = true
	for _, tc := range []struct {
		name, host, want string
		personal         bool
	}{
		{name: "requires Personal Bot", host: "172.17.0.1", want: "requires --personal-bot"},
		{name: "hostname", personal: true, host: "docker.local", want: "must be an IPv4 address"},
		{name: "IPv6", personal: true, host: "::1", want: "must be an IPv4 address"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			serveHubPersonalBot, serveHubPersonalBotBrokerHost = tc.personal, tc.host
			if err := runServeHub(&cobra.Command{}, nil); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("startup error = %v, want %q", err, tc.want)
			}
		})
	}
}
