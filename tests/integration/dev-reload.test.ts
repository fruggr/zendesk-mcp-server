import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createReloadableServer, registerReloadTool } from '../../src/dev/reload';
import { createServerShell, registerToolset } from '../../src/server';
import { createAllTools } from '../../src/tools/index';
import { makeConfig } from './harness';

const getToken = () => 'test-token';

/**
 * Connect an in-memory client to `server` and track `tools/list_changed`
 * notifications so a test can assert the client was told to refetch.
 */
const connect = async (server: Awaited<ReturnType<typeof createServerShell>>) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dev-reload-test', version: '0.0.0' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  await client.connect(clientTransport);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, names, listChanged: () => listChanged };
};

describe('dev-mode tool reload', () => {
  it('swaps the exposed toolset in place and notifies the client', async () => {
    const config = makeConfig({ mode: 'all' });
    const ctx = { subdomain: config.subdomain, getToken };
    const server = createServerShell(config);
    const params = { config, getToken };

    const all = createAllTools(ctx);
    let generation = registerToolset(server, params, all);

    const { names, listChanged } = await connect(server);
    const before = await names();
    expect(before).toContain('get_ticket');
    const changesAfterConnect = listChanged();

    // Simulate a reload where `get_ticket` was removed from the source: dispose
    // the current generation, register a fresh one without it.
    generation.dispose();
    generation = registerToolset(
      server,
      params,
      all.filter((t) => t.name !== 'get_ticket'),
    );

    const after = await names();
    expect(after).not.toContain('get_ticket');
    // Everything else survived the swap.
    expect(after).toEqual(before.filter((n) => n !== 'get_ticket'));
    // The client was told to refetch as part of the swap.
    expect(listChanged()).toBeGreaterThan(changesAfterConnect);

    generation.dispose();
  });

  it('exposes reload_tools which re-imports modules and keeps the surface', async () => {
    const config = makeConfig({ mode: 'all' });
    const { server, reload } = createReloadableServer(config, getToken);
    registerReloadTool(server, reload);

    const { client, names, listChanged } = await connect(server);
    const before = await names();
    // The dev tool is present alongside the Zendesk tools.
    expect(before).toContain('reload_tools');
    const changesAfterConnect = listChanged();

    // No source edited between generations, so re-importing the leaf modules
    // and recomposing must yield the identical tool surface — proving the
    // dynamic-import + reconcile pipeline runs cleanly end to end.
    const result = await client.callTool({ name: 'reload_tools', arguments: {} });
    expect(result.isError).toBeFalsy();

    const after = await names();
    expect(after).toEqual(before);
    // reload_tools survives its own reload (it is not part of the disposable
    // generation), so it can be called again.
    expect(after).toContain('reload_tools');
    expect(listChanged()).toBeGreaterThan(changesAfterConnect);
  });
});
