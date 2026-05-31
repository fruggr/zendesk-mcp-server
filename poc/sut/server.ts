/**
 * Demo SUT (Server Under Test) — the live, editable target the meta-MCP drives.
 *
 * This file starts life as **Variant A** (1 tool: `echo`). To demonstrate the
 * hot-reload loop (AC-4), edit this file into **Variant B** (2 tools, with a
 * modified `echo` description) — the canonical contents live in
 * `variants/variant-a.ts` and `variants/variant-b.ts`. The automated validator
 * (`poc/validate.ts`) performs that edit by copying a variant over this file,
 * then calls `sut_reload`.
 *
 * Hard rule for any stdio MCP server: stdout carries JSON-RPC only. All human
 * logging goes to stderr (`console.error`).
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
