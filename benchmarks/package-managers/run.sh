#!/usr/bin/env bash
#
# Package-manager install benchmark: pnpm (JS) vs pnpm+pacquet (Rust) vs nub.
#
# Measures how long each tool takes to install THIS repository's dependencies
# with a frozen lockfile, across three cache states (cold / warm / repeat).
# Uses `hyperfine` when available (statistical, multi-run); otherwise falls
# back to a simple timing loop so the script still runs anywhere.
#
# Each tool runs in its own isolated copy of the repo with a private
# store/cache, so the real checkout is never touched and tools never share
# caches. Missing or failing tools are recorded as N/A — the run continues.
#
# See README.md for methodology, tuning knobs and caveats.
set -euo pipefail

# --- Locate repo root (two levels up: benchmarks/package-managers/) -----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# --- Tunables (override via env) ---------------------------------------------
# Which tools to benchmark and which cache scenarios to run.
TOOLS="${TOOLS:-pnpm pnpm-rust nub}"
SCENARIOS="${SCENARIOS:-cold warm repeat}"

# Run counts per scenario. Cold hits the network every run, so keep it low.
COLD_RUNS="${COLD_RUNS:-3}"
WARM_RUNS="${WARM_RUNS:-8}"
REPEAT_RUNS="${REPEAT_RUNS:-8}"

# The @pnpm/pacquet config-dependency spec for the pnpm-rust variant. pnpm
# requires the integrity checksum inlined in the version specifier
# ("<version>+<sha512-…>") — a bare version is rejected. Regenerate for another
# version with:  npm view @pnpm/pacquet@<v> dist.integrity
PACQUET_SPEC="${PACQUET_SPEC:-0.11.12+sha512-/1mL6IEu3EiVhGc5vpispCjkmtTlOgLrTOuS4H6qcngoyB5ISHDg8Ops19nPU7vbl3aF2ER8+EVj4nZ4oPw+WA==}"

# Extra args passed to `nub install` (nub is a drop-in; adjust if flags differ).
NUB_INSTALL_ARGS="${NUB_INSTALL_ARGS:---frozen-lockfile --ignore-scripts}"

# Output + scratch locations.
OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/results}"
WORKDIR="${WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/pm-bench.XXXXXX")}"
KEEP_WORKDIR="${KEEP_WORKDIR:-0}"

mkdir -p "$OUT_DIR"
: > "$OUT_DIR/manifest.jsonl"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

cleanup() {
  if [ "$KEEP_WORKDIR" != "1" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

# --- Benchmark engine detection ----------------------------------------------
USE_HYPERFINE=1
if ! command -v hyperfine >/dev/null 2>&1; then
  USE_HYPERFINE=0
  warn "hyperfine not found — falling back to a simple timing loop."
  warn "For statistically robust numbers install it: https://github.com/sharkdp/hyperfine"
fi

# --- Per-tool metadata --------------------------------------------------------
# engine label + the human-facing "how it installs" note, keyed by tool slug.
engine_label() {
  case "$1" in
    pnpm) echo "pnpm (JS/TS engine)" ;;
    pnpm-rust) echo "pnpm + pacquet (Rust engine)" ;;
    nub) echo "nub (Rust)" ;;
    *) echo "$1" ;;
  esac
}

# Is the tool available on this machine? (pnpm-rust just needs pnpm.)
tool_available() {
  case "$1" in
    pnpm | pnpm-rust) command -v pnpm >/dev/null 2>&1 ;;
    nub) command -v nub >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# --- Prepare an isolated repo copy + private store/cache for a tool ----------
# Layout: $WORKDIR/<tool>/{repo,store,cache,home}
setup_tool_dir() {
  local tool="$1"
  local tdir="$WORKDIR/$tool"
  rm -rf "$tdir"
  mkdir -p "$tdir/repo" "$tdir/store" "$tdir/cache" "$tdir/home"

  # Copy only what install needs — a full repo copy is unnecessary and slow.
  # Strip the "scripts" field: this benchmark measures resolve+fetch+link, not
  # the project's build. Without it the repo's `prepare` (tsdown) would run and
  # fail (no src/ in the copy). Dropping scripts doesn't affect a frozen install
  # (the lockfile integrity is over dependencies, not the scripts field).
  node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1]));delete p.scripts;fs.writeFileSync(process.argv[2],JSON.stringify(p,null,2))' \
    "$REPO_ROOT/package.json" "$tdir/repo/package.json"
  cp "$REPO_ROOT/pnpm-lock.yaml" "$tdir/repo/"
  cp "$REPO_ROOT/pnpm-workspace.yaml" "$tdir/repo/" 2>/dev/null || true
  [ -f "$REPO_ROOT/.npmrc" ] && cp "$REPO_ROOT/.npmrc" "$tdir/repo/"
  [ -f "$REPO_ROOT/.nvmrc" ] && cp "$REPO_ROOT/.nvmrc" "$tdir/repo/"

  # pnpm-rust: enable the pacquet Rust engine for --frozen-lockfile installs by
  # adding it to configDependencies (see pnpm 11.2 release notes / issue #11723).
  # The integrity is inlined in PACQUET_SPEC, so a frozen install accepts it
  # directly — no lockfile edit needed.
  if [ "$tool" = "pnpm-rust" ]; then
    {
      echo ""
      echo "configDependencies:"
      echo "  \"@pnpm/pacquet\": \"$PACQUET_SPEC\""
      echo "usePacquet: true"
    } >> "$tdir/repo/pnpm-workspace.yaml"
  fi

  echo "$tdir"
}

