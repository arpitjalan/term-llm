package contain

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestPersonalBotRuntimeImageWaitCanBeCancelled(t *testing.T) {
	m, runner := newAssistantTestManager(t)
	if err := m.buildMu.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	defer m.buildMu.Release(1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, result := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		_, _, err := m.runtimeImage(ctx)
		result <- err
	}()
	<-started
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled image waiter: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("image preparation ignored cancellation while another build held ownership")
	}
	if len(runner.runs) != 0 || len(runner.outputs) != 0 {
		t.Fatal("cancelled image waiter invoked Docker")
	}
}

func TestPersonalBotStartPreservesComposeSettings(t *testing.T) {
	m, _ := newAssistantTestManager(t)
	createTestAssistant(t, m, "helper")
	connectTestAssistant(t, m, "helper")
	const definition = `
name: custom-assistant
x-term-llm:
  default_service: assistant
  workspace: /workspace
services:
  assistant:
    image: previous-runtime:local
    extra_hosts: [host.docker.internal:host-gateway]
    networks: [backend]
    configs: [settings]
    secrets: [credential]
  sidecar:
    image: example/sidecar:local
    networks: [backend]
volumes:
  workspace: {}
networks:
  backend:
    internal: true
configs:
  settings:
    content: mode=demo
secrets:
  credential:
    external: true
x-custom:
  owner: example
`
	path := filepath.Join(m.root, "helper", "compose.yaml")
	if err := os.WriteFile(path, []byte(definition), 0o600); err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err := yaml.Unmarshal([]byte(definition), &want); err != nil {
		t.Fatal(err)
	}
	want["services"].(map[string]any)["assistant"].(map[string]any)["image"] = m.opts.Image
	op, err := m.Start("helper")
	if err != nil {
		t.Fatal(err)
	}
	if result := waitAssistantOperation(t, m, op); result.State != "succeeded" {
		t.Fatal(result.Error)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := yaml.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("starting assistant changed unrelated Compose settings:\n%s", data)
	}
}
