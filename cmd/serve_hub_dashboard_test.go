package cmd

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/contain"
	"github.com/samsaffron/term-llm/internal/hub"
)

func TestHubDashboardRouteSelectsIndependentShell(t *testing.T) {
	for _, base := range []string{"", "/hub", "/company/bot"} {
		for _, personalBot := range []bool{false, true} {
			t.Run(fmt.Sprintf("base=%s/personalBot=%v", base, personalBot), func(t *testing.T) {
				s := newHubServer(hub.NewRegistry(), nil)
				s.basePath = base
				if personalBot {
					s.assistantManager = &contain.Manager{}
				}
				for _, path := range []string{"/", "/dashboard/"} {
					// Query values must never select a different dashboard entry.
					r := httptest.NewRequest(http.MethodGet, base+path+"?personalBot=true&personalBotManager=true", nil)
					w := httptest.NewRecorder()
					s.handler().ServeHTTP(w, r)
					if w.Code != http.StatusOK {
						t.Fatalf("%s: status=%d body=%s", path, w.Code, w.Body.String())
					}
					config := hubCacheShellConfig(t, w)
					manager := personalBot && path == "/"
					if config.Page != "dashboard" || config.BasePath != base || config.PersonalBot != personalBot {
						t.Fatalf("%s: shell configuration=%+v", path, config)
					}
					entry, title := "hub", "Hub - term-llm"
					if manager {
						entry, title = "personal-bot", "Your agents - term-llm"
					}
					body := w.Body.String()
					for _, want := range []string{"<title>" + title + "</title>", base + "/dist/" + entry + ".js?v=", base + "/dist/" + entry + ".css?v="} {
						if !strings.Contains(body, want) {
							t.Errorf("%s: shell missing %q", path, want)
						}
					}
					if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Frame-Options") != "DENY" {
						t.Fatalf("%s: shell security headers=%v", path, w.Header())
					}
				}
			})
		}
	}
}

func TestHubDashboardRouteCanonicalPathAndMethods(t *testing.T) {
	for _, base := range []string{"", "/hub"} {
		s := newHubServer(hub.NewRegistry(), nil)
		s.basePath = base
		handler := s.handler()
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(method, base+"/dashboard?node=alpha%2Fbeta&view=overview", nil))
			if w.Code != http.StatusTemporaryRedirect || w.Header().Get("Location") != base+"/dashboard/?node=alpha%2Fbeta&view=overview" {
				t.Fatalf("%s %s: redirect=%d %q", method, base, w.Code, w.Header().Get("Location"))
			}
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodHead, base+"/dashboard/", nil))
		if w.Code != http.StatusOK || w.Body.Len() != 0 || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatalf("HEAD %s: status=%d headers=%v body=%s", base, w.Code, w.Header(), w.Body.String())
		}
		for _, path := range []string{"/", "/dashboard", "/dashboard/"} {
			w = httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, base+path, nil))
			if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
				t.Fatalf("POST %s%s: status=%d headers=%v", base, path, w.Code, w.Header())
			}
		}
		for _, path := range []string{"/dashboard/nodes", "/dashboardish/", "/dashboard/index.html"} {
			w = httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, base+path, nil))
			if w.Code != http.StatusNotFound {
				t.Fatalf("%s%s: status=%d, want 404", base, path, w.Code)
			}
		}
	}
}

func TestHubDashboardRouteRequiresSharedBearerAuthentication(t *testing.T) {
	s := newHubServer(hub.NewRegistry(), nil)
	s.requireAuth, s.token, s.basePath = true, "operator-secret", "/hub"
	s.assistantManager = &contain.Manager{}
	for _, path := range []string{"/hub/", "/hub/dashboard", "/hub/dashboard/"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized || hubCacheShellConfig(t, w).Page != "bearer-login" {
			t.Fatalf("anonymous %s: status=%d body=%s", path, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), `action="`+path+`"`) {
			t.Fatalf("%s: login lost destination", path)
		}
		// A cookie issued for the Hub also grants access to its regular dashboard.
		r.AddCookie(&http.Cookie{Name: hubAuthCookieName, Value: s.token})
		w = httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		want := http.StatusOK
		if path == "/hub/dashboard" {
			want = http.StatusTemporaryRedirect
		}
		if w.Code != want {
			t.Fatalf("authenticated %s: status=%d body=%s", path, w.Code, w.Body.String())
		}
	}
}

func TestHubDashboardRouteRequiresSharedPasskeySession(t *testing.T) {
	s := newTestPasskeyHub(t, "/hub")
	s.assistantManager = &contain.Manager{}
	issued, err := s.passkey.sessions.Create("credential")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/hub/", "/hub/dashboard/"} {
		r := httptest.NewRequest(http.MethodGet, "http://backend"+path, nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != http.StatusSeeOther {
			t.Fatalf("anonymous %s: status=%d body=%s", path, w.Code, w.Body.String())
		}
		r.AddCookie(&http.Cookie{Name: hubSessionCookieName, Value: issued.Token})
		w = httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		if w.Code != http.StatusOK || hubCacheShellConfig(t, w).AuthMode != "passkey" {
			t.Fatalf("authenticated %s: status=%d body=%s", path, w.Code, w.Body.String())
		}
	}
}
