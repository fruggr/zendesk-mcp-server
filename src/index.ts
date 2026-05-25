import { buildBasicAuthHeader } from './auth/api-token';
import { getSessionToken } from './auth/session-token';
import { createTokenStore } from './auth/token-store';
import type { Config } from './config';
import { loadConfig } from './config';
import { createMcpServer } from './server';

type GetToken = () => string | Promise<string>;

const resolveStdioGetToken = (config: Config): GetToken => {
  if (config.zendeskEmail && config.zendeskApiToken) {
    const staticToken = buildBasicAuthHeader(config.zendeskEmail, config.zendeskApiToken);
    return () => staticToken;
  }
  const tokenStore = createTokenStore({
    subdomain: config.subdomain,
    oauthClientId: config.oauthClientId,
  });
  return tokenStore.getToken;
};

const main = async (): Promise<void> => {
  const config = loadConfig();

  if (config.transport === 'stdio') {
    const { server } = createMcpServer(config, resolveStdioGetToken(config));
    await server.start({ transportType: 'stdio' });
    console.error('Zendesk MCP server running via stdio');
    return;
  }

  // HTTP mode: the per-session bearer is delivered via fastmcp's
  // `authenticate` callback (configured inside createMcpServer) and pulled
  // from async-local storage by getSessionToken at handler call time.
  const { server } = createMcpServer(config, getSessionToken);
  await server.start({
    transportType: 'httpStream',
    httpStream: { host: config.host, port: config.port },
  });
  console.error(`Zendesk MCP server running via http on ${config.host}:${config.port}`);
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
