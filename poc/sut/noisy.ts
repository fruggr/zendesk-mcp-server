/**
 * Noisy SUT — pollutes stdout with non-JSON-RPC garbage at startup, then runs a
 * perfectly normal MCP server. Used for AC-7: the meta-MCP must not let stdout
 * noise corrupt JSON-RPC parsing. The malformed lines are reported as parse
 * errors (captured by the controller) and the handshake still succeeds.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

// --- deliberate stdout pollution (a real-world footgun: a stray console.log) ---
console.log('==== demo-sut noisy banner — this is NOT json-rpc ====');
console.log('{ "almost": json, but not really }}}');
// -------------------------------------------------------------------------------

const server = new McpServer({ name: 'demo-sut-noisy', version: '1.0.0-NOISY' });

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
console.error('[demo-sut noisy] ready despite stdout noise — 1 tool: echo');
