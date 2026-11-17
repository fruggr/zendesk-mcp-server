import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../../src/server';
import { errorHandlers } from '../msw-handlers';
import { mswServer } from '../setup';
import { makeConfig } from './harness';

const BASE = 'https://testsubdomain.zendesk.com/api/v2';

// End-to-end proof of the 401 backstop: when Zendesk rejects the token mid-call,
// the server invokes `onUnauthorized` (so the OAuth store can drop the dead
// token), and replays a read once only when the store says it renewed it.

describe('[stdio] unauthorized backstop', () => {
  let close: (() => Promise<void>) | undefined;

  const connect = async (getToken: () => string, onUnauthorized: () => unknown) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(
      makeConfig({ mode: 'all' }),
      getToken,
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
    return client;
  };

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

    // A store that did not report a renewed token gets no in-call retry: the call
    // that hit the 401 still surfaces the error to the client (`isError`), and
    // recovery is deferred to the next call.
    expect(result.isError).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('replays a read once on the token the store renewed', async () => {
    // Only the token a sibling process rotated out is refused.
    mswServer.use(
      http.get(`${BASE}/users/me`, ({ request }) =>
        request.headers.get('authorization') === 'Bearer stale'
          ? new HttpResponse('unauthorized', { status: 401 })
          : undefined,
      ),
    );
    let token = 'stale';
    const onUnauthorized = vi.fn(() => {
      token = 'renewed';
      return true;
    });
    const client = await connect(() => token, onUnauthorized);

    const result = await client.callTool({ name: 'get_current_user', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('replays a read only once when the renewed token is refused too', async () => {
    mswServer.use(errorHandlers.usersMeUnauthorized);
    const onUnauthorized = vi.fn(() => true);
    const client = await connect(() => 'test-token', onUnauthorized);

    const result = await client.callTool({ name: 'get_current_user', arguments: {} });

    expect(result.isError).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('never replays a write, which may already have applied part of its calls', async () => {
    const writes = vi.fn();
    mswServer.use(
      http.put(`${BASE}/tickets/:id`, () => {
        writes();
        return new HttpResponse('unauthorized', { status: 401 });
      }),
    );
    const onUnauthorized = vi.fn(() => true);
    const client = await connect(() => 'test-token', onUnauthorized);

    const result = await client.callTool({
      name: 'update_ticket',
      arguments: { ticket_id: 1, status: 'open' },
    });

    expect(result.isError).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
  });
});
