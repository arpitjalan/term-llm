package cmd

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/userservice"
	"github.com/spf13/cobra"
)

func TestServiceLaunchParsing(t *testing.T) {
	originalHost, originalPort, originalCORS := serveHost, servePort, append([]string(nil), serveCORSOrigins...)
	for _, tc := range []struct {
		name, kind  string
		args        []string
		auth, url   string
		bad         bool
		errContains string
	}{
		{name: "web default", kind: "web", auth: "passkey", url: "http://localhost:8080/ui/"},
		{name: "web and jobs default", kind: "web", args: []string{"jobs"}, auth: "bearer", url: "http://localhost:8080/ui/"},
		{name: "web and jobs flags", kind: "web", args: []string{"--personal-bot", "jobs", "--auth", "bearer", "--port", "8181"}, auth: "bearer", url: "http://localhost:8181/ui/"},
		{name: "web and jobs no auth", kind: "web", args: []string{"jobs", "--no-auth"}, auth: "none", url: "http://localhost:8080/ui/"},
		{name: "web and jobs passkey rejected", kind: "web", args: []string{"jobs", "--auth", "passkey"}, bad: true, errContains: "--auth passkey supports serve web only"},
		{name: "hub default", kind: "hub", auth: "passkey", url: "http://localhost:8090/hub/"},
		{name: "custom port", kind: "web", args: []string{"--auth", "bearer", "--port", "8181"}, auth: "bearer", url: "http://localhost:8181/ui/"},
		{name: "public Hub", kind: "hub", args: []string{"--public-url", "https://hub.example.com/hub/"}, auth: "passkey", url: "https://hub.example.com/hub/"},
		{name: "reverse bearer", kind: "web", args: []string{"--auth", "bearer", "--hub-connect", "reverse", "--hub-register", "--hub-url", "https://hub.example.com/hub/", "--hub-node-id", "laptop"}, auth: "bearer", url: "http://localhost:8080/ui/"},
		{name: "existing no-auth alias", kind: "web", args: []string{"--no-auth"}, auth: "none", url: "http://localhost:8080/ui/"},
		{name: "unsafe secret argv", kind: "web", args: []string{"--token", "do-not-print"}, bad: true},
		{name: "unsafe jobs secret argv", kind: "web", args: []string{"jobs", "--token", "do-not-print"}, bad: true, errContains: "--token is not persisted"},
		{name: "unsafe Hub secret argv", kind: "hub", args: []string{"--registration-token", "do-not-print"}, bad: true},
		{name: "passkey reverse rejected", kind: "web", args: []string{"--hub-connect", " Reverse "}, bad: true},
		{name: "unknown native server flag", kind: "hub", args: []string{"--made-up"}, bad: true},
		{name: "personal bot without discovery", kind: "hub", args: []string{"--personal-bot", "--contain=false"}, bad: true},
		{name: "runtime without personal bot", kind: "hub", args: []string{"--personal-bot-binary", "/opt/term-llm-linux"}, bad: true},
		{name: "image without personal bot", kind: "hub", args: []string{"--personal-bot-image", "term-llm:latest"}, bad: true},
		{name: "relative personal bot runtime", kind: "hub", args: []string{"--personal-bot", "--personal-bot-binary", "./runtime/term-llm-linux"}, bad: true, errContains: "--personal-bot-binary must be absolute for a service"},
		{name: "personal bot runtime", kind: "hub", args: []string{"--personal-bot", "--personal-bot-binary", "/opt/term-llm-linux"}, auth: "passkey", url: "http://localhost:8090/hub/"},
		{name: "private broker", kind: "hub", args: []string{"--personal-bot", "--personal-bot-broker-host", "172.17.0.1"}, auth: "passkey", url: "http://localhost:8090/hub/"},
		{name: "broker without personal bot", kind: "hub", args: []string{"--personal-bot-broker-host", "172.17.0.1"}, bad: true, errContains: "requires --personal-bot"},
		{name: "invalid broker", kind: "hub", args: []string{"--personal-bot", "--personal-bot-broker-host", "::1"}, bad: true},
		{name: "additional platform", kind: "web", args: []string{"api"}, bad: true},
		{name: "extra platform", kind: "web", args: []string{"jobs", "api"}, bad: true},
		{name: "duplicate jobs", kind: "web", args: []string{"jobs", "jobs"}, bad: true},
		{name: "Hub jobs rejected", kind: "hub", args: []string{"jobs"}, bad: true},
		{name: "public unauthenticated", kind: "web", args: []string{"--no-auth", "--host", "0.0.0.0"}, bad: true},
		{name: "mismatched passkey paths", kind: "web", args: []string{"--public-url", "http://localhost:8080/chat/", "--base-path", "/ui"}, bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := parseServiceLaunch(tc.kind, tc.args)
			if tc.bad {
				if err == nil {
					t.Fatalf("accepted %+v", s)
				}
				if strings.Contains(err.Error(), "do-not-print") {
					t.Fatal("error leaked secret")
				}
				if tc.errContains != "" && !strings.Contains(err.Error(), tc.errContains) {
					t.Fatalf("error %q does not contain %q", err, tc.errContains)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if s.Auth != tc.auth || s.URL != tc.url {
				t.Fatalf("got %+v", s)
			}
			again, err := parseServiceLaunch(tc.kind, s.Args)
			if err != nil || again.URL != s.URL || again.Auth != s.Auth || !slices.Equal(again.Args, s.Args) {
				t.Fatalf("not idempotent %+v %v", again, err)
			}
		})
	}
	if serveHost != originalHost || servePort != originalPort || !slices.Equal(serveCORSOrigins, originalCORS) {
		t.Fatal("installer changed serve globals")
	}
}
func isolatedServiceHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "cache"))
	return home
}
func TestServiceInstallDryRunAndReinstall(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getuid() == 0 {
		t.Skip("Linux user-unit fixture")
	}
	home := isolatedServiceHome(t)
	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	if err := installUserService(cmd, "web", nil, serviceInstallOptions{dryRun: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "config")); !os.IsNotExist(err) {
		t.Fatal("dry-run wrote configuration")
	}
	if !strings.Contains(out.String(), "ExecStart=") {
		t.Fatal(out.String())
	}
	opts := serviceInstallOptions{noStart: true, yes: true, custom: true}
	if err := installUserService(cmd, "web", []string{"--auth", "bearer", "--port", "18181"}, opts); err != nil {
		t.Fatal(err)
	}
	e, err := newServiceEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	first, err := userservice.Load(e.specPath("web"))
	if err != nil {
		t.Fatal(err)
	}
	token, err := e.credentials("web").Get(cmd.Context(), serviceTokenName("web"))
	if err != nil {
		t.Fatal(err)
	}
	opts.custom = false
	if err := installUserService(cmd, "web", nil, opts); err != nil {
		t.Fatal(err)
	}
	second, err := userservice.Load(e.specPath("web"))
	if err != nil {
		t.Fatal(err)
	}
	nextToken, err := e.credentials("web").Get(cmd.Context(), serviceTokenName("web"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Port != second.Port || second.Auth != "bearer" || token != nextToken {
		t.Fatal("reinstall reset custom setup or rotated token")
	}
	if strings.Contains(out.String(), token) {
		t.Fatal("installation output leaked credential")
	}
	native, _ := os.ReadFile(e.native.Path("web"))
	spec, _ := os.ReadFile(e.specPath("web"))
	if bytes.Contains(native, []byte(token)) || bytes.Contains(spec, []byte(token)) {
		t.Fatal("secret in native unit or specification")
	}
}

func TestServiceWebJobsPreservesToken(t *testing.T) {
	home := isolatedServiceHome(t)
	e := serviceEnvironment{home: home, root: filepath.Join(home, "config", "term-llm", "services"), native: userservice.Native{OS: "linux"}}
	cmd := &cobra.Command{}
	cmd.SetContext(t.Context())
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	var old *userservice.Spec
	var firstToken string
	args := []string{"jobs", "--personal-bot", "--agent", "personal"}
	for i := range 2 {
		spec, err := buildServiceInstallSpec(e, "web", args, serviceInstallOptions{}, old)
		if err != nil {
			t.Fatal(err)
		}
		imported, names, err := collectServiceSecrets(cmd, e, "web", spec, serviceInstallOptions{initialSecrets: map[string]string{"OPENAI_API_KEY": "key-" + strconv.Itoa(i)}})
		if err != nil {
			t.Fatal(err)
		}
		if err := storeServiceSecrets(cmd, e, "web", &spec, imported, names); err != nil {
			t.Fatal(err)
		}
		if err := userservice.Save(e.specPath("web"), spec); err != nil {
			t.Fatal(err)
		}
		saved, err := userservice.Load(e.specPath("web"))
		if err != nil {
			t.Fatal(err)
		}
		token, err := e.credentials("web").Get(cmd.Context(), serviceTokenName("web"))
		if err != nil || token == "" {
			t.Fatalf("token unavailable: %v", err)
		}
		if firstToken != "" && token != firstToken {
			t.Fatal("reinstall rotated token")
		}
		if key, err := e.credentials("web").Get(cmd.Context(), "OPENAI_API_KEY"); err != nil || key != "key-0" {
			t.Fatalf("reinstall changed the saved provider credential: %v", err)
		}
		if saved.Kind != "web" || saved.Auth != "bearer" || !slices.Contains(saved.Args, "jobs") || strings.Contains(out.String(), token) || strings.Contains(strings.Join(saved.Args, " "), token) {
			t.Fatal("Web + Jobs runtime or private bearer credential was not preserved")
		}
		firstToken = token
		old, args = &saved, saved.Args
	}
}

func TestServiceKindsAreIndependent(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getuid() == 0 {
		t.Skip("Linux user-unit fixture")
	}
	isolatedServiceHome(t)
	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	for _, kind := range []string{"web", "hub"} {
		if err := installUserService(cmd, kind, nil, serviceInstallOptions{noStart: true}); err != nil {
			t.Fatal(err)
		}
	}
	e, _ := newServiceEnvironment()
	web, _ := userservice.Load(e.specPath("web"))
	hub, _ := userservice.Load(e.specPath("hub"))
	if web.Port == hub.Port || web.AuthFile == hub.AuthFile {
		t.Fatal("service identities overlap")
	}
	if _, err := e.selectKind(nil); err == nil {
		t.Fatal("ambiguous service selection")
	}
}

func TestServiceReadinessRequiresNativeProcess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer server.Close()
	host, portText, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	port, _ := strconv.Atoi(portText)
	spec := userservice.Spec{Kind: "hub", Host: host, Port: port, BasePath: "/hub"}
	if err := checkUserServicePort(spec); err == nil {
		t.Fatal("accepted an occupied port")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	native := userservice.Native{OS: "linux", Run: func(context.Context, string, ...string) ([]byte, error) { cancel(); return []byte("MainPID=0\n"), nil }}
	if err := waitUserService(ctx, spec, native); err == nil {
		t.Fatal("foreign HTTP responder was mistaken for a running managed service")
	}
	native.Run = func(context.Context, string, ...string) ([]byte, error) { return []byte("MainPID=123\n"), nil }
	if err := waitUserService(context.Background(), spec, native); err != nil {
		t.Fatal(err)
	}
}

func TestServiceSelection(t *testing.T) {
	for _, kind := range []string{"web", "hub"} {
		t.Run(kind, func(t *testing.T) {
			e := serviceEnvironment{native: userservice.Native{OS: "darwin", Home: t.TempDir()}}
			path := e.native.Path(kind)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, nil, 0600); err != nil {
				t.Fatal(err)
			}
			for _, args := range [][]string{nil, {kind}} {
				got, err := e.selectKind(args)
				if err != nil || got != kind {
					t.Fatalf("selectKind(%v) = %q, %v", args, got, err)
				}
			}
		})
	}
}

func TestServiceInstallReloadsReplacedDefinition(t *testing.T) {
	spec := userservice.Spec{Kind: "web", Port: 8080}
	for _, tc := range []struct {
		name     string
		oldErr   error
		replaced bool
		want     bool
	}{
		{"fresh install", os.ErrNotExist, false, false},
		{"unchanged reinstall", nil, false, false},
		// Upgrades can change the rendered launchd/systemd template (for example
		// ProcessType) without changing the saved spec; the loaded job must reload.
		{"template changed", nil, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := serviceInstallNeedsRestart(tc.oldErr, spec, spec, nil, "", tc.replaced); got != tc.want {
				t.Fatalf("serviceInstallNeedsRestart = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestServiceInstallPinsStateDirectories(t *testing.T) {
	for _, custom := range []bool{false, true} {
		t.Run(strconv.FormatBool(custom), func(t *testing.T) {
			home := t.TempDir()
			e := serviceEnvironment{home: home}
			defaults := map[string]string{
				"XDG_CONFIG_HOME": filepath.Join(home, ".config"),
				"XDG_DATA_HOME":   filepath.Join(home, ".local", "share"),
				"XDG_CACHE_HOME":  filepath.Join(home, ".cache"),
			}
			for key := range defaults {
				value := ""
				if custom {
					value = filepath.Join(home, key)
					defaults[key] = value
				}
				t.Setenv(key, value)
			}
			first, err := buildServiceInstallSpec(e, "hub", []string{"--auth", "none"}, serviceInstallOptions{}, nil)
			if err != nil {
				t.Fatal(err)
			}
			for key, want := range defaults {
				if got := first.Environment[key]; got != want {
					t.Fatalf("%s = %q, want %q", key, got, want)
				}
				// A reinstall retains the saved locations despite a different shell.
				t.Setenv(key, filepath.Join(home, "different", key))
			}
			second, err := buildServiceInstallSpec(e, "hub", first.Args, serviceInstallOptions{}, &first)
			if err != nil {
				t.Fatal(err)
			}
			for key, want := range defaults {
				if got := second.Environment[key]; got != want {
					t.Fatalf("reinstall %s = %q, want saved %q", key, got, want)
				}
			}
		})
	}
}

func TestServiceReportsSavedStatePaths(t *testing.T) {
	home := isolatedServiceHome(t)
	e := serviceEnvironment{
		home: home, root: filepath.Join(home, "config", "term-llm", "services"),
		native: userservice.Native{OS: "linux", Home: home, ConfigHome: filepath.Join(home, "config"), Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("ActiveState=active\nMainPID=123\n"), nil
		}},
	}
	spec, err := buildServiceInstallSpec(e, "hub", []string{"--auth", "none"}, serviceInstallOptions{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := userservice.Save(e.specPath("hub"), spec); err != nil {
		t.Fatal(err)
	}
	// The saved specification, rather than the invoking shell, identifies data.
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "unrelated-config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "unrelated-data"))
	for _, mode := range []string{"dry-run", "unregistered", "registered"} {
		t.Run(mode, func(t *testing.T) {
			var out bytes.Buffer
			cmd := &cobra.Command{}
			cmd.SetContext(t.Context())
			cmd.SetOut(&out)
			if mode == "registered" {
				if _, err := e.native.Install(spec, e.specPath("hub")); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			if mode == "dry-run" {
				err = printServiceDryRun(cmd, e, "hub", spec, e.specPath("hub"))
			} else {
				err = showUserService(cmd, e, "hub")
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{
				"executable: " + spec.Binary,
				"working directory: " + spec.Directory,
				"configuration directory: " + filepath.Join(home, "config", "term-llm"),
				"data directory: " + filepath.Join(home, "data", "term-llm"),
			} {
				if !strings.Contains(out.String(), want) {
					t.Fatalf("missing %q in output:\n%s", want, out.String())
				}
			}
		})
	}
}
