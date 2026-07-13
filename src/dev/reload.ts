import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { Config } from '../config';
import { createServerShell, registerToolset } from '../server';
import { createAllTools, type ToolContext, type ToolDefinition } from '../tools/index';
import { startStdioTransport } from '../transports/stdio';
import { type Logger, silentLogger } from '../utils/logger';

const thisDir = dirname(fileURLToPath(import.meta.url));
// `src/tools/` — the leaf factory modules re-imported on reload.
const toolsDir = join(thisDir, '..', 'tools');

// The leaf tool-factory modules, mirroring `createAllTools` in tools/index.ts.
// Reload re-imports THESE files directly (with a cache-busting query) because
// an ESM cache-bust does not cascade to a module's own imports: busting
// tools/index.ts would keep serving the stale tickets.ts/etc. So we bust the
// leaves — where handler code and schemas live — and recompose here. Modules
// deeper than these (client, definitions, guidance) are not re-imported; edits
// there need a full restart. Keep this list in sync with createAllTools.
const TOOL_MODULES = [
  { file: 'tickets.ts', factory: 'createTicketTools' },
  { file: 'search.ts', factory: 'createSearchTools' },
  { file: 'help-center.ts', factory: 'createHelpCenterTools' },
  { file: 'users.ts', factory: 'createUserTools' },
] as const;

type ToolFactory = (ctx: ToolContext) => ToolDefinition[];

/**
 * Re-import every leaf tool-factory module with a fresh cache-busting query so
 * the running process sees edited tool code, then recompose the definitions
 * exactly as `createAllTools` does. A per-call `randomUUID()` nonce keeps the
 * import specifier unique (Node caches modules by specifier, so a repeated
 * query would serve stale code) without any shared module state.
 */
const loadFreshTools = async (ctx: ToolContext): Promise<ToolDefinition[]> => {
  const nonce = randomUUID();
  const modules = await Promise.all(
    TOOL_MODULES.map(async ({ file, factory }) => {
      const specifier = `${pathToFileURL(join(toolsDir, file)).href}?v=${nonce}`;
      const mod = (await import(specifier)) as Record<string, ToolFactory | undefined>;
      const create = mod[factory];
      /* v8 ignore next 2 -- defensive guard: only hit if a factory export is renamed */
      if (!create) throw new Error(`Tool module ${file} has no export ${factory}`);
      return create(ctx);
    }),
  );
  return modules.flat();
};

/**
 * A server shell plus a `reload()` that swaps in freshly re-imported tool code
 * over the live session and returns the new tool count. Split from
 * `startDevServer` so the reconciliation can be exercised without a transport:
 * the initial toolset is registered from the static import (fast, and reload
 * only matters after an edit); `reload()` disposes the current generation and
 * registers a fresh one.
 */
export const createReloadableServer = (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  onUnauthorized?: () => void,
  // Test seam: how a reload obtains the fresh tool definitions. Defaults to
  // re-importing the leaf modules from disk; tests inject a stub to drive the
  // re-registration failure/rollback path deterministically.
  loadTools: (ctx: ToolContext) => Promise<ToolDefinition[]> = loadFreshTools,
): { server: McpServer; reload: () => Promise<number> } => {
  const server = createServerShell(config, logger);
  const ctx: ToolContext = { subdomain: config.subdomain, getToken };
  const params = { config, getToken, onUnauthorized, logger };

  // The last generation registered successfully — both the handle (to dispose)
  // and its definitions (to restore if a reload's re-registration fails).
  // Initial generation is the static import (fast; reload only matters after an
  // edit).
  let currentTools = createAllTools(ctx);
  let current = registerToolset(server, params, currentTools);

  const reload = async (): Promise<number> => {
    // Import fresh code BEFORE touching the live registration, so a syntax
    // error in an edited file rejects here and leaves the current generation
    // untouched.
    const tools = await loadTools(ctx);
    // Dispose the old generation BEFORE registering the new one: both share the
    // same tool names, and the SDK rejects registering a name that is still
    // registered. Safe to do so — JS is single-threaded, so no tool call can
    // interleave in the gap between dispose and re-register.
    current.dispose();
    try {
      current = registerToolset(server, params, tools);
      currentTools = tools;
    } catch (err) {
      // The fresh generation failed to register (e.g. an edit introduced a
      // duplicate tool name). Restore the last-good set so the live session is
      // never left without its tools, then surface the error to the caller.
      try {
        current = registerToolset(server, params, currentTools);
      } catch (rollbackErr) {
        // Restoring the last-good set also failed — the session may now have no
        // tools (the old generation was already disposed). Log it so the state
        // is diagnosable; still surface the original reload error to the caller.
        logger.error('tools_rollback_failed', {
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
      throw err;
    }
    return current.count;
  };

  return { server, reload };
};

/**
 * Register the dev-only `reload_tools` meta-tool on the server. It stays
 * registered across reloads (it is NOT part of the disposable toolset
 * generation), so it can always be called again. Its handler triggers a reload
 * and reports the outcome; a failed reload surfaces as a tool error while the
 * previous generation stays live.
 */
export const registerReloadTool = (
  server: McpServer,
  reload: () => Promise<number>,
  logger: Logger = silentLogger,
): void => {
  server.registerTool(
    'reload_tools',
    {
      title: 'Reload tools from source (dev)',
      description:
        'Dev only. Re-imports the Zendesk tool modules from source and re-registers them on this live session, so tool code you just edited takes effect without restarting the server or reconnecting the client. Call it once at the end of an edit cycle, before testing your changes; the refreshed tool list is announced via tools/list_changed. Only the tool modules (tickets, search, help_center, users) are reloaded — edits to shared infrastructure (HTTP client, shared definitions, server wiring) still require a full restart. Takes no arguments and makes no Zendesk API calls.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const count = await reload();
        logger.info('tools_reloaded', { count });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Reloaded ${count} tool(s) from source. The updated tool list is now live (tools/list_changed sent).`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('tools_reload_failed', { error: message });
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Reload failed; the previously loaded tools are still live. Fix the error and call reload_tools again: ${message}`,
            },
          ],
        };
      }
    },
  );
};

/**
 * Start the stdio server in dev mode: the normal toolset plus a persistent
 * `reload_tools` tool that hot-reloads edited tool code on demand. stdio only —
 * HTTP builds a per-session server per request, so there is no long-lived
 * server to hot-swap.
 */
/* v8 ignore start -- runtime bootstrap: binds the reload tool to a real stdio
   transport; the reload machinery it wires up is covered by dev-reload.test.ts */
export const startDevServer = async (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  onUnauthorized?: () => void,
): Promise<void> => {
  const { server, reload } = createReloadableServer(config, getToken, logger, onUnauthorized);
  registerReloadTool(server, reload, logger);
  await startStdioTransport(server, logger);
  logger.info('dev_mode_enabled');
};
/* v8 ignore stop */
