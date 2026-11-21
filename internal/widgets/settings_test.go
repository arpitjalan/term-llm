package widgets

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func widgetState(t *testing.T, m *Manager, mount string) string {
	t.Helper()
	for _, s := range m.Status() {
		if s.Mount == mount {
			return s.State
		}
	}
	t.Fatalf("no widget at mount %q in %+v", mount, m.Status())
	return ""
}

func writeSettingsFile(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, SettingsFile), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func proxyGet(m *Manager, mount string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	m.Proxy(mount, rec, httptest.NewRequest(http.MethodGet, "/", nil))
	return rec
}

func TestScanMarksWidgetsListedInSettingsDisabled(t *testing.T) {
	dir := t.TempDir()
	writeWidget(t, dir, "alpha", "title: Alpha\ncommand: [\"echo\", \"$PORT\"]\n")
	writeWidget(t, dir, "beta", "title: Beta\nmount: beta-app\ncommand: [\"echo\", \"$PORT\"]\n")
	// Listed by directory, not mount; a name with no widget is harmless.
	writeSettingsFile(t, dir, "disabled:\n  - beta\n  - removed-widget\n")

	m := NewManager(dir, "/ui")
	defer m.Close()

	if got := widgetState(t, m, "alpha"); got != "stopped" {
		t.Errorf("alpha state = %q, want stopped", got)
	}
	if got := widgetState(t, m, "beta-app"); got != "disabled" {
		t.Errorf("beta state = %q, want disabled", got)
	}
	if errs := m.LoadErrors(); len(errs) != 0 {
		t.Errorf("load errors = %v, want none", errs)
	}
	if rec := proxyGet(m, "beta-app"); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "widget disabled: beta-app") {
		t.Errorf("proxy to disabled widget = %d %q, want 404 widget disabled", rec.Code, rec.Body.String())
	}
}

func TestSetDisabledStopsWidgetAndKeepsItOffUntilEnabled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the helper widget process is exercised on Unix")
	}
	dir := t.TempDir()
	writeWidget(t, dir, "live", "title: Live\ncommand: [\""+os.Args[0]+"\", \"-test.run=TestWidgetChildHTTPServer\", \"--\", \"$PORT\"]\n")
	m := NewManager(dir, "/ui")
	defer m.Close()

	if rec := proxyGet(m, "live"); rec.Code != http.StatusOK {
		t.Fatalf("first request = %d %q, want 200", rec.Code, rec.Body.String())
	}
	e := m.entries["live"]
	if e.process() == nil {
		t.Fatal("widget process did not start")
	}

	if err := m.SetDisabled("live", true); err != nil {
		t.Fatalf("SetDisabled(true): %v", err)
	}
	if e.process() != nil {
		t.Fatal("disabling left the widget process running")
	}
	if got := widgetState(t, m, "live"); got != "disabled" {
		t.Fatalf("state after disable = %q, want disabled", got)
	}
	if rec := proxyGet(m, "live"); rec.Code != http.StatusNotFound {
		t.Fatalf("request while disabled = %d %q, want 404", rec.Code, rec.Body.String())
	}
	if e.process() != nil {
		t.Fatal("a request started the disabled widget")
	}

	// A restart, or a reload, reads the choice back from SettingsFile.
	restarted := NewManager(dir, "/ui")
	defer restarted.Close()
	if got := widgetState(t, restarted, "live"); got != "disabled" {
		t.Fatalf("state after restart = %q, want disabled", got)
	}
	m.Reload()
	if got := widgetState(t, m, "live"); got != "disabled" {
		t.Fatalf("state after reload = %q, want disabled", got)
	}

	if err := m.SetDisabled("live", false); err != nil {
		t.Fatalf("SetDisabled(false): %v", err)
	}
	if got := widgetState(t, m, "live"); got != "stopped" {
		t.Fatalf("state after enable = %q, want stopped", got)
	}
	if rec := proxyGet(m, "live"); rec.Code != http.StatusOK {
		t.Fatalf("request after enable = %d %q, want 200", rec.Code, rec.Body.String())
	}
	settings, err := readSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Disabled) != 0 {
		t.Fatalf("disabled after enable = %v, want none", settings.Disabled)
	}
}

func TestSetDisabledWritesSortedNamesUnderAHeader(t *testing.T) {
	dir := t.TempDir()
	for _, id := range []string{"alpha", "beta", "gamma"} {
		writeWidget(t, dir, id, "title: "+id+"\ncommand: [\"echo\", \"$PORT\"]\n")
	}
	m := NewManager(dir, "/ui")
	defer m.Close()

	for _, step := range []struct {
		mount    string
		disabled bool
	}{{"gamma", true}, {"alpha", true}, {"alpha", true}, {"beta", true}, {"beta", false}} {
		if err := m.SetDisabled(step.mount, step.disabled); err != nil {
			t.Fatalf("SetDisabled(%q, %v): %v", step.mount, step.disabled, err)
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, SettingsFile))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.HasPrefix(got, settingsHeader) {
		t.Errorf("settings file lost its header:\n%s", got)
	}
	if want := "disabled:\n  - alpha\n  - gamma\n"; !strings.HasSuffix(got, want) {
		t.Errorf("settings file = %q, want it to end with %q", got, want)
	}
}

func TestSetDisabledRejectsUnknownMount(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(dir, "/ui")
	defer m.Close()

	if err := m.SetDisabled("missing", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetDisabled(missing) = %v, want ErrNotFound", err)
	}
	if _, err := os.Stat(filepath.Join(dir, SettingsFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("settings file written for an unknown widget (stat err %v)", err)
	}
}

func TestUnreadableSettingsDisableNothingAndAreNotOverwritten(t *testing.T) {
	cases := map[string]func(t *testing.T, dir string){
		"malformed": func(t *testing.T, dir string) { writeSettingsFile(t, dir, "disabled: [alpha\n") },
		"unknown key": func(t *testing.T, dir string) {
			writeSettingsFile(t, dir, "disabled: [alpha]\nenabled: [beta]\n")
		},
		"symlink": func(t *testing.T, dir string) {
			if runtime.GOOS == "windows" {
				t.Skip("symlinks need extra privileges on Windows")
			}
			target := filepath.Join(t.TempDir(), "elsewhere.yaml")
			if err := os.WriteFile(target, []byte("disabled: [alpha]\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, SettingsFile)); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeWidget(t, dir, "alpha", "title: Alpha\ncommand: [\"echo\", \"$PORT\"]\n")
			setup(t, dir)
			before, err := os.Lstat(filepath.Join(dir, SettingsFile))
			if err != nil {
				t.Fatal(err)
			}

			m := NewManager(dir, "/ui")
			defer m.Close()

			if got := widgetState(t, m, "alpha"); got != "stopped" {
				t.Errorf("state = %q, want stopped", got)
			}
			if errs := m.LoadErrors(); len(errs) != 1 || !strings.Contains(errs[0].Error(), SettingsFile) {
				t.Errorf("load errors = %v, want one naming %s", errs, SettingsFile)
			}
			if err := m.SetDisabled("alpha", true); err == nil {
				t.Error("SetDisabled succeeded over an unreadable settings file")
			}
			after, err := os.Lstat(filepath.Join(dir, SettingsFile))
			if err != nil {
				t.Fatal(err)
			}
			if !os.SameFile(before, after) || before.ModTime() != after.ModTime() {
				t.Error("an unreadable settings file was replaced")
			}
		})
	}
}
