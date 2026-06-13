import { createTokenStore } from './auth/token-store';
import type { Config } from './config';
import { loadConfig } from './config';
import { createMcpServer } from './server';
import { startHttpTransport } from './transports/http';
import { startStdioTransport } from './transports/stdio';
import { createLogger, type Logger } from './utils/logger';

const buildStdioServer = (config: Config, logger: Logger) => {
  // OAuth mode — browser-based auth on first tool call. `invalidate` drops the
  // dead access token on a 401 so the next call refreshes/re-authenticates.
  const tokenStore = createTokenStore(
    {
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
      callbackPort: config.callbackPort,
    },
    logger,
  );
  return createMcpServer(config, tokenStore.getToken, logger, tokenStore.invalidate);
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.transport === 'stdio') {
    const server = buildStdioServer(config, logger);
    await startStdioTransport(server, logger);
    return;
  }

  // HTTP mode: the HTTP transport creates a per-session McpServer with the
  // request's bearer captured in its tools' closure — no shared state.
  await startHttpTransport(config, logger);
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
