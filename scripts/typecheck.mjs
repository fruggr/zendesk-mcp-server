#!/usr/bin/env node
// Type-checks the project, picking a working `tsc` for the current environment.
//
// TypeScript 7 ships a native (Go) compiler, `tsgo`. Under PRoot's
// link2symlink extension (Termux proot-distro on Android), pnpm's hardlinked
// files are really symlinks into a hidden `/.l2s` store, and the kernel leaks
// that store through `/proc` in two places tsgo relies on:
//   1. `readlink(/proc/self/exe)` — the bundled lib.*.d.ts lookup next to the
//      executable resolves to `/.l2s`, so tsgo panics at startup;
//   2. `open(O_PATH)` + `readlink(/proc/self/fd/N)` — tsgo's realpath returns
//      an extensionless `/.l2s/.l2s.<hash>` name for every resolved
//      `.d.ts`/`.d.cts`/`package.json`, collapsing module resolution.
// Node's own JS compilers are immune (glibc realpath walks with the syscalls
// PRoot masks). Full analysis and minimal reproduction:
// https://github.com/dlecan/tsgo-proot-l2s-repro — the durable fix belongs
// upstream (https://github.com/microsoft/typescript-go).
//
// Workaround applied here: on such environments, break the pnpm hardlink of
// every file the native compiler reads (copy-in-place; a standalone copy
// realpaths normally), once per install, then run native TS 7 — ~8x faster
// than the JS fallback on the affected hardware. A marker file under
// node_modules skips the walk until the next `pnpm install` rewrites
// `.modules.yaml`. The pass assumes pnpm's default project-local virtual
// store; with an external `virtual-store-dir` nothing relevant lives under
// node_modules, which the native-binary sentinel below detects, falling back
// to TypeScript 6 (JS, under the `typescript-legacy` alias) — also the
// automatic fallback for any other failure of the pass.
//
// Override the auto-detection with ZENDESK_MCP_TSC=native|legacy. `native` is
// a pure compiler selection with zero filesystem side effects — under PRoot
// it reproduces the raw upstream failure; the un-hardlink pass runs only on
// auto-detection. Retire this shim and the `typescript-legacy` alias once
// tsgo resolves the upstream issue, restoring "typecheck": "tsc --noEmit".

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Detect PRoot's link2symlink layer — the one environment where tsgo needs
// the un-hardlink pass. `PROOT_L2S_DIR` is PRoot's own signal that
// link2symlink is active (set even when the store isn't at the default
// `/.l2s`); the path check is the fallback. Keyed on these, never on arch
// (real arm64 runs native TS 7 fine as-is).
const nativeBroken = () => Boolean(process.env.PROOT_L2S_DIR) || existsSync('/.l2s');

// The pass mutates this package's own node_modules — resolve it from the
// script's location, never from cwd, so a stray invocation from another
// directory cannot rewrite an unrelated project.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files the native compiler reads during a type-check: its own executable
// (`lib/tsc` inside the platform package), every declaration file and package
// manifest, plus plain TS sources (a package may expose `.ts` files as its
// types entry). Any of them still routed through the l2s store would leak its
// `/.l2s` name through tsgo's realpath.
const isTypecheckInput = (name, dir) =>
  name.endsWith('.ts') ||
  name.endsWith('.tsx') ||
  name.endsWith('.cts') ||
  name.endsWith('.mts') ||
  name.endsWith('.json') ||
  (name === 'tsc' && dir.endsWith('/lib'));

// The tmp name is pid-unique so concurrent typecheck runs cannot clobber each
// other's half-written copy; rename() then swaps in a complete file
// atomically either way.
const unshareFile = (path, stat) => {
  const tmp = `${path}.unshare-tmp-${process.pid}`;
  try {
    copyFileSync(path, tmp);
    chmodSync(tmp, stat.mode);
    utimesSync(tmp, stat.atime, stat.mtime);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

// Walk node_modules without following directory symlinks (pnpm's package
// symlinks all point back into `node_modules/.pnpm`, which the walk covers).
//
// Detecting l2s routing: getdents is the one layer PRoot does NOT mask, so an
// l2s-routed file surfaces as a symlink (d_type=DT_LNK) in the directory
// listing even though lstat reports a regular file — regardless of its faked
// hardlink count (an orphaned l2s pair reports nlink=1 and still leaks).
// Genuine symlinks (pnpm package links, .bin shims) stay symlinks under lstat
// and are left alone. A plain regular file with nlink > 1 is also copied — a
// best-effort net for filesystems that report no d_type (where orphaned l2s
// pairs are indistinguishable from regular files and can be missed).
const unshareTree = (root) => {
  let count = 0;
  let sawNativeTsc = false;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.name.includes('.unshare-tmp-')) {
        // Leftover from a crashed earlier pass.
        rmSync(path, { force: true });
      } else if (isTypecheckInput(entry.name, dir)) {
        if (entry.name === 'tsc') {
          sawNativeTsc = true;
        }
        const stat = lstatSync(path);
        if (stat.isFile() && (!entry.isFile() || stat.nlink > 1)) {
          unshareFile(path, stat);
          count += 1;
        }
      }
    }
  }
  return { count, sawNativeTsc };
};

// One-off per install: `pnpm install` rewrites `.modules.yaml`, which
// invalidates the marker and re-triggers the walk (new files come back
// hardlinked from the store). The marker is back-stamped to the walk's START
// time and equality counts as stale, so an install racing the walk still
// invalidates it.
const ensureUnshared = () => {
  const nodeModules = join(packageRoot, 'node_modules');
  const marker = join(nodeModules, '.tsgo-unshared');
  const modulesState = join(nodeModules, '.modules.yaml');
  if (
    existsSync(marker) &&
    (!existsSync(modulesState) || statSync(modulesState).mtimeMs < statSync(marker).mtimeMs)
  ) {
    return;
  }
  console.error(
    '[typecheck] PRoot link2symlink detected; un-hardlinking type-check inputs (one-off per install)',
  );
  const started = new Date();
  const { count, sawNativeTsc } = unshareTree(nodeModules);
  if (!sawNativeTsc) {
    throw new Error(
      `no native tsc binary under ${nodeModules} — unsupported layout (external pnpm virtual-store-dir?)`,
    );
  }
  writeFileSync(marker, `${started.toISOString()}\n`);
  utimesSync(marker, started, started);
  console.error(
    `[typecheck] un-hardlinked ${count} files in ${((Date.now() - started.getTime()) / 1000).toFixed(1)}s`,
  );
};

let useLegacy = forced === 'legacy';
if (!useLegacy && forced !== 'native' && nativeBroken()) {
  try {
    ensureUnshared();
  } catch (error) {
    console.error(
      `[typecheck] un-hardlink pass failed (${error.message}); falling back to TypeScript 6`,
    );
    useLegacy = true;
  }
}
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
