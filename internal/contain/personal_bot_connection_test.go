package contain

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/samsaffron/term-llm/internal/config"
)

func connectionTransactionFixture(t *testing.T) (*Manager, string, map[string][]byte) {
	t.Helper()
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	_, err := m.WithConnection("helper", func(dir string) error {
		for _, name := range connectionTransactionFiles[:4] {
			if err := config.WriteFileAtomicallyNoFollow(filepath.Join(dir, name), []byte("previous-"+name), 0o600); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	dir, err := m.ConnectionDir("helper")
	if err != nil {
		t.Fatal(err)
	}
	previous := map[string][]byte{}
	for _, name := range connectionTransactionFiles {
		path := filepath.Join(dir, name)
		previous[path], err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(m.root, "helper", assistantMetadataFile)
	previous[path], err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return m, dir, previous
}

func assertConnectionSnapshot(t *testing.T, previous map[string][]byte) {
	t.Helper()
	for path, expected := range previous {
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("failed connection changed %s: %v", filepath.Base(path), err)
		}
	}
}

func TestPersonalBotConnectionTransactionRestoresAllFailedWrites(t *testing.T) {
	for _, failure := range []string{"save", "revision", "record"} {
		t.Run(failure, func(t *testing.T) {
			m, dir, previous := connectionTransactionFixture(t)
			_, err := m.WithConnection("helper", func(dir string) error {
				for _, name := range connectionTransactionFiles[:4] {
					if err := config.WriteFileAtomicallyNoFollow(filepath.Join(dir, name), []byte("new-private-key-"+name), 0o600); err != nil {
						return err
					}
				}
				if failure == "save" {
					return errors.New("provider echoed new-private-key")
				}
				path := filepath.Join(dir, ".revision")
				if failure == "record" {
					path = filepath.Join(m.root, "helper", assistantMetadataFile)
				}
				// A directory at the file destination makes atomic rename fail on
				// every platform, independent of the test process's privileges.
				if err := os.Remove(path); err != nil {
					return err
				}
				return os.Mkdir(path, 0o700)
			})
			if !errors.Is(err, ErrAssistantUnavailable) || strings.Contains(err.Error(), "new-private-key") || strings.Contains(err.Error(), dir) {
				t.Fatalf("unsafe connection failure: %v", err)
			}
			assertConnectionSnapshot(t, previous)
		})
	}
}

func TestPersonalBotConnectionTransactionRejectsLinkedRevisionBeforeSave(t *testing.T) {
	m, dir, previous := connectionTransactionFixture(t)
	revision := filepath.Join(dir, ".revision")
	outside := filepath.Join(t.TempDir(), "keep-private")
	if err := os.WriteFile(outside, []byte("outside-content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(revision); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, revision); err != nil {
		t.Fatal(err)
	}
	delete(previous, revision)
	called := false
	_, err := m.WithConnection("helper", func(string) error { called = true; return nil })
	if !errors.Is(err, ErrAssistantUnavailable) || called {
		t.Fatalf("linked revision allowed a credential mutation: called=%v err=%v", called, err)
	}
	assertConnectionSnapshot(t, previous)
	if target, err := os.Readlink(revision); err != nil || target != outside {
		t.Fatal("rejected transaction replaced the linked revision")
	}
	if data, _ := os.ReadFile(outside); string(data) != "outside-content" {
		t.Fatal("rejected transaction changed the linked target")
	}
}

func TestPersonalBotFailedFirstConnectionRemovesNewSeed(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	dir, _ := m.ConnectionDir("helper")
	_, err := m.WithConnection("helper", func(dir string) error {
		for _, name := range connectionTransactionFiles[:4] {
			if err := config.WriteFileAtomicallyNoFollow(filepath.Join(dir, name), []byte("new-private-key"), 0o600); err != nil {
				return err
			}
		}
		return errors.New("save failed")
	})
	if !errors.Is(err, ErrAssistantUnavailable) {
		t.Fatalf("failed save accepted: %v", err)
	}
	for _, name := range connectionTransactionFiles {
		if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("failed first connection retained %s: %v", name, err)
		}
	}
	record, err := m.readRecord("helper")
	if err != nil || !record.Assistant.NeedsConnection {
		t.Fatalf("failed connection marked assistant ready: %+v, %v", record, err)
	}
}
