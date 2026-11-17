#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TAURI_TARGET:-}"

if [[ -z "$TARGET" ]]; then
  case "$(uname -m)" in
    arm64) TARGET="aarch64-apple-darwin" ;;
    x86_64) TARGET="x86_64-apple-darwin" ;;
    *)
      echo "不支持的 macOS 架构: $(uname -m)" >&2
      exit 2
      ;;
  esac
fi

APP_BUNDLE="$ROOT_DIR/src-tauri/target/$TARGET/release/bundle/macos/Antigravity++.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/antigravityplusplus"
PROCESS_NAME="antigravityplusplus"

build_app() {
  cd "$ROOT_DIR"
  npm run check
  node scripts/prepare-tauri.cjs "$TARGET"
  npx --yes @tauri-apps/cli@2 build --target "$TARGET" --bundles app
}

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  build|--build)
    build_app
    ;;
  run)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    build_app
    open_app
    ;;
  --debug|debug)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    build_app
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    build_app
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$PROCESS_NAME\""
    ;;
  --telemetry|telemetry)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    build_app
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"com.antigravityplusplus.launcher.tauri\""
    ;;
  --verify|verify)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    build_app
    open_app
    sleep 1
    pgrep -x "$PROCESS_NAME" >/dev/null
    ;;
  *)
    echo "用法: $0 [build|run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
