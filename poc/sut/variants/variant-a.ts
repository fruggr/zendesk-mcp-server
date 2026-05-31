/**
 * SUT variant A — 1 tool: `echo`.
 *
 * Standalone MCP server (stdio transport) used as the System Under Test for the
 * mcpmon hot-reload / `notifications/tools/list_changed` experiment.
 *
 * The A -> B transition is performed by copying `variant-b.ts` over `server.ts`
 * (simulating a developer editing the live entry point). mcpmon watches the file
 * and restarts this process; on restart it emits `notifications/tools/list_changed`
 * toward the client.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'sut-hotreload',
  version: '1.0.0-variant-a',
});

// Single tool in variant A.
server.tool(
  'echo',
  'Echo back the provided text (variant A).',
  { text: z.string().describe('Text to echo back') },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Startup marker on stderr — used as the §5 reload proof.
  process.stderr.write('SUT variant A ready — 1 tool (echo)\n');
}

main().catch((err) => {
  process.stderr.write(`SUT variant A fatal: ${String(err)}\n`);
  process.exit(1);
});
