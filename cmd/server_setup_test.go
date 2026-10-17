package cmd

import "testing"

func TestServerSetupDomainRejectsURLAndShellInput(t *testing.T) {
	for _, domain := range []string{"bot.example.com", "bot-2.example.com", "xn--bcher-kva.example"} {
		if err := validateServerSetupDomain(domain); err != nil {
			t.Errorf("rejected hostname %q: %v", domain, err)
		}
	}
	for _, domain := range []string{"", "localhost", "127.0.0.1", "::1", "https://bot.example.com", "bot.example.com:443", "bot.example.com/path", "bot.example.com?x=1", "bot.example.com#secret", "user@bot.example.com", "bot..example.com", "bot.example.com\nnginx", "bot.example.com;id", "$(id).example.com", " bot.example.com"} {
		t.Run(domain, func(t *testing.T) {
			if err := validateServerSetupDomain(domain); err == nil {
				t.Fatal("accepted a non-hostname as server configuration")
			}
		})
	}
}
