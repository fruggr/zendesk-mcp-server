import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// server.json is a version-controlled file at the repo root (committed, not a
// build artifact). scripts/build-server-json.mjs seeds/validates it from
// package.json; at release only its `version` is synced. These tests read the
// committed manifest, assert it stays consistent with package.json (the single
// source of truth) and the registry schema constraints, and guard against any
// drift between the committed file and what the generator would seed.
import { buildServerJson } from '../../scripts/build-server-json.mjs';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);
const committedServerJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../server.json', import.meta.url)), 'utf8'),
);
const serverJson = committedServerJson;
const npmPackage = serverJson.packages[0];

describe('server.json (version-controlled MCP registry manifest)', () => {
  it('matches what the generator would seed from package.json (no drift)', () => {
    expect(committedServerJson).toEqual(buildServerJson(pkg));
  });

  it('pins the registry server.json schema', () => {
    expect(serverJson.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
  });

  it('derives the server name from package.json#mcpName', () => {
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(serverJson.name).toBe('io.github.fruggr/zendesk-mcp-server');
  });

  it('keeps the committed version in sync with package.json (no drift)', () => {
    expect(serverJson.version).toBe(pkg.version);
    expect(npmPackage.version).toBe(pkg.version);
  });

  it('derives the npm package identifier from package.json', () => {
    expect(npmPackage.registryType).toBe('npm');
    expect(npmPackage.identifier).toBe(pkg.name);
  });

  it('derives the repository pointer and website from package.json', () => {
    expect(serverJson.repository).toEqual({
      url: 'https://github.com/fruggr/zendesk-mcp-server',
      source: 'github',
      // Stable numeric repo id — keeps the registry entry valid across renames.
      id: '1206027556',
    });
    expect(serverJson.websiteUrl).toBe(pkg.homepage);
  });

  it('declares the stdio transport the server speaks', () => {
    expect(npmPackage.transport).toEqual({ type: 'stdio' });
  });

  it('requires package.json#mcpName (registry ownership link)', () => {
    expect(() => buildServerJson({ ...pkg, mcpName: undefined })).toThrow(/mcpName/);
  });

  it('keeps the description within the registry limit', () => {
    expect(serverJson.description.length).toBeGreaterThan(0);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
});
