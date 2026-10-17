package contain

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"github.com/samsaffron/term-llm/internal/botsource"
	"github.com/samsaffron/term-llm/internal/buildinfo"
)

// dockerPlatform describes the daemon, which may run a different OS or CPU than
// the Hub. Docker Desktop and OrbStack expose a Linux daemon on macOS/Windows.
func (m *Manager) dockerPlatform(ctx context.Context) (string, error) {
	out, err := m.opts.Runner.Output(ctx, "docker", []string{"info", "--format", "{{.OSType}}/{{.Architecture}}"}, RunOptions{Stderr: io.Discard})
	if err != nil {
		return "", fmt.Errorf("Docker Engine must be installed, running and accessible on this server")
	}
	return assistantDockerPlatform(strings.TrimSpace(string(out)))
}

func assistantDockerPlatform(value string) (string, error) {
	switch value {
	case "linux/amd64", "linux/x86_64":
		return "linux/amd64", nil
	case "linux/arm64", "linux/aarch64":
		return "linux/arm64", nil
	default:
		return "", fmt.Errorf("assistants need Linux containers on an amd64 or arm64 Docker Engine; on Windows, switch Docker Desktop to Linux containers")
	}
}

func (m *Manager) buildSourceImage(ctx context.Context) (string, string, error) {
	platform, err := m.dockerPlatform(ctx)
	if err != nil {
		return "", "", err
	}
	source, goVersion, err := botsource.Source()
	if err != nil {
		return "", "", err
	}
	return m.buildSourceImageForPlatform(ctx, source, goVersion, platform)
}

func (m *Manager) buildSourceImageForPlatform(ctx context.Context, source []byte, goVersion, platform string) (string, string, error) {
	dockerfile, err := assistantSourceDockerfile()
	if err != nil {
		return "", "", err
	}
	args := []string{"--platform", platform,
		"--build-arg", "GO_VERSION=" + goVersion,
		"--build-arg", "TARGETARCH=" + strings.TrimPrefix(platform, "linux/"),
		"--build-arg", "TERM_LLM_VERSION=" + buildinfo.Version,
		"--build-arg", "TERM_LLM_COMMIT=" + buildinfo.Commit,
		"--build-arg", "TERM_LLM_DATE=" + buildinfo.Date}
	image, id := assistantSourceImageID(source, dockerfile, args)
	if _, err := m.opts.Runner.Output(ctx, "docker", []string{"image", "inspect", image}, RunOptions{Stderr: io.Discard}); err == nil {
		return image, platform, nil
	}
	buildDir, err := m.stageImageContext(id, "source.tar.gz", 0o600, bytes.NewReader(source), dockerfile)
	if err != nil {
		return "", "", err
	}
	args = append(append([]string{"build"}, args...), "--tag", image, buildDir)
	buildLog, err := os.OpenFile(buildDir+".log", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", "", fmt.Errorf("could not create assistant runtime build log")
	}
	defer buildLog.Close()
	if err := m.opts.Runner.Run(ctx, "docker", args, RunOptions{Stdout: buildLog, Stderr: buildLog}); err != nil {
		log.Printf("assistant runtime build failed: %v; Docker build output: %s", err, buildLog.Name())
		return "", "", fmt.Errorf("could not prepare the Linux assistant runtime; check Docker access, internet connectivity and available disk space, then try again")
	}
	return image, platform, nil
}

func assistantSourceDockerfile() ([]byte, error) {
	builder, err := personalBotAssets.ReadFile("personal-bot/build.Dockerfile")
	if err != nil {
		return nil, err
	}
	runtime, err := personalBotAssets.ReadFile("personal-bot/Dockerfile")
	if err != nil {
		return nil, err
	}
	// Both build paths use the same runtime contract and installed utilities.
	return append(builder, []byte(strings.Replace(string(runtime), "COPY term-llm ", "COPY --from=builder /out/term-llm ", 1))...), nil
}

func assistantSourceImageID(source, dockerfile []byte, args []string) (image, id string) {
	hash := sha256.New()
	for _, input := range append([][]byte{source, dockerfile}, []byte(strings.Join(args, "\x00"))) {
		_, _ = hash.Write(input)
		_, _ = hash.Write([]byte{0})
	}
	id = hex.EncodeToString(hash.Sum(nil))
	return "term-llm-personal-bot:" + id, id
}
