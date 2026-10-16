#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ "$#" -ne 0 ]]; then
  echo "Usage: make personal-bot-runtime" >&2
  exit 1
fi
for command in docker go; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to build the Personal Bot runtime." >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required; start Docker Desktop or the Docker service." >&2
  exit 1
fi
if ! docker_arch="$(docker version --format '{{.Server.Arch}}')"; then
  echo "Cannot reach Docker; start Docker Desktop or the Docker service." >&2
  exit 1
fi
case "$docker_arch" in
  amd64|arm64) ;;
  *) echo "Unsupported Docker architecture: $docker_arch (expected amd64 or arm64)." >&2; exit 1 ;;
esac

runtime_dir="${XDG_DATA_HOME:-$HOME/.local/share}/term-llm/personal-bot"
if [[ "$runtime_dir" != /* ]]; then
  echo "XDG_DATA_HOME must be an absolute path for a persistent Personal Bot runtime." >&2
  exit 1
fi
mkdir -p "$runtime_dir"
runtime="$runtime_dir/term-llm-linux"
staged="$(mktemp "$runtime_dir/.term-llm-linux.XXXXXX")"
trap 'rm -f "$staged"' EXIT
CGO_ENABLED=0 GOOS=linux GOARCH="$docker_arch" go build -o "$staged" .
chmod 755 "$staged"
mv -f "$staged" "$runtime"
printf 'Personal Bot runtime (linux/%s): %s\n' "$docker_arch" "$runtime"
