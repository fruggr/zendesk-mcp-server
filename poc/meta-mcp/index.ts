/**
 * Meta-MCP — a generic stdio MCP server that drives a Server-Under-Test (SUT).
 *
 * The surface exposed to the LLM is a FIXED set of meta-tools (below). Every
 * mutation of the SUT happens *behind* this stable surface, so the dev loop
 *   edit SUT source → sut_reload → sut_list_tools → sut_call_tool → observe
 * works inside a single LLM session and never depends on the client honouring
 * `notifications/tools/list_changed` (AC-5).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { defaultSutParams } from './config';
import { SutController } from './sut-controller';

const controller = new SutController(defaultSutParams);

const server = new McpServer({ name: 'meta-mcp', version: '0.1.0' });

/** Wrap any payload as a single JSON text-content block. */
const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

/** Same, but flags the tool result as an error for the client. */
const jsonError = (payload: unknown) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

server.registerTool(
  'sut_start',
  {
    title: 'Start SUT',
    description:
      'Spawn the Server-Under-Test as a stdio subprocess and run the MCP `initialize` handshake. Uses the hard-coded default SUT unless overridden.',
    inputSchema: {
      command: z
        .string()
        .optional()
        .describe('Executable (defaults to the configured SUT command).'),
      args: z.array(z.string()).optional().describe('Arguments for the executable.'),
      cwd: z.string().optional().describe('Working directory for the SUT process.'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Extra environment variables for the SUT.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ command, args, cwd, env }) => {
    const res = await controller.start({ command, args, cwd, env });
    return res.ok ? json(res) : jsonError(res);
  },
);

server.registerTool(
  'sut_stop',
  {
    title: 'Stop SUT',
    description:
      'Terminate the SUT subprocess cleanly (SIGTERM, then SIGKILL fallback). No zombies left behind.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async () => {
    const res = await controller.stop();
    return res.ok ? json(res) : jsonError(res);
  },
);

server.registerTool(
  'sut_reload',
  {
    title: 'Reload SUT',
    description:
      'Kill the running SUT (if any) and respawn it, picking up source edits. Returns the before/after tools diff. This is the hot-reload primitive — no LLM session restart needed.',
    inputSchema: {},
    annotations: { readOnlyHint: false },
  },
  async () => {
    const res = await controller.reload();
    return res.ok ? json(res) : jsonError(res);
  },
);

server.registerTool(
  'sut_list_tools',
  {
    title: 'List SUT tools',
    description:
      "Proxy the SUT's tools/list — returns each tool's name, description, inputSchema and annotations.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const res = await controller.listTools();
    return res.ok ? json(res) : jsonError(res);
  },
);

server.registerTool(
  'sut_call_tool',
  {
    title: 'Call SUT tool',
    description:
      "Proxy the SUT's tools/call — invoke a SUT tool by name and return its raw content.",
    inputSchema: {
      name: z.string().describe('Name of the SUT tool to call.'),
      arguments: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('Arguments object for the SUT tool.'),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ name, arguments: args }) => {
    const res = await controller.callTool(name, args ?? {});
    return res.ok ? json(res) : jsonError(res);
  },
);

server.registerTool(
  'sut_status',
  {
    title: 'SUT status',
    description:
      'Report the SUT process state: pid, running/stopped/error, last exit code/signal, last error, server info.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => json(controller.status()),
);

server.registerTool(
  'sut_logs',
  {
    title: 'SUT logs',
    description:
      "Return the most recent lines of the SUT's stderr (diagnostics for crashes / reload failures).",
    inputSchema: {
      lines: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe('How many trailing lines to return (default 50).'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lines }) => json({ lines: controller.logs(lines ?? 50) }),
);

// Stop the SUT if the meta-MCP itself is shutting down, so we never orphan it.
const shutdown = async () => {
  await controller.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[meta-mcp] running via stdio — 7 meta-tools exposed (surface is fixed)');
