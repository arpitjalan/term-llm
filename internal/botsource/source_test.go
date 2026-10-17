package botsource

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
	"testing/fstest"
)

func testArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var body bytes.Buffer
	zw := gzip.NewWriter(&body)
	tw := tar.NewWriter(zw)
	for path, data := range files {
		if err := tw.WriteHeader(&tar.Header{Name: path, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func TestSourceUsesPinnedRootGoVersion(t *testing.T) {
	archive := testArchive(t, map[string]string{
		"go.mod":                 "module example.com/app\n\ngo 1.27.2\n",
		"internal/reflow/go.mod": "module example.com/reflow\n\ngo 1.18\n",
	})
	got, version, err := source(fstest.MapFS{archivePath: &fstest.MapFile{Data: archive}})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, archive) || version != "1.27.2" {
		t.Fatalf("Source() = %d archive bytes, %q; want %d bytes, 1.27.2", len(got), version, len(archive))
	}
}

func TestSourceFailuresExplainHowToRebuild(t *testing.T) {
	tests := map[string]fstest.MapFS{
		"not embedded":        {},
		"invalid archive":     {archivePath: &fstest.MapFile{Data: []byte("corrupt")}},
		"missing root module": {archivePath: &fstest.MapFile{Data: testArchive(t, map[string]string{"internal/nested/go.mod": "go 1.27.2\n"})}},
		"invalid version":     {archivePath: &fstest.MapFile{Data: testArchive(t, map[string]string{"go.mod": "go 1.27;invalid\n"})}},
	}
	for name, files := range tests {
		t.Run(name, func(t *testing.T) {
			archive, version, err := source(files)
			if err == nil || !strings.Contains(err.Error(), "make build") || archive != nil || version != "" {
				t.Fatalf("Source() = %d bytes, %q, %v; want actionable build error", len(archive), version, err)
			}
		})
	}
}

func TestModuleGoVersion(t *testing.T) {
	for _, tc := range []struct {
		name, module, want string
	}{
		{"pinned patch", "module app\n\ngo 1.27.2\n", "1.27.2"},
		{"minor version", "module app\n\ngo 1.27\n", "1.27"},
		{"comments and CRLF", "// go 1.18\r\nmodule app\r\n\tgo\t1.27.2 // pinned\r\n", "1.27.2"},
		{"missing directive", "module app\n", ""},
		{"comment only", "module app\n// go 1.27.2\n", ""},
		{"toolchain only", "module app\ntoolchain go1.27.2\n", ""},
		{"invalid tag", "module app\ngo 1.27;invalid\n", ""},
		{"extra words", "module app\ngo 1.27.2 extra\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := moduleGoVersion([]byte(tc.module))
			if got != tc.want || (err != nil) != (tc.want == "") {
				t.Fatalf("moduleGoVersion() = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
