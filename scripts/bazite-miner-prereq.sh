#!/usr/bin/env bash
# One-time Bazite setup for a policy-mining worker.
#
# This keeps the immutable host clean by doing dev-tool setup inside a
# Distrobox container. Re-run safely after updates or if the container is
# recreated.

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-retirement-miner}"
CONTAINER_IMAGE="${CONTAINER_IMAGE:-registry.fedoraproject.org/fedora-toolbox:latest}"
NODE_MAJOR="${NODE_MAJOR:-24}"
NVM_VERSION="${NVM_VERSION:-v0.40.1}"

log() {
  printf '[bazite-miner-prereq] %s\n' "$*"
}

die() {
  printf '[bazite-miner-prereq] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v distrobox >/dev/null 2>&1 || \
  die "distrobox is missing. Bazite normally ships it; install/enable Distrobox first."
command -v podman >/dev/null 2>&1 || \
  die "podman is missing. Bazite normally ships it; install/enable Podman first."

if ! podman container exists "$CONTAINER_NAME" >/dev/null 2>&1; then
  log "creating Distrobox container '$CONTAINER_NAME' from $CONTAINER_IMAGE"
  distrobox create --name "$CONTAINER_NAME" --image "$CONTAINER_IMAGE" --yes
else
  log "container '$CONTAINER_NAME' already exists"
fi

log "installing toolchain inside '$CONTAINER_NAME'"
distrobox enter "$CONTAINER_NAME" -- \
  env NODE_MAJOR="$NODE_MAJOR" NVM_VERSION="$NVM_VERSION" bash -lc '
set -euo pipefail

if command -v sudo >/dev/null 2>&1; then
  SUDO=sudo
else
  SUDO=
fi

$SUDO dnf install -y \
  ca-certificates \
  curl \
  findutils \
  gcc \
  gcc-c++ \
  git \
  gzip \
  make \
  openssl-devel \
  pkgconf-pkg-config \
  procps-ng \
  tar \
  xz

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if ! nvm install "$NODE_MAJOR"; then
  echo "[bazite-miner-prereq] Node $NODE_MAJOR install failed; falling back to Node 23"
  NODE_MAJOR=23
  nvm install "$NODE_MAJOR"
fi
nvm alias default "$NODE_MAJOR"
nvm use "$NODE_MAJOR"

if [ ! -s "$HOME/.cargo/env" ]; then
  curl --proto "=https" --tlsv1.2 -fsSL https://sh.rustup.rs | \
    sh -s -- -y --profile minimal
fi

# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustup default stable

node -v
npm -v
cargo --version
'

mkdir -p "$HOME/bin"
cat > "$HOME/bin/retirement-miner" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-retirement-miner}"
DISPATCHER_URL="${DISPATCHER_URL:-ws://192.168.68.101:8765}"
HOST_DISPLAY_NAME="${HOST_DISPLAY_NAME:-bazite-$(hostname -s)}"
BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-8099}"
NODE_VERSION="${NODE_VERSION:-24}"

DISPATCHER_HOST=$(printf '%s\n' "$DISPATCHER_URL" | sed -E 's|^wss?://([^:/]+).*|\1|')
START_HOST_URL="${START_HOST_URL:-http://$DISPATCHER_HOST:$BOOTSTRAP_PORT/start-host.sh}"
REPO_GIT_URL="${REPO_GIT_URL:-git://$DISPATCHER_HOST/retirement-calculator}"

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
LAUNCHER
chmod +x "$HOME/bin/retirement-miner"

log "done"
log "launcher installed at $HOME/bin/retirement-miner"
log "run it with: $HOME/bin/retirement-miner"
