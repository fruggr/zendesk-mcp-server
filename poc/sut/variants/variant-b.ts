/**
 * Canonical contents of the demo SUT — Variant B (2 tools: `echo` + `reverse`),
 * with a modified description on `echo`. The validator copies this file over
 * `poc/sut/server.ts` to simulate the developer editing the source, then calls
 * `sut_reload` so the new surface appears without restarting the session.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'demo-sut', version: '1.1.0-B' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    // Description changed vs variant A — proves description mutations survive reload.
    description: 'Echo back the provided text unchanged (variant B — description updated).',
    inputSchema: { text: z.string().describe('Text to echo back') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ text }) => ({ content: [{ type: 'text' as const, text }] }),
);

server.registerTool(
  'reverse',
  {
    title: 'Reverse',
    description: 'Return the input text reversed character-by-character.',
    inputSchema: { text: z.string().describe('Text to reverse') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ text }) => ({
    content: [{ type: 'text' as const, text: [...text].reverse().join('') }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[demo-sut variant B] ready — 2 tools: echo, reverse');
