import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTokenStore } from './auth/token-store';
import type { Config } from './config';
import { loadConfig } from './config';
import { startDevServer } from './dev/reload';
import { createMcpServer } from './server';
import { startHttpTransport } from './transports/http';
import { startStdioTransport } from './transports/stdio';
import { createLogger, type Logger } from './utils/logger';
import { installShutdown } from './utils/shutdown';

// OAuth mode — browser-based auth on first tool call. `invalidate` drops the
// dead access token on a 401 so the next call refreshes/re-authenticates.
const buildStdioTokenStore = (config: Config, logger: Logger) =>
  createTokenStore(
    {
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
      callbackPort: config.callbackPort,
    },
    logger,
  );

// Both stdio paths end with a server already connected to its transport; dev
// mode wires `reload_tools` and connects on its own. Returning the server is
// what lets the caller close it on shutdown.
const connectStdio = async (
  config: Config,
  tokenStore: ReturnType<typeof buildStdioTokenStore>,
  logger: Logger,
): Promise<McpServer> => {
  if (config.dev) {
    return startDevServer(config, tokenStore.getToken, logger, tokenStore.invalidate);
  }
  const server = createMcpServer(config, tokenStore.getToken, logger, tokenStore.invalidate);
  await startStdioTransport(server, logger);
  return server;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.transport === 'stdio') {
    const tokenStore = buildStdioTokenStore(config, logger);
    const server = await connectStdio(config, tokenStore, logger);

    // Installed *after* the transport is connected: the SDK's stdin `data`
    // listener is what puts stdin in flowing mode, and `end` only fires there.
    installShutdown({
      watchStdin: true,
      logger,
      cleanup: async () => {
        await server.close();
        tokenStore.dispose();
      },
    });
    return;
  }

  if (config.dev) {
    // Dev mode hot-reloads a single long-lived server; HTTP builds one per
    // request, so there is nothing to reload. Warn rather than silently ignore.
    logger.warn('dev_mode_ignored_http');
  }

  // HTTP mode: the HTTP transport creates a per-session McpServer with the
  // request's bearer captured in its tools' closure — no shared state.
  const http = await startHttpTransport(config, logger);

  // Signals only: an HTTP server has no client on stdin to lose. Nothing reads
  // stdin here, so it stays paused and never reports EOF anyway — but saying so
  // explicitly keeps that from becoming load-bearing.
  installShutdown({ watchStdin: false, logger, cleanup: http.close });
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
