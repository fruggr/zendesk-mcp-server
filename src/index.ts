import { loadConfig } from './config';
import { createMcpServer } from './server';
import { startStdioTransport } from './transports/stdio';
import { buildBasicAuthHeader } from './auth/api-token';
import { createTokenStore } from './auth/token-store';

const main = async (): Promise<void> => {
  const config = loadConfig();

  if (config.zendeskEmail && config.zendeskApiToken) {
    // API token mode — static Basic auth
    const staticToken = buildBasicAuthHeader(config.zendeskEmail, config.zendeskApiToken);
    const getToken = () => staticToken;
    const server = createMcpServer(config, getToken);
    await startStdioTransport(server);
  } else {
    // OAuth mode — browser-based auth on first tool call
    const tokenStore = createTokenStore({
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
    });
    const server = createMcpServer(config, tokenStore.getToken);
    await startStdioTransport(server);
  }
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
