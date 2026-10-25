// Compiles zod schemas on their first synchronous parse. Must stay the FIRST import:
// schemas built before it keep the runtime parser, silently. Why, and what it is worth:
// docs/decisions/zod-compile.md.
import 'zod/compile';

import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Config } from './config';
import { loadConfig } from './config';
import { startDevServer } from './dev/reload';
import { renderToolSurface } from './routing/print';
import { defaultServerFactory, toolEnv } from './server';
import { createAllTools } from './tools/index';
import { startStdioTransport } from './transports/stdio';
import { createLogger, type Logger } from './utils/logger';
import { installShutdown } from './utils/shutdown';
import { type SlaRuntime, startSlaRuntime } from './utils/sla-service';
import { isStartupError } from './utils/startup-error';

type StdioTokenStore = ReturnType<typeof import('./auth/token-store').createTokenStore>;

// OAuth mode — browser-based auth on first tool call. `invalidate` drops the
// dead access token on a 401 so the next call refreshes/re-authenticates.
// Loaded on demand: the browser sign-in (and its `open` dependency) is stdio's
// alone, so an HTTP server never loads it.
const buildStdioTokenStore = async (config: Config, logger: Logger): Promise<StdioTokenStore> => {
  const { createTokenStore } = await import('./auth/token-store');
  return createTokenStore(
    {
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
      callbackPort: config.callbackPort,
      readOnly: config.readOnly,
    },
    logger,
  );
};

// Both stdio paths end with the transport serving; dev mode builds its servers
// with `reload_tools`. The handle is what lets the caller close it on shutdown.
const connectStdio = (
  config: Config,
  tokenStore: StdioTokenStore,
  logger: Logger,
  slaRuntime: SlaRuntime,
): StdioServerHandle => {
  if (config.dev) {
    return startDevServer(
      config,
      tokenStore.getToken,
      logger,
      tokenStore.invalidate,
      slaRuntime,
      tokenStore.getTokenSilently,
    );
  }
  return startStdioTransport(
    (extras) =>
      defaultServerFactory({
        config,
        getToken: tokenStore.getToken,
        logger,
        onUnauthorized: tokenStore.invalidate,
        // The alert poller runs unasked: it must never open a browser sign-in.
        getBackgroundToken: tokenStore.getTokenSilently,
        slaRuntime,
        ...extras,
      }),
    logger,
  );
};

const main = async (): Promise<void> => {
  const config = loadConfig();

  // Diagnostic short-circuit: print the surface these flags resolve to and
  // exit. Before the token store is built, and before any transport, because
  // tool definitions are pure — auth only fires inside a handler — so this
  // never needs a credential or a network call.
  if (config.printTools) {
    const tools = createAllTools(toolEnv(config));
    console.log(renderToolSurface(config, tools));
    return;
  }

  const logger = createLogger(config.logLevel);

  if (config.transport === 'stdio') {
    const tokenStore = await buildStdioTokenStore(config, logger);
    const sla = startSlaRuntime(config);
    const stdio = connectStdio(config, tokenStore, logger, sla.runtime);

    // Installed *after* the transport is connected: the SDK's stdin `data`
    // listener is what puts stdin in flowing mode, and `end` only fires there.
    installShutdown({
      watchStdin: true,
      logger,
      cleanup: async () => {
        sla.stop();
        await stdio.close();
        tokenStore.dispose();
      },
    });
    return;
  }

  if (config.dev) {
    // Dev mode hot-reloads a single long-lived server; HTTP builds one per
    // session or per request, so there is nothing to reload. Warn rather than
    // silently ignore.
    logger.warn('dev_mode_ignored_http');
  }

  // Signals only: an HTTP server has no client on stdin to lose. Nothing reads
  // stdin here, so it stays paused and never reports EOF anyway — but saying so
  // explicitly keeps that from becoming load-bearing. Installed before the
  // server starts, so `http_transport_ready` already means a SIGTERM is handled.
  // A signal during the start waits for it to finish, then closes what it
  // opened (the store, the port); the shutdown watchdog bounds that wait.
  let starting: Promise<{ close: () => Promise<void> }> | undefined;
  installShutdown({
    watchStdin: false,
    logger,
    cleanup: async () => (await starting?.catch(() => undefined))?.close(),
  });

  // Loaded on demand: the authorization server is HTTP's alone, so a stdio
  // start never parses it.
  const { startHttpTransport } = await import('./transports/http');
  starting = startHttpTransport(config, logger);
  await starting;
};

main().catch((error) => {
  // A misconfiguration the operator fixes: its message says how, and a stack
  // trace would only bury it.
  if (isStartupError(error)) console.error(error.message);
  else console.error('Fatal error:', error);
  process.exit(1);
});
