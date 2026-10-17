package scripts

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerOptionalServerSetup(t *testing.T) {
	for _, tc := range []struct {
		name, host string
		args       []string
		wantError  string
		server     bool
	}{
		{name: "plain install", host: "Linux"},
		{name: "server install", host: "Linux", args: []string{"--server-domain", "bot.example.com", "--accept-acme-tos", "--email", "owner@example.com"}, server: true},
		{name: "consent required", host: "Linux", args: []string{"--server-domain", "bot.example.com"}, wantError: "requires --accept-acme-tos"},
		{name: "server only Linux", host: "Darwin", args: []string{"--server-domain", "bot.example.com", "--accept-acme-tos"}, wantError: "requires Debian/Ubuntu Linux"},
		{name: "email needs server", host: "Linux", args: []string{"--email", "owner@example.com"}, wantError: "require --server-domain"},
		{name: "terms need server", host: "Linux", args: []string{"--accept-acme-tos"}, wantError: "require --server-domain"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			bin := filepath.Join(dir, "bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			archive := filepath.Join(dir, "release.tar.gz")
			file, err := os.Create(archive)
			if err != nil {
				t.Fatal(err)
			}
			compressed := gzip.NewWriter(file)
			writer := tar.NewWriter(compressed)
			body := []byte("#!/bin/sh\nset -eu\nprintf '%s\\n' \"$*\" >> \"$COMMAND_LOG\"\n")
			if err := writer.WriteHeader(&tar.Header{Name: "term-llm", Mode: 0755, Size: int64(len(body))}); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write(body); err != nil {
				t.Fatal(err)
			}
			for _, close := range []func() error{writer.Close, compressed.Close, file.Close} {
				if err := close(); err != nil {
					t.Fatal(err)
				}
			}
			writeExecutable(t, filepath.Join(bin, "uname"), "#!/bin/sh\nif [ \"$1\" = -s ]; then printf '%s\\n' \"$TEST_HOST\"; else echo x86_64; fi\n")
			writeExecutable(t, filepath.Join(bin, "curl"), `#!/bin/sh
set -eu
printf 'download\n' >> "$COMMAND_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then cp "$TEST_ARCHIVE" "$2"; exit; fi
  shift
done
exit 1
`)
			installed := filepath.Join(dir, "installed")
			log := filepath.Join(dir, "commands")
			args := append([]string{"../install.sh", "--version", "v1.2.3", "--install-dir", installed}, tc.args...)
			cmd := exec.Command("sh", args...)
			cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "HOME="+dir, "TEST_HOST="+tc.host, "TEST_ARCHIVE="+archive, "COMMAND_LOG="+log)
			output, runErr := cmd.CombinedOutput()
			commands, _ := os.ReadFile(log)
			if tc.wantError != "" {
				if runErr == nil || !strings.Contains(string(output), tc.wantError) {
					t.Fatalf("wanted %q, got %v\n%s", tc.wantError, runErr, output)
				}
				if len(commands) != 0 {
					t.Fatalf("invalid server options performed installation: %s", commands)
				}
				return
			}
			if runErr != nil {
				t.Fatalf("install failed: %v\n%s", runErr, output)
			}
			if _, err := os.Stat(filepath.Join(installed, "term-llm")); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(commands), "server setup") != tc.server {
				t.Fatalf("unexpected server setup dispatch: %s", commands)
			}
			if tc.server && !strings.Contains(string(commands), "server setup --domain bot.example.com --accept-acme-tos --email owner@example.com") {
				t.Fatalf("server setup arguments changed: %s", commands)
			}
		})
	}
}
