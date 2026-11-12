#!/usr/bin/env node
// Fingerprint of the installed packages that can change a mutation verdict, for
// the baseline cache key (`.github/actions/mutation-baseline/action.yml`):
// the closure of what the suite imports, instead of the whole lockfile.
// `--explain` prints what went into it. Why, and what the weekly cold baseline
// covers that this cannot: docs/decisions/mutation-testing.md, section 4.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Code-unit order, not `localeCompare`: the hash must not depend on the runner's locale.
const byCodeUnit = (a, b) => Number(a > b) - Number(a < b);

/**
 * The runner itself. Stryker loads these by name from `stryker.config.mjs`
 * (`testRunner`, `plugins`), never through an import the scan could find.
 */
const RUNNER_ROOTS = ['@stryker-mutator/core', '@stryker-mutator/vitest-runner', 'vitest'];

/**
 * Not loaded by the suite Stryker runs. Shared with the cache-key test in
 * `tests/unit/mutation-scope.test.ts`, which says why each one is exempt.
 */
export const EXEMPT = new Set(['tests/functional', 'tests/bundle']);

const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
// A loose scan also meets `from '...'` inside strings and comments; keeping only
// what is shaped like a package name drops most of those. The rest are harmless:
// a name that is not installed adds nothing to the closure.
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/.*)?$/;

/** Package names behind the bare specifiers in a source text. */
export const importRoots = (source) => {
  const roots = new Set();
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    if (specifier.startsWith('node:') || !PACKAGE_SPECIFIER.test(specifier)) continue;
    const parts = specifier.split('/');
    roots.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return roots;
};

/**
 * The pnpm store directory names the version, the resolved peers and the patch
 * hash at once; a patched or re-peered package is a different package here.
 */
export const packageIdentity = (name, entry) =>
  /\/\.pnpm\/([^/]+)\/node_modules\//.exec(entry.path ?? '')?.[1] ?? `${name}@${entry.version}`;

const childrenOf = (entry) => ({
  ...entry.dependencies,
  ...entry.optionalDependencies,
  ...entry.devDependencies,
});

/**
 * Sorted identities of the roots and everything they depend on, read from
 * `pnpm list --json --depth Infinity`. pnpm prints each subtree once and marks
 * later copies `deduped`, so edges are collected over the whole tree first.
 */
export const closureOf = (tree, roots) => {
  const edges = new Map();
  const topLevel = new Map();
  const index = (deps, isTop) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      const id = packageIdentity(name, entry);
      if (isTop) topLevel.set(name, id);
      const children = Object.entries(childrenOf(entry)).map(([n, e]) => packageIdentity(n, e));
      if (children.length > 0 || !edges.has(id)) edges.set(id, children);
      index(childrenOf(entry), false);
    }
  };
  index(childrenOf(tree), true);

  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of edges.get(id) ?? []) visit(child);
  };
  for (const root of roots) {
    const id = topLevel.get(root);
    if (id) visit(id);
  }
  return [...seen].sort(byCodeUnit);
};

/**
 * The manifest minus what does not reach a verdict: `version` (rewritten by every
 * release), `packageManager` (every pnpm bump) and the dependency ranges, whose
 * resolved result is the closure.
 */
export const verdictFieldsOf = (manifest) => {
  const { version, packageManager, devDependencies, dependencies, ...kept } = manifest;
  return kept;
};

export const fingerprint = ({ packages, manifest }) =>
  createHash('sha256')
    .update(JSON.stringify({ packages: [...packages].sort(byCodeUnit), manifest }))
    .digest('hex');

const sourcesUnder = (dir) =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (EXEMPT.has(rel)) return [];
    if (entry.isDirectory()) return sourcesUnder(rel);
    return /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [rel] : [];
  });

const collect = () => {
  const files = [
    ...sourcesUnder('src'),
    ...sourcesUnder('tests'),
    'vitest.config.ts',
    'stryker.config.mjs',
  ];
  const roots = new Set(RUNNER_ROOTS);
  for (const file of files) {
    for (const root of importRoots(readFileSync(join(repoRoot, file), 'utf8'))) roots.add(root);
  }
  const [tree] = JSON.parse(
    execFileSync('pnpm', ['list', '--json', '--depth', 'Infinity'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const manifest = verdictFieldsOf(
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')),
  );
  return { roots: [...roots].sort(byCodeUnit), packages: closureOf(tree, roots), manifest };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputs = collect();
  if (process.argv.includes('--explain')) {
    console.log(`roots (${inputs.roots.length}):\n  ${inputs.roots.join('\n  ')}`);
    console.log(`packages (${inputs.packages.length}):\n  ${inputs.packages.join('\n  ')}`);
  }
  console.log(fingerprint(inputs));
}
