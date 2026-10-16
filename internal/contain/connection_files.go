package contain

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/samsaffron/term-llm/internal/config"
)

type connectionSeedFile struct {
	name string
	data []byte // nil removes the old provider's credentials
}

var connectionTransactionFiles = []string{
	"config.yaml", "chatgpt_oauth.json", "chatgpt_connection.json", connectionStateFile, ".revision",
}

// Snapshot before calling a credential writer, including the revision that
// causes the next container start to consume this seed. Reject linked or
// unreadable existing files before any assignment or credential mutation.
func snapshotConnectionFiles(dir string, names []string, limit int64) ([]connectionSeedFile, error) {
	files := make([]connectionSeedFile, 0, len(names))
	for _, name := range names {
		data, err := readConnectionFile(filepath.Join(dir, name), limit)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: existing connection files are unavailable; no changes were made", ErrAssistantUnavailable)
		}
		files = append(files, connectionSeedFile{name: name, data: data})
	}
	return files, nil
}

// Restore every changed destination even if another cannot be restored. Empty
// directories introduced at owned file paths may be removed; never recursively
// remove content or follow links while recovering a failed transaction.
func restoreConnectionFiles(dir string, files []connectionSeedFile) error {
	var failed bool
	for _, file := range files {
		if err := restoreConnectionFile(dir, file); err != nil {
			failed = true
		}
	}
	if failed {
		return fmt.Errorf("%w: connection could not be fully restored; reconnect before starting", ErrAssistantUnavailable)
	}
	return nil
}

func restoreConnectionFile(dir string, file connectionSeedFile) error {
	path := filepath.Join(dir, file.name)
	current, err := readConnectionFile(path, 256<<10)
	if err == nil && file.data != nil && bytes.Equal(current, file.data) {
		return nil
	}
	if errors.Is(err, os.ErrNotExist) && file.data == nil {
		return nil
	}
	if info, statErr := os.Lstat(path); statErr == nil && info.IsDir() {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return applyConnectionFile(dir, file)
}

// Manager serializes this transaction against start/stop and only advances the
// seed revision after success. Preserve the prior seed if any individual write
// fails, so a failed provider switch cannot leave a mixed configuration.
func replaceConnectionFiles(dir string, files []connectionSeedFile) error {
	previous := make([]connectionSeedFile, len(files))
	for i, file := range files {
		data, err := readConnectionFile(filepath.Join(dir, file.name), 64<<10)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%w: existing connection files are unavailable", ErrAssistantUnavailable)
		}
		previous[i] = connectionSeedFile{name: file.name, data: data}
	}
	for i, file := range files {
		if err := applyConnectionFile(dir, file); err != nil {
			// A durable write can report a directory-sync failure after rename.
			// Restore the failing destination as well as earlier writes.
			for j := i; j >= 0; j-- {
				if restoreErr := applyConnectionFile(dir, previous[j]); restoreErr != nil {
					return fmt.Errorf("%w: connection could not be restored; reconnect before starting", ErrAssistantUnavailable)
				}
			}
			return fmt.Errorf("%w: could not save connection files", ErrAssistantUnavailable)
		}
	}
	return nil
}

func applyConnectionFile(dir string, file connectionSeedFile) error {
	path := filepath.Join(dir, file.name)
	if file.data != nil {
		return config.WriteFileAtomicallyNoFollow(path, file.data, 0o600)
	}
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Do not read linked files, special files, or oversized content from a seed.
// The directory is private and not writable by a running assistant.
func readConnectionFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("invalid connection file")
	}
	return os.ReadFile(path)
}
