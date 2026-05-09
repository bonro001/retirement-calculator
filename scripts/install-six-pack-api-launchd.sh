#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plist_src="$repo_root/deploy/com.robbonner.six-pack-api.plist"
plist_dst="$HOME/Library/LaunchAgents/com.robbonner.six-pack-api.plist"
label="com.robbonner.six-pack-api"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/worker-logs"

if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$plist_dst" || true
fi

cp "$plist_src" "$plist_dst"
launchctl bootstrap "gui/$(id -u)" "$plist_dst"
launchctl kickstart -k "gui/$(id -u)/$label"
launchctl print "gui/$(id -u)/$label" | rg 'state =|working directory =|runs =|last exit code' || true
