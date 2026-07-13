#!/bin/bash
set -euo pipefail

# Install dependencies at the start of a Claude Code on the web session so tests,
# linters and the MCP server work out of the box. Web-only: local sessions manage
# their own dependencies (and would re-run this on every start with no benefit).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# pnpm ships via Corepack (bundled with Node); enable it if pnpm isn't on PATH.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

# Idempotent and fast when node_modules is already cached; --frozen-lockfile
# keeps the install faithful to the committed pnpm-lock.yaml.
pnpm install --frozen-lockfile
