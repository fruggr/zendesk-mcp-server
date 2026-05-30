import { afterEach, describe, expect, it } from 'vitest';
import { errorHandlers } from '../msw-handlers';
import { mswServer } from '../setup';
import { type ConnectedClient, type IntegrationHarness, makeConfig } from './harness';

/** Names of the text blocks returned by a tool call, joined for easy asserts. */
const textOf = (result: { content?: Array<{ type: string; text?: string }> }): string =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

const toolNames = (tools: Array<{ name: string }>): string[] => tools.map((t) => t.name);

/**
 * Shared, transport-agnostic integration scenarios. Every assertion here goes
 * through a real MCP client over the harness's transport — `tools/list` and
 * `tools/call` cross the wire, the server dispatches to the actual tool, and the
 * Zendesk HTTP call is served by MSW. A later HTTP harness reuses this verbatim.
 */
export const registerCoreScenarios = (harness: IntegrationHarness): void => {
  describe(`[${harness.name}] core MCP roundtrip`, () => {
    let connected: ConnectedClient | undefined;

    afterEach(async () => {
      await connected?.close();
      connected = undefined;
    });

    describe('tools/list', () => {
      it('exposes individual tools in "all" mode', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const { tools } = await connected.client.listTools();
        const names = toolNames(tools);

        expect(names).toContain('get_current_user');
        expect(names).toContain('get_ticket');
        expect(names).toContain('create_ticket');
      });

      it('exposes one proxy per namespace in "namespace" mode', async () => {
        connected = await harness.connect(makeConfig({ mode: 'namespace' }));
        const { tools } = await connected.client.listTools();
        const names = toolNames(tools);

        expect(names).toContain('zendesk_tickets');
        expect(names).toContain('zendesk_help_center');
        expect(names).toContain('zendesk_users');
        // No individual tools leak through the proxy facade.
        expect(names).not.toContain('get_current_user');
      });

      it('exposes a single proxy in "single" mode', async () => {
        connected = await harness.connect(makeConfig({ mode: 'single' }));
        const { tools } = await connected.client.listTools();

        expect(toolNames(tools)).toEqual(['zendesk']);
      });

      it('applies the namespace filter', async () => {
        connected = await harness.connect(makeConfig({ mode: 'namespace', namespaces: ['users'] }));
        const { tools } = await connected.client.listTools();

        expect(toolNames(tools)).toEqual(['zendesk_users']);
      });

      it('applies the read-only filter', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all', readOnly: true }));
        const names = toolNames((await connected.client.listTools()).tools);

        expect(names).toContain('get_current_user');
        expect(names).not.toContain('create_ticket');
        expect(names).not.toContain('update_ticket');
      });
    });

    describe('tools/call', () => {
      it('dispatches a direct tool call to the mocked Zendesk API', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'get_current_user',
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('Test User');
      });

      it('dispatches through the single proxy at runtime', async () => {
        connected = await harness.connect(makeConfig({ mode: 'single' }));
        const result = await connected.client.callTool({
          name: 'zendesk',
          arguments: { operation: 'get_current_user', params: {} },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('Test User');
      });

      it('surfaces a Zendesk API error as an MCP tool error', async () => {
        mswServer.use(errorHandlers.usersMeUnauthorized);

        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'get_current_user',
          arguments: {},
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Authentication failed');
      });
    });
  });
};
