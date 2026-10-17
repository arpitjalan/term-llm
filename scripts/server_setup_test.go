package scripts

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Rewrite absolute system paths into a fixture and mock every administration
// command. These tests never need root or contact a service manager or network.
func newServerSetupFixture(t *testing.T) (string, func(...string) (string, error)) {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	for _, dir := range []string{"bin", "etc/nginx/sites-available", "etc/nginx/sites-enabled", "etc/apt/sources.list.d", "run/systemd/system", "root"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "etc/os-release"), []byte("ID=ubuntu\nVERSION_CODENAME=noble\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../cmd/server_setup.sh")
	if err != nil {
		t.Fatal(err)
	}
	source = []byte(strings.NewReplacer("/etc/", root+"/etc/", "/usr/local/", root+"/usr/local/", "/var/lib/", root+"/var/lib/", "/run/", root+"/run/").Replace(string(source)))
	script := filepath.Join(root, "setup.sh")
	writeExecutable(t, script, string(source))
	mock := `#!/bin/sh
set -eu
name=${0##*/}
printf '%s %s\n' "$name" "$*" >> "$FIXTURE/commands"
case "$name" in
  id) if [ "$*" = '-u termllm' ]; then echo 1001; else echo "${TEST_UID:-0}"; fi ;;
  uname) echo Linux ;;
  getent) [ -f "$FIXTURE/account" ] && cat "$FIXTURE/account" ;;
  useradd)
    mkdir -p "$FIXTURE/home/termllm"
    printf 'termllm:x:1001:1001:term-llm server:%s/home/termllm:/bin/sh\n' "$FIXTURE" > "$FIXTURE/account"
    ;;
  ss)
    case "$*" in *8090*) [ "${TEST_MODE:-}" != port-conflict ] || echo 'LISTEN 0 128 0.0.0.0:8090 0.0.0.0:*' ;; esac
    ;;
  apt-get) case "$*" in *docker-ce*) touch "$FIXTURE/docker-installed" ;; esac ;;
  docker)
    case "$1" in
      compose) [ "${TEST_MODE:-}" != no-compose ] ;;
      network) echo 172.17.0.1 ;;
      version) ;;
      *) exit 1 ;;
    esac
    ;;
  curl)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then printf key > "$2"; shift; fi
      shift
    done
    ;;
  certbot) [ "${TEST_MODE:-}" != certificate-failure ] ;;
  dpkg) echo amd64 ;;
  runuser)
    shift 3
    [ "$1" = env ]
    shift
    [ "$1" = -i ]
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in PATH=*) shift ;; *=*) export "$1"; shift ;; *) break ;; esac
    done
    exec "$@"
    ;;
  nginx|systemctl|loginctl|usermod|chown) ;;
  *) exit 1 ;;
esac
`
	for _, name := range []string{"id", "uname", "getent", "useradd", "usermod", "ss", "apt-get", "docker", "curl", "certbot", "dpkg", "runuser", "nginx", "systemctl", "loginctl", "chown"} {
		writeExecutable(t, filepath.Join(bin, name), mock)
	}
	binary := filepath.Join(root, "term-llm")
	writeExecutable(t, binary, `#!/bin/sh
set -eu
printf 'term-llm %s\n' "$*" >> "$FIXTURE/commands"
spec="$HOME/.config/term-llm/services/hub/service.json"
if [ ! -f "$spec" ]; then
  mkdir -p "$(dirname "$spec")"
  printf '{"kind":"hub","auth":"passkey","url":"https://bot.example.com/","host":"127.0.0.1","port":8090,"args":["--personal-bot","--personal-bot-broker-host","172.17.0.1"]}\n' > "$spec"
fi
printf 'Set up your passkey: https://bot.example.com/#setup=ONE_TIME_PRIVATE_CODE\n'
`)
	harness := filepath.Join(root, "harness.sh")
	writeExecutable(t, harness, `#!/bin/sh
set -eu
command() {
  if [ "$2" = docker ] && [ "${TEST_MODE:-}" = no-docker ] && [ ! -f "$FIXTURE/docker-installed" ]; then return 1; fi
  type "$2"
}
script=$1
shift
. "$script"
`)
	run := func(extra ...string) (string, error) {
		args := []string{harness, script, "--domain", "bot.example.com", "--binary", binary, "--accept-acme-tos"}
		cmd := exec.Command("sh", append(args, extra...)...)
		cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "FIXTURE="+root,
			"HOME="+filepath.Join(root, "root"), "XDG_CONFIG_HOME=", "XDG_DATA_HOME=")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	return root, run
}

