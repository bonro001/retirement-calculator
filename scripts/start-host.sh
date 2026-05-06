#!/usr/bin/env bash
# Worker setup + start script for macOS / Linux cluster hosts.
#
# Idempotent. Safe to re-run any time to bring this host current with
# main, rebuild Rust, and (re)start the host process. Replaces the
# multi-line copy-paste dance and encodes the lessons learned:
#   - Use `npm ci` instead of `npm install` so the lockfile stays clean
#     (otherwise the cluster panel shows "modified · package-lock.json").
#   - Set up the macOS keychain credential helper so auto-update's git
#     pull doesn't prompt for a Personal Access Token on every fire.
#   - Hard-reset to origin/main to survive divergence (host stuck on a
#     feature branch, dirty tracked files from a prior failed setup).
#   - Pkill anything already running before relaunching.
#
# Prerequisites — install once if missing:
#   - git, node + npm (https://nodejs.org/en/download)
#   - Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
#
# Env overrides:
#   REPO_DIR           where the repo lives (default ~/retirement-calculator)
#   DISPATCHER_URL     ws://host:port (default ws://192.168.68.101:8765)
#   REPO_GIT_URL       git source for clone/fetch (default git://<dispatcher-host>/retirement-calculator,
#                      so workers pull from the dispatcher's git-daemon over LAN
#                      instead of GitHub — see scripts/start-dispatcher-git-daemon.sh)
#   HOST_DISPLAY_NAME  panel label (default node-host-<hostname>)

set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/retirement-calculator}"
DISPATCHER_URL="${DISPATCHER_URL:-ws://192.168.68.101:8765}"
HOST_DISPLAY_NAME="${HOST_DISPLAY_NAME:-node-host-$(hostname -s)}"

# Derive LAN git URL from DISPATCHER_URL host. Override via REPO_GIT_URL
# (e.g. point back at GitHub if the dispatcher's git-daemon is down).
DISPATCHER_HOST=$(echo "$DISPATCHER_URL" | sed -E 's|^wss?://([^:/]+).*|\1|')
REPO_GIT_URL="${REPO_GIT_URL:-git://$DISPATCHER_HOST/retirement-calculator}"

echo "[start-host] dispatcher: $DISPATCHER_URL"
echo "[start-host] display name: $HOST_DISPLAY_NAME"
echo "[start-host] repo: $REPO_DIR"
echo "[start-host] git source: $REPO_GIT_URL"

# Stop anything currently running so the relaunch lands cleanly.
pkill -f "start-rust-host.mjs" 2>/dev/null || true
pkill -f "cluster/host.ts" 2>/dev/null || true
sleep 1

# Clone if the repo isn't already there.
if [ ! -d "$REPO_DIR" ]; then
  echo "[start-host] cloning repo into $REPO_DIR from $REPO_GIT_URL"
  git clone "$REPO_GIT_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"

# Idempotent credential helper setup. Only matters if REPO_GIT_URL is
# overridden back to https://github.com/...; the LAN git:// protocol
# is unauthenticated.
git config --global credential.helper osxkeychain 2>/dev/null || \
  git config --global credential.helper store

# Point origin at the LAN git source. Cheap to do every run; survives
# the case where a worker was originally cloned from GitHub and now
# needs to follow the dispatcher's git-daemon.
git remote set-url origin "$REPO_GIT_URL"

git fetch origin

# Follow the dispatcher's branch instead of hardcoding main, so a
# feature branch (with its own prebuilt napi binary, for example)
# can be tested without merging first. Falls back to main if the
# dispatcher is unreachable or doesn't report a valid branch.
TARGET_BRANCH=$(DISPATCHER_URL="$DISPATCHER_URL" node scripts/dispatcher-branch.mjs 2>/dev/null || echo main)
echo "[start-host] target branch: $TARGET_BRANCH"

# Force-create-or-reset the local branch to origin's tip. `-f`
# discards any local modifications; `-B` recreates the branch from
# origin if it doesn't exist locally. Workers are ephemeral; the
# dispatcher is authoritative.
git checkout -f -B "$TARGET_BRANCH" "origin/$TARGET_BRANCH"

# Prefer `npm ci` (strict, never modifies lockfile). Fall back to
# `npm install` if the lockfile drifted out of sync with package.json
# on main — `npm ci` would otherwise refuse and wedge the worker.
npm ci || npm install

# Provision the Rust napi. Two paths inside the build script:
#   - cargo present: compile from source, publish to flight-engine-rs/prebuilt/
#     so cargo-less workers can pick it up on their next git pull.
#   - cargo absent: copy the committed prebuilt binary into target/release/.
# First-run cold Rust compile is 5-10 minutes; incremental is fast.
npm run engine:rust:build:napi

# Start the host with auto-update enabled. The launcher will check
# main on every welcome / start_session and self-update if behind.
echo "[start-host] launching with auto-update enabled"
DISPATCHER_URL="$DISPATCHER_URL" \
REPO_GIT_URL="$REPO_GIT_URL" \
HOST_DISPLAY_NAME="$HOST_DISPLAY_NAME" \
HOST_AUTO_UPDATE=1 \
exec npm run cluster:host:rust-auto
