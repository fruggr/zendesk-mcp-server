import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../../src/server';
import { errorHandlers } from '../msw-handlers';
import { mswServer } from '../setup';
import { makeConfig } from './harness';

// End-to-end proof of the 401 backstop: when Zendesk rejects the token mid-call,
// the server invokes `onUnauthorized` (so the OAuth store can drop the dead
// token) and still surfaces the error to the client.
describe('[stdio] unauthorized backstop', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('calls onUnauthorized when a tool hits a 401 from Zendesk', async () => {
    mswServer.use(errorHandlers.usersMeUnauthorized);
    const onUnauthorized = vi.fn();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(
      makeConfig({ mode: 'all' }),
      () => 'test-token',
      undefined,
      onUnauthorized,
    );
    await server.connect(serverTransport);

    const client = new Client({ name: 'unauthorized-backstop-test', version: '0.0.0' });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({ name: 'get_current_user', arguments: {} });

    // The backstop is not a transparent in-call retry: the call that hit the 401
    // still surfaces the error to the client (`isError`). Recovery is deferred to
    // the next call, whose getToken refreshes the token invalidated here.
    expect(result.isError).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
