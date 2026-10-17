package contain

import (
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"github.com/samsaffron/term-llm/internal/config"
	"gopkg.in/yaml.v3"
)

var assistantImagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)

// imageSource accepts only administrator-controlled image/binary settings. The
// ordinary Linux path stages the executable actually running this server.
func (m *Manager) imageSource() (binary, platform string, err error) {
	return m.imageSourceForOS(runtime.GOOS)
}

func (m *Manager) imageSourceForOS(goos string) (binary, platform string, err error) {
	if m.opts.Image != "" {
		if !assistantImagePattern.MatchString(m.opts.Image) {
			return "", "", fmt.Errorf("the administrator configured an invalid assistant image name")
		}
		return "", "", nil
	}
	binary = m.opts.BinaryPath
	if binary == "" {
		if goos != "linux" {
			// Docker builds the matching Linux runtime from bundled source. A
			// native macOS or Windows executable cannot run in the container.
			return "", "", nil
		}
		binary, err = os.Executable()
		if err != nil {
			return "", "", fmt.Errorf("could not locate the running server binary")
		}
	}
	f, err := elf.Open(binary)
	if err != nil {
		return "", "", fmt.Errorf("the assistant binary must be a readable Linux ELF executable")
	}
	defer f.Close()
	switch f.Machine {
	case elf.EM_X86_64:
		platform = "linux/amd64"
	case elf.EM_AARCH64:
		platform = "linux/arm64"
	default:
		return "", "", fmt.Errorf("assistant images support Linux amd64 or arm64 executables")
	}
	return binary, platform, nil
}

func (m *Manager) prepareImage(ctx context.Context, name string) error {
	image, platform, err := m.runtimeImage(ctx)
	if err != nil {
		return err
	}
	return m.setWorkspaceImage(name, image, platform)
}

func (m *Manager) runtimeImage(ctx context.Context) (string, string, error) {
	if err := m.buildMu.Acquire(ctx, 1); err != nil {
		return "", "", fmt.Errorf("image preparation was interrupted; check assistant status before retrying: %w", err)
	}
	defer m.buildMu.Release(1)
	binary, platform, err := m.imageSource()
	if err != nil {
		return "", "", err
	}
	image := m.opts.Image
	if image == "" {
		if binary == "" {
			return m.buildSourceImage(ctx)
		}
		image, err = m.buildImage(ctx, binary, platform)
		if err != nil {
			return "", "", err
		}
	}
	return image, platform, nil
}

func (m *Manager) buildImage(ctx context.Context, binary, platform string) (string, error) {
	dockerfile, err := personalBotAssets.ReadFile("personal-bot/Dockerfile")
	if err != nil {
		return "", err
	}
	source, err := os.Open(binary)
	if err != nil {
		return "", fmt.Errorf("could not read the assistant server binary")
	}
	defer source.Close()
	hash := sha256.New()
	_, _ = hash.Write(dockerfile)
	if _, err := io.Copy(hash, source); err != nil {
		return "", fmt.Errorf("could not read the assistant server binary")
	}
	id := hex.EncodeToString(hash.Sum(nil))
	image := "term-llm-personal-bot:" + id
	if _, err := m.opts.Runner.Output(ctx, "docker", []string{"image", "inspect", image}, RunOptions{Stderr: io.Discard}); err == nil {
		return image, nil
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return "", fmt.Errorf("could not stage the assistant server binary")
	}
	buildDir, err := m.stageImage(id, source, dockerfile)
	if err != nil {
		return "", err
	}
	args := []string{"build", "--platform", platform, "--tag", image, buildDir}
	if err := m.opts.Runner.Run(ctx, "docker", args, RunOptions{Stdout: io.Discard, Stderr: io.Discard}); err != nil {
		return "", fmt.Errorf("could not build assistant image; check Docker access, internet connectivity and available disk space")
	}
	return image, nil
}

func (m *Manager) stageImage(id string, source io.Reader, dockerfile []byte) (string, error) {
	return m.stageImageContext(id, "term-llm", 0o755, source, dockerfile)
}

func (m *Manager) stageImageContext(id, filename string, mode os.FileMode, source io.Reader, dockerfile []byte) (string, error) {
	// This dedicated content-addressed tree never updates contain's user-editable
	// images/agent assets or downloads an unrelated term-llm release.
	root := filepath.Join(filepath.Dir(m.root), "personal-bot-images")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("could not create assistant image storage")
	}
	dir := filepath.Join(root, id)
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		return dir, nil
	}
	tmp, err := os.MkdirTemp(root, ".build-")
	if err != nil {
		return "", fmt.Errorf("could not stage assistant image")
	}
	defer os.RemoveAll(tmp)
	f, err := os.OpenFile(filepath.Join(tmp, filename), os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return "", fmt.Errorf("could not stage assistant binary")
	}
	_, copyErr := io.Copy(f, source)
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		return "", fmt.Errorf("could not copy assistant binary")
	}
	if err := os.WriteFile(filepath.Join(tmp, "Dockerfile"), dockerfile, 0o600); err != nil {
		return "", fmt.Errorf("could not stage assistant Dockerfile")
	}
	if err := os.Rename(tmp, dir); err != nil {
		return "", fmt.Errorf("could not save assistant image build context")
	}
	return dir, nil
}

func (m *Manager) setWorkspaceImage(name, image, platform string) error {
	path := filepath.Join(m.root, name, "compose.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("could not read assistant container definition")
	}
	var compose struct {
		Services map[string]map[string]any `yaml:"services"`
		// Preserve user-supplied Compose settings when updating the runtime image.
		Extra map[string]any `yaml:",inline"`
	}
	if yaml.Unmarshal(data, &compose) != nil || compose.Services["assistant"] == nil {
		return fmt.Errorf("invalid assistant container definition")
	}
	compose.Services["assistant"]["image"] = image
	compose.Services["assistant"]["extra_hosts"] = []string{"host.docker.internal:host-gateway"}
	if platform != "" {
		compose.Services["assistant"]["platform"] = platform
	}
	data, err = yaml.Marshal(compose)
	if err != nil {
		return fmt.Errorf("could not prepare assistant container definition")
	}
	if err := config.WriteFileAtomicallyNoFollow(path, data, 0o600); err != nil {
		return fmt.Errorf("could not save assistant container definition")
	}
	bootstrap, err := personalBotAssets.ReadFile("personal-bot/bootstrap.sh")
	if err != nil {
		return err
	}
	if err := config.WriteFileAtomicallyNoFollow(filepath.Join(m.root, name, "bootstrap.sh"), bootstrap, 0o600); err != nil {
		return fmt.Errorf("could not update assistant startup configuration")
	}
	return nil
}
