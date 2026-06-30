#!/usr/bin/env node
// Generates the official MCP registry manifest (server.json) and prints it to
// stdout. `package.json` is the single source of truth for everything that
// already lives there (name, npm identifier, version, repository, homepage);
// only the registry/launch metadata that has no other authoritative source is
// declared below. server.json is a build artifact — never hand-edit it.
//
//   node scripts/build-server-json.mjs > server.json
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

/**
 * Builds the server.json object from package.json plus the MCP-specific fields.
 * Exported so tests can assert the manifest without shelling out.
 */
export function buildServerJson(packageJson) {
  if (!packageJson.mcpName) {
    throw new Error('package.json is missing "mcpName" (the MCP registry server name)');
  }
  // git+https://github.com/owner/repo.git -> https://github.com/owner/repo
  const repositoryUrl = packageJson.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: packageJson.mcpName,
    // Standalone, <=100 chars (registry limit). Distinct from package.json's
    // longer npm description on purpose, so it can't be derived from it.
    description:
      'Zendesk Support & Help Center MCP server with per-user OAuth 2.1 PKCE authentication.',
    version: packageJson.version,
    repository: {
      url: repositoryUrl,
      source: 'github',
      // Stable numeric repo id — keeps the registry entry valid across renames.
      id: '1206027556',
    },
    websiteUrl: packageJson.homepage,
    packages: [
      {
        registryType: 'npm',
        registryBaseUrl: 'https://registry.npmjs.org',
        identifier: packageJson.name,
        version: packageJson.version,
        runtimeHint: 'npx',
        transport: { type: 'stdio' },
        packageArguments: [
          {
            type: 'positional',
            valueHint: 'subdomain',
            description:
              'Zendesk subdomain (the <subdomain> in https://<subdomain>.zendesk.com). Alternatively set ZENDESK_SUBDOMAIN.',
            isRequired: true,
          },
        ],
        environmentVariables: [
          {
            name: 'ZENDESK_SUBDOMAIN',
            description: 'Zendesk subdomain, used when no positional subdomain argument is given.',
            isRequired: false,
          },
        ],
      },
    ],
  };
}

// Only emit when run directly, not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(buildServerJson(pkg), null, 2)}\n`);
}
