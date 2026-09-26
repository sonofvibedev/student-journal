#!/usr/bin/env bash
# Launches codebase-memory-mcp, installing it first if missing.
# Installer output goes to stderr so MCP stdout stays clean.
set -euo pipefail
BIN="$HOME/.local/bin/codebase-memory-mcp"
if [ ! -x "$BIN" ]; then
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh \
    | bash -s -- --skip-config >&2
fi
exec "$BIN" "$@"
