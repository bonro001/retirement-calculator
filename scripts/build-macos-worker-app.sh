#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="XCAppRunner"
APP_DIR="$ROOT_DIR/dist/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
SWIFT_SRC="$ROOT_DIR/macos/RetirementWorkerStatus/WorkerStatusApp.swift"
INFO_PLIST="$ROOT_DIR/macos/RetirementWorkerStatus/Info.plist"
APP_EXECUTABLE="$MACOS_DIR/XCAppRunner"
WORKER_BIN="$ROOT_DIR/flight-engine-rs/target/release/retirement_worker"

echo "[build-macos-worker-app] building Rust worker"
cargo build --release --manifest-path "$ROOT_DIR/flight-engine-rs/Cargo.toml" --bin retirement_worker

echo "[build-macos-worker-app] creating app bundle"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp "$INFO_PLIST" "$CONTENTS_DIR/Info.plist"
cp "$WORKER_BIN" "$RESOURCES_DIR/retirement_worker"
chmod +x "$RESOURCES_DIR/retirement_worker"

echo "[build-macos-worker-app] compiling Swift menu bar app"
swiftc \
  -O \
  -target "$(swiftc -print-target-info | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["target"]["triple"])')" \
  -framework AppKit \
  "$SWIFT_SRC" \
  -o "$APP_EXECUTABLE"

chmod +x "$APP_EXECUTABLE"

if command -v codesign >/dev/null 2>&1; then
  echo "[build-macos-worker-app] ad-hoc signing app"
  codesign --force --deep --sign - "$APP_DIR" >/dev/null
fi

echo "[build-macos-worker-app] built $APP_DIR"
