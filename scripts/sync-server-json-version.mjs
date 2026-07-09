#!/usr/bin/env node
// Syncs ONLY the `version` fields of the committed server.json to a target
// version, preserving every other field byte-for-byte. Run by semantic-release
// (@semantic-release/exec `prepareCmd`) during a release so the committed
// manifest tracks package.json with zero drift and the release commit carries a
// clean one-line version diff — without re-deriving metadata from scratch.
//
// The target version comes from argv (semantic-release passes
// ${nextRelease.version}); it falls back to package.json's version, which
// @semantic-release/npm has already bumped in the working tree by the time this
// runs.
//
//   node scripts/sync-server-json-version.mjs [version]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverJsonPath = fileURLToPath(new URL('../server.json', import.meta.url));
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

const version = process.argv[2] ?? JSON.parse(readFileSync(pkgPath, 'utf8')).version;
if (!version) {
  throw new Error('No version to sync: pass it as an argument or set package.json#version');
}

const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8'));
serverJson.version = version;
if (Array.isArray(serverJson.packages)) {
  for (const pkg of serverJson.packages) {
    pkg.version = version;
  }
}

writeFileSync(serverJsonPath, `${JSON.stringify(serverJson, null, 2)}\n`);
process.stdout.write(`Synced server.json version to ${version}\n`);
