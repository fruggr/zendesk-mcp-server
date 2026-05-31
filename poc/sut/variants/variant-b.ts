/**
 * SUT variant B — 2 tools: `echo` (modified description) + `reverse`.
 *
 * Standalone MCP server (stdio transport). This file is copied over `server.ts`
 * to simulate a developer adding a new tool while the session is live. mcpmon
 * detects the change, restarts the process, and emits
 * `notifications/tools/list_changed` toward the client.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'sut-hotreload',
  version: '1.0.0-variant-b',
});

// `echo` with a DIFFERENT description than variant A — lets us check whether the
// client also refreshes tool metadata, not just the tool set.
server.tool(
  'echo',
  'Echo back the provided text (variant B — description updated).',
  { text: z.string().describe('Text to echo back') },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

// New tool introduced in variant B.
server.tool(
  'reverse',
  'Reverse the provided text (variant B).',
  { text: z.string().describe('Text to reverse') },
  async ({ text }) => ({
    content: [{ type: 'text', text: [...text].reverse().join('') }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Startup marker on stderr — used as the §5 reload proof.
  process.stderr.write('SUT variant B ready — 2 tools (echo, reverse)\n');
}

main().catch((err) => {
  process.stderr.write(`SUT variant B fatal: ${String(err)}\n`);
  process.exit(1);
});
