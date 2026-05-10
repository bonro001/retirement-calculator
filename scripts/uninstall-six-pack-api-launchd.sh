#!/usr/bin/env bash
set -euo pipefail

plist_dst="$HOME/Library/LaunchAgents/com.robbonner.six-pack-api.plist"
label="com.robbonner.six-pack-api"

if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$plist_dst" || true
fi

rm -f "$plist_dst"
echo "Removed $label"
