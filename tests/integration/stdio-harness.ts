import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Config } from '../../src/config';
import { createMcpServer } from '../../src/server';
import { type StdioBuildExtras, startStdioTransport } from '../../src/transports/stdio';
import {
  type ConnectedClient,
  clientOptionsFor,
  type Era,
  type IntegrationHarness,
} from './harness';

/** Builds the server a stdio connection serves; the default is the production one. */
export type StdioTestFactory = (
  config: Config,
  extras: StdioBuildExtras,
) => ReturnType<typeof createMcpServer>;

const productionServer: StdioTestFactory = (config, { requestStateCodec }) =>
  // The token is opaque to the transport: MSW intercepts the Zendesk calls
  // regardless of its value.
  createMcpServer(config, () => 'test-token', undefined, undefined, { requestStateCodec });

/**
 * Exercises the stdio path end-to-end without spawning a process: the same
 * `startStdioTransport` the binary uses (SDK `serveStdio`, era chosen by the
 * client), over an in-memory pipe instead of the process's stdin/stdout. The
 * roundtrip (serialization, era negotiation, tool dispatch) stays real while
 * staying in-process for fast, deterministic tests.
 */
export const createStdioHarness = (
  era: Era,
  factory: StdioTestFactory = productionServer,
): IntegrationHarness => ({
  name: era === '2025' ? 'stdio' : `stdio-${era}`,
  async connect(config: Config): Promise<ConnectedClient> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = startStdioTransport((extras) => factory(config, extras), undefined, {
      transport: serverTransport,
    });

    const client = new Client(
      { name: 'integration-test', version: '0.0.0' },
      clientOptionsFor(era),
    );
    await client.connect(clientTransport);

    return {
      client,
      close: async () => {
        await client.close();
        await handle.close();
      },
    };
  },
});

export const stdioHarness = createStdioHarness('2025');
