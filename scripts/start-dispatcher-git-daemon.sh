#!/usr/bin/env bash
# Run once on the dispatcher box to expose its retirement-calculator
# repo to LAN workers via git://. Workers' bootstrap scripts pull from
# this LAN URL by default (derived from DISPATCHER_URL), so feature
# branches that haven't been pushed to GitHub can still reach workers,
# and the GitHub round-trip is replaced with LAN latency.
#
# Idempotent — safe to re-run. Stops any prior daemon and relaunches.
# Daemon stays up until reboot; for persistence across reboots, wrap
# in launchd (mac) / systemd (linux).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PORT="${GIT_DAEMON_PORT:-9418}"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[start-dispatcher-git-daemon] no repo at $REPO_DIR — clone first" >&2
  exit 1
fi

# Allow git-daemon to serve this repo. Without the marker file, the
# daemon refuses to export non-bare repos even with --export-all on
# its own working tree.
touch "$REPO_DIR/.git/git-daemon-export-ok"

# Stop any previously-running daemon on this port so relaunch is clean.
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN || true)"
  if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null || true
  fi
fi
pkill -f "git daemon.*--port=$PORT" 2>/dev/null || true
sleep 1

# Serve this repo at the stable worker URL
# git://<dispatcher-ip>/retirement-calculator, even if the local folder
# name differs. --reuseaddr lets us restart without waiting for socket
# TIME_WAIT. --detach forks.
git daemon \
  --interpolated-path="$REPO_DIR" \
  --export-all \
  --reuseaddr \
  --detach \
  --listen=0.0.0.0 \
  --port="$PORT"

echo "[start-dispatcher-git-daemon] listening on 0.0.0.0:$PORT"
echo "[start-dispatcher-git-daemon] serving repo: $REPO_DIR"
echo "[start-dispatcher-git-daemon] workers can now pull from git://<this-host>/retirement-calculator"
