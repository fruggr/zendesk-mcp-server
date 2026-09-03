import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { errorHandlers, MOCK_PROMOTED_ARTICLE, promotedArticlesHandler } from '../msw-handlers';
import { mswServer } from '../setup';
import { type ConnectedClient, type IntegrationHarness, makeConfig } from './harness';

/** Names of the text blocks returned by a tool call, joined for easy asserts. */
const textOf = (result: { content?: Array<{ type: string; text?: string }> }): string =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

const toolNames = (tools: Array<{ name: string }>): string[] => tools.map((t) => t.name);

/** Text of a resources/read result, joined for easy asserts. */
const resourceTextOf = (read: { contents?: Array<{ text?: unknown }> }): string =>
  (read.contents ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');

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

      it('keeps the read-by-id article resource (and the resources capability) when topology and promoted listing are both off', async () => {
        connected = await harness.connect(makeConfig({ topology: false, promotedArticles: false }));
        expect(connected.client.getInstructions()).toBeUndefined();
        // Read-by-id stays registered whenever help_center is active, so the
        // resources capability persists; only the topology resource and the promoted
        // listing are gone. (Namespace filtering is what removes resources entirely.)
        expect(connected.client.getServerCapabilities()?.resources).toBeDefined();
        const uris = (await connected.client.listResources()).resources.map((r) => r.uri);
        expect(uris).not.toContain('zendesk-hc://topology');
        expect(uris.some((u) => u.startsWith('zendesk-hc://article/'))).toBe(false);
      });

      it('lists and reads the topology resource with the live tenant structure', async () => {
        connected = await harness.connect(makeConfig());
        const { resources } = await connected.client.listResources();
        expect(resources.map((r) => r.uri)).toContain('zendesk-hc://topology');

        const read = await connected.client.readResource({ uri: 'zendesk-hc://topology' });
        const text = resourceTextOf(read);
        expect(text).toContain('en-us'); // default locale
        expect(text).toContain('(800)'); // category General
        expect(text).toContain('(600)'); // section FAQ
        expect(text).toContain('admin'); // current user role
      });

      it('exposes the resource and instructions under a custom scheme when --hc-resource-scheme is set (#169)', async () => {
        connected = await harness.connect(makeConfig({ hcResourceScheme: 'wiki' }));

        const instructions = connected.client.getInstructions();
        expect(instructions).toContain('wiki://topology');
        expect(instructions).not.toContain('zendesk-hc://');

        const { resources } = await connected.client.listResources();
        expect(resources.map((r) => r.uri)).toContain('wiki://topology');
        expect(resources.map((r) => r.uri)).not.toContain('zendesk-hc://topology');

        const read = await connected.client.readResource({ uri: 'wiki://topology' });
        const text = resourceTextOf(read);
        expect(text).toContain('en-us');
        expect(text).toContain('(800)');
      });

      it('still renders the topology for a content-editor token that is forbidden the admin-only parts (#161)', async () => {
        mswServer.use(errorHandlers.permissionGroupsForbidden);
        connected = await harness.connect(makeConfig());

        const read = await connected.client.readResource({ uri: 'zendesk-hc://topology' });
        const text = resourceTextOf(read);
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

      it('disables the promoted pre-listing (zero scan, tool gone) but keeps read-by-id when --no-promoted-articles', async () => {
        // Count any /articles scan: with the pre-listing off there must be none. A
        // successful handler (not an error one) would let an accidental scan pass
        // silently on the "no entries" check alone, so assert the request count too.
        let scanCount = 0;
        mswServer.use(
          http.get('https://testsubdomain.zendesk.com/api/v2/help_center/articles', () => {
            scanCount += 1;
            return HttpResponse.json({
              articles: [MOCK_PROMOTED_ARTICLE],
              meta: { has_more: false, after_cursor: '' },
              count: 1,
            });
          }),
        );
        connected = await harness.connect(makeConfig({ mode: 'all', promotedArticles: false }));

        // The list callback short-circuits → no promoted entries AND no scan request.
        const uris = (await connected.client.listResources()).resources.map((r) => r.uri);
        expect(uris.some((u) => u.startsWith('zendesk-hc://article/'))).toBe(false);
        expect(scanCount).toBe(0);

        // ...and the companion tool is gone.
        const names = toolNames((await connected.client.listTools()).tools);
        expect(names).not.toContain('list_promoted_articles');

        // ...but reading an UNLISTED (non-promoted) article by id still works —
        // read-by-id is NOT disabled by the flag. Article 5000 is never promoted.
        const read = await connected.client.readResource({ uri: 'zendesk-hc://article/5000' });
        expect(resourceTextOf(read)).toContain('(5000)');
      });

      it('exposes the list_promoted_articles tool when the feature is enabled (default)', async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const names = toolNames((await connected.client.listTools()).tools);
        expect(names).toContain('list_promoted_articles');
      });

      it('honors a custom --hc-resource-scheme for both listing and reading (#169)', async () => {
        mswServer.use(promotedArticlesHandler);
        connected = await harness.connect(makeConfig({ hcResourceScheme: 'wiki' }));
        const uris = (await connected.client.listResources()).resources.map((r) => r.uri);

        expect(uris).toContain('wiki://article/5001');
        expect(uris).not.toContain('zendesk-hc://article/5001');

        const read = await connected.client.readResource({ uri: 'wiki://article/5001' });
        expect(resourceTextOf(read)).toContain('(5001)');
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
        expect(names).not.toContain('set_section_translation');
        expect(names).not.toContain('set_category_translation');
        // The read side of the same feature survives the filter.
        expect(names).toContain('find_translation_gaps');
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

      it("reads a ticket's comment thread newest-first over the wire", async () => {
        connected = await harness.connect(makeConfig({ mode: 'all' }));
        const result = await connected.client.callTool({
          name: 'list_ticket_comments',
          arguments: { ticket_id: 1 },
        });

        expect(result.isError).toBeFalsy();
        const text = textOf(result);
        expect(text).toContain('# Comments on ticket #1 (newest first)');
        // Defaults applied end-to-end: newest first, author resolved to a name.
        expect(text).toContain('### Internal note (id 3001) by User 9998 (9998)');
        expect(text.indexOf('id 3001')).toBeLessThan(text.indexOf('id 3000'));
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

      it('audits then publishes a section translation through the help_center proxy (#224)', async () => {
        connected = await harness.connect(makeConfig({ mode: 'namespace' }));

        // Section 600 has a `fr` translation that is still a draft, so the audit
        // must report it as a draft rather than as missing.
        const audit = await connected.client.callTool({
          name: 'zendesk_help_center',
          arguments: { operation: 'find_translation_gaps', params: { locale: 'fr' } },
        });
        expect(audit.isError).toBeFalsy();
        expect(textOf(audit)).toContain('(600) — draft translation (not published)');

        const published = await connected.client.callTool({
          name: 'zendesk_help_center',
          arguments: {
            operation: 'set_section_translation',
            params: { section_id: 600, locale: 'fr', draft: false },
          },
        });
        expect(published.isError).toBeFalsy();
        expect(textOf(published)).toContain('Translation updated for section #600 in "fr"');

        // The category level is iso with the section one and shares the same
        // upsert, but its write path could not be validated against the live
        // tenant (#225, S12), so it gets its own wire-level pass here.
        const category = await connected.client.callTool({
          name: 'zendesk_help_center',
          arguments: {
            operation: 'set_category_translation',
            params: { category_id: 800, locale: 'fr', name: 'Général' },
          },
        });
        expect(category.isError).toBeFalsy();
        expect(textOf(category)).toContain('Translation updated for category #800 in "fr"');
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
