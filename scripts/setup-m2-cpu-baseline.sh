#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$PWD}"
NODE_MAJOR_MIN="${NODE_MAJOR_MIN:-20}"
ENABLE_REMOTE_LOGIN="${ENABLE_REMOTE_LOGIN:-1}"
INSTALL_HOMEBREW="${INSTALL_HOMEBREW:-1}"
INSTALL_NODE_WITH_BREW="${INSTALL_NODE_WITH_BREW:-1}"
INSTALL_RUSTUP="${INSTALL_RUSTUP:-1}"

log() {
  printf '\n==> %s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This script is for macOS M2/M-series hosts." >&2
    exit 1
  fi
}

ensure_xcode_tools() {
  log "Checking Xcode command line tools"
  if xcode-select -p >/dev/null 2>&1; then
    xcode-select -p
    return
  fi
  echo "Xcode command line tools are missing. Opening installer..."
  xcode-select --install || true
  echo "Re-run this script after the Xcode command line tools finish installing." >&2
  exit 1
}

ensure_homebrew() {
  if have brew; then
    log "Homebrew found"
    brew --version | head -1
    return
  fi
  if [[ "$INSTALL_HOMEBREW" != "1" ]]; then
    echo "Homebrew is missing and INSTALL_HOMEBREW is not 1." >&2
    exit 1
  fi
  log "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_node() {
  log "Checking Node/npm"
  if have node && have npm; then
    local major
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if [[ "$major" -ge "$NODE_MAJOR_MIN" ]]; then
      node -v
      npm -v
      return
    fi
    echo "Node $(node -v) is older than required major $NODE_MAJOR_MIN."
  fi

  if [[ "$INSTALL_NODE_WITH_BREW" != "1" ]]; then
    echo "Node/npm missing or too old and INSTALL_NODE_WITH_BREW is not 1." >&2
    exit 1
  fi
  ensure_homebrew
  brew install node
  node -v
  npm -v
}

ensure_cargo() {
  log "Checking Rust/Cargo"
  if have cargo; then
    cargo --version
    return
  fi
  if [[ "$INSTALL_RUSTUP" != "1" ]]; then
    echo "Cargo is missing and INSTALL_RUSTUP is not 1." >&2
    exit 1
  fi
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
  cargo --version
}

enable_remote_login() {
  if [[ "$ENABLE_REMOTE_LOGIN" != "1" ]]; then
    log "Skipping Remote Login setup"
    return
  fi
  log "Enabling macOS Remote Login (SSH)"
  sudo systemsetup -setremotelogin on
  sudo systemsetup -getremotelogin
}

ensure_repo_deps() {
  log "Checking repo directory"
  cd "$REPO_DIR"
  pwd
  if [[ ! -f package.json || ! -d flight-engine-rs ]]; then
    echo "REPO_DIR must point at the Retirement Calculator repo root." >&2
    echo "Current REPO_DIR: $REPO_DIR" >&2
    exit 1
  fi

  log "Installing npm dependencies if needed"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
}

verify_engine() {
  log "Building normal Rust NAPI addon"
  npm run engine:rust:build:napi

  log "Running calibration"
  npm run test:calibration
}

print_access_info() {
  log "M2 access info"
  echo "hostname: $(hostname)"
  echo "user: $(whoami)"
  echo "wifi_ip_en0: $(ipconfig getifaddr en0 2>/dev/null || true)"
  echo "ethernet_ip_en1: $(ipconfig getifaddr en1 2>/dev/null || true)"
  echo
  echo "Test SSH from another Mac with:"
  echo "  ssh $(whoami)@$(hostname) 'hostname && node -v && cargo --version'"
}

print_benchmark_command() {
  log "Cross-machine validation command"
  cat <<'EOF'
Run this when the M2 is on AC power and quiet:

git status --short
git rev-parse HEAD
hostname
npm run engine:rust:build:napi
npm run test:calibration
npm run perf:cpu-baseline -- \
  --policies 5000 \
  --trials 5000 \
  --repeats 3 \
  --mode parametric \
  --label m2-cross-machine-5000x5000
EOF
}

main() {
  require_macos
  ensure_xcode_tools
  ensure_homebrew
  ensure_node
  ensure_cargo
  enable_remote_login
  ensure_repo_deps
  verify_engine
  print_access_info
  print_benchmark_command
}

main "$@"
