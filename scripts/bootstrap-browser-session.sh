#!/usr/bin/env bash

set -euo pipefail

SELENIUM_URL="${SELENIUM_URL:-http://localhost:4444}"
STATUS_URL="${SELENIUM_URL}/status"
SESSION_URL="${SELENIUM_URL}/session"

echo "waiting for selenium at ${STATUS_URL}"

until curl -fsS "${STATUS_URL}" >/dev/null; do
  sleep 1
done

echo "creating a browser session"

response="$(
  curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  "${SESSION_URL}" \
  -d '{
    "capabilities": {
      "alwaysMatch": {
        "browserName": "chrome"
      }
    }
  }'
)"

echo "${response}"

session_id="$(
  RESPONSE="${response}" node -e 'const data = JSON.parse(process.env.RESPONSE); process.stdout.write(data.value.sessionId ?? "");'
)"

if [ -z "${session_id}" ]; then
  echo "failed to create a browser session" >&2
  exit 1
fi

cdp_url="ws://localhost:4444/session/${session_id}/se/cdp"

echo
echo "browser session created"
echo "noVNC: http://localhost:7900/?autoconnect=1&resize=scale"
echo "CDP:   ${cdp_url}"
