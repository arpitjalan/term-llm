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

	"gopkg.in/yaml.v3"
)

var assistantImagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)

// imageSource accepts only administrator-controlled image/binary settings. The
// ordinary Linux path stages the executable actually running this server.
func (m *Manager) imageSource() (binary, platform string, err error) {
	if m.opts.Image != "" {
		if !assistantImagePattern.MatchString(m.opts.Image) {
			return "", "", fmt.Errorf("the administrator configured an invalid assistant image name")
		}
		return "", "", nil
	}
	binary = m.opts.BinaryPath
	if binary == "" {
		if runtime.GOOS != "linux" {
			return "", "", fmt.Errorf("building assistants requires a Linux server, or an administrator-configured Linux binary or prebuilt image")
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
	m.buildMu.Lock()
	defer m.buildMu.Unlock()
	if ctx.Err() != nil {
		return fmt.Errorf("image preparation was interrupted; check assistant status before retrying")
	}
	binary, platform, err := m.imageSource()
	if err != nil {
		return err
	}
	image := m.opts.Image
	if image == "" {
		image, err = m.buildImage(ctx, binary, platform)
		if err != nil {
			return err
		}
	}
	return m.setWorkspaceImage(name, image, platform)
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
	f, err := os.OpenFile(filepath.Join(tmp, "term-llm"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
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
		Hints    map[string]any            `yaml:"x-term-llm"`
		Services map[string]map[string]any `yaml:"services"`
		Volumes  map[string]any            `yaml:"volumes"`
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
	if err := atomicPrivateFile(path, data); err != nil {
		return fmt.Errorf("could not save assistant container definition")
	}
	bootstrap, err := personalBotAssets.ReadFile("personal-bot/bootstrap.sh")
	if err != nil {
		return err
	}
	if err := atomicPrivateFile(filepath.Join(m.root, name, "bootstrap.sh"), bootstrap); err != nil {
		return fmt.Errorf("could not update assistant startup configuration")
	}
	return nil
}
