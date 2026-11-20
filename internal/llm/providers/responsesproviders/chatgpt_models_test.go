package responsesproviders

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/term-llm/term-llm/internal/credentials"
)

func TestChatGPTListModelsFetchesAndCachesServiceTiers(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	origClient := chatGPTHTTPClient
	defer func() { chatGPTHTTPClient = origClient }()

	calls := 0
	chatGPTHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Path != "/backend-api/codex/models" {
			t.Fatalf("path = %q", req.URL.Path)
		}
		if got := req.URL.Query().Get("client_version"); got != "0.167.0" {
			t.Fatalf("client_version = %q, want current stable Codex catalog version 0.167.0", got)
		}
		if got := req.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Fatalf("Authorization = %q", got)
		}
		if got := req.Header.Get("originator"); got != chatGPTOriginator {
			t.Fatalf("originator = %q, want %q", got, chatGPTOriginator)
		}
		if got := req.Header.Get("User-Agent"); got != chatGPTUserAgent() {
			t.Fatalf("User-Agent = %q, want %q", got, chatGPTUserAgent())
		}
		if got := req.Header.Get("version"); got != "" {
			t.Fatalf("version = %q, want omitted (not a Codex application)", got)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"ETag": []string{"etag-1"}},
			Body: io.NopCloser(strings.NewReader(`{
				"models": [{
					"slug": "gpt-5.5",
					"display_name": "GPT 5.5",
					"max_input_tokens": 123,
					"service_tiers": [{"id":"priority","name":"fast","description":"Priority processing"}],
					"additional_speed_tiers": ["fast"]
				}]
			}`)),
		}, nil
	})}

	provider := NewChatGPTProviderWithCreds(&credentials.ChatGPTCredentials{
		AccessToken: "test-token",
		AccountID:   "test-account",
		ExpiresAt:   time.Now().Add(time.Hour).Unix(),
	}, "gpt-5.5-medium")

	models, err := provider.ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	if len(models) != 1 || models[0].ID != "gpt-5.5" || models[0].InputLimit != 123 {
		t.Fatalf("unexpected models: %#v", models)
	}
	if !ModelSupportsFast(models[0]) {
		t.Fatalf("expected fast support: %#v", models[0])
	}

	models, err = provider.ListModels(context.Background())
	if err != nil {
		t.Fatalf("cached ListModels: %v", err)
	}
	if calls != 1 {
		t.Fatalf("calls after cache = %d, want 1", calls)
	}
}

func TestChatGPTRefreshModelsBypassesFreshCache(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	origClient := chatGPTHTTPClient
	defer func() { chatGPTHTTPClient = origClient }()

	if err := saveChatGPTModelsCache(chatGPTModelsCache{
		AccountID: "test-account", FetchedAt: time.Now(), ClientVersion: chatGPTModelsClientVersion,
		Models: []ModelInfo{{ID: "old-model"}},
	}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	chatGPTHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"models":[{"slug":"gpt-6.1-sol","context_window":272000}]}`))}, nil
	})}
	provider := NewChatGPTProviderWithCreds(&credentials.ChatGPTCredentials{
		AccessToken: "test-token", AccountID: "test-account", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}, "old-model")

	models, err := provider.RefreshModelsForProvider(context.Background(), "chatgpt")
	if err != nil || len(models) != 1 || models[0].ID != "gpt-6.1-sol" || calls != 1 {
		t.Fatalf("refresh = %#v, error %v, calls %d", models, err, calls)
	}
	models, err = provider.ListModels(context.Background())
	if err != nil || len(models) != 1 || models[0].ID != "gpt-6.1-sol" || calls != 1 {
		t.Fatalf("cached listing = %#v, error %v, calls %d", models, err, calls)
	}
}

func TestChatGPTRefreshModelsReportsFailureWithoutFallback(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	origClient := chatGPTHTTPClient
	defer func() { chatGPTHTTPClient = origClient }()
	if err := saveChatGPTModelsCache(chatGPTModelsCache{
		AccountID: "test-account", FetchedAt: time.Now(), ClientVersion: chatGPTModelsClientVersion,
		Models: []ModelInfo{{ID: "old-model"}},
	}); err != nil {
		t.Fatal(err)
	}
	chatGPTHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("network down")
	})}
	provider := NewChatGPTProviderWithCreds(&credentials.ChatGPTCredentials{
		AccessToken: "test-token", AccountID: "test-account", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}, "old-model")
	if _, err := provider.RefreshModelsForProvider(context.Background(), "chatgpt"); err == nil || !strings.Contains(err.Error(), "network down") {
		t.Fatalf("refresh error = %v, want network failure", err)
	}
	models, err := provider.ListModels(context.Background())
	if err != nil || len(models) != 1 || models[0].ID != "old-model" {
		t.Fatalf("cache after failed refresh = %#v, error %v", models, err)
	}
}

func TestChatGPTRefreshModelsRejectsEmptyCatalog(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	origClient := chatGPTHTTPClient
	defer func() { chatGPTHTTPClient = origClient }()
	chatGPTHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"models":[]}`))}, nil
	})}
	provider := NewChatGPTProviderWithCreds(&credentials.ChatGPTCredentials{
		AccessToken: "test-token", AccountID: "test-account", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}, "old-model")
	if _, err := provider.RefreshModelsForProvider(context.Background(), "chatgpt"); err == nil || !strings.Contains(err.Error(), "no models") {
		t.Fatalf("refresh error = %v, want empty catalog error", err)
	}
}

