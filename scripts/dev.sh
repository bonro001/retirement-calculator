#!/usr/bin/env bash
#
# Switch the local vite dev server to a specific worktree (or the
# main repo). Solves the friction where vite anchored to the main
# repo doesn't see edits made on a feature-branch worktree, forcing
# either a merge-and-pull or manual file copies to drive HMR.
#
# Usage:
#   scripts/dev.sh                         # serve from this worktree
#   scripts/dev.sh <worktree-name>         # serve from a sibling worktree
#   scripts/dev.sh main                    # serve from the main repo
#   scripts/dev.sh --status                # show what vite is currently serving
#
# Examples:
#   scripts/dev.sh windfall-growth-and-editor
#   scripts/dev.sh cards-cleanup-and-sim-nav
#
# Implementation:
#   1. Stop whatever's listening on :5173 (vite or otherwise).
#   2. cd into the target directory.
#   3. Start vite in the background, log to /tmp/vite-<target>.log.
#   4. Wait until the port is listening, then print the URL.

set -euo pipefail

PORT=5173
MAIN_REPO="$HOME/Retirenment Calculator"
WORKTREES_ROOT="$MAIN_REPO/.claude/worktrees"

if [[ "${1:-}" == "--status" ]]; then
  # Listening process only — `lsof -ti :PORT` includes both server and
  # connected clients. Filter to LISTEN explicitly via `-sTCP:LISTEN`.
  pid=$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [[ -n "$pid" ]]; then
    cwd=$(lsof -p "$pid" 2>/dev/null | awk '$4 == "cwd" { for (i=9; i<=NF; i++) printf "%s ", $i; print "" }' | sed 's/ *$//')
    echo "vite pid=$pid serving from: $cwd"
  else
    echo "no vite on :$PORT"
  fi
  exit 0
fi

target_arg="${1:-}"
if [[ -z "$target_arg" ]]; then
  # No arg: assume the script's parent dir is the target.
  target_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
elif [[ "$target_arg" == "main" ]]; then
  target_dir="$MAIN_REPO"
else
  target_dir="$WORKTREES_ROOT/$target_arg"
fi

if [[ ! -d "$target_dir" ]]; then
  echo "error: $target_dir is not a directory" >&2
  echo "available worktrees:" >&2
  ls -1 "$WORKTREES_ROOT" 2>/dev/null | sed 's/^/  /' >&2
  exit 1
fi
if [[ ! -f "$target_dir/package.json" ]]; then
  echo "error: $target_dir has no package.json" >&2
  exit 1
fi

# Stop existing vite on :5173 if any.
if pid=$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null | head -1); then
  if [[ -n "$pid" ]]; then
    echo "stopping vite pid=$pid"
    kill "$pid" 2>/dev/null || true
    # Wait up to 5s for the port to free, force-kill if not.
    for _ in 1 2 3 4 5; do
      sleep 1
      if ! lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    done
    if lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
  fi
fi

# Start vite in the target dir, background it, log to /tmp.
log_name="vite-$(basename "$target_dir").log"
log_path="/tmp/$log_name"
echo "starting vite in $target_dir (log: $log_path)"
cd "$target_dir"
nohup npm run dev > "$log_path" 2>&1 &
new_pid=$!
echo "vite pid=$new_pid"

# Wait for the port to come up.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then
    echo "vite is serving from: $target_dir"
    echo "url: http://localhost:$PORT/"
    exit 0
  fi
done
echo "warning: vite did not respond on :$PORT within 10s"
echo "tail of log:"
tail -10 "$log_path" || true
exit 1
