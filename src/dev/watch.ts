import { watch as fsWatch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '../config';
import { createServerShell, registerToolset } from '../server';
import { createAllTools, type ToolContext, type ToolDefinition } from '../tools/index';
import { startStdioTransport } from '../transports/stdio';
import { type Logger, silentLogger } from '../utils/logger';

// fs.watch fires several times per save (and the Biome PostToolUse formatter
// touches files again right after). Collapse a burst into one reload.
const DEBOUNCE_MS = 150;

const thisDir = dirname(fileURLToPath(import.meta.url));
// `src/` — watched recursively for `.ts` changes.
const srcDir = resolve(thisDir, '..');
// `src/tools/` — the leaf factory modules re-imported on reload.
const toolsDir = resolve(thisDir, '../tools');

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
 * Re-import every leaf tool-factory module with a fresh cache-busting query
 * (`?v=N`, monotonic) so the running process sees edited tool code, then
 * recompose the definitions exactly as `createAllTools` does. Each call MUST
 * use a version not seen before or Node serves the cached module.
 */
const loadFreshTools = async (ctx: ToolContext, version: number): Promise<ToolDefinition[]> => {
  const modules = await Promise.all(
    TOOL_MODULES.map(async ({ file, factory }) => {
      const specifier = `${pathToFileURL(join(toolsDir, file)).href}?v=${version}`;
      const mod = (await import(specifier)) as Record<string, ToolFactory | undefined>;
      const create = mod[factory];
      if (!create) throw new Error(`Tool module ${file} has no export ${factory}`);
      return create(ctx);
    }),
  );
  return modules.flat();
};

/**
 * A server shell plus a `reload()` that swaps in freshly re-imported tool code
 * over the live session. Split from `startWatchMode` so the reconciliation can
 * be exercised without the filesystem: the initial toolset is registered from
 * the static import (fast, and reload only matters after an edit); `reload()`
 * disposes the current generation and registers a fresh one.
 */
export const createReloadableServer = (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  onUnauthorized?: () => void,
): { server: ReturnType<typeof createServerShell>; reload: () => Promise<void> } => {
  const server = createServerShell(config, logger);
  const ctx: ToolContext = { subdomain: config.subdomain, getToken };
  const params = { config, getToken, onUnauthorized, logger };

  // Initial generation from the static import (fast; reload only matters after
  // an edit). Reassigned on every reload.
  let current = registerToolset(server, params, createAllTools(ctx));
  let version = 0;

  const reload = async (): Promise<void> => {
    version += 1;
    // Import fresh code BEFORE touching the live registration, so a syntax
    // error in the edited file rejects here and leaves the current generation
    // untouched.
    const tools = await loadFreshTools(ctx, version);
    // Dispose the old generation BEFORE registering the new one: both share the
    // same tool names, and the SDK rejects registering a name that is still
    // registered. Safe to do so — JS is single-threaded, so no tool call can
    // interleave in the gap between dispose and re-register.
    current.dispose();
    current = registerToolset(server, params, tools);
  };

  return { server, reload };
};

/**
 * Start the stdio server in watch mode: register the toolset, connect the
 * transport, then reload the toolset in place on any `.ts` change under `src/`.
 * stdio only — HTTP builds a per-session server per request, so there is no
 * long-lived server to hot-swap.
 */
export const startWatchMode = async (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  onUnauthorized?: () => void,
): Promise<void> => {
  const { server, reload } = createReloadableServer(config, getToken, logger, onUnauthorized);
  await startStdioTransport(server, logger);
  logger.info('watch_mode_enabled', { dir: srcDir });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = false;
  let pending = false;

  const runReload = async (): Promise<void> => {
    if (reloading) {
      // A change landed mid-reload; remember to reload once more after.
      pending = true;
      return;
    }
    reloading = true;
    try {
      await reload();
      logger.info('tools_reloaded');
    } catch (err) {
      // A reload failure (e.g. a syntax error mid-edit) must not kill the
      // server: keep the previous generation live and wait for the next save.
      logger.error('tools_reload_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reloading = false;
      if (pending) {
        pending = false;
        void runReload();
      }
    }
  };

  fsWatch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith('.ts')) return;
    clearTimeout(timer);
    timer = setTimeout(() => void runReload(), DEBOUNCE_MS);
  });
};
