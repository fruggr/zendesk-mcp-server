#!/usr/bin/env node
// Seeds/validates the official MCP registry manifest (server.json) and prints it
// to stdout. Unlike before, server.json is now version-controlled at the repo
// root (committed, reviewable) — this generator no longer produces a throwaway
// build artifact. Its role is twofold:
//   - seed: `pnpm build:server-json` (re)writes the committed file when the
//     package.json-derived metadata below changes;
//   - validate: tests assert the committed file equals this output (no drift).
// At release, only the `version` field of the committed file is synced (see
// scripts/sync-server-json-version.mjs), so the release commit stays a clean
// one-line diff and never re-derives metadata.
//
// `package.json` is the single source of truth for everything that already
// lives there (name, npm identifier, version, repository, homepage); only the
// registry/launch metadata that has no other authoritative source is declared
// below.
//
//   node scripts/build-server-json.mjs > server.json   (or: pnpm build:server-json)
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
    // Standalone, <=100 chars (registry limit). Feature-oriented (what the
    // assistant can do), mirroring the README. Distinct from package.json's
    // longer npm description on purpose, so it can't be derived from it.
    description:
      'Draft, translate and update Help Center articles and manage Zendesk tickets from your AI assistant.',
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
