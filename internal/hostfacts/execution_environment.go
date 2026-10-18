package hostfacts

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ExecutionEnvironment reports whether this process runs on the host or in a
// detected Linux container. It only reads local container markers, without
// running the broader host identity probes.
func ExecutionEnvironment() string {
	return executionEnvironment(runtime.GOOS, "/", os.ReadFile)
}

func executionEnvironment(goos, root string, readFile func(string) ([]byte, error)) string {
	if goos == "linux" && linuxContainer(root, readFile) != "" {
		return "container"
	}
	return "host"
}

func linuxContainer(root string, readFile func(string) ([]byte, error)) string {
	if _, err := readFile(filepath.Join(root, ".dockerenv")); err == nil {
		return "docker"
	}
	if _, err := readFile(filepath.Join(root, "run/.containerenv")); err == nil {
		return "podman"
	}
	// systemd container managers expose their identity to unprivileged payloads.
	// See https://systemd.io/CONTAINER_INTERFACE/ for /run/host/container-manager.
	for _, path := range []string{"run/host/container-manager", "run/systemd/container"} {
		if value, err := readFile(filepath.Join(root, path)); err == nil {
			if manager := strings.TrimSpace(string(value)); manager != "" && manager != "wsl" {
				return manager
			}
		}
	}
	if cgroup, err := readFile(filepath.Join(root, "proc/1/cgroup")); err == nil {
		for _, marker := range []struct{ path, manager string }{
			{"lxc", "lxc"},
			{"/docker/", "docker"},
			{"/docker-", "docker"},
			{"/kubepods", "kubernetes"},
			{"/cri-containerd-", "containerd"},
			{"/libpod-", "podman"},
		} {
			if strings.Contains(string(cgroup), marker.path) {
				return marker.manager
			}
		}
	}
	return ""
}
