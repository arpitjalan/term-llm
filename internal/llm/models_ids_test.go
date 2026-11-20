package llm

import (
	"slices"
	"testing"

	"github.com/term-llm/term-llm/internal/config"
)

func TestAccountListsModelConsultsOnlyDirectAccountCatalogs(t *testing.T) {
	original := accountModelCatalogs[config.ProviderTypeChatGPT]
	t.Cleanup(func() { accountModelCatalogs[config.ProviderTypeChatGPT] = original })
	var lookups []string
	accountModelCatalogs[config.ProviderTypeChatGPT] = func(model string) (bool, bool, bool) {
		lookups = append(lookups, model)
		return model == "gpt-6.1-sol", true, true
	}

	cfg := &config.Config{Providers: map[string]config.ProviderConfig{
		"chatgpt": {ModelConfigs: []config.ProviderModelConfig{{ID: "gpt-6.1-sol", Alias: "sol"}}},
		"work":    {Type: config.ProviderTypeChatGPT},
		"gateway": {Type: config.ProviderTypeChatGPT, BaseURL: "https://gateway.example/backend-api/codex"},
		"shared":  {Type: config.ProviderTypeChatGPT, ProxyBinding: "proxy-route"},
	}}
	tests := []struct {
		provider, model string
		listed, checked bool
	}{
		{provider: "chatgpt", model: "gpt-5.5", checked: true},
		{provider: "chatgpt", model: "sol", listed: true, checked: true},
		{provider: "work", model: "gpt-6.1-sol", listed: true, checked: true},
		{provider: "gateway", model: "gpt-5.5"},
		{provider: "shared", model: "gpt-5.5"},
		{provider: "anthropic", model: "claude-sonnet-4-6"},
	}
	for _, tt := range tests {
		listed, _, checked := AccountListsModel(cfg, tt.provider, tt.model)
		if listed != tt.listed || checked != tt.checked {
			t.Errorf("AccountListsModel(%s:%s) = listed %v, checked %v; want listed %v, checked %v",
				tt.provider, tt.model, listed, checked, tt.listed, tt.checked)
		}
	}
	// Aliases reach the catalog as upstream IDs; other endpoints never reach it.
	if want := []string{"gpt-5.5", "gpt-6.1-sol", "gpt-6.1-sol"}; !slices.Equal(lookups, want) {
		t.Fatalf("catalog lookups = %v, want %v", lookups, want)
	}
}
