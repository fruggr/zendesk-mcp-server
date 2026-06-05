import { buildBasicAuthHeader } from './auth/api-token';
import { createTokenStore } from './auth/token-store';
import type { Config } from './config';
import { loadConfig } from './config';
import { createMcpServer } from './server';
import { startHttpTransport } from './transports/http';
import { startStdioTransport } from './transports/stdio';
import { createLogger, type Logger } from './utils/logger';

type GetToken = () => string | Promise<string>;

const resolveStdioGetToken = (config: Config, logger: Logger): GetToken => {
  if (config.zendeskEmail && config.zendeskApiToken) {
    const staticToken = buildBasicAuthHeader(config.zendeskEmail, config.zendeskApiToken);
    return () => staticToken;
  }
  const tokenStore = createTokenStore(
    {
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
    },
    logger,
  );
  return tokenStore.getToken;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.transport === 'stdio') {
    const server = createMcpServer(config, resolveStdioGetToken(config, logger), logger);
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
