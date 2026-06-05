import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthRequiredError } from '../../src/auth/token-store';
import { createMcpServer } from '../../src/server';
import { makeConfig } from './harness';

const textOf = (result: { content?: Array<{ type: string; text?: string }> }): string =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

const AUTH_URL = 'https://testsubdomain.zendesk.com/oauth/authorizations/new?client_id=test';

// End-to-end proof of B1: when getToken throws AuthRequiredError (the fail-fast
// path), a tool call must come back as an MCP tool error whose text carries the
// authorize URL, so the user can sign in and retry.
describe('[stdio] authentication-required tool error', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('surfaces the authorize URL as the tool error text', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const getToken = () => {
      throw createAuthRequiredError(AUTH_URL);
    };
    const server = createMcpServer(makeConfig({ mode: 'all' }), getToken);
    await server.connect(serverTransport);

    const client = new Client({ name: 'auth-required-test', version: '0.0.0' });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({ name: 'get_current_user', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('authentication required');
    expect(textOf(result)).toContain(AUTH_URL);
  });
});
