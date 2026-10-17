#!/usr/bin/env bash
# Starts a throwaway editor instance (own profile, no other extensions) with
# Lookout in development mode and runs dev/integration.cjs against a fake
# Claude Code folder (CLAUDE_CONFIG_DIR), so the real ~/.claude is untouched.
# Usage: dev/run-integration.sh <work-dir>
# TG_APP picks the editor (default: Antigravity IDE).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$1"
APP="${TG_APP:-/Applications/Antigravity IDE.app}"
mkdir -p "$WORK/user-data" "$WORK/extensions" "$WORK/workspace" "$WORK/workspace2" "$WORK/claude/sessions"
echo '{ "model": "opus", "statusLine": { "type": "command", "command": "printf mine" } }' > "$WORK/claude/settings.json"
export TG_OUT="$WORK/result.txt"
: > "$TG_OUT"
# VS Code keeps its IPC socket in the user data dir, and a socket path may not
# be longer than 103 characters on macOS: a short link keeps long work dirs usable.
LINK_DIR="$(mktemp -d)"
trap 'rm -rf "$LINK_DIR"' EXIT
ln -s "$WORK/user-data" "$LINK_DIR/u"
# -g keeps the window in the background so it does not take focus.
open -g -n -W -a "$APP" --env TG_OUT="$TG_OUT" --env CLAUDE_CONFIG_DIR="$WORK/claude" --env TG_WORK="$WORK" --env TG_HOLD_MS="${TG_HOLD_MS:-0}" --args \
  --user-data-dir="$LINK_DIR/u" \
  --extensions-dir="$WORK/extensions" \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-welcome \
  --skip-release-notes \
  --extensionDevelopmentPath="$ROOT" \
  --extensionTestsPath="$ROOT/dev/integration.cjs" \
  "$WORK/workspace" || true
cat "$TG_OUT"
! grep -q '^FAIL' "$TG_OUT"
