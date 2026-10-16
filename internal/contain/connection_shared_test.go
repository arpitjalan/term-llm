package contain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingConnectionCommit struct{ *Manager }

func (w failingConnectionCommit) WithConnection(name string, save func(string) error) (ManagedAssistant, error) {
	return w.Manager.WithConnection(name, func(dir string) error {
		if err := save(dir); err != nil {
			return err
		}
		return errors.New("fixture connection commit failure")
	})
}

func TestConnectionSharedAssignmentRollsBackAfterWorkspaceFailure(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "alpha")
	s, err := NewConnectionService(m)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	connection, err := s.shared.CreateChatGPT(testChatGPTCredentials(), "Team ChatGPT")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UseSharedConnection("alpha", connection.ID, ""); err != nil {
		t.Fatal(err)
	}
	dir, _ := m.ConnectionDir("alpha")
	previous := assertPrivateConnectionFile(t, dir, "chatgpt_connection.json")
	var bridge struct{ Token string }
	if err := json.Unmarshal(previous, &bridge); err != nil {
		t.Fatal(err)
	}
	s.workspaces = failingConnectionCommit{m}
	if _, err := s.UseSharedConnection("alpha", connection.ID, ""); err == nil {
		t.Fatal("failed workspace commit was accepted")
	}
	if _, ok := s.shared.authorize(bridge.Token); !ok {
		t.Fatal("failed workspace commit revoked the previous runtime token")
	}
	if current := assertPrivateConnectionFile(t, dir, "chatgpt_connection.json"); !bytes.Equal(current, previous) {
		t.Fatal("failed workspace commit changed the previous connection seed")
	}
}

func TestConnectionSharedAssignmentPersistsWithoutCopyingOAuth(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "alpha")
	createTestAssistant(t, m, "beta")
	s, err := NewConnectionService(m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	connection, err := s.shared.CreateChatGPT(testChatGPTCredentials(), "Team ChatGPT")
	if err != nil {
		t.Fatal(err)
	}
	var tokens []string
	for _, name := range []string{"alpha", "beta"} {
		status, err := s.UseSharedConnection(name, connection.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		if status.ConnectionID != connection.ID || status.ConnectionName != "Team ChatGPT" || status.State != "authorized" {
			t.Fatalf("incorrect shared status: %+v", status)
		}
		dir, _ := m.ConnectionDir(name)
		data := assertPrivateConnectionFile(t, dir, "chatgpt_connection.json")
		if strings.Contains(string(data), "private-test-refresh-token") || strings.Contains(string(data), "private-test-access-token") {
			t.Fatal("OAuth credentials copied to worker")
		}
		var bridge struct{ URL, Token, CACert string }
		if err := json.Unmarshal(data, &bridge); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(bridge.URL, "https://host.docker.internal:") || bridge.Token == "" {
			t.Fatal("missing private broker connection")
		}
		tokens = append(tokens, bridge.Token)
		if _, err := os.Stat(filepath.Join(dir, "chatgpt_oauth.json")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("shared worker has a copied OAuth seed")
		}
		assertNoConnectionSecrets(t, status, bridge.Token, "private-test-refresh-token")
	}
	if tokens[0] == tokens[1] {
		t.Fatal("assistants share a broker capability")
	}
	s.Close()
	restarted, err := NewConnectionService(m)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	connections, err := restarted.SharedConnections(context.Background())
	if err != nil || len(connections) != 1 || connections[0].ID != connection.ID {
		t.Fatalf("shared connection lost on restart: %v", err)
	}
	status, err := restarted.Status("beta")
	if err != nil || status.ConnectionID != connection.ID {
		t.Fatalf("assignment lost on restart: %v", err)
	}
}

func TestConnectionSharedAssignmentRejectsRunningAndClearsBridgeOnAPIKey(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	createTestAssistant(t, m, "alpha")
	s, err := NewConnectionService(m)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	connection, err := s.shared.CreateChatGPT(testChatGPTCredentials(), "Team ChatGPT")
	if err != nil {
		t.Fatal(err)
	}
	runner.ps = []byte(`{"Names":"alpha","State":"running","Labels":"org.term-llm.contain.name=alpha"}`)
	if _, err := s.UseSharedConnection("alpha", connection.ID, ""); !errors.Is(err, ErrAssistantBusy) {
		t.Fatalf("running assignment allowed: %v", err)
	}
	runner.ps = nil
	if _, err := s.UseSharedConnection("alpha", connection.ID, ""); err != nil {
		t.Fatal(err)
	}
	status, err := s.SaveAPIKey("alpha", "openai", "", "private-test-api-key")
	if err != nil {
		t.Fatal(err)
	}
	if status.ConnectionID != "" || status.Provider != "openai" {
		t.Fatalf("old shared assignment retained: %+v", status)
	}
	dir, _ := m.ConnectionDir("alpha")
	if _, err := os.Stat(filepath.Join(dir, "chatgpt_connection.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old bridge retained in seed")
	}
}
