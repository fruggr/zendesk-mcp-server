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
 *   pnpm tsx scripts/mcp-live.ts list                       # list exposed tools
 *   pnpm tsx scripts/mcp-live.ts call <tool> '<json-params>' # call one tool
 *
 * Anything after `--` is forwarded to the server config parser, so the full CLI
 * surface (`--mode`, `--namespace`, `--read-only`, `--tool`) is available:
 *   pnpm tsx scripts/mcp-live.ts list -- --mode namespace
 *   pnpm tsx scripts/mcp-live.ts call get_current_user '{}' -- --mode all
 *
 * Auth: real Zendesk calls need ZENDESK_SUBDOMAIN + ZENDESK_EMAIL +
 * ZENDESK_API_TOKEN in the environment (API-token / Basic auth). The OAuth flow
 * is intentionally unsupported here because it opens a browser.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildBasicAuthHeader } from '../src/auth/api-token';
import { loadConfig } from '../src/config';
import { createMcpServer } from '../src/server';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const configArgs = sep === -1 ? [] : argv.slice(sep + 1);

const [command, toolName, rawParams] = own;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const config = loadConfig(configArgs);

// Mirror src/index.ts: prefer API-token auth. OAuth is unusable headless, so a
// missing token only errors when a tool actually tries to reach Zendesk —
// `list` and arg validation still work without credentials.
const getToken =
  config.zendeskEmail && config.zendeskApiToken
    ? () => buildBasicAuthHeader(config.zendeskEmail as string, config.zendeskApiToken as string)
    : () =>
        fail(
          'Live calls need ZENDESK_EMAIL + ZENDESK_API_TOKEN (OAuth needs a browser). ' +
            'Set them in the environment, or use `list` which requires no token.',
        );

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

    fail(`Unknown command "${command}". Use "list" or "call".`);
  } finally {
    await client.close();
    await server.close();
  }
};

main().catch((error) => {
  console.error('mcp-live failed:', error);
  process.exit(1);
});
