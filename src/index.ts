import { buildBasicAuthHeader } from './auth/api-token';
import { createTokenStore } from './auth/token-store';
import { loadConfig } from './config';
import { createMcpServer } from './server';
import { startStdioTransport } from './transports/stdio';
import { createLogger } from './utils/logger';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.zendeskEmail && config.zendeskApiToken) {
    // API token mode — static Basic auth
    const staticToken = buildBasicAuthHeader(config.zendeskEmail, config.zendeskApiToken);
    const getToken = () => staticToken;
    const server = createMcpServer(config, getToken, logger);
    await startStdioTransport(server, logger);
  } else {
    // OAuth mode — browser-based auth on first tool call
    const tokenStore = createTokenStore(
      {
        subdomain: config.subdomain,
        oauthClientId: config.oauthClientId,
      },
      logger,
    );
    const server = createMcpServer(config, tokenStore.getToken, logger);
    await startStdioTransport(server, logger);
  }
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
