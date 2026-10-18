// Command buildbotsource bundles the current checkout so Docker can build a
// Linux assistant runtime without requiring a local Go installation.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/samsaffron/term-llm/internal/pathutil"
)

const outputPath = "internal/botsource/assets/term-llm-source.tar.gz"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "build assistant source:", err)
		os.Exit(1)
	}
}

func run() error {
	root, err := pathutil.ModuleRoot()
	if err != nil {
		return err
	}
	files, err := collect(root)
	if err != nil {
		return err
	}
	archive, err := build(files)
	if err != nil {
		return err
	}
	out := filepath.Join(root, filepath.FromSlash(outputPath))
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return fmt.Errorf("create archive directory: %w", err)
	}
	if err := os.WriteFile(out, archive, 0o644); err != nil {
		return fmt.Errorf("write source archive: %w", err)
	}
	fmt.Printf("Assistant build source: %d files, %d compressed bytes\n", len(files), len(archive))
	return nil
}

// collect includes every build input under cmd and internal, including embedded
// resources and the owned modules referenced by local go.mod replacements.
func collect(root string) (map[string][]byte, error) {
	files := make(map[string][]byte)
	for _, rel := range []string{"main.go", "go.mod", "go.sum"} {
		data, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", rel, err)
		}
		files[rel] = data
	}
	for _, dir := range []string{"cmd", "internal"} {
		if err := collectDir(root, dir, files); err != nil {
			return nil, err
		}
	}
	return files, nil
}

func collectDir(root, dir string, files map[string][]byte) error {
	err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(entry.Name(), ".") && !embeddedResource(rel) {
			return nil
		}
		// Including a previous bundle would grow the archive at every build.
		if strings.HasPrefix(rel, "internal/botsource/assets/") && strings.HasSuffix(rel, ".tar.gz") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[rel] = data
		return nil
	})
	if err != nil {
		return fmt.Errorf("collect %s: %w", dir, err)
	}
	return nil
}

// These all: embed roots intentionally include dotfiles such as .env and
// .template.yaml. Omitting them would silently change the Linux runtime's
// built-in templates even though it still compiles.
func embeddedResource(path string) bool {
	for _, prefix := range []string{
		"internal/contain/personal-bot/",
		"internal/contain/templates/",
		"internal/agents/builtin/",
	} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func build(files map[string][]byte) ([]byte, error) {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	var compressed bytes.Buffer
	zw, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	tw := tar.NewWriter(zw)
	for _, path := range paths {
		data := files[path]
		if err := tw.WriteHeader(&tar.Header{
			Name: path, Size: int64(len(data)), Mode: 0o644,
			Typeflag: tar.TypeReg, Format: tar.FormatPAX,
		}); err != nil {
			return nil, fmt.Errorf("archive %s: %w", path, err)
		}
		if _, err := tw.Write(data); err != nil {
			return nil, fmt.Errorf("archive %s: %w", path, err)
		}
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("close source archive: %w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("compress source archive: %w", err)
	}
	return compressed.Bytes(), nil
}
