#!/bin/bash
set -euo pipefail

# Install dependencies at the start of a Claude Code on the web session so tests,
# linters and the MCP server work out of the box. Web-only: local sessions manage
# their own dependencies (and would re-run this on every start with no benefit).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# pnpm is pinned via package.json "packageManager"; Corepack selects that exact
# version rather than trusting whatever pnpm happens to be on PATH.
#
# --ignore-scripts: install dependencies only, never run lifecycle scripts. This
# deliberately skips the repo's own `prepare` (which builds via tsdown) and any
# dependency install scripts, so a session start never executes branch or
# package code — the dev/test loop runs from source via tsx, and CI builds
# separately. It also keeps the hook cheap when node_modules is already cached.
corepack enable >/dev/null 2>&1 || true
corepack pnpm install --frozen-lockfile --ignore-scripts
