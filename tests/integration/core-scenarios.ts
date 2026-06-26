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

    describe('capabilities', () => {
      it('advertises the logging capability over the wire', async () => {
        connected = await harness.connect(makeConfig());
        expect(connected.client.getServerCapabilities()?.logging).toBeDefined();
      });

      it('advertises the resources capability alongside logging when help_center is active', async () => {
        connected = await harness.connect(makeConfig());
        const caps = connected.client.getServerCapabilities();
        expect(caps?.logging).toBeDefined();
        expect(caps?.resources).toBeDefined();
      });
    });

    describe('instructions + topology resource', () => {
      it('sends Help Center instructions referencing the topology resource', async () => {
        connected = await harness.connect(makeConfig());
        const instructions = connected.client.getInstructions();
        expect(instructions).toContain('zendesk-hc://topology');
        expect(instructions).toContain('testsubdomain');
      });

      it('omits instructions and the resource when help_center is filtered out', async () => {
        connected = await harness.connect(
          makeConfig({ mode: 'namespace', namespaces: ['tickets'] }),
        );
        expect(connected.client.getInstructions()).toBeUndefined();
        expect(connected.client.getServerCapabilities()?.resources).toBeUndefined();
      });

      it('omits instructions and the resource when topology is disabled', async () => {
        connected = await harness.connect(makeConfig({ topology: false }));
        expect(connected.client.getInstructions()).toBeUndefined();
        expect(connected.client.getServerCapabilities()?.resources).toBeUndefined();
      });

      it('lists and reads the topology resource with the live tenant structure', async () => {
        connected = await harness.connect(makeConfig());
        const { resources } = await connected.client.listResources();
        expect(resources.map((r) => r.uri)).toContain('zendesk-hc://topology');

        const read = await connected.client.readResource({ uri: 'zendesk-hc://topology' });
        const text = (read.contents ?? [])
          .map((c) => (typeof c.text === 'string' ? c.text : ''))
          .join('\n');
        expect(text).toContain('en-us'); // default locale
        expect(text).toContain('(800)'); // category General
        expect(text).toContain('(600)'); // section FAQ
        expect(text).toContain('admin'); // current user role
      });
    });

    describe('tools/list', () => {
      it('exposes individual tools in "all" mode', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const { tools } = await connected.client.listTools();
        const names = toolNames(tools);

        expect(names).toContain('get_current_user');
        expect(names).toContain('get_ticket');
        expect(names).toContain('create_ticket');
        expect(names).toContain('list_sla_policies');
      });

      it('reaches list_sla_policies over the wire and returns the policy matrix', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'list_sla_policies',
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('SLA contractuels fruggr - Bugs/Incidents');
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

      it('rejects an unknown parameter in "all" mode instead of silently dropping it (#100)', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'list_tickets',
          arguments: { per_page: 3 },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('per_page');
      });

      it('rejects an unknown parameter through a proxy instead of silently dropping it (#100)', async () => {
        connected = await harness.connect(makeConfig({ mode: 'single' }));
        const result = await connected.client.callTool({
          name: 'zendesk',
          arguments: { operation: 'list_tickets', params: { per_page: 3 } },
        });
        expect(result.isError).toBe(true);
        const text = textOf(result);
        expect(text).toContain('per_page');
        expect(text).toContain('page_size');
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
