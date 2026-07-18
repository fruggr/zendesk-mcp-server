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
// arm64 (Apple silicon, Graviton) — the fast native TS 7 is used.
//
// Override the auto-detection with ZENDESK_MCP_TSC=native|legacy.
// Retire this shim and the `typescript-legacy` alias once tsgo resolves the
// upstream issue, restoring "typecheck": "tsc --noEmit".

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const forced = process.env.ZENDESK_MCP_TSC; // "native" | "legacy" | undefined

// PRoot's link2symlink store — the one environment where tsgo mislocates its
// libs. Keyed on this marker, never on arch (real arm64 runs native TS 7 fine).
const nativeBroken = () => existsSync('/.l2s');

const useLegacy = forced === 'legacy' || (forced !== 'native' && nativeBroken());

// Resolve the chosen compiler by package name (via its always-exported
// package.json) so this works regardless of the node_modules layout. Both
// packages must be addressed by name — each declares its bin as `tsc`.
const require = createRequire(import.meta.url);
const pkg = useLegacy ? 'typescript-legacy' : 'typescript';
const bin = join(dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'tsc');

console.error(`[typecheck] ${useLegacy ? 'TypeScript 6 (JS fallback)' : 'TypeScript 7 (native)'}`);

try {
  execFileSync(process.execPath, [bin, '--noEmit', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
} catch (error) {
  process.exit(typeof error.status === 'number' ? error.status : 1);
}
