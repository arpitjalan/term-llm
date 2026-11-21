package serve

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/term-llm/term-llm/internal/widgets"
)

func TestWidgetIndexUsesProxyPortableLinks(t *testing.T) {
	dir := t.TempDir()
	widgetDir := filepath.Join(dir, "example")
	if err := os.Mkdir(widgetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := "title: Example\nmount: example\ncommand: [\"echo\", \"$PORT\"]\n"
	if err := os.WriteFile(filepath.Join(widgetDir, "widget.yaml"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	manager := widgets.NewManager(dir, "/ui")
	defer manager.Close()
	srv := &serveServer{widgetsMgr: manager}

	rec := httptest.NewRecorder()
	srv.handleWidgetIndex(rec, httptest.NewRequest(http.MethodGet, "/widgets", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%q", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `href="widgets/example/"`) {
		t.Fatalf("index missing relative widget link: %s", body)
	}
	if strings.Contains(body, `href="/ui/widgets/example/"`) {
		t.Fatalf("index baked in node-local base path: %s", body)
	}
}

func TestAdminWidgetsStopRoute(t *testing.T) {
	manager := widgets.NewManager(t.TempDir(), "/ui")
	defer manager.Close()
	srv := &serveServer{widgetsMgr: manager}
	mux := http.NewServeMux()
	srv.registerWidgetRoutes(mux)

	post := httptest.NewRecorder()
	mux.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/admin/widgets/stop", nil))
	if post.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200; body=%s", post.Code, post.Body.String())
	}
	if got := post.Body.String(); got != `{"ok":true}` {
		t.Fatalf("POST body = %q, want %q", got, `{"ok":true}`)
	}

	get := httptest.NewRecorder()
	mux.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/admin/widgets/stop", nil))
	if get.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405; body=%s", get.Code, get.Body.String())
	}
}

func TestAdminWidgetActionRoutes(t *testing.T) {
	dir := t.TempDir()
	widgetDir := filepath.Join(dir, "example")
	if err := os.Mkdir(widgetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := "title: Example\ncommand: [\"echo\", \"$PORT\"]\n"
	if err := os.WriteFile(filepath.Join(widgetDir, "widget.yaml"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	manager := widgets.NewManager(dir, "/ui")
	defer manager.Close()
	srv := &serveServer{widgetsMgr: manager}
	mux := http.NewServeMux()
	srv.registerWidgetRoutes(mux)
	serve := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}
	state := func() string { return manager.Status()[0].State }

	for _, step := range []struct {
		path  string
		state string
	}{
		{"/admin/widgets/example/disable", "disabled"},
		{"/admin/widgets/example/disable", "disabled"},
		{"/admin/widgets/example/enable", "stopped"},
		{"/admin/widgets/example/stop", "stopped"},
	} {
		rec := serve(http.MethodPost, step.path)
		if rec.Code != http.StatusOK || rec.Body.String() != `{"ok":true}` {
			t.Fatalf("POST %s = %d %q, want 200 {\"ok\":true}", step.path, rec.Code, rec.Body.String())
		}
		if got := state(); got != step.state {
			t.Fatalf("after POST %s state = %q, want %q", step.path, got, step.state)
		}
	}

	for _, tc := range []struct {
		method, path string
		code         int
	}{
		{http.MethodPost, "/admin/widgets/missing/disable", http.StatusNotFound},
		{http.MethodPost, "/admin/widgets/missing/stop", http.StatusNotFound},
		{http.MethodPost, "/admin/widgets/example/delete", http.StatusNotFound},
		{http.MethodPost, "/admin/widgets/example", http.StatusNotFound},
		{http.MethodGet, "/admin/widgets/example/disable", http.StatusMethodNotAllowed},
	} {
		if rec := serve(tc.method, tc.path); rec.Code != tc.code {
			t.Errorf("%s %s = %d %q, want %d", tc.method, tc.path, rec.Code, rec.Body.String(), tc.code)
		}
	}
	if got := state(); got != "stopped" {
		t.Errorf("state after rejected requests = %q, want stopped", got)
	}
}
