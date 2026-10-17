import { afterEach, describe, expect, it } from 'vitest';
import { registerCoreScenarios } from './core-scenarios';
import { type ConnectedClient, MODERN_REVISION, makeConfig } from './harness';
import { createHttpHarness, httpHarness } from './http-harness';

// The shared MCP roundtrip scenarios, over the HTTP transport and its
// authorization server, in both protocol eras. The OAuth-specific behaviour
// lives in http-oauth.test.ts.
registerCoreScenarios(httpHarness);
registerCoreScenarios(createHttpHarness('2026'));

describe('[http] protocol eras', () => {
  const open: ConnectedClient[] = [];

  afterEach(async () => {
    for (const connected of open.splice(0)) await connected.close();
  });

  const connect = async (era: '2025' | '2026', config = makeConfig()) => {
    const connected = await createHttpHarness(era).connect(config);
    open.push(connected);
    return connected;
  };

  it('negotiates 2026-07-28 with a client pinned to it', async () => {
    const { client } = await connect('2026');
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_REVISION);
  });

  it('keeps a default client on a 2025 revision', async () => {
    const { client } = await connect('2025');
    expect(client.getNegotiatedProtocolVersion()).toMatch(/^2025-/);
  });

  it('serves the same tool list in both eras', async () => {
    const config = makeConfig({ mode: 'all' });
    const modern = (await (await connect('2026', config)).client.listTools()).tools;
    const legacy = (await (await connect('2025', config)).client.listTools()).tools;

    expect(modern).toEqual(legacy);
  });

  it('refuses an unauthenticated 2026-07-28 request with the OAuth challenge', async () => {
    const { baseUrl } = await connect('2026');
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MODERN_REVISION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_REVISION } },
      }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});
