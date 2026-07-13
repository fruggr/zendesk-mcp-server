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
# version rather than trusting whatever pnpm is on PATH.
#
# Plain install (not --frozen-lockfile): this is a dev bootstrap, so a session
# that adds or bumps a dependency should reconcile the lockfile rather than fail
# the way a frozen/CI install would. Dependency lifecycle scripts are already
# governed by pnpm-workspace.yaml (the `allowBuilds` whitelist + the
# `minimumReleaseAge` cooldown), so we do NOT pass --ignore-scripts — that would
# skip whitelisted builds that packages need to work (e.g. esbuild's native
# binary, which tsx/tsdown depend on).
corepack enable >/dev/null 2>&1 || true
corepack pnpm install
