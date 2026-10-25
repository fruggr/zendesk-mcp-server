#!/bin/sh
# Keep POSIX sh: Android/Termux has neither /bin/bash nor /usr/bin/env.

# PostToolUse (Edit|Write): lint the one edited file, never the whole tree.
# Claude Code hands the path over as JSON on stdin (`tool_input.file_path`); no
# environment variable carries it. Lint-only with `--skip=types` on purpose:
# docs/decisions/lint-tooling.md. Every exit is 0, so the hook never blocks an edit.

# Newlines are rejected inside jq: `$(...)` strips trailing ones, so a checked
# `x.ts<LF>` or `evil<LF>/x.ts` would reach Biome as another path.
file=$(jq -r '.tool_input.file_path | select(type == "string" and (contains("\n") | not))' 2>/dev/null) || exit 0
[ -n "$file" ] && [ -f "$file" ] || exit 0

# `--write` must not reach outside the repo: an agent can edit any file on disk.
# A symlinked file is skipped and its directory resolved physically (`cd -P`, as
# the kernel would), so neither a link nor `..` can redirect the write.
[ -L "$file" ] && exit 0
project=$(cd -P "$CLAUDE_PROJECT_DIR" && pwd -P) || exit 0
dir=$(cd -P "$(dirname "$file")" && pwd -P) || exit 0
case "$dir/" in
  "$project"/*) ;;
  *) exit 0 ;;
esac

# Biome's own launcher through `node`, not `node_modules/.bin/biome`: that shim is
# a `#!/bin/sh` script, and Android only has /bin/sh where /bin links to /system/bin.
cd "$project" &&
  node node_modules/@biomejs/biome/bin/biome lint --write --skip=types --no-errors-on-unmatched -- "$dir/${file##*/}"
exit 0
