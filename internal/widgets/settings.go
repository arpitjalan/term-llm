package widgets

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	"github.com/term-llm/term-llm/internal/fileprivacy"
	"gopkg.in/yaml.v3"
)

// SettingsFile sits beside the widget directories and lists the widgets that
// are turned off. Disabling or enabling a widget rewrites only this file, never
// anything inside a widget's own directory, so a widget kept in a checkout
// stays clean and one reinstalled over its directory stays off.
const SettingsFile = "widgets.yaml"

const maxSettingsBytes = 64 << 10

const settingsHeader = `# Widgets turned off in term-llm, by directory name. term-llm rewrites this
# file when a widget is disabled or enabled; to turn one back on by hand,
# remove its name and reload widgets.
`

// ErrNotFound reports a mount that no loaded widget uses.
var ErrNotFound = errors.New("widget not found")

var errWidgetDisabled = errors.New("widget is disabled")

// Settings is the parsed contents of SettingsFile.
type Settings struct {
	// Disabled lists the IDs (directory names) of the widgets turned off.
	Disabled []string `yaml:"disabled"`
}

func (s Settings) disabledIDs() map[string]bool {
	ids := make(map[string]bool, len(s.Disabled))
	for _, id := range s.Disabled {
		ids[id] = true
	}
	return ids
}

// readSettings parses SettingsFile in dir. A missing file, or a missing
// directory, means no widget is disabled.
func readSettings(dir string) (Settings, error) {
	root, err := os.OpenRoot(dir)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	defer root.Close()
	info, err := root.Lstat(SettingsFile)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	if !info.Mode().IsRegular() {
		return Settings{}, fmt.Errorf("%s must be a regular file, not a symlink", SettingsFile)
	}
	f, err := root.Open(SettingsFile)
	if err != nil {
		return Settings{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSettingsBytes+1))
	if err != nil {
		return Settings{}, err
	}
	if len(data) > maxSettingsBytes {
		return Settings{}, fmt.Errorf("%s exceeds %d bytes", SettingsFile, maxSettingsBytes)
	}
	var s Settings
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&s); err != nil && !errors.Is(err, io.EOF) {
		return Settings{}, fmt.Errorf("parse %s: %w", SettingsFile, err)
	}
	return s, nil
}

// writeSettings atomically replaces SettingsFile in dir; a symlink in its place
// is replaced, not followed.
func writeSettings(dir string, s Settings) error {
	var buf bytes.Buffer
	buf.WriteString(settingsHeader)
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(s); err != nil {
		return err
	}
	if err := encoder.Close(); err != nil {
		return err
	}
	return fileprivacy.WriteFileAtomic(filepath.Join(dir, SettingsFile), buf.Bytes())
}

// withDisabled returns ids, sorted and without duplicates, with id added
// (disabled) or removed.
func withDisabled(ids []string, id string, disabled bool) []string {
	next := slices.DeleteFunc(slices.Clone(ids), func(v string) bool { return v == id })
	if disabled {
		next = append(next, id)
	}
	slices.Sort(next)
	return slices.Compact(next)
}

// SetDisabled turns the widget at mount off, stopping its process, or back
// on. The choice is kept in SettingsFile, so reloads and restarts keep it. A
// disabled widget stays listed by Status, as "disabled", but is never started.
func (m *Manager) SetDisabled(mount string, disabled bool) error {
	e, err := m.recordDisabled(mount, disabled)
	if err != nil || !disabled {
		return err
	}
	if err := e.stopProcess(); err != nil {
		return fmt.Errorf("stop disabled widget: %w", err)
	}
	return nil
}

func (m *Manager) recordDisabled(mount string, disabled bool) (*widgetEntry, error) {
	m.settingsMu.Lock()
	defer m.settingsMu.Unlock()
	m.mu.RLock()
	e, ok := m.entries[mount]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNotFound, mount)
	}
	e.mu.Lock()
	id := e.manifest.ID
	e.mu.Unlock()

	settings, err := readSettings(m.widgetsDir)
	if err != nil {
		return nil, fmt.Errorf("read widget settings: %w", err)
	}
	if next := withDisabled(settings.Disabled, id, disabled); !slices.Equal(next, settings.Disabled) {
		if err := writeSettings(m.widgetsDir, Settings{Disabled: next}); err != nil {
			return nil, fmt.Errorf("save widget settings: %w", err)
		}
	}
	e.mu.Lock()
	e.disabled = disabled
	e.mu.Unlock()
	return e, nil
}
