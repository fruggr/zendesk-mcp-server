import { createTokenStore } from './auth/token-store';
import type { Config } from './config';
import { loadConfig } from './config';
import { startWatchMode } from './dev/watch';
import { createMcpServer } from './server';
import { startHttpTransport } from './transports/http';
import { startStdioTransport } from './transports/stdio';
import { createLogger, type Logger } from './utils/logger';

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

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.transport === 'stdio') {
    const tokenStore = buildStdioTokenStore(config, logger);
    if (config.watch) {
      await startWatchMode(config, tokenStore.getToken, logger, tokenStore.invalidate);
      return;
    }
    const server = createMcpServer(config, tokenStore.getToken, logger, tokenStore.invalidate);
    await startStdioTransport(server, logger);
    return;
  }

  if (config.watch) {
    // Watch mode hot-swaps a single long-lived server; HTTP builds one per
    // request, so there is nothing to reload. Fail loudly rather than silently
    // ignore the flag.
    logger.warn('watch_mode_ignored_http');
  }

  // HTTP mode: the HTTP transport creates a per-session McpServer with the
  // request's bearer captured in its tools' closure — no shared state.
  await startHttpTransport(config, logger);
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
