/**
 * Canonical contents of the demo SUT — Variant A (1 tool: `echo`).
 * The validator copies this file over `poc/sut/server.ts` to reset to A.
 * Keep this byte-identical to the initial state of `server.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'demo-sut', version: '1.0.0-A' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echo back the provided text unchanged.',
    inputSchema: { text: z.string().describe('Text to echo back') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ text }) => ({ content: [{ type: 'text' as const, text }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[demo-sut variant A] ready — 1 tool: echo');
