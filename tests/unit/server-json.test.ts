import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `server.json` is the manifest published to the official MCP registry
// (registry.modelcontextprotocol.io). It is hand-maintained, so these checks
// guard against it silently drifting away from `package.json`. The release
// pipeline overwrites the manifest's `version` from the freshly released
// version before publishing, so version equality is intentionally NOT asserted
// here — see docs/release-automation.md.
const readJson = (relative: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8'));

const serverJson = readJson('server.json');
const packageJson = readJson('package.json');
const npmPackage = serverJson.packages[0];

describe('server.json (MCP registry manifest)', () => {
  it('pins the registry server.json schema', () => {
    expect(serverJson.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
  });

  it('uses the GitHub-authenticated namespace for the fruggr org', () => {
    expect(serverJson.name).toBe('io.github.fruggr/zendesk-mcp-server');
  });

  it('proves npm ownership: package.json#mcpName matches the registry name', () => {
    expect(packageJson.mcpName).toBe(serverJson.name);
  });

  it('advertises the npm package this repo actually publishes', () => {
    expect(npmPackage.registryType).toBe('npm');
    expect(npmPackage.identifier).toBe(packageJson.name);
  });

  it('declares the stdio transport the server speaks', () => {
    expect(npmPackage.transport).toEqual({ type: 'stdio' });
  });

  it('points at this repository', () => {
    expect(serverJson.repository).toEqual({
      url: 'https://github.com/fruggr/zendesk-mcp-server',
      source: 'github',
      // Stable numeric repo id — keeps the registry entry valid if the repo is
      // ever renamed or recreated.
      id: '1206027556',
    });
  });

  it('keeps the description within the registry limit', () => {
    expect(serverJson.description.length).toBeGreaterThan(0);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
});
