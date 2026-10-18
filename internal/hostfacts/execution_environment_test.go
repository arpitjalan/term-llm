package hostfacts

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExecutionEnvironment(t *testing.T) {
	for _, tc := range []struct {
		name  string
		goos  string
		files map[string]string
		want  string
	}{
		{name: "host", goos: "linux", want: "host"},
		{name: "Docker", goos: "linux", files: map[string]string{".dockerenv": ""}, want: "container"},
		{name: "Podman", goos: "linux", files: map[string]string{"run/.containerenv": ""}, want: "container"},
		{name: "LXC", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/lxc/worker"}, want: "container"},
		{name: "systemd nspawn", goos: "linux", files: map[string]string{"run/host/container-manager": "systemd-nspawn\n"}, want: "container"},
		{name: "legacy systemd marker", goos: "linux", files: map[string]string{"run/systemd/container": "systemd-nspawn\n"}, want: "container"},
		{name: "empty systemd marker", goos: "linux", files: map[string]string{"run/host/container-manager": "\n"}, want: "host"},
		{name: "Docker cgroup", goos: "linux", files: map[string]string{"proc/1/cgroup": "1:name=systemd:/docker/worker"}, want: "container"},
		{name: "Docker scope", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/system.slice/docker-worker.scope"}, want: "container"},
		{name: "Kubernetes cgroup", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/kubepods.slice/kubepods-burstable.slice/worker"}, want: "container"},
		{name: "containerd cgroup", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/system.slice/cri-containerd-worker.scope"}, want: "container"},
		{name: "Podman cgroup", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/machine.slice/libpod-worker.scope"}, want: "container"},
		{name: "Docker host service", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/system.slice/docker.service"}, want: "host"},
		{name: "host cgroup", goos: "linux", files: map[string]string{"proc/1/cgroup": "0::/user.slice"}, want: "host"},
		{name: "WSL", goos: "linux", files: map[string]string{"proc/version": "Linux version 6.6.87.2-microsoft-standard-WSL2"}, want: "host"},
		{name: "WSL systemd marker", goos: "linux", files: map[string]string{"run/systemd/container": "wsl\n"}, want: "host"},
		{name: "Docker in WSL", goos: "linux", files: map[string]string{".dockerenv": "", "proc/version": "Linux version 6.6.87.2-microsoft-standard-WSL2"}, want: "container"},
		{name: "macOS", goos: "darwin", files: map[string]string{".dockerenv": ""}, want: "host"},
		{name: "Windows", goos: "windows", files: map[string]string{".dockerenv": ""}, want: "host"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			for name, content := range tc.files {
				path := filepath.Join(root, name)
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
			}
			if got := executionEnvironment(tc.goos, root, os.ReadFile); got != tc.want {
				t.Errorf("executionEnvironment() = %q, want %q", got, tc.want)
			}
		})
	}
}
