import { afterEach, describe, expect, it } from 'vitest';
import { errorHandlers, promotedArticlesHandler } from '../msw-handlers';
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

      it('omits instructions and the topology resource when topology is disabled', async () => {
        connected = await harness.connect(makeConfig({ topology: false }));
        expect(connected.client.getInstructions()).toBeUndefined();
        // Instructions are topology-gated. The article resources are a separate,
        // still-enabled feature, so the resources capability is still advertised
        // — only the topology resource itself is gone from the listing.
        expect(connected.client.getServerCapabilities()?.resources).toBeDefined();
        const { resources } = await connected.client.listResources();
        expect(resources.map((r) => r.uri)).not.toContain('zendesk-hc://topology');
      });

      it('omits the resources capability when both resource features are disabled', async () => {
        connected = await harness.connect(makeConfig({ topology: false, articleResources: false }));
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

      it('still renders the topology for a content-editor token that is forbidden the admin-only parts (#161)', async () => {
        mswServer.use(errorHandlers.permissionGroupsForbidden);
        connected = await harness.connect(makeConfig());

        const read = await connected.client.readResource({ uri: 'zendesk-hc://topology' });
        const text = (read.contents ?? [])
          .map((c) => (typeof c.text === 'string' ? c.text : ''))
          .join('\n');
        // The readable structure still comes back instead of a -32603 failure.
        expect(text).toContain('(800)');
        expect(text).toContain('(600)');
        expect(text).toContain('admin');
        // The admin-only section is flagged unavailable, not silently empty.
        expect(text).toMatch(/Guide.?admin/i);
      });
    });

    describe('help-center article resources', () => {
      it('lists only the promoted articles as article resources', async () => {
        mswServer.use(promotedArticlesHandler);
        connected = await harness.connect(makeConfig());
        const { resources } = await connected.client.listResources();
        const uris = resources.map((r) => r.uri);

        expect(uris).toContain('zendesk-hc://article/5001'); // promoted
        expect(uris).not.toContain('zendesk-hc://article/5000'); // not promoted

        // Each article entry carries its own title/description (not the template's
        // generic one) so a resource picker can tell them apart — the entry must
        // not inherit the template metadata verbatim.
        const promoted = resources.find((r) => r.uri === 'zendesk-hc://article/5001');
        expect(promoted?.title).toBe('Featured guide');
        expect(promoted?.description).toContain('Featured guide');
        expect(promoted?.description).toContain('5001');
      });

      it('reads any article id as a Markdown resource', async () => {
        connected = await harness.connect(makeConfig());
        const read = await connected.client.readResource({ uri: 'zendesk-hc://article/5001' });
        const text = (read.contents ?? [])
          .map((c) => (typeof c.text === 'string' ? c.text : ''))
          .join('\n');

        expect(text).toContain('(5001)');
        expect(text).toContain('Testing guide'); // body converted from HTML
        expect(text).not.toContain('<p>'); // not a raw HTML dump
      });

      it('keeps resources/list working (topology still listed) when the promoted scan fails', async () => {
        mswServer.use(errorHandlers.articlesListError);
        connected = await harness.connect(makeConfig());
        const uris = (await connected.client.listResources()).resources.map((r) => r.uri);

        expect(uris).toContain('zendesk-hc://topology');
      });

      it('exposes no article resources when the feature is disabled', async () => {
        mswServer.use(promotedArticlesHandler);
        connected = await harness.connect(makeConfig({ articleResources: false }));
        const uris = (await connected.client.listResources()).resources.map((r) => r.uri);

        expect(uris.some((u) => u.startsWith('zendesk-hc://article/'))).toBe(false);
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
        expect(names).toContain('list_views');
        expect(names).toContain('get_view_tickets');
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
        expect(names).not.toContain('archive_article');
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

      it('reads a view by title and returns its tickets over the wire', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'get_view_tickets',
          arguments: { view: 'Unassigned tickets' },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('Ticket #1');
      });

      it("reads a ticket's change history over the wire", async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'get_ticket_history',
          arguments: { ticket_id: 1 },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('Change history for ticket #1');
        expect(textOf(result)).toContain('**status**: new → open');
      });

      it('uploads and attaches a file when posting a public comment', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'add_public_comment',
          arguments: {
            ticket_id: 1,
            body: 'See attached',
            attachments: [
              { file_name: 'a.log', file_base64: 'aGVsbG8=', content_type: 'text/plain' },
            ],
          },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('with 1 attachment(s)');
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

      it('lists content tags with defaults applied and filters by name prefix (#132)', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));

        // No arguments: the schema defaults (sort=name, page_size=30) are
        // applied by the SDK, so the full referential comes back enumerable.
        const all = await connected.client.callTool({
          name: 'list_content_tags',
          arguments: {},
        });
        expect(all.isError).toBeFalsy();
        const allText = textOf(all);
        expect(allText).toContain('ai');
        expect(allText).toContain('mistral');

        // name_prefix narrows the listing to a single tag.
        const filtered = await connected.client.callTool({
          name: 'list_content_tags',
          arguments: { name_prefix: 'mi' },
        });
        expect(filtered.isError).toBeFalsy();
        const filteredText = textOf(filtered);
        expect(filteredText).toContain('mistral');
        expect(filteredText).not.toContain('scanner');
      });

      it('compares translations, surfacing the outdated flag and section status over the wire (#135)', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'compare_translations',
          arguments: { article_id: 5000, source_locale: 'fr', target_locale: 'en-us' },
        });

        expect(result.isError).toBeFalsy();
        const text = textOf(result);
        // en-us is outdated:true in the translations-list fixture.
        expect(text).toContain('outdated flag');
        expect(text.toLowerCase()).toContain('yes');
        // Per-section presence status, not a word-count verdict.
        expect(text).toContain('| Idx | Heading | Status');
        expect(text).not.toContain('different');
      });

      it('archives a Help Center article over the wire when confirmed', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'archive_article',
          arguments: { article_id: 5000, confirm: true },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('Article #5000 archived');
      });

      it('reorders a Help Center article over the wire', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'reorder_article',
          arguments: { article_id: 5000, target: 'bottom' },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('section #600');
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
