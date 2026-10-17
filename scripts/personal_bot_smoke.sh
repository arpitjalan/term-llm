#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "$root/frontend/node_modules/.bin/playwright" ]]; then
  echo "frontend smoke dependencies are missing; run 'make frontend-deps' first" >&2
  exit 1
fi
for command in node npm curl git; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to run the Personal Bot browser smoke" >&2
    exit 1
  fi
done

mkdir -p "$root/tmp"
run_dir="$(mktemp -d "$root/tmp/personal-bot-smoke.XXXXXX")"
smoke_home="$run_dir/home"
workspace="$run_dir/workspace"
routine_workspace="$workspace/routines"
widget_dir="$smoke_home/config/term-llm/widgets/smoke-dashboard"
scratch_dir="$run_dir/scratch"
results="$run_dir/results"
log="$run_dir/server.log"
mkdir -p "$widget_dir" "$routine_workspace" "$scratch_dir" "$results"
port="${TERM_LLM_SMOKE_PORT:-$(node "$root/scripts/free_port.mjs")}"
url="http://127.0.0.1:${port}/ui/"
smoke_succeeded=false

cleanup() {
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    for _ in $(seq 1 40); do
      if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$server_pid" 2>/dev/null; then
      echo "Personal Bot smoke server did not stop within 4 seconds; killing it" >&2
      kill -KILL "$server_pid" 2>/dev/null || true
    fi
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "$smoke_succeeded" != true && -s "$log" ]]; then
    echo "Personal Bot smoke server log:" >&2
    cat "$log" >&2
  fi
  rm -rf "$smoke_home" "$workspace" "$scratch_dir"
  rm -f "$run_dir/term-llm"
  echo "Personal Bot screenshots and test artifacts: $results"
}
trap cleanup EXIT

cd "$root"
if [[ -n "${TERM_LLM_SMOKE_BINARY:-}" ]]; then
  binary="$TERM_LLM_SMOKE_BINARY"
  if [[ "$binary" != /* ]]; then binary="$root/$binary"; fi
  if [[ ! -x "$binary" ]]; then
    echo "TERM_LLM_SMOKE_BINARY must name an executable built from this checkout" >&2
    exit 1
  fi
else
  npm --prefix frontend run build
  go run ./cmd/builduisource
  go run ./cmd/buildbotsource
  binary="$run_dir/term-llm"
  go build -o "$binary" .
fi

cat >"$smoke_home/config/term-llm/config.yaml" <<'YAML'
default_provider: debug
providers:
  debug:
    model: fast
YAML

# A real local widget exercises discovery, lazy process startup, proxying, and
# lifecycle controls without adding a runtime dependency beyond the smoke's Node.
cat >"$widget_dir/widget.yaml" <<'YAML'
title: Smoke dashboard
description: A local dashboard for the browser smoke
command: ["node", "server.mjs", "$PORT"]
YAML
cat >"$widget_dir/server.mjs" <<'JS'
import { createServer } from 'node:http';

createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>Smoke dashboard</title></head><body><h1>Your local widget is running</h1></body></html>');
}).listen(Number(process.argv[2]), '127.0.0.1');
JS

# Project discovery resolves a directory inside a Git checkout to that checkout's
# root. Give both fixture directories their own roots so ./tmp cannot select the
# actual term-llm checkout as an assistant workspace.
env -i PATH="$PATH" HOME="$smoke_home" GIT_CONFIG_NOSYSTEM=1 git -C "$workspace" init -q
env -i PATH="$PATH" HOME="$smoke_home" GIT_CONFIG_NOSYSTEM=1 git -C "$routine_workspace" init -q

# Give the server only its isolated paths and the deterministic debug provider.
# No user credentials, Hub registration, or provider environment reach the run.
(
  cd "$workspace"
  exec env -i PATH="$PATH" HOME="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_home/config" XDG_DATA_HOME="$smoke_home/data" \
    XDG_CACHE_HOME="$smoke_home/cache" TMPDIR="$scratch_dir" \
    "$binary" serve web jobs --personal-bot --provider debug --projects \
    --host 127.0.0.1 --port "$port" --no-auth \
    --session-db "$smoke_home/sessions.db"
) >"$log" 2>&1 &
server_pid=$!
for _ in $(seq 1 80); do
  if curl -fsS "${url}healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then exit 1; fi
  sleep 0.25
done
curl -fsS "${url}healthz" >/dev/null

if [[ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]] && command -v chromium >/dev/null 2>&1; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v chromium)"
fi
cd "$root/frontend"
TMPDIR="$scratch_dir" TERM_LLM_SMOKE_URL="$url" TERM_LLM_PERSONAL_BOT_SMOKE=1 \
  TERM_LLM_PERSONAL_BOT_WORKSPACE="$routine_workspace" \
  npm run test:e2e -- personal-bot.spec.ts personal-bot-themes.spec.ts --workers=1 --reporter=line --output="$results" "$@"
smoke_succeeded=true
