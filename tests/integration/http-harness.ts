import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Config } from '../../src/config';
import { startHttpTransport } from '../../src/transports/http';
import { createZendeskOAuthMock, localServerPassthrough } from '../msw-handlers';
import { mswServer } from '../setup';
import type { ConnectedClient, IntegrationHarness } from './harness';
import { signInWithDcr } from './oauth-client';

/**
 * Exercises the HTTP path end-to-end: a real `node:http` server, a client that
 * signs in through the authorization server (DCR, the MSW-mocked Zendesk
 * login, consent) and then talks MCP over Streamable HTTP with the access
 * token it obtained. Nothing is stubbed between the client and the tools.
 */
export const httpHarness: IntegrationHarness = {
  name: 'http',
  async connect(config: Config): Promise<ConnectedClient> {
    // The sign-in needs a working Zendesk login, whatever the scenario mocked:
    // the OAuth mock goes on top for it, then the scenario's own handlers are
    // put back above it, so the tool calls see exactly what the scenario set.
    const scenarioHandlers = mswServer.listHandlers();
    mswServer.use(localServerPassthrough, ...createZendeskOAuthMock().handlers);
    const handle = await startHttpTransport({
      ...config,
      transport: 'http',
      oauthStore: 'memory://',
      oauthMasterSecret: Buffer.alloc(32, 8).toString('base64'),
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const { tokens } = await signInWithDcr(baseUrl);
    if (!tokens.body.access_token) {
      await handle.close();
      throw new Error(`HTTP harness sign-in failed: ${JSON.stringify(tokens.body)}`);
    }

    mswServer.use(localServerPassthrough, ...scenarioHandlers);

    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } },
      }),
    );

    return {
      client,
      baseUrl,
      close: async () => {
        await client.close();
        await handle.close();
      },
    };
  },
};