func TestChatGPTListModelsFallsBackToStaleCache(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	origClient := chatGPTHTTPClient
	defer func() { chatGPTHTTPClient = origClient }()

	if err := saveChatGPTModelsCache(chatGPTModelsCache{
		AccountID:     "test-account",
		FetchedAt:     time.Now().Add(-time.Hour),
		ClientVersion: chatGPTModelsClientVersion,
		Models: []ModelInfo{{
			ID:                     "gpt-5.5",
			ServiceTiers:           []ModelServiceTier{{ID: ServiceTierFast}},
			ReasoningEfforts:       []string{"medium", "max", "ultra"},
			DefaultReasoningEffort: "ultra",
		}},
	}); err != nil {
		t.Fatalf("save cache: %v", err)
	}

	chatGPTHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("network down")
	})}

	provider := NewChatGPTProviderWithCreds(&credentials.ChatGPTCredentials{
		AccessToken: "test-token",
		AccountID:   "test-account",
		ExpiresAt:   time.Now().Add(time.Hour).Unix(),
	}, "gpt-5.5-medium")

	models, fresh, err := provider.ListModelsWithFreshness(context.Background())
	if err != nil {
		t.Fatalf("ListModels stale fallback: %v", err)
	}
	if fresh {
		t.Fatal("expected stale fallback to report fresh=false")
	}
	if len(models) != 1 || models[0].ID != "gpt-5.5" {
		t.Fatalf("unexpected stale models: %#v", models)
	}
	if want := []string{"medium", "max"}; !equalSlice(models[0].ReasoningEfforts, want) {
		t.Fatalf("stale ReasoningEfforts = %v, want %v", models[0].ReasoningEfforts, want)
	}
	if models[0].DefaultReasoningEffort != "max" {
		t.Fatalf("stale DefaultReasoningEffort = %q, want max", models[0].DefaultReasoningEffort)
	}
}

func TestChatGPTModelInfoDecodesReasoningMetadata(t *testing.T) {
	var response chatGPTModelsResponse
	if err := json.Unmarshal([]byte(`{
		"models": [
			{
				"slug": "gpt-5.6-sol",
				"display_name": "GPT-5.6 Sol",
				"input_token_limit": 372000,
				"supported_reasoning_levels": [
					{"effort": "low", "description": "Fast"},
					{"level": "medium"},
					"ultra"
				],
				"default_reasoning_level": "medium"
			}
		]
	}`), &response); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(response.Models) != 1 {
		t.Fatalf("models = %#v", response.Models)
	}
	got := response.Models[0].toModelInfo()
	if got.ID != "gpt-5.6-sol" || got.DisplayName != "GPT-5.6 Sol" || got.InputLimit != 372_000 {
		t.Fatalf("model identity/limit = %#v", got)
	}
	wantEfforts := []string{"low", "medium", "max"}
	if !equalSlice(got.ReasoningEfforts, wantEfforts) {
		t.Fatalf("ReasoningEfforts = %v, want %v", got.ReasoningEfforts, wantEfforts)
	}
	if got.DefaultReasoningEffort != "medium" {
		t.Fatalf("DefaultReasoningEffort = %q, want medium", got.DefaultReasoningEffort)
	}
}

