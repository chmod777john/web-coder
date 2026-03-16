#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CLOUDFLARED_CONTAINER_NAME:-web-coder-cloudflared}"
IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}"
LOCAL_URL="${TUNNEL_LOCAL_URL:-http://127.0.0.1:3001}"
ACTION="${1:-start}"

container_exists() {
  docker ps -aq -f "name=^${CONTAINER_NAME}$" | grep -q .
}

container_running() {
  docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .
}

extract_url() {
  docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eo 'https://[-a-zA-Z0-9.]+trycloudflare.com' | tail -n 1
}

start_tunnel() {
  if container_running; then
    url="$(extract_url || true)"
    echo "cloudflared is already running in container ${CONTAINER_NAME}"
    if [ -n "${url}" ]; then
      echo "${url}"
    fi
    return 0
  fi

  if container_exists; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null
  fi

  docker run \
    -d \
    --name "${CONTAINER_NAME}" \
    --network host \
    "${IMAGE}" \
    tunnel \
    --no-autoupdate \
    --url "${LOCAL_URL}" >/dev/null

  for _ in $(seq 1 30); do
    url="$(extract_url || true)"
    if [ -n "${url}" ]; then
      echo "${url}"
      return 0
    fi
    sleep 1
  done

  echo "cloudflared started but tunnel URL is not ready yet" >&2
  docker logs "${CONTAINER_NAME}" >&2 || true
  return 1
}

stop_tunnel() {
  if ! container_exists; then
    echo "cloudflared container ${CONTAINER_NAME} is not running"
    return 0
  fi

  docker rm -f "${CONTAINER_NAME}" >/dev/null
  echo "stopped ${CONTAINER_NAME}"
}

show_url() {
  if ! container_exists; then
    echo "cloudflared container ${CONTAINER_NAME} does not exist" >&2
    return 1
  fi

  url="$(extract_url || true)"
  if [ -z "${url}" ]; then
    echo "no tunnel URL found yet in ${CONTAINER_NAME} logs" >&2
    return 1
  fi

  echo "${url}"
}

case "${ACTION}" in
  start)
    start_tunnel
    ;;
  stop)
    stop_tunnel
    ;;
  restart)
    stop_tunnel
    start_tunnel
    ;;
  logs)
    docker logs -f "${CONTAINER_NAME}"
    ;;
  url)
    show_url
    ;;
  *)
    echo "usage: $0 [start|stop|restart|logs|url]" >&2
    exit 1
    ;;
esac
