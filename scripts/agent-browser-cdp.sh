#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELENIUM_URL="${SELENIUM_URL:-http://localhost:4444}"
STREAM_PORT="${AGENT_BROWSER_STREAM_PORT:-9223}"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser is not installed or not in PATH" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: AGENT_BROWSER_STREAM_PORT=9223 $0 <agent-browser args...>" >&2
  echo "example: $0 open https://example.com" >&2
  exit 1
fi

CDP_TARGET="${CDP_TARGET:-}"

if [ -z "${CDP_TARGET}" ]; then
  status_json="$(curl -fsS "${SELENIUM_URL}/status")"
  active_session_id="$(
    RESPONSE="${status_json}" node -e 'const data = JSON.parse(process.env.RESPONSE); const slots = data.value?.nodes?.flatMap((node) => node.slots ?? []) ?? []; const session = slots.map((slot) => slot.session).find(Boolean); process.stdout.write(session?.sessionId ?? "");'
  )"

  if [ -z "${active_session_id}" ]; then
    echo "no active Selenium browser session found, creating one" >&2
    "${SCRIPT_DIR}/bootstrap-browser-session.sh" >/dev/null
    status_json="$(curl -fsS "${SELENIUM_URL}/status")"
    active_session_id="$(
      RESPONSE="${status_json}" node -e 'const data = JSON.parse(process.env.RESPONSE); const slots = data.value?.nodes?.flatMap((node) => node.slots ?? []) ?? []; const session = slots.map((slot) => slot.session).find(Boolean); process.stdout.write(session?.sessionId ?? "");'
    )"
  fi

  if [ -z "${active_session_id}" ]; then
    echo "could not resolve an active Selenium session" >&2
    exit 1
  fi

  CDP_TARGET="ws://localhost:4444/session/${active_session_id}/se/cdp"
fi

echo "connecting agent-browser to CDP target ${CDP_TARGET}"
echo "streaming websocket will listen on ws://localhost:${STREAM_PORT}"

AGENT_BROWSER_STREAM_PORT="${STREAM_PORT}" \
  exec agent-browser --cdp "${CDP_TARGET}" "$@"
