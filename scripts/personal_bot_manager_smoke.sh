#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if [[ ! -x frontend/node_modules/.bin/playwright ]]; then
  echo "Run make frontend-deps before the management smoke." >&2
  exit 1
fi
docker compose version >/dev/null
docker_arch="$(docker version --format '{{.Server.Arch}}')"
case "$docker_arch" in amd64|arm64) ;; *) echo "Unsupported Docker architecture: $docker_arch" >&2; exit 1 ;; esac
mkdir -p "$root/tmp"
state="$(mktemp -d "$root/tmp/personal-bot-manager-smoke.XXXXXX")"
smoke_docker_config="${DOCKER_CONFIG:-$HOME/.docker}"
smoke_home="$state/home"
mkdir -p "$smoke_home/config" "$smoke_home/data" "$smoke_home/cache" "$state/results"
export DOCKER_CONFIG="$smoke_docker_config"
cleanup() {
  if [[ -n "${hub_pid:-}" ]]; then
    kill -TERM "$hub_pid" 2>/dev/null || true
    wait "$hub_pid" 2>/dev/null || true
  fi
  # Only remove resources created in this invocation's isolated fixture root.
  for compose in "$smoke_home"/config/term-llm/containers/*/compose.yaml; do
    [[ -f "$compose" ]] || continue
    workspace="$(dirname "$compose")"
    name="$(basename "$workspace")"
    docker compose -f "$compose" --project-directory "$workspace" \
      -p "term-llm-contain-$name" down --volumes --remove-orphans >"$state/cleanup-$name.log" 2>&1 || true
  done
  echo "Management smoke artifacts: $state"
}
trap cleanup EXIT

if [[ -z "${TERM_LLM_SMOKE_BINARY:-}" ]]; then
  make build
  binary="$root/term-llm"
else
  binary="$(cd "$(dirname "$TERM_LLM_SMOKE_BINARY")" && pwd)/$(basename "$TERM_LLM_SMOKE_BINARY")"
fi
CGO_ENABLED=0 GOOS=linux GOARCH="$docker_arch" go build -o "$state/term-llm-linux" .
port="$(node scripts/free_port.mjs)"
token="personal-bot-manager-smoke-token"
env -u TERM_LLM_PPROF -u TERM_LLM_SERVE_HUB_URL -u TERM_LLM_SERVE_HUB_REGISTER -u TERM_LLM_CHATGPT_CONNECTION_FILE \
  HOME="$smoke_home" XDG_CONFIG_HOME="$smoke_home/config" XDG_DATA_HOME="$smoke_home/data" \
  XDG_CACHE_HOME="$smoke_home/cache" DOCKER_CONFIG="$smoke_docker_config" \
  "$binary" serve hub --personal-bot --personal-bot-binary "$state/term-llm-linux" \
  --host 127.0.0.1 --port "$port" --base-path /demo --auth bearer --token "$token" \
  >"$state/hub.log" 2>&1 &
hub_pid=$!
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$hub_pid" 2>/dev/null || { cat "$state/hub.log" >&2; exit 1; }
  sleep .2
done
curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null
if [[ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]] && command -v chromium >/dev/null 2>&1; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v chromium)"
fi
TERM_LLM_MANAGER_SMOKE_URL="http://127.0.0.1:$port/demo/" \
TERM_LLM_MANAGER_SMOKE_TOKEN="$token" \
TERM_LLM_MANAGER_SMOKE_CONFIG="$smoke_home/config/term-llm" \
TERM_LLM_MANAGER_SMOKE_PID="$hub_pid" \
  npm --prefix frontend run test:e2e -- e2e/personal-bot-manager.spec.ts e2e/personal-bot-connections.spec.ts \
  --workers=1 --reporter=line --output="$state/results" "$@"
