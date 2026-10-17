#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if [[ ! -x frontend/node_modules/.bin/playwright ]]; then
  echo "Run make frontend-deps before the connection smoke." >&2
  exit 1
fi
for command in node npm curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to run the Personal Bot connection smoke." >&2
    exit 1
  fi
done

mkdir -p "$root/tmp"
state="$(mktemp -d "$root/tmp/personal-bot-connect-smoke.XXXXXX")"
node_home="$state/node-home"
hub_home="$state/hub-home"
workspace="$state/workspace"
scratch="$state/scratch"
results="$state/results"
mkdir -p "$node_home/config/term-llm" "$hub_home/config" "$workspace" "$scratch" "$results"
succeeded=false
cleanup() {
  for pid in "${hub_pid:-}" "${node_pid:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep .1
      done
      if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ "$succeeded" != true ]]; then
    for log in "$state/node.log" "$state/hub.log"; do
      if [[ -s "$log" ]]; then cat "$log" >&2; fi
    done
  fi
  rm -rf "$node_home" "$hub_home" "$workspace" "$scratch"
  echo "Personal Bot connection screenshots and test artifacts: $results"
}
trap cleanup EXIT

if [[ -n "${TERM_LLM_SMOKE_BINARY:-}" ]]; then
  binary="$TERM_LLM_SMOKE_BINARY"
  if [[ "$binary" != /* ]]; then binary="$root/$binary"; fi
  if [[ ! -x "$binary" ]]; then
    echo "TERM_LLM_SMOKE_BINARY must name an executable built from this checkout." >&2
    exit 1
  fi
else
  make build
  binary="$root/term-llm"
fi

cat >"$node_home/config/term-llm/config.yaml" <<'YAML'
default_provider: debug
provider_discovery: config
providers:
  debug:
    model: fast
YAML
node_port="$(node scripts/free_port.mjs)"
hub_port="$(node scripts/free_port.mjs)"
node_token="personal-bot-native-node-fixture-token"
hub_token="personal-bot-connect-hub-fixture-token"
node_url="http://127.0.0.1:$node_port/chat/"
hub_url="http://127.0.0.1:$hub_port/demo/"
(
  cd "$workspace"
  exec env -i PATH="$PATH" HOME="$node_home" \
    XDG_CONFIG_HOME="$node_home/config" XDG_DATA_HOME="$node_home/data" \
    XDG_CACHE_HOME="$node_home/cache" TMPDIR="$scratch" \
    "$binary" serve web jobs --personal-bot --provider debug \
    --host 127.0.0.1 --port "$node_port" --base-path /chat --token "$node_token" \
    --session-db "$node_home/sessions.db"
) >"$state/node.log" 2>&1 &
node_pid=$!
for _ in $(seq 1 100); do
  if curl -fsS -H "Authorization: Bearer $node_token" "${node_url}healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$node_pid" 2>/dev/null || { cat "$state/node.log" >&2; exit 1; }
  sleep .2
done
curl -fsS -H "Authorization: Bearer $node_token" "${node_url}healthz" >/dev/null

# An unused image allows manager startup on every host. Connecting an existing
# serve process exercises no Docker build, container, or lifecycle operation.
env -i PATH="$PATH" HOME="$hub_home" \
  XDG_CONFIG_HOME="$hub_home/config" XDG_DATA_HOME="$hub_home/data" \
  XDG_CACHE_HOME="$hub_home/cache" TMPDIR="$scratch" \
  "$binary" serve hub --personal-bot --personal-bot-image personal-bot-smoke-unused \
  --host 127.0.0.1 --port "$hub_port" --base-path /demo --auth bearer --token "$hub_token" \
  --nodes-file "$hub_home/nodes.json" >"$state/hub.log" 2>&1 &
hub_pid=$!
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$hub_port/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$hub_pid" 2>/dev/null || { cat "$state/hub.log" >&2; exit 1; }
  sleep .2
done
curl -fsS "http://127.0.0.1:$hub_port/healthz" >/dev/null

if [[ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]] && command -v chromium >/dev/null 2>&1; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v chromium)"
fi
TERM_LLM_MANAGER_SMOKE_URL="$hub_url" TERM_LLM_MANAGER_SMOKE_TOKEN="$hub_token" \
TERM_LLM_CONNECT_SMOKE_NODE_URL="$node_url" TERM_LLM_CONNECT_SMOKE_NODE_TOKEN="$node_token" \
TERM_LLM_CONNECT_SMOKE_NODES_FILE="$hub_home/nodes.json" \
  npm --prefix frontend run test:e2e -- e2e/personal-bot-connect.spec.ts \
  --workers=1 --reporter=line --output="$results" "$@"
succeeded=true
