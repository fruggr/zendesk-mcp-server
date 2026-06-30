import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// server.json is a generated artifact (not committed) — see
// scripts/build-server-json.mjs. These tests run the generator against the real
// package.json and assert the manifest it produces stays consistent with that
// source of truth and the registry schema constraints.
import { buildServerJson } from '../../scripts/build-server-json.mjs';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);
const serverJson = buildServerJson(pkg);
const npmPackage = serverJson.packages[0];

describe('server.json (generated MCP registry manifest)', () => {
  it('pins the registry server.json schema', () => {
    expect(serverJson.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
  });

  it('derives the server name from package.json#mcpName', () => {
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(serverJson.name).toBe('io.github.fruggr/zendesk-mcp-server');
  });

  it('derives the npm package identifier and version from package.json', () => {
    expect(npmPackage.registryType).toBe('npm');
    expect(npmPackage.identifier).toBe(pkg.name);
    expect(serverJson.version).toBe(pkg.version);
    expect(npmPackage.version).toBe(pkg.version);
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