func TestServerSetupFreshAndRerun(t *testing.T) {
	for _, mode := range []string{"", "no-docker"} {
		t.Run("Docker "+mode, func(t *testing.T) {
			t.Setenv("TEST_MODE", mode)
			root, run := newServerSetupFixture(t)
			// CLI update checks can run before provisioning on an otherwise fresh root account.
			updateDir := filepath.Join(root, "root/.config/term-llm")
			if err := os.MkdirAll(updateDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(updateDir, "update-state.json"), []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := run("--email", "owner@example.com")
			if err != nil {
				t.Fatalf("setup: %v\n%s", err, out)
			}
			if !strings.Contains(out, "#setup=ONE_TIME_PRIVATE_CODE") {
				t.Fatalf("missing explicit passkey setup link:\n%s", out)
			}
			log, err := os.ReadFile(filepath.Join(root, "commands"))
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"loginctl enable-linger termllm", "systemctl start user@1001.service", "--personal-bot-broker-host 172.17.0.1", "--auth passkey", "--print-setup-link", "--email owner@example.com", "https://bot.example.com/healthz", "-- env -i HOME=", "USER=termllm LOGNAME=termllm"} {
				if !strings.Contains(string(log), want) {
					t.Errorf("missing command %q:\n%s", want, log)
				}
			}
			if strings.Contains(string(log), "ONE_TIME_PRIVATE_CODE") {
				t.Fatal("enrollment code leaked to command arguments")
			}
			site := filepath.Join(root, "etc/nginx/sites-available/term-llm")
			data, err := os.ReadFile(site)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"server_name bot.example.com;", "listen 443 ssl;", "proxy_pass http://127.0.0.1:8090;", "proxy_set_header Upgrade $http_upgrade;", "proxy_buffering off;"} {
				if !strings.Contains(string(data), want) {
					t.Errorf("proxy lacks %q", want)
				}
			}
			data = append(data, []byte("# user customization\n")...)
			if err := os.WriteFile(site, data, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "commands"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
			out, err = run()
			if err != nil {
				t.Fatalf("rerun: %v\n%s", err, out)
			}
			rerun, _ := os.ReadFile(site)
			if string(rerun) != string(data) {
				t.Fatal("rerun changed the existing proxy")
			}
			log, _ = os.ReadFile(filepath.Join(root, "commands"))
			if strings.Contains(string(log), "term-llm service install hub --yes --print-setup-link -- ") {
				t.Fatal("rerun replaced existing Hub launch arguments")
			}
			if strings.Contains(string(log), "term-llm service restart hub") {
				t.Fatal("unchanged binary restarted the existing Hub")
			}
			binary := filepath.Join(root, "term-llm")
			current, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(binary, append(current, []byte("\n# updated binary\n")...), 0o755); err != nil {
				t.Fatal(err)
			}
			out, err = run()
			if err != nil {
				t.Fatalf("binary update: %v\n%s", err, out)
			}
			log, _ = os.ReadFile(filepath.Join(root, "commands"))
			if strings.Count(string(log), "\nterm-llm service restart hub\n") != 1 {
				t.Fatal("updated binary did not restart the existing Hub once")
			}
		})
	}
}

