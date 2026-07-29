#!/usr/bin/env node
// Runs Biome, resolving a binary that works in the current environment.
//
// Native Termux reports `process.platform === 'android'`, which Biome's npm
// packaging has no answer for: its launcher maps the platform onto one of the
// `@biomejs/cli-*` packages and has no android entry, and pnpm would have
// skipped every one of them anyway (each carries its own os/cpu/libc gate).
// The `linux-*-musl` builds are statically linked and run as-is on bionic, so
// on android this fetches the one matching the installed Biome, caches it per
// version outside the project, and execs it. Everywhere else it hands off to
// Biome's own launcher, unchanged.
//
// Every Biome caller in this repo goes through here — keep it that way when
// adding one. `--print-binary` prints the resolved path instead of running
// Biome, for callers that need the binary itself: `scripts/bench-lint-tooling.mjs`
// times it (measuring this wrapper would add a Node start-up to every sample),
// and it is how to set `BIOME_BINARY` for something that bypasses this file
// entirely, such as an IDE extension or an ad-hoc `pnpm exec biome`.
//
// Why the fix is here and not in pnpm's install config, and what the android
// path costs: `docs/decisions/biome-on-android.md`. Retire that path once
// Biome publishes an android build.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { constants, homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const require = createRequire(import.meta.url);

// Resolved through the manifest (always exported) rather than a hardcoded
// path, so this holds whatever the node_modules layout is.
const manifestPath = require.resolve('@biomejs/biome/package.json');
const launcher = join(dirname(manifestPath), 'bin', 'biome');

// musl only: the glibc builds have no interpreter to load on bionic.
const MUSL_PACKAGES = {
  arm64: '@biomejs/cli-linux-arm64-musl',
  x64: '@biomejs/cli-linux-x64-musl',
};

// npm's and tar's own chatter would only add noise; their failures surface
// through stderr and the message in `androidBinary`.
const CHILD_STDIO = ['ignore', 'ignore', 'inherit'];

// `npm pack` rather than a hand-rolled download: npm validates the tarball
// against the registry manifest and honors whatever registry, proxy or auth
// config is already in place. `tar` is Termux-provided; this runs on android
// only, so neither is a new dependency for anyone else.
const fetchBinary = (packageName, version, binary) => {
  console.error(
    `[biome] fetching ${packageName}@${version} for android-${process.arch} (once per version)`,
  );
  const parent = dirname(binary);
  mkdirSync(parent, { recursive: true });
  // Staging beside the final path keeps the rename on one filesystem, so the
  // binary appears atomically: a concurrent run sees either nothing or the
  // complete 56 MB, never a partial write.
  const staging = mkdtempSync(join(parent, '.staging-'));
  try {
    // `--loglevel=warn` drops npm's notices (shasum, file count) but keeps
    // warnings and errors.
    execFileSync(
      'npm',
      ['pack', `${packageName}@${version}`, '--pack-destination', staging, '--loglevel=warn'],
      { stdio: CHILD_STDIO },
    );
    const tarball = readdirSync(staging).find((entry) => entry.endsWith('.tgz'));
    if (!tarball) {
      throw new Error('npm pack produced no tarball');
    }
    execFileSync('tar', ['-xzf', join(staging, tarball), '-C', staging, 'package/biome'], {
      stdio: CHILD_STDIO,
    });
    const extracted = join(staging, 'package', 'biome');
    chmodSync(extracted, 0o755);
    renameSync(extracted, binary);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

const androidBinary = () => {
  const { version } = require(manifestPath);
  const packageName = MUSL_PACKAGES[process.arch];
  if (!packageName) {
    console.error(
      `[biome] no musl build for android-${process.arch}; point BIOME_BINARY at a Biome ${version} binary`,
    );
    process.exit(1);
  }
  // Keyed by version and arch: a Renovate bump fetches its own binary on the
  // next run, and a stale one is never silently reused. Under XDG_CACHE_HOME
  // rather than node_modules, so `pnpm install` does not evict it.
  const binary = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'zendesk-mcp-server',
    'biome',
    `${version}-${process.arch}`,
    'biome',
  );
  if (!existsSync(binary)) {
    try {
      fetchBinary(packageName, version, binary);
    } catch (error) {
      console.error(`[biome] could not fetch ${packageName}@${version}: ${error.message}`);
      console.error(
        `[biome] to do it by hand: npm pack ${packageName}@${version}, extract package/biome to ${binary} (chmod +x) — or point BIOME_BINARY at a Biome ${version} binary`,
      );
      process.exit(1);
    }
  }
  return binary;
};

// android is the only platform that needs resolving; elsewhere the launcher
// does it, and a BIOME_BINARY already in the environment wins everywhere.
const binaryPath = () => {
  if (process.env.BIOME_BINARY) {
    return process.env.BIOME_BINARY;
  }
  return process.platform === 'android' ? androidBinary() : launcher;
};

if (args[0] === '--print-binary') {
  console.log(binaryPath());
  process.exit(0);
}

if (process.platform === 'android' && !process.env.BIOME_BINARY) {
  // Exec the binary directly instead of handing the launcher a BIOME_BINARY:
  // it saves a Node start-up on a path that runs on every file edit. What the
  // launcher would have set is reproduced here — Biome reads it for its own
  // diagnostics, and `npm_config_user_agent`'s first field is the package
  // manager, same as upstream's detection.
  const packageManager = process.env.npm_config_user_agent?.split(' ')[0];
  const env = {
    ...process.env,
    BIOME_DISTRIBUTION: 'npm',
    JS_RUNTIME_VERSION: process.version,
    JS_RUNTIME_NAME: process.release.name,
    ...(packageManager ? { NODE_PACKAGE_MANAGER: packageManager } : {}),
  };
  try {
    execFileSync(androidBinary(), args, { stdio: 'inherit', env });
  } catch (error) {
    // Propagate exactly what Biome did: a lint violation is a numeric status
    // (CI depends on it), a killed process is 128+signal per shell convention,
    // and anything else is this wrapper failing rather than Biome reporting.
    if (typeof error.status === 'number') {
      process.exit(error.status);
    }
    if (error.signal) {
      const signalNumber = constants.signals[error.signal];
      process.exit(signalNumber ? 128 + signalNumber : 1);
    }
    console.error(`[biome] failed to run Biome: ${error.message}`);
    process.exit(1);
  }
} else {
  // In-process rather than a second Node: the launcher is a CJS script that
  // reads `process.argv.slice(2)` and sets `process.exitCode`, both already
  // correct here, so requiring it runs upstream's own path with one process
  // instead of two.
  try {
    require(launcher);
  } catch (error) {
    console.error(`[biome] failed to run ${launcher}: ${error.message}`);
    process.exit(1);
  }
}
