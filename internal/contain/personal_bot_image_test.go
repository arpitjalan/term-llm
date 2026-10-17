package contain

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"gopkg.in/yaml.v3"
)

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
