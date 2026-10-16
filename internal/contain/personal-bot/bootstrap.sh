#!/bin/sh
set -eu

seed=/run/personal-bot-connection
config=/home/agent/.config/term-llm
test -s "$seed/config.yaml" || { echo "Connect a model provider before starting this assistant." >&2; exit 1; }
test -s "$seed/.revision" || { echo "Assistant connection is incomplete." >&2; exit 1; }
mkdir -p "$config" /workspace /home/agent/.cache /home/agent/.local/share

# The host seed is read-only. An existing OAuth store may be the refresh
# authority for other assistants, even after this assistant changes providers.
# Preserve it unless the seed explicitly supplies replacement credentials.
if ! cmp -s "$seed/.revision" "$config/.revision"; then
  rm -f "$config/chatgpt_connection.json"
  cp -R "$seed/." "$config/"
  chown -R agent:agent "$config"
fi
chown agent:agent /home/agent /home/agent/.config /home/agent/.cache /home/agent/.local /home/agent/.local/share /workspace
chmod 700 "$config"

unset TERM_LLM_CHATGPT_CONNECTION_FILE
if test -s "$config/chatgpt_connection.json"; then
  export TERM_LLM_CHATGPT_CONNECTION_FILE="$config/chatgpt_connection.json"
fi

cd /workspace
exec gosu agent /usr/local/bin/term-llm serve web jobs \
  --personal-bot \
  --agent "$AGENT_NAME" \
  --base-path "${WEB_BASE_PATH:-/chat}" \
  --host 0.0.0.0 --port 8081 \
  --auth bearer --token "$WEB_TOKEN"
