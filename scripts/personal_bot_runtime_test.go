package scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPersonalBotRuntimeBuild(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate runtime build script")
	}
	script := filepath.Join(filepath.Dir(currentFile), "personal_bot_runtime.sh")
	for _, tc := range []struct {
		name, arch, mode, wantError string
		defaultDataHome             bool
	}{
		{name: "arm64", arch: "arm64"},
		{name: "amd64", arch: "amd64"},
		{name: "default data directory", arch: "arm64", defaultDataHome: true},
		{name: "unsupported architecture", arch: "riscv64", wantError: "Unsupported Docker architecture"},
		{name: "Docker missing", mode: "missing", wantError: "docker is required"},
		{name: "Docker unavailable", mode: "unavailable", wantError: "Cannot reach Docker"},
		{name: "Compose missing", mode: "compose", wantError: "Docker Compose is required"},
		{name: "build fails", arch: "arm64", mode: "build", wantError: "cross-build failed"},
		{name: "relative data directory", arch: "arm64", mode: "relative", wantError: "XDG_DATA_HOME must be an absolute path"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			bin := filepath.Join(dir, "bin")
			if err := os.Mkdir(bin, 0o755); err != nil {
				t.Fatal(err)
			}
			writeExecutable(t, filepath.Join(bin, "docker"), `#!/bin/bash
set -eu
case "$1" in
  compose) [[ "$TEST_MODE" != compose ]] ;;
  version)
    [[ "$TEST_MODE" != unavailable ]] || exit 1
    printf '%s\n' "$TEST_ARCH"
    ;;
  *) exit 1 ;;
esac
`)
			writeExecutable(t, filepath.Join(bin, "go"), `#!/bin/bash
set -eu
printf '%s %s %s\n' "$CGO_ENABLED" "$GOOS" "$GOARCH" > "$BUILD_LOG"
[[ "$1" == build && "$2" == -o && "$4" == . ]] || exit 1
printf 'new runtime\n' > "$3"
if [[ "$TEST_MODE" == build ]]; then
  echo 'cross-build failed' >&2
  exit 1
fi
`)
			harness := filepath.Join(dir, "harness.sh")
			writeExecutable(t, harness, `#!/bin/bash
if [[ "$TEST_MODE" == missing ]]; then
  command() {
    if [[ "$1" == -v && "$2" == docker ]]; then return 1; fi
    builtin command "$@"
  }
  export -f command
fi
exec bash "$1"
`)
			dataHome := filepath.Join(dir, "data with spaces")
			if tc.defaultDataHome {
				dataHome = filepath.Join(dir, ".local", "share")
			}
			runtimePath := filepath.Join(dataHome, "term-llm", "personal-bot", "term-llm-linux")
			if err := os.MkdirAll(filepath.Dir(runtimePath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(runtimePath, []byte("old runtime\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			xdgDataHome := dataHome
			if tc.defaultDataHome {
				xdgDataHome = ""
			} else if tc.mode == "relative" {
				xdgDataHome = "relative"
			}
			cmd := exec.Command("bash", harness, script)
			cmd.Dir = dir // The script must find the checkout without relying on CWD.
			cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"),
				"HOME="+dir, "XDG_DATA_HOME="+xdgDataHome, "TEST_MODE="+tc.mode,
				"TEST_ARCH="+tc.arch, "BUILD_LOG="+filepath.Join(dir, "build.log"))
			out, err := cmd.CombinedOutput()
			if (err != nil) != (tc.wantError != "") {
				t.Fatalf("runtime build error = %v, want error %q\n%s", err, tc.wantError, out)
			}
			wantRuntime := "old runtime\n"
			if tc.wantError == "" {
				wantRuntime = "new runtime\n"
				if !strings.Contains(string(out), runtimePath) {
					t.Errorf("runtime path absent from output:\n%s", out)
				}
				build, err := os.ReadFile(filepath.Join(dir, "build.log"))
				if err != nil {
					t.Fatal(err)
				}
				if string(build) != "0 linux "+tc.arch+"\n" {
					t.Errorf("cross-build environment = %q", build)
				}
			} else if !strings.Contains(string(out), tc.wantError) {
				t.Errorf("runtime build output lacks %q:\n%s", tc.wantError, out)
			}
			data, err := os.ReadFile(runtimePath)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != wantRuntime {
				t.Errorf("runtime = %q, want %q", data, wantRuntime)
			}
			leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(runtimePath), ".term-llm-linux.*"))
			if err != nil || len(leftovers) != 0 {
				t.Errorf("staged runtimes remain: %v (error %v)", leftovers, err)
			}
		})
	}
}

func TestPersonalBotRuntimeTargetBuildsNativeFirst(t *testing.T) {
	makePath, err := exec.LookPath("make")
	if err != nil {
		t.Skip("make unavailable")
	}
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Makefile"), makefile, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeExecutable(t, filepath.Join(dir, "go"), `#!/bin/sh
set -eu
case "$1" in
  build) printf 'native\n' >> "$COMMAND_LOG" ;;
  env) printf 'linux\n' ;;
  *) exit 1 ;;
esac
`)
	writeExecutable(t, filepath.Join(dir, "scripts", "personal_bot_runtime.sh"), `#!/bin/sh
printf 'runtime\n' >> "$COMMAND_LOG"
`)
	cmd := exec.Command(makePath, "-o", "frontend", "personal-bot-runtime", "VERSION=test", "COMMIT=test", "BUILD_DATE=test")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"), "COMMAND_LOG="+filepath.Join(dir, "commands.log"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make personal-bot-runtime failed: %v\n%s", err, out)
	}
	data, err := os.ReadFile(filepath.Join(dir, "commands.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "native\nruntime\n" {
		t.Errorf("build command order = %q", data)
	}
}
