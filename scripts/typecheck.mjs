#!/usr/bin/env node
// Type-checks the project, picking a working `tsc` for the current environment.
//
// TypeScript 7 ships a native (Go) compiler, `tsgo`, that locates its bundled
// lib.*.d.ts relative to itself via os.Executable() (/proc/self/exe). Under
// PRoot / Termux, pnpm's hardlinked store binary is routed through the
// link2symlink store (/.l2s), so that resolution breaks and tsgo is
// non-functional (it panics, or silently loads no libs). Root cause and fix
// belong upstream: https://github.com/microsoft/typescript-go
//
// On such environments we fall back to the JS-based TypeScript 6, installed
// under the `typescript-legacy` alias. Everywhere else — CI, x86, genuine
// arm64 (Apple silicon, Graviton) — the fast native TS 7 is used. Because the
// two are different compilers, CI (native TS 7) stays the source of truth; a
// local TS 6 pass is a close pre-check, not a guarantee.
//
// Override the auto-detection with ZENDESK_MCP_TSC=native|legacy.
// Retire this shim and the `typescript-legacy` alias once tsgo resolves the
// upstream issue, restoring "typecheck": "tsc --noEmit".

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';

// Explicit override, normalized so casing/whitespace variants ("Native",
// "legacy\n") are honored. An unrecognized value warns and falls through to
// auto-detection rather than being silently ignored.
const rawForced = process.env.ZENDESK_MCP_TSC;
const forced = rawForced?.trim().toLowerCase();
if (rawForced && forced !== 'native' && forced !== 'legacy') {
  console.error(
    `[typecheck] ignoring unrecognized ZENDESK_MCP_TSC=${JSON.stringify(rawForced)} (expected "native" or "legacy"); auto-detecting`,
  );
}

// Detect PRoot's link2symlink layer — the one environment where tsgo mislocates
// its libs. `PROOT_L2S_DIR` is PRoot's own signal that link2symlink is active
// (set even when the store isn't at the default `/.l2s`); the path check is the
// fallback. Keyed on these, never on arch (real arm64 runs native TS 7 fine).
const nativeBroken = () => Boolean(process.env.PROOT_L2S_DIR) || existsSync('/.l2s');

const useLegacy = forced === 'legacy' || (forced !== 'native' && nativeBroken());
const pkg = useLegacy ? 'typescript-legacy' : 'typescript';

console.error(`[typecheck] ${useLegacy ? 'TypeScript 6 (JS fallback)' : 'TypeScript 7 (native)'}`);

try {
  // Resolve the chosen compiler by package name (via its always-exported
  // package.json) so this works regardless of node_modules layout. Both
  // packages ship a JS `bin/tsc` shim, so both are launched through Node.
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'tsc');
  execFileSync(process.execPath, [bin, '--noEmit', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
} catch (error) {
  // A non-zero tsc run (type errors) throws with a numeric status — propagate
  // it. A signal-killed tsc (e.g. OOM -> SIGKILL) is surfaced as 128+signal,
  // matching shell convention, so a CI orchestrator can tell it from a real
  // type error. Anything else (unresolved package, failed spawn) is a wrapper
  // failure: report it instead of a bare exit 1.
  if (typeof error.status === 'number') {
    process.exit(error.status);
  }
  if (error.signal) {
    const signalNumber = constants.signals[error.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }
  console.error(`[typecheck] failed to run ${pkg}'s tsc: ${error.message}`);
  process.exit(1);
}
