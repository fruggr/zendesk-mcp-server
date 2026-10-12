#!/bin/sh
# Keep POSIX sh: Android/Termux has neither /bin/bash nor /usr/bin/env.

# PostToolUse (Edit|Write): lint the one edited file, never the whole tree.
# Claude Code hands the path over as JSON on stdin (`tool_input.file_path`); no
# environment variable carries it. Lint-only with `--skip=types` on purpose:
# docs/decisions/lint-tooling.md. Every exit is 0, so the hook never blocks an edit.

file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file" ] && [ -f "$file" ] || exit 0

# `--write` must not reach outside the repo: an agent can edit any file on disk.
# A symlinked file is skipped and its directory resolved physically (`cd -P`, as
# the kernel would), so neither a link nor `..` can redirect the write.
[ -L "$file" ] && exit 0
# `$(...)` strips trailing newlines, so a directory named `evil<LF>` would be
# checked as one path and handed to Biome as another.
case "$file" in *'
'*) exit 0 ;;
esac
project=$(cd -P "$CLAUDE_PROJECT_DIR" && pwd -P) || exit 0
dir=$(cd -P "$(dirname "$file")" && pwd -P) || exit 0
case "$dir/" in
  "$project"/*) ;;
  *) exit 0 ;;
esac

cd "$project" &&
  node scripts/biome.mjs lint --write --skip=types --no-errors-on-unmatched -- "$dir/${file##*/}"
exit 0
