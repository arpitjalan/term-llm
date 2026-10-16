package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestServePersonalBotRequiresWeb(t *testing.T) {
	flag := serveCmd.Flags().Lookup("personal-bot")
	if flag == nil || flag.DefValue != "false" {
		t.Fatal("serve --personal-bot must be registered and disabled by default")
	}
	for _, tc := range []struct {
		name       string
		args       []string
		configured []string
		enabled    bool
		want       []string
		wantErr    bool
	}{
		{name: "web", args: []string{"web"}, enabled: true, want: []string{"web"}},
		{name: "web and jobs", args: []string{"web", "jobs"}, enabled: true, want: []string{"web", "jobs"}},
		{name: "configured web", configured: []string{"web", "jobs"}, enabled: true, want: []string{"web", "jobs"}},
		{name: "API only", args: []string{"api"}, enabled: true, wantErr: true},
		{name: "jobs only", args: []string{"jobs"}, enabled: true, wantErr: true},
		{name: "configured jobs only", configured: []string{"jobs"}, enabled: true, wantErr: true},
		{name: "arguments override configured web", args: []string{"api"}, configured: []string{"web"}, enabled: true, wantErr: true},
		{name: "ordinary jobs unchanged", args: []string{"jobs"}, want: []string{"jobs"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolvePlatforms(tc.args, tc.configured, tc.enabled)
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), "--personal-bot requires the web platform") {
					t.Fatalf("resolvePlatforms error = %v, want personal-bot web requirement", err)
				}
				return
			}
			if err != nil || !slices.Equal(got, tc.want) {
				t.Fatalf("resolvePlatforms = %v, %v; want %v, nil", got, err, tc.want)
			}
		})
	}
}

func TestServePersonalBotHTMLIsOptIn(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		name := "ordinary web"
		if enabled {
			name = "personal bot"
		}
		t.Run(name, func(t *testing.T) {
			srv := &serveServer{
				cfg:        serveServerConfig{ui: true, basePath: "/assistant", personalBot: enabled},
				startupDir: t.TempDir(),
			}
			recorder := httptest.NewRecorder()
			srv.handleUI(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
			if recorder.Code != http.StatusOK {
				t.Fatalf("UI status = %d, want 200", recorder.Code)
			}
			body := recorder.Body.String()
			if strings.Contains(body, "TERM_LLM_PERSONAL_BOT") != enabled {
				t.Fatalf("personal bot bootstrap presence does not match enabled=%t", enabled)
			}
			if enabled && !strings.Contains(body, `<script>window.TERM_LLM_PERSONAL_BOT=true;</script>`) {
				t.Fatal("personal bot page must enable the frontend with a boolean bootstrap value")
			}
			if !strings.Contains(body, `window.TERM_LLM_UI_PREFIX="/assistant"`) {
				t.Fatal("personal bot must retain the existing custom-base-path bootstrap")
			}
		})
	}
}

func TestServeCapabilitiesAdvertiseJobsAvailability(t *testing.T) {
	srv := &serveServer{projectsEnabled: true}
	var previousETag string
	for _, enabled := range []bool{false, true} {
		if enabled {
			srv.jobsV2 = &jobsV2Manager{}
		}
		recorder := httptest.NewRecorder()
		srv.handleCapabilities(recorder, httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("capabilities status = %d, want 200", recorder.Code)
		}
		var payload struct {
			Jobs *struct {
				Enabled bool `json:"enabled"`
			} `json:"jobs"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Jobs == nil || payload.Jobs.Enabled != enabled {
			t.Fatalf("jobs capability = %+v, want enabled=%t", payload.Jobs, enabled)
		}
		etag := recorder.Header().Get("ETag")
		if etag == "" || etag == previousETag {
			t.Fatal("capabilities ETag must reflect jobs availability")
		}
		previousETag = etag
	}
}