func TestServerSetupSavedBrokerAddress(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		args       []string
	}{
		{name: "missing", want: "no valid private broker address"},
		{name: "wildcard", args: []string{"--personal-bot-broker-host", "0.0.0.0"}, want: "broker address is not private"},
		{name: "public", args: []string{"--personal-bot-broker-host=8.8.8.8"}, want: "broker address is not private"},
		{name: "loopback", args: []string{"--personal-bot-broker-host", "127.0.0.1"}, want: "broker address is not private"},
		{name: "last flag wins", args: []string{"--personal-bot-broker-host", "172.17.0.1", "--personal-bot-broker-host=0.0.0.0"}, want: "broker address is not private"},
		{name: "gateway changed", args: []string{"--personal-bot-broker-host", "192.168.55.1"}, want: "Docker bridge gateway changed"},
		{name: "equals form", args: []string{"--personal-bot-broker-host=172.17.0.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, run := newServerSetupFixture(t)
			if out, err := run(); err != nil {
				t.Fatalf("first setup: %v\n%s", err, out)
			}
			path := filepath.Join(root, "home/termllm/.config/term-llm/services/hub/service.json")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var spec map[string]any
			if err := json.Unmarshal(data, &spec); err != nil {
				t.Fatal(err)
			}
			spec["args"] = append([]string{"--personal-bot"}, tc.args...)
			data, err = json.Marshal(spec)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "commands"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := run()
			if (err != nil) != (tc.want != "") || !strings.Contains(out, tc.want) {
				t.Fatalf("rerun error = %v, want %q\n%s", err, tc.want, out)
			}
			preserved, _ := os.ReadFile(path)
			if string(preserved) != string(data) {
				t.Fatal("rerun changed existing service configuration")
			}
			log, _ := os.ReadFile(filepath.Join(root, "commands"))
			if tc.want != "" && tc.name != "gateway changed" && strings.Contains(string(log), "apt-get") {
				t.Fatal("unsafe saved broker address was accepted before package changes")
			}
		})
	}
}

func TestServerSetupRefusesConflicts(t *testing.T) {
	for _, tc := range []struct {
		name, mode, path, content, want string
		args                            []string
	}{
		{name: "URL as hostname", args: []string{"--domain", "https://bot.example.com/"}, want: "public DNS hostname"},
		{name: "multiline hostname", args: []string{"--domain", "other\nbot.example.com"}, want: "public DNS hostname"},
		{name: "invalid email", args: []string{"--email", "--other-flag"}, want: "valid email address"},
		{name: "multiline email", args: []string{"--email", "bad\nowner@example.com"}, want: "valid email address"},
		{name: "other OS", path: "etc/os-release", content: "ID=fedora\n", want: "only Debian and Ubuntu"},
		{name: "unrelated site", path: "etc/nginx/sites-available/term-llm", content: "existing proxy\n", want: "already exists for another setup"},
		{name: "other proxy for domain", path: "etc/nginx/sites-enabled/other", content: "server_name bot.example.com;\n", want: "already uses bot.example.com"},
		{name: "existing system service", path: "etc/systemd/system/term-llm-hub.service", content: "existing unit\n", want: "existing system Hub"},
		{name: "root account state", path: "root/.config/term-llm/config.yaml", content: "existing provider\n", want: "root-owned term-llm state"},
		{name: "updater name cannot hide catalog", path: "root/.config/term-llm/update-state.json/config.yaml", content: "existing provider\n", want: "root-owned term-llm state"},
		{name: "unrelated account", path: "account", content: "termllm:x:1001:1001:other service:/home/termllm:/bin/sh\n", want: "not managed by server setup"},
		{name: "occupied Hub port", mode: "port-conflict", want: "port 8090 is occupied"},
		{name: "Compose missing", mode: "no-compose", want: "Compose v2 is missing"},
		{name: "certificate fails", mode: "certificate-failure", want: "check domain A/AAAA DNS"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TEST_MODE", tc.mode)
			root, run := newServerSetupFixture(t)
			if tc.path != "" {
				path := filepath.Join(root, tc.path)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			out, err := run(tc.args...)
			if err == nil || !strings.Contains(out, tc.want) {
				t.Fatalf("setup error = %v, want %q\n%s", err, tc.want, out)
			}
			if tc.path != "" {
				data, _ := os.ReadFile(filepath.Join(root, tc.path))
				if string(data) != tc.content {
					t.Fatal("conflicting user file was changed")
				}
			}
			log, _ := os.ReadFile(filepath.Join(root, "commands"))
			if strings.Contains(string(log), "term-llm service install") {
				t.Fatal("started Hub after failed provisioning")
			}
		})
	}
}
