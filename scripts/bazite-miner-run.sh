#!/usr/bin/env bash
# Start the Bazite policy-mining worker after bazite-miner-prereq.sh has run.

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-retirement-miner}"
DISPATCHER_URL="${DISPATCHER_URL:-ws://192.168.68.101:8765}"
HOST_DISPLAY_NAME="${HOST_DISPLAY_NAME:-bazite-$(hostname -s)}"
BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-8099}"
NODE_VERSION="${NODE_VERSION:-24}"

die() {
  printf '[bazite-miner-run] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v distrobox >/dev/null 2>&1 || die "distrobox is missing"
command -v podman >/dev/null 2>&1 || die "podman is missing"
podman container exists "$CONTAINER_NAME" >/dev/null 2>&1 || \
  die "container '$CONTAINER_NAME' is missing; run bazite-miner-prereq.sh first"

DISPATCHER_HOST=$(printf '%s\n' "$DISPATCHER_URL" | sed -E 's|^wss?://([^:/]+).*|\1|')
START_HOST_URL="${START_HOST_URL:-http://$DISPATCHER_HOST:$BOOTSTRAP_PORT/start-host.sh}"
REPO_GIT_URL="${REPO_GIT_URL:-git://$DISPATCHER_HOST/retirement-calculator}"

printf '[bazite-miner-run] dispatcher: %s\n' "$DISPATCHER_URL"
printf '[bazite-miner-run] host name: %s\n' "$HOST_DISPLAY_NAME"
printf '[bazite-miner-run] start-host: %s\n' "$START_HOST_URL"

exec distrobox enter "$CONTAINER_NAME" -- \
  env \
    DISPATCHER_URL="$DISPATCHER_URL" \
    HOST_DISPLAY_NAME="$HOST_DISPLAY_NAME" \
    NODE_VERSION="$NODE_VERSION" \
    REPO_GIT_URL="$REPO_GIT_URL" \
    START_HOST_URL="$START_HOST_URL" \
    bash -lc '
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use "$NODE_VERSION" >/dev/null 2>&1 || nvm use 23 >/dev/null 2>&1 || true
fi

if [ -s "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

curl -fsSL "$START_HOST_URL" -o /tmp/retirement-start-host.sh
chmod +x /tmp/retirement-start-host.sh
exec /tmp/retirement-start-host.sh
'