func TestChatGPTModelInfoPrefersActiveContextOverMaximum(t *testing.T) {
	got := (chatGPTModelInfo{
		Slug:             "account-preview",
		ContextWindow:    272_000,
		MaxContextWindow: 872_000,
	}).toModelInfo()
	if got.InputLimit != 272_000 {
		t.Fatalf("InputLimit = %d, want active context_window 272000", got.InputLimit)
	}
}

func TestChatGPTListModelsRetainsHiddenModelsForExplicitSelection(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	origClient := chatGPTHTTPClient
	defer func() { chatGPTHTTPClient = origClient }()

	chatGPTHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(`{"models":[
				{"slug":"visible","visibility":"list","context_window":272000},
				{"slug":"hidden","visibility":"hide","context_window":872000},
				{"slug":"legacy","context_window":100000}
			]}`)),
		}, nil
	})}
	provider := NewChatGPTProviderWithCreds(&credentials.ChatGPTCredentials{
		AccessToken: "test-token",
		AccountID:   "test-account",
		ExpiresAt:   time.Now().Add(time.Hour).Unix(),
	}, "visible")

	models, fresh, err := provider.ListModelsWithFreshness(context.Background())
	if err != nil || !fresh {
		t.Fatalf("ListModelsWithFreshness() = fresh %v, error %v", fresh, err)
	}
	if len(models) != 3 || models[0].ID != "visible" || models[1].ID != "hidden" || models[2].ID != "legacy" {
		t.Fatalf("models = %#v, want complete remote catalog", models)
	}
}

func TestChatGPTCacheIsAccountScoped(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	if err := saveChatGPTModelsCache(chatGPTModelsCache{
		AccountID:     "account-a",
		FetchedAt:     time.Now(),
		ClientVersion: chatGPTModelsClientVersion,
		Models:        []ModelInfo{{ID: "private-preview"}},
	}); err != nil {
		t.Fatalf("save cache: %v", err)
	}
	if _, err := loadChatGPTModelsCacheForAccount(chatGPTModelsClientVersion, "account-a"); err != nil {
		t.Fatalf("load matching account: %v", err)
	}
	if _, err := loadChatGPTModelsCacheForAccount(chatGPTModelsClientVersion, "account-b"); err == nil {
		t.Fatal("expected cache from another account to be rejected")
	}
}

func TestChatGPTAccountListsModel(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("TERM_LLM_CREDENTIALS_DIR", t.TempDir())
	unchecked := func(when string) {
		t.Helper()
		if listed, _, checked := ChatGPTAccountListsModel("gpt-6.1-sol"); listed || checked {
			t.Fatalf("%s: listed %v, checked %v; want an unchecked result", when, listed, checked)
		}
	}
	saveCatalog := func(account string, fetchedAt time.Time) {
		t.Helper()
		if err := saveChatGPTModelsCache(chatGPTModelsCache{
			AccountID:     account,
			FetchedAt:     fetchedAt,
			ClientVersion: chatGPTModelsClientVersion,
			Models:        []ModelInfo{{ID: "gpt-6.1-sol", ReasoningEfforts: []string{"low", "medium", "high"}}, {ID: "hidden-preview"}},
		}); err != nil {
			t.Fatalf("save cache: %v", err)
		}
	}

	unchecked("without a login")
	if err := credentials.SaveChatGPTCredentials(&credentials.ChatGPTCredentials{
		AccessToken: "test-token",
		AccountID:   "account-a",
		ExpiresAt:   time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatalf("save credentials: %v", err)
	}
	unchecked("without a cached catalog")
	saveCatalog("account-b", time.Now())
	unchecked("with another account's catalog")

	saveCatalog("account-a", time.Now())
	for model, want := range map[string]bool{
		"gpt-6.1-sol":      true,
		"gpt-6.1-sol-high": true,
		"GPT-6.1-Sol":      true,
		"hidden-preview":   true,
		"gpt-5.5":          false,
		"gpt-5.4-high":     false,
	} {
		listed, fresh, checked := ChatGPTAccountListsModel(model)
		if listed != want || !fresh || !checked {
			t.Fatalf("ChatGPTAccountListsModel(%q) = listed %v, fresh %v, checked %v; want listed %v from a fresh catalog", model, listed, fresh, checked, want)
		}
	}

	saveCatalog("account-a", time.Now().Add(-time.Hour))
	if listed, fresh, checked := ChatGPTAccountListsModel("gpt-5.5"); listed || fresh || !checked {
		t.Fatalf("stale catalog: listed %v, fresh %v, checked %v; want a checked, stale miss", listed, fresh, checked)
	}
}
