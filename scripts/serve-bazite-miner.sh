#!/usr/bin/env bash
# Run on the dispatcher Mac. Starts the LAN git source, starts the
# dispatcher if needed, and serves the tiny Bazite bootstrap scripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HTTP_PORT="${HTTP_PORT:-8099}"
DISPATCHER_PORT="${DISPATCHER_PORT:-8765}"
HOST_IP="${HOST_IP:-}"
LOG_DIR="$REPO_DIR/out/bazite-miner"

pick_ip() {
  if [ -n "$HOST_IP" ]; then
    printf '%s\n' "$HOST_IP"
    return
  fi

  if command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr en0 2>/dev/null && return
    ipconfig getifaddr en1 2>/dev/null && return
  fi

  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk "{print \$1; exit}" && return
  fi

  printf '127.0.0.1\n'
}

host_ip="$(pick_ip)"
mkdir -p "$LOG_DIR"

bash "$SCRIPT_DIR/start-dispatcher-git-daemon.sh"

dispatcher_running=0
if command -v lsof >/dev/null 2>&1; then
  if lsof -tiTCP:"$DISPATCHER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    dispatcher_running=1
  fi
fi

if [ "$dispatcher_running" -eq 0 ]; then
  echo "[serve-bazite-miner] starting dispatcher on :$DISPATCHER_PORT"
  (
    cd "$REPO_DIR"
    nohup env DISPATCHER_PORT="$DISPATCHER_PORT" npm run cluster:dispatcher \
      > "$LOG_DIR/dispatcher.log" 2>&1 &
    echo $! > "$LOG_DIR/dispatcher.pid"
  )
  echo "[serve-bazite-miner] dispatcher log: $LOG_DIR/dispatcher.log"
else
  echo "[serve-bazite-miner] dispatcher already listening on :$DISPATCHER_PORT"
fi

cat <<EOF

[serve-bazite-miner] bootstrap server starting on :$HTTP_PORT

On the Bazite box, run:

  curl -fsSL http://$host_ip:$HTTP_PORT/bazite-miner-prereq.sh | DISPATCHER_URL=ws://$host_ip:$DISPATCHER_PORT BOOTSTRAP_PORT=$HTTP_PORT bash
  curl -fsSL http://$host_ip:$HTTP_PORT/bazite-miner-run.sh | DISPATCHER_URL=ws://$host_ip:$DISPATCHER_PORT BOOTSTRAP_PORT=$HTTP_PORT bash

After prereqs, you can restart it later with:

  DISPATCHER_URL=ws://$host_ip:$DISPATCHER_PORT BOOTSTRAP_PORT=$HTTP_PORT ~/bin/retirement-miner

Dispatcher URL used by default:

  ws://$host_ip:$DISPATCHER_PORT

EOF

exec python3 -m http.server "$HTTP_PORT" --bind 0.0.0.0 --directory "$SCRIPT_DIR"