# Build the install command for a tool (run from inside its repo copy).
install_cmd() {
  local tool="$1" tdir="$2"
  local store="$tdir/store" cache="$tdir/cache" home="$tdir/home"
  local env_prefix="HOME='$home' XDG_CACHE_HOME='$cache' XDG_CONFIG_HOME='$cache'"
  case "$tool" in
    pnpm)
      # Pure JS/TS baseline: this copy's pnpm-workspace.yaml has no pacquet entry,
      # so the Rust engine never activates — no flag needed.
      echo "$env_prefix pnpm install --frozen-lockfile --ignore-scripts --store-dir='$store'"
      ;;
    pnpm-rust)
      echo "$env_prefix pnpm install --frozen-lockfile --ignore-scripts --store-dir='$store'"
      ;;
    nub)
      echo "$env_prefix nub install $NUB_INSTALL_ARGS"
      ;;
  esac
}

# Prepare command run before each timed run, per scenario.
prepare_cmd() {
  local scenario="$1" tdir="$2"
  local store="$tdir/store" cache="$tdir/cache" home="$tdir/home"
  case "$scenario" in
    cold)
      # Wipe everything: fresh fetch + extract + link on every timed run.
      echo "rm -rf node_modules '$store' '$cache' '$home'; mkdir -p '$store' '$cache' '$home'"
      ;;
    warm)
      # Keep the populated store; drop node_modules → measures link/import only.
      echo "rm -rf node_modules"
      ;;
    repeat)
      # Everything present and valid → measures the up-to-date no-op path.
      echo "true"
      ;;
  esac
}

runs_for() {
  case "$1" in
    cold) echo "$COLD_RUNS" ;;
    warm) echo "$WARM_RUNS" ;;
    repeat) echo "$REPEAT_RUNS" ;;
  esac
}

# Warmup runs: cold wants none (each run is the measurement); warm/repeat need
# one to populate the store / node_modules before timing begins.
warmup_for() {
  case "$1" in
    cold) echo 0 ;;
    *) echo 1 ;;
  esac
}

record_manifest() {
  # tool scenario engine status mode file
  printf '{"tool":"%s","scenario":"%s","engine":"%s","status":"%s","mode":"%s","file":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" >> "$OUT_DIR/manifest.jsonl"
}

# --- Prime the lockfile with pacquet (pnpm-rust only) ------------------------
# A --frozen-lockfile install refuses to add a config dependency that isn't yet
# recorded in pnpm-lock.yaml ("Cannot update configDependencies with
# frozen-lockfile because the lockfile is not up to date"). The inline integrity
# in PACQUET_SPEC is accepted, but the entry still has to land in the lockfile
# first. So run ONE non-frozen, non-timed install: it writes @pnpm/pacquet into
# the copy's lockfile and fetches the engine. Every timed frozen run afterwards
# is then valid. Timeout-guarded so a wedged fetch can't hang the whole job.
prime_pacquet_lockfile() {
  local tool="$1" tdir="$2"
  local repo="$tdir/repo" store="$tdir/store" cache="$tdir/cache" home="$tdir/home"
  log "$tool: priming lockfile with @pnpm/pacquet (one-time non-frozen install)…"
  if ( cd "$repo" && HOME="$home" XDG_CACHE_HOME="$cache" XDG_CONFIG_HOME="$cache" \
        timeout "${PACQUET_PRIME_TIMEOUT:-420}" \
        pnpm install --ignore-scripts --store-dir="$store" ) \
        > "$OUT_DIR/pacquet-prime.log" 2>&1; then
    return 0
  fi
  warn "$tool: pacquet prime install failed — last lines:"
  tail -n 20 "$OUT_DIR/pacquet-prime.log" >&2
  return 1
}

