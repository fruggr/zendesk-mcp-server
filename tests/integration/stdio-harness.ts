import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../../src/config';
import { createMcpServer } from '../../src/server';
import type { ConnectedClient, IntegrationHarness } from './harness';

/**
 * Exercises the stdio path end-to-end without spawning a process: the server is
 * the same `McpServer` that `src/index.ts` connects to a `StdioServerTransport`,
 * but here it is linked to the client through an in-memory pipe. This keeps the
 * roundtrip (serialization, request/response correlation, tool dispatch) real
 * while staying in-process for fast, deterministic tests.
 */
export const stdioHarness: IntegrationHarness = {
  name: 'stdio',
  async connect(config: Config): Promise<ConnectedClient> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // The token is opaque to the transport: MSW intercepts the Zendesk calls
    // regardless of its value.
    const { server } = createMcpServer(config, () => 'test-token');
    await server.connect(serverTransport);

    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    await client.connect(clientTransport);

    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  },
};
