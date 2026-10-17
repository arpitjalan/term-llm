package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func writeFile(t *testing.T, root, path, body string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCollectPreservesBuildInputsAndExcludesTestsAndOwnArchive(t *testing.T) {
	root := t.TempDir()
	include := map[string]string{
		"main.go":                                         "package main\n",
		"go.mod":                                          "module example.com/app\n\ngo 1.27.2\nreplace example.com/terminal => ./internal/terminal/runtime\n",
		"go.sum":                                          "module checksums\n",
		"cmd/server_setup.go":                             "//go:embed server_setup.sh\n",
		"cmd/server_setup.sh":                             "#!/bin/sh\n",
		"internal/serveui/static/dist/app.js.gz":          "embedded frontend\n",
		"internal/serveui/static/icon-512.png":            "embedded icon\n",
		"internal/contain/personal-bot/Dockerfile":        "FROM debian\n",
		"internal/contain/personal-bot/.env":              "ASSISTANT_PORT=8080\n",
		"internal/contain/templates/agent/.env":           "AGENT_PORT=8080\n",
		"internal/contain/templates/agent/.template.yaml": "name: agent\n",
		"internal/agents/builtin/contain/recipes/ollama/.template.yaml":      "name: ollama\n",
		"internal/agents/builtin/contain/recipes/postgres/.env":              "POSTGRES_DB=assistant\n",
		"internal/agents/builtin/contain/recipes/postgres/.template.yaml":    "name: postgres\n",
		"internal/agents/builtin/contain/recipes/redis/.template.yaml":       "name: redis\n",
		"internal/agents/builtin/contain/recipes/code-server/.env":           "PORT=8080\n",
		"internal/agents/builtin/contain/recipes/code-server/.template.yaml": "name: code-server\n",
		"internal/terminal/runtime/go.mod":                                   "module example.com/terminal\n",
		"internal/terminal/runtime/go.sum":                                   "nested module checksums\n",
		"internal/terminal/runtime/tea.go":                                   "package tea\n",
		"internal/terminal/renderer/go.mod":                                  "module example.com/renderer\n",
		"internal/terminal/renderer/renderer.go":                             "package renderer\n",
		"internal/reflow/go.mod":                                             "module example.com/reflow\n",
		"internal/reflow/wrap.go":                                            "package reflow\n",
		"internal/uisource/assets/source.tar.gz":                             "embedded UI source\n",
		"internal/botsource/source.go":                                       "package botsource\n",
		"internal/botsource/assets/README.txt":                               "embed placeholder\n",
		"internal/botsource/assets/runtime-note.txt":                         "other resource\n",
		"internal/agents/builtin/helper/system.md":                           "assistant instructions\n",
		"internal/session/export_html.css":                                   "embedded stylesheet\n",
	}
	exclude := map[string]string{
		"cmd/setup_test.go":                                "package cmd\n",
		"cmd/.DS_Store":                                    "hidden\n",
		"cmd/.cache/object":                                "hidden cache\n",
		"internal/serveui/embed_test.go":                   "package serveui\n",
		"internal/testdata/fixture.json":                   "test data\n",
		"internal/terminal/runtime/testdata/corpus/seed":   "test data\n",
		"internal/botsource/assets/term-llm-source.tar.gz": "previous bundle\n",
		"internal/botsource/assets/old-source.tar.gz":      "another previous bundle\n",
		"internal/.cache/private":                          "hidden cache\n",
		"internal/contain/personal-bot/.cache/private":     "hidden cache under embed root\n",
		"frontend/src/main.tsx":                            "source frontend is not needed for go build\n",
	}
	for path, body := range include {
		writeFile(t, root, path, body)
	}
	for path, body := range exclude {
		writeFile(t, root, path, body)
	}
	files, err := collect(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(include) {
		t.Fatalf("collected %d files, want %d: %v", len(files), len(include), files)
	}
	for path, want := range include {
		if string(files[path]) != want {
			t.Errorf("build input %s = %q, want %q", path, files[path], want)
		}
	}
	for path := range exclude {
		if _, ok := files[path]; ok {
			t.Errorf("unexpected build input %s", path)
		}
	}
}

func TestCollectDoesNotFollowSymlinks(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "main.go", "package main\n")
	writeFile(t, root, "go.mod", "module app\n")
	writeFile(t, root, "go.sum", "")
	writeFile(t, root, "cmd/app.go", "package cmd\n")
	writeFile(t, root, "internal/helper.go", "package helper\n")
	if err := os.Symlink(filepath.Join(root, "main.go"), filepath.Join(root, "internal", "linked.go")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	files, err := collect(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := files["internal/linked.go"]; ok {
		t.Fatal("collected symlink target")
	}
}

func TestCollectReportsMissingBuildInput(t *testing.T) {
	_, err := collect(t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "read main.go") {
		t.Fatalf("missing root source error = %v", err)
	}
}

func TestBuildIsDeterministicWithSortedFixedMetadata(t *testing.T) {
	files := map[string][]byte{
		"main.go": []byte("package main\n"),
		"go.mod":  []byte("module app\n\ngo 1.27.2\n"),
		"internal/agents/" + strings.Repeat("long-name/", 15) + "system.md": []byte("embedded resource\n"),
	}
	archive, err := build(files)
	if err != nil {
		t.Fatal(err)
	}
	again, err := build(files)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(archive, again) {
		t.Fatal("identical inputs produced different archive bytes")
	}
	zr, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	if !zr.ModTime.IsZero() || zr.Name != "" || zr.Comment != "" {
		t.Fatalf("gzip metadata is not fixed: %+v", zr.Header)
	}
	tr := tar.NewReader(zr)
	var paths []string
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		paths = append(paths, header.Name)
		if header.Mode != 0o644 || header.Uid != 0 || header.Gid != 0 || header.ModTime.Unix() != 0 || header.Typeflag != tar.TypeReg {
			t.Errorf("archive metadata is not fixed: %+v", header)
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(data, files[header.Name]) {
			t.Errorf("archive content for %s = %q", header.Name, data)
		}
	}
	want := make([]string, 0, len(files))
	for path := range files {
		want = append(want, path)
	}
	sort.Strings(want)
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("archive paths = %v, want %v", paths, want)
	}
}
