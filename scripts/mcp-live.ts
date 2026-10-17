#!/usr/bin/env tsx
/**
 * Live driver for the Zendesk MCP server — boots the *current source tree* and
 * talks to it through a real MCP client over an in-memory transport, exactly
 * like `tests/integration` but interactive and against a live config.
 *
 * It does NOT register itself as an MCP server (no `.mcp.json` needed); it is a
 * one-shot client you can run from any branch to exercise tools live.
 *
 * Usage:
 *   pnpm tsx scripts/mcp-live.ts list                       # list exposed tools + resources
 *   pnpm tsx scripts/mcp-live.ts call <tool> '<json-params>' # call one tool
 *   pnpm tsx scripts/mcp-live.ts read <resource-uri>         # read one resource
 *
 * Anything after `--` is forwarded to the server config parser, so the full CLI
 * surface (`--mode`, `--namespace`, `--read-only`, `--tool`) is available:
 *   pnpm tsx scripts/mcp-live.ts list -- --mode namespace
 *   pnpm tsx scripts/mcp-live.ts call get_current_user '{}' -- --mode all
 *   pnpm tsx scripts/mcp-live.ts read zendesk-hc://topology -- --mode all
 *
 * Auth: `list` / schema validation work credential-free. A real `call` or
 * `read` resolves the token itself (`live-auth.ts`): ZENDESK_OAUTH_TOKEN when
 * set, else the token the stdio server persisted on its first sign-in. The
 * caller never handles the token.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig, VALUE_FLAG_NAMES } from '../src/config';
import { createMcpServer } from '../src/server';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const configArgs = sep === -1 ? [] : argv.slice(sep + 1);

const [command, toolName, rawParams] = own;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// `subdomain` is required by the config schema, but `list` and arg validation
// never touch Zendesk — so when no subdomain is provided (env or positional
// arg), fall back to a placeholder. This keeps credential-free inspection
// working; a real `call` still needs a real subdomain + token.
// Skip values that follow a value-taking flag (e.g. `all` in `--mode all`),
// otherwise the placeholder is wrongly skipped. The flag list comes from
// `src/config.ts`, so it cannot drift from the parser's own view of it.
const hasPositionalSubdomain = configArgs.some((arg, i) => {
  if (arg.startsWith('-')) return false;
  const prev = configArgs[i - 1];
  return !(prev && VALUE_FLAG_NAMES.has(prev));
});
if (!process.env['ZENDESK_SUBDOMAIN'] && !hasPositionalSubdomain) {
  process.env['ZENDESK_SUBDOMAIN'] = resolveLiveSubdomain() ?? 'mcp-live-placeholder';
}

const config = loadConfig(configArgs);

// Resolved lazily: `list` and arg validation never need a credential, so a
// missing one only errors when a tool actually reaches Zendesk. Throwing (rather
// than exiting) lets the MCP layer surface a clean tool error.
const tokenSource = resolveLiveToken(config.subdomain);
const getToken = (): Promise<string> => {
  if (tokenSource) return tokenSource.getToken();
  return Promise.reject(new Error(missingTokenHelp(config.subdomain)));
};

const main = async (): Promise<void> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config, getToken);
  await server.connect(serverTransport);

  const client = new Client({ name: 'mcp-live', version: '0.0.0' });
  await client.connect(clientTransport);

  try {
    if (command === 'list' || command === undefined) {
      const { tools } = await client.listTools();
      console.log(`# ${tools.length} tool(s) in "${config.mode}" mode\n`);
      for (const tool of tools) {
        const firstLine = (tool.description ?? '').split('\n')[0];
        console.log(`- ${tool.name}: ${firstLine}`);
      }
      // Resources are only advertised when the server registers at least one
      // (e.g. the topology resource). In tool-only sessions (--no-topology, or a
      // namespace without resources) the capability is absent, so guard the call
      // to keep `list` working everywhere.
      if (client.getServerCapabilities()?.resources) {
        const { resources } = await client.listResources();
        console.log(`\n# ${resources.length} resource(s)\n`);
        for (const resource of resources) {
          console.log(`- ${resource.uri}: ${resource.description ?? resource.name}`);
        }
      }
      return;
    }

    if (command === 'read') {
      const uri = toolName;
      if (!uri) fail('Usage: mcp-live.ts read <resource-uri>');
      const result = await client.readResource({ uri: uri as string });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'call') {
      if (!toolName) fail("Usage: mcp-live.ts call <tool> ['<json-params>']");
      let args: Record<string, unknown> = {};
      if (rawParams) {
        try {
          args = JSON.parse(rawParams);
        } catch (error) {
          fail(`Invalid JSON params: ${(error as Error).message}`);
        }
      }
      const result = await client.callTool({ name: toolName as string, arguments: args });
      console.log(JSON.stringify(result, null, 2));
      if (result.isError) process.exitCode = 1;
      return;
    }

    fail(`Unknown command "${command}". Use "list", "call" or "read".`);
  } finally {
    await client.close();
    await server.close();
    tokenSource?.dispose();
  }
};

main().catch((error) => {
  console.error('mcp-live failed:', error);
  process.exit(1);
});
