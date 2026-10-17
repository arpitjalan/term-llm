package contain

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/samsaffron/term-llm/internal/config"
	"gopkg.in/yaml.v3"
)

//go:embed all:personal-bot
var personalBotAssets embed.FS

const assistantMetadataFile = "personal-bot.json"

func (m *Manager) records() ([]assistantRecord, error) {
	paths, err := filepath.Glob(filepath.Join(m.root, "*", assistantMetadataFile))
	if err != nil {
		return nil, err
	}
	records := make([]assistantRecord, 0, len(paths))
	for _, path := range paths {
		record, err := m.readRecord(filepath.Base(filepath.Dir(path)))
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

func (m *Manager) readRecord(name string) (assistantRecord, error) {
	if err := validateAssistantName(name); err != nil {
		return assistantRecord{}, err
	}
	dir := filepath.Join(m.root, name)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return assistantRecord{}, ErrAssistantNotFound
	}
	data, err := os.ReadFile(filepath.Join(dir, assistantMetadataFile))
	if errors.Is(err, os.ErrNotExist) {
		return assistantRecord{}, ErrAssistantNotFound
	}
	if err != nil {
		return assistantRecord{}, fmt.Errorf("could not read managed assistant metadata")
	}
	var record assistantRecord
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Assistant.Name != name {
		return assistantRecord{}, fmt.Errorf("invalid managed assistant metadata for %q", name)
	}
	return record, nil
}

func (m *Manager) writeRecord(record assistantRecord) error {
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	if err := config.WriteFileAtomicallyNoFollow(filepath.Join(m.root, record.Assistant.Name, assistantMetadataFile), data, 0o600); err != nil {
		return fmt.Errorf("could not save managed assistant metadata")
	}
	m.latest[record.Assistant.Name] = record.Operation.ID
	return nil
}

func (m *Manager) createFiles(ctx context.Context, record assistantRecord) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("creation was interrupted; retry after the server restarts")
	}
	if err := m.checkProjectCollision(record.Assistant.Name); err != nil {
		return err
	}
	if err := os.MkdirAll(m.root, 0o700); err != nil {
		return fmt.Errorf("could not create assistant storage")
	}
	template, err := os.MkdirTemp(m.root, ".personal-bot-template-")
	if err != nil {
		return fmt.Errorf("could not prepare assistant template")
	}
	defer os.RemoveAll(template)
	for _, name := range []string{"compose.yaml", ".env", "bootstrap.sh"} {
		data, err := personalBotAssets.ReadFile("personal-bot/" + name)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(template, name), data, 0o600); err != nil {
			return fmt.Errorf("could not prepare assistant template")
		}
	}
	return m.renderWorkspace(record, template)
}

func (m *Manager) checkProjectCollision(name string) error {
	defs, err := Definitions()
	if err != nil {
		return fmt.Errorf("could not inspect existing container workspaces")
	}
	for _, def := range defs {
		if ProjectName(def.Name) == ProjectName(name) {
			return fmt.Errorf("%w: this name conflicts with an existing container workspace", ErrAssistantInvalid)
		}
	}
	return nil
}

func (m *Manager) renderWorkspace(record assistantRecord, template string) (resultErr error) {
	port, err := allocateAssistantPort()
	if err != nil {
		return err
	}
	token, err := randomHexToken(32)
	if err != nil {
		return fmt.Errorf("could not generate assistant login token")
	}
	// The placeholder image is replaced with a content-addressed local image at
	// Start. No untrusted or unrelated release image is ever pulled by default.
	image := "term-llm-personal-bot:unbuilt"
	if m.opts.Image != "" {
		image = m.opts.Image
	}
	imageYAML, _ := json.Marshal(image)
	dir, err := CreateWorkspace(record.Assistant.Name, CreateOptions{
		Template: template, NoInput: true, CWD: "/workspace", Stdout: io.Discard,
		Values: map[string]string{"personal_bot_image": string(imageYAML), "web_port": port, "web_token": token},
	})
	if err != nil {
		return fmt.Errorf("could not reserve assistant workspace; choose a different name or check server storage")
	}
	// CreateWorkspace successfully reserved this new directory. If subsequent
	// initialization fails, remove only that directory so creation can be retried.
	defer func() {
		if resultErr != nil {
			_ = os.RemoveAll(dir)
		}
	}()
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("could not secure assistant workspace")
	}
	if err := createAssistantProfile(dir, record.Assistant); err != nil {
		return err
	}
	return m.writeRecord(record)
}

func allocateAssistantPort() (string, error) {
	used, err := usedWorkspaceWebPorts()
	if err != nil {
		return "", fmt.Errorf("could not inspect assigned assistant ports")
	}
	for port := webPortBase; port < webPortBase+webPortScanLimit; port++ {
		if !used[port] && hostPortAvailable(port) {
			return strconv.Itoa(port), nil
		}
	}
	return "", fmt.Errorf("no free assistant browser port is available")
}

func createAssistantProfile(dir string, assistant ManagedAssistant) error {
	profile := filepath.Join(dir, "connection", "term-llm", "agents", assistant.Name)
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return fmt.Errorf("could not create private assistant configuration")
	}
	agent, err := yaml.Marshal(map[string]any{
		"name": assistant.Name, "description": "Personal assistant", "time_grounding": true,
		"tools":     map[string]any{"enabled": []string{"read_file", "write_file", "edit_file", "glob", "grep", "shell", "ask_user", "update_plan"}},
		"max_turns": 100,
	})
	if err != nil {
		return err
	}
	for path, data := range map[string][]byte{
		"agent.yaml": agent,
		"system.md":  []byte("You are a persistent personal assistant. Your working directory is /workspace. Keep useful work and deliverables there.\n\nYour purpose:\n" + assistant.Purpose + "\n"),
	} {
		if err := config.WriteFileAtomicallyNoFollow(filepath.Join(profile, path), data, 0o600); err != nil {
			return fmt.Errorf("could not write assistant instructions")
		}
	}
	return nil
}
