package contain

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPersonalBotAutomaticRuntimeAcrossOperatingSystems(t *testing.T) {
	for _, goos := range []string{"darwin", "windows", "freebsd"} {
		t.Run(goos, func(t *testing.T) {
			m, _ := newAssistantTestManager(t)
			m.opts.Image = ""
			binary, platform, err := m.imageSourceForOS(goos)
			if err != nil || binary != "" || platform != "" {
				t.Fatalf("automatic runtime = %q, %q, %v", binary, platform, err)
			}
		})
	}
}

func TestPersonalBotRuntimeOverridesAcrossOperatingSystems(t *testing.T) {
	header := make([]byte, 64)
	copy(header, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(header[16:], 2)
	binary.LittleEndian.PutUint16(header[18:], 183)
	binary.LittleEndian.PutUint32(header[20:], 1)
	binary.LittleEndian.PutUint16(header[52:], 64)
	path := filepath.Join(t.TempDir(), "term-llm-linux")
	if err := os.WriteFile(path, header, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, goos := range []string{"linux", "darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			m, _ := newAssistantTestManager(t)
			m.opts.Image, m.opts.BinaryPath = "", path
			binary, platform, err := m.imageSourceForOS(goos)
			if err != nil || binary != path || platform != "linux/arm64" {
				t.Fatalf("explicit runtime = %q, %q, %v", binary, platform, err)
			}
			m.opts.Image = "custom:v1"
			m.opts.BinaryPath = "missing-file"
			binary, platform, err = m.imageSourceForOS(goos)
			if err != nil || binary != "" || platform != "" {
				t.Fatalf("image override = %q, %q, %v", binary, platform, err)
			}
		})
	}
}

func TestPersonalBotDockerPlatform(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"linux/x86_64", "linux/amd64"}, {"linux/amd64", "linux/amd64"},
		{"linux/aarch64", "linux/arm64"}, {"linux/arm64", "linux/arm64"},
		{"windows/amd64", ""}, {"linux/armv7l", ""}, {"", ""},
	} {
		t.Run(tc.input, func(t *testing.T) {
			got, err := assistantDockerPlatform(tc.input)
			if got != tc.want || (err != nil) != (tc.want == "") {
				t.Fatalf("Docker platform = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestPersonalBotEnvironmentReportsDockerBlocker(t *testing.T) {
	for _, tc := range []struct {
		name, info, want      string
		dockerErr, composeErr error
	}{
		{name: "Docker stopped", dockerErr: errors.New("connection refused"), want: "Docker Engine"},
		{name: "Compose missing", composeErr: errors.New("missing plugin"), want: "Docker Compose v2"},
		{name: "Windows containers", info: "windows/amd64", want: "switch Docker Desktop to Linux containers"},
		{name: "ready", info: "linux/arm64"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, runner := newAssistantTestManager(t)
			runner.dockerError, runner.composeError = tc.dockerErr, tc.composeErr
			if tc.info != "" {
				runner.dockerInfo = []byte(tc.info)
			}
			env := m.Environment(context.Background())
			if env.Available != (tc.want == "") || (tc.want != "" && !strings.Contains(env.Error, tc.want)) {
				t.Fatalf("environment = %+v; want %q", env, tc.want)
			}
		})
	}
}

func TestPersonalBotSourceImageUsesBundledCheckoutAndDockerArchitecture(t *testing.T) {
	for _, platform := range []string{"linux/amd64", "linux/arm64"} {
		t.Run(platform, func(t *testing.T) {
			m, runner := newAssistantTestManager(t)
			const source = "bundled checkout including embedded UI and local modules"
			image, gotPlatform, err := m.buildSourceImageForPlatform(context.Background(), []byte(source), "1.27.2", platform)
			if err != nil || gotPlatform != platform || !strings.HasPrefix(image, "term-llm-personal-bot:") {
				t.Fatalf("source image = %q, %q, %v", image, gotPlatform, err)
			}
			if len(runner.runs) != 1 {
				t.Fatalf("build commands = %v", runner.runs)
			}
			args := runner.runs[0]
			if !reflect.DeepEqual(args[:4], []string{"docker", "build", "--platform", platform}) || !strings.Contains(strings.Join(args, " "), "GO_VERSION=1.27.2") {
				t.Fatalf("build does not target the Docker platform and pinned Go version: %v", args)
			}
			dir := args[len(args)-1]
			staged, err := os.ReadFile(filepath.Join(dir, "source.tar.gz"))
			if err != nil || string(staged) != source {
				t.Fatalf("staged checkout = %q, %v", staged, err)
			}
			dockerfile, err := os.ReadFile(filepath.Join(dir, "Dockerfile"))
			if err != nil {
				t.Fatal(err)
			}
			for _, expected := range []string{"golang:${GO_VERSION}", "GOARCH=\"$TARGETARCH\"", "ADD source.tar.gz", "COPY --from=builder /out/term-llm", "cmd.Commit=$TERM_LLM_COMMIT"} {
				if !strings.Contains(string(dockerfile), expected) {
					t.Fatalf("Dockerfile missing %q", expected)
				}
			}
			if strings.Contains(string(dockerfile), "releases/download") {
				t.Fatal("source build downloads an unrelated released executable")
			}
			runner.imageExists = true
			cached, _, err := m.buildSourceImageForPlatform(context.Background(), []byte(source), "1.27.2", platform)
			if err != nil || cached != image || len(runner.runs) != 1 {
				t.Fatalf("cached image rebuilt: %q, %v, %v", cached, err, runner.runs)
			}
		})
	}
}

func TestPersonalBotSourceImageBuildFailureCanRetry(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	runner.runError = errors.New("disk full")
	if _, _, err := m.buildSourceImageForPlatform(context.Background(), []byte("source"), "1.27.2", "linux/arm64"); err == nil || !strings.Contains(err.Error(), "available disk space") {
		t.Fatalf("build error = %v", err)
	}
	runner.runError = nil
	if _, _, err := m.buildSourceImageForPlatform(context.Background(), []byte("source"), "1.27.2", "linux/arm64"); err != nil {
		t.Fatal(err)
	}
}

func TestPersonalBotSourceImageCacheTracksInputs(t *testing.T) {
	image, _ := assistantSourceImageID([]byte("source"), []byte("Dockerfile"), []string{"linux/arm64", "v1"})
	for _, tc := range []struct {
		source, dockerfile string
		args               []string
	}{
		{"new source", "Dockerfile", []string{"linux/arm64", "v1"}},
		{"source", "new Dockerfile", []string{"linux/arm64", "v1"}},
		{"source", "Dockerfile", []string{"linux/amd64", "v1"}},
		{"source", "Dockerfile", []string{"linux/arm64", "v2"}},
	} {
		got, _ := assistantSourceImageID([]byte(tc.source), []byte(tc.dockerfile), tc.args)
		if got == image {
			t.Fatal("changed source, Dockerfile, platform or build identity reused a stale image")
		}
	}
}