# --- Run one (tool, scenario) cell -------------------------------------------
run_cell() {
  local tool="$1" scenario="$2" tdir="$3"
  local engine; engine="$(engine_label "$tool")"
  local repo="$tdir/repo"
  local runs; runs="$(runs_for "$scenario")"
  local warmup; warmup="$(warmup_for "$scenario")"
  local cmd; cmd="$(install_cmd "$tool" "$tdir")"
  local prep; prep="$(prepare_cmd "$scenario" "$tdir")"

  log "$tool / $scenario  (runs=$runs, warmup=$warmup)"

  # Sanity: one throwaway install so a broken tool fails loudly here, not mid-run.
  # Capture output so a failure's reason is visible (printed below + kept on disk).
  local sanity_log="$OUT_DIR/sanity-$tool-$scenario.log"
  if ! ( cd "$repo" && eval "$prep" && eval "$cmd" ) > "$sanity_log" 2>&1; then
    warn "$tool: install failed for scenario '$scenario' — recording N/A. Last lines:"
    tail -n 25 "$sanity_log" >&2
    record_manifest "$tool" "$scenario" "$engine" "failed" "-" "-"
    return 0
  fi

  if [ "$USE_HYPERFINE" = "1" ]; then
    local json="$OUT_DIR/hf-$tool-$scenario.json"
    if ( cd "$repo" && hyperfine \
          --warmup "$warmup" --runs "$runs" \
          --prepare "$prep" \
          --export-json "$json" \
          --command-name "$tool" \
          "$cmd" ) >&2; then
      record_manifest "$tool" "$scenario" "$engine" "ok" "hyperfine" "$(basename "$json")"
    else
      warn "$tool: hyperfine run failed for '$scenario'."
      record_manifest "$tool" "$scenario" "$engine" "failed" "-" "-"
    fi
  else
    # Simple fallback: time N runs with the shell's built-in nanosecond clock.
    local txt="$OUT_DIR/simple-$tool-$scenario.txt"
    : > "$txt"
    local ok=1 i start end
    ( cd "$repo" && eval "$prep" && eval "$cmd" ) >/dev/null 2>&1 || true # warmup
    for ((i = 0; i < runs; i++)); do
      ( cd "$repo" && eval "$prep" ) >/dev/null 2>&1 || true
      start="$(date +%s.%N)"
      if ! ( cd "$repo" && eval "$cmd" ) >/dev/null 2>&1; then ok=0; break; fi
      end="$(date +%s.%N)"
      awk -v s="$start" -v e="$end" 'BEGIN { printf "%.6f\n", e - s }' >> "$txt"
    done
    if [ "$ok" = "1" ]; then
      record_manifest "$tool" "$scenario" "$engine" "ok" "simple" "$(basename "$txt")"
    else
      warn "$tool: simple run failed for '$scenario'."
      record_manifest "$tool" "$scenario" "$engine" "failed" "-" "-"
    fi
  fi
}

# --- Main --------------------------------------------------------------------
log "Repo: $REPO_ROOT"
log "Tools: $TOOLS | Scenarios: $SCENARIOS"
log "Workdir: $WORKDIR | Output: $OUT_DIR"
log "Engine: $([ "$USE_HYPERFINE" = 1 ] && echo hyperfine || echo 'simple timing loop')"

for tool in $TOOLS; do
  if ! tool_available "$tool"; then
    warn "$tool not installed — skipping. (engine: $(engine_label "$tool"))"
    for scenario in $SCENARIOS; do
      record_manifest "$tool" "$scenario" "$(engine_label "$tool")" "missing" "-" "-"
    done
    continue
  fi
  tdir="$(setup_tool_dir "$tool")"
  # pnpm-rust: pacquet must be written into the lockfile before any frozen run.
  if [ "$tool" = "pnpm-rust" ] && ! prime_pacquet_lockfile "$tool" "$tdir"; then
    warn "$tool: skipping all scenarios (pacquet could not be primed)."
    for scenario in $SCENARIOS; do
      record_manifest "$tool" "$scenario" "$(engine_label "$tool")" "failed" "-" "-"
    done
    continue
  fi
  for scenario in $SCENARIOS; do
    run_cell "$tool" "$scenario" "$tdir"
  done
done

log "Aggregating results…"
node "$SCRIPT_DIR/aggregate.mjs" "$OUT_DIR"

log "Done. Results in $OUT_DIR/ (results.md, results.json)."
