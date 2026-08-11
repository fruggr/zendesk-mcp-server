import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createHelpCenterTools } from '../../../src/tools/help-center';
import {
  MOCK_ARTICLE,
  MOCK_CATEGORY,
  MOCK_CATEGORY_TRANSLATION,
  MOCK_SECTION,
  MOCK_SECTION_TRANSLATION,
  MOCK_TRANSLATION,
  manyContentTagsHandler,
  promotedArticlesHandler,
} from '../../msw-handlers';
import { mswServer } from '../../setup';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };
const HC_BASE = 'https://testsubdomain.zendesk.com/api/v2/help_center';

const findTool = (name: string) => {
  const tools = createHelpCenterTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

describe('help center tools', () => {
  it('creates 29 tools', () => {
    expect(createHelpCenterTools(ctx)).toHaveLength(29);
  });

  describe('list_promoted_articles', () => {
    it('lists only the promoted articles, with the admin-only status note', async () => {
      mswServer.use(promotedArticlesHandler);
      const tool = findTool('list_promoted_articles');
      const result = await tool.handler({});
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('Featured guide'); // promoted (5001)
      expect(text).toContain('5001');
      expect(text).not.toContain('How to test'); // non-promoted (5000) filtered out
      // The admin-only caveat rides along on each promoted article.
      expect(text).toContain('**Promoted**');
      expect(text).toMatch(/Help Center admin|Guide admin/);
    });

    it('reports when nothing is promoted', async () => {
      // The default /articles handler returns a single non-promoted article.
      const tool = findTool('list_promoted_articles');
      const result = await tool.handler({});
      expect(result.content[0]?.text).toContain('No promoted articles');
    });

    it('flags truncation and the API cost when the scan hits the page cap', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/articles`, () =>
          HttpResponse.json({
            articles: [{ ...MOCK_ARTICLE, id: 5001, promoted: true }],
            meta: { has_more: true, after_cursor: 'next-cursor' },
            count: 100,
          }),
        ),
      );
      const tool = findTool('list_promoted_articles');
      const result = await tool.handler({});
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/cap|omitted|missing/i);
      expect(text).toMatch(/Zendesk API request/i); // surfaces the cost to the LLM
    });

    it('surfaces the scan cost when it fans out over several pages', async () => {
      let n = 0;
      mswServer.use(
        http.get(`${HC_BASE}/articles`, () => {
          n += 1;
          return HttpResponse.json({
            articles: [{ ...MOCK_ARTICLE, id: 5000 + n, promoted: true }],
            meta: { has_more: n < 2, after_cursor: n < 2 ? 'next' : '' },
            count: 2,
          });
        }),
      );
      const tool = findTool('list_promoted_articles');
      const result = await tool.handler({});
      const text = result.content[0]?.text ?? '';
      expect(text).not.toMatch(/cap/i); // not truncated
      expect(text).toContain('2 Zendesk API requests');
    });
  });

  describe('search_articles', () => {
    it('searches articles', async () => {
      const tool = findTool('search_articles');
      const result = await tool.handler({ query: 'testing', per_page: 100, page: 1 });
      expect(result.content[0]?.text).toContain('How to test');
    });

    it('does not include article body', async () => {
      const tool = findTool('search_articles');
      const result = await tool.handler({ query: 'testing', per_page: 100, page: 1 });
      expect(result.content[0]?.text).not.toContain('Testing guide');
    });
  });

  describe('get_article', () => {
    it('returns article with translations list', async () => {
      const tool = findTool('get_article');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('How to test');
      expect(result.content[0]?.text).toContain('Available translations');
      expect(result.content[0]?.text).toContain('fr');
    });

    it('supports locale parameter', async () => {
      const tool = findTool('get_article');
      const result = await tool.handler({ article_id: 5000, locale: 'fr' });
      expect(result.content[0]?.text).toContain('5000');
    });

    it('does not show the large-article hint on small articles', async () => {
      const tool = findTool('get_article');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).not.toContain('get_article_outline');
    });

    it('prepends a hint pointing to get_article_outline on large articles (by size)', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/articles/:id`, () =>
          HttpResponse.json({
            article: { ...MOCK_ARTICLE, body: '<p>x</p>'.repeat(500) },
          }),
        ),
      );
      const tool = findTool('get_article');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('get_article_outline');
      expect(result.content[0]?.text).toContain('update_article_section');
    });

    it('prepends a hint pointing to get_article_outline on multi-section articles', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/articles/:id`, () =>
          HttpResponse.json({
            article: {
              ...MOCK_ARTICLE,
              body: '<h2>A</h2><p>1</p><h2>B</h2><p>2</p><h2>C</h2><p>3</p><h2>D</h2><p>4</p>',
            },
          }),
        ),
      );
      const tool = findTool('get_article');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('get_article_outline');
    });
  });

  describe('update_article_translation description', () => {
    it('steers callers toward update_article_section for targeted edits', () => {
      const tool = findTool('update_article_translation');
      expect(tool.description).toContain('update_article_section');
    });
  });

  describe('get_article description', () => {
    it('mentions get_article_outline as a lighter alternative', () => {
      const tool = findTool('get_article');
      expect(tool.description).toContain('get_article_outline');
    });
  });

  describe('list_categories', () => {
    it('lists categories', async () => {
      const tool = findTool('list_categories');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).toContain('General');
    });
  });

  describe('list_sections', () => {
    it('lists sections', async () => {
      const tool = findTool('list_sections');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).toContain('FAQ');
    });

    it('filters by category_id', async () => {
      const tool = findTool('list_sections');
      const result = await tool.handler({ category_id: 800, page_size: 25 });
      expect(result.content[0]?.text).toContain('FAQ');
    });
  });

  describe('list_articles', () => {
    it('lists articles', async () => {
      const tool = findTool('list_articles');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).toContain('How to test');
    });

    it('does not include article body', async () => {
      const tool = findTool('list_articles');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).not.toContain('Testing guide');
    });

    it('filters by section_id', async () => {
      const tool = findTool('list_articles');
      const result = await tool.handler({ section_id: 600, page_size: 25 });
      expect(result.content[0]?.text).toContain('How to test');
    });

    it('filters by locale', async () => {
      const tool = findTool('list_articles');
      const result = await tool.handler({ locale: 'fr', page_size: 25 });
      expect(result.content[0]?.text).toContain('How to test');
    });

    it('includes translation locales when include_translations is true', async () => {
      const tool = findTool('list_articles');
      const result = await tool.handler({ page_size: 25, include_translations: true });
      expect(result.content[0]?.text).toContain('Translations');
      expect(result.content[0]?.text).toContain('fr');
      expect(result.content[0]?.text).toContain('en-us');
    });

    it('supports sort_by and sort_order', async () => {
      const tool = findTool('list_articles');
      const result = await tool.handler({
        page_size: 25,
        sort_by: 'created_at',
        sort_order: 'desc',
      });
      expect(result.content[0]?.text).toContain('How to test');
    });
  });

  describe('list_article_translations', () => {
    it('lists translations for an article', async () => {
      const tool = findTool('list_article_translations');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('fr');
      expect(result.content[0]?.text).toContain('Comment tester');
    });

    it('does not include translation body', async () => {
      const tool = findTool('list_article_translations');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).not.toContain('Guide de test');
    });
  });

  describe('create_article_translation', () => {
    it('creates a translation', async () => {
      const tool = findTool('create_article_translation');
      const result = await tool.handler({
        article_id: 5000,
        locale: 'fr',
        title: 'Comment tester',
        body: '<p>Guide</p>',
        draft: false,
      });
      expect(result.content[0]?.text).toContain('Translation created');
      expect(result.content[0]?.text).toContain('"fr"');
    });
  });

  describe('update_article_translation', () => {
    it('updates a translation', async () => {
      const tool = findTool('update_article_translation');
      const result = await tool.handler({
        article_id: 5000,
        locale: 'fr',
        title: 'Updated title',
      });
      expect(result.content[0]?.text).toContain('Translation updated');
    });
  });

  // The tools originally told callers that a locale-filtered listing omits a
  // draft-translated node just as it omits an untranslated one, so "absent from
  // list_sections(locale)" was the whole story. Validating #225 against a live
  // tenant disproved the draft half: with an admin token such a node IS returned,
  // under its draft name. An agent reading the old wording would conclude
  // "listed ⇒ published" on exactly the path these tools exist to fix.
  describe('translation-gap tool descriptions', () => {
    it.each(['list_section_translations', 'list_category_translations', 'find_translation_gaps'])(
      '%s does not promise that a draft translation is hidden from the locale listing',
      (name) => {
        const { description } = findTool(name);
        expect(description).toMatch(/draft.*may still be listed|may still be listed.*draft/is);
        expect(description).not.toMatch(/omits.*unpublished draft|invisible to list_sections/is);
      },
    );
  });

  describe('list_section_translations', () => {
    it('reports each locale with its draft state and whether a description is set', async () => {
      const result = await findTool('list_section_translations').handler({ section_id: 600 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Translation: en-us (7100)');
      expect(text).toContain('Translation: fr (7101)');
      // `title` is the localized NAME here, not an article title — the rendering
      // has to say so, otherwise the caller maps the wrong field back.
      expect(text).toContain('**Name**: FAQ (fr)');
      expect(text).not.toContain('**Title**');
      expect(text).toContain('**Draft**: true');
      expect(text).toContain('**Draft**: false');
      expect(text).toContain('**Description**: set');
    });

    it('renders an empty description as "empty" rather than dropping the line', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/sections/:id/translations`, () =>
          HttpResponse.json({
            translations: [{ ...MOCK_SECTION_TRANSLATION, body: '' }],
          }),
        ),
      );
      const result = await findTool('list_section_translations').handler({ section_id: 600 });
      expect(result.content[0]?.text).toContain('**Description**: empty');
    });
  });

  describe('list_category_translations', () => {
    it('lists the category translations with the localized names', async () => {
      const result = await findTool('list_category_translations').handler({ category_id: 800 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Translation: en-us (7200)');
      expect(text).toContain('**Name**: Général');
      expect(text).not.toContain('**Draft**: true');
    });
  });

  describe('set_section_translation', () => {
    // Captures what actually reached Zendesk: the method, the path (locale
    // spelling included) and the `translation` payload.
    const captureWrites = () => {
      const writes: Array<{ method: string; path: string; payload: Record<string, unknown> }> = [];
      const record = async (method: string, request: Request) => {
        const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        writes.push({
          method,
          path: new URL(request.url).pathname,
          payload: (payload['translation'] as Record<string, unknown>) ?? {},
        });
      };
      mswServer.use(
        http.post(`${HC_BASE}/sections/:id/translations`, async ({ request }) => {
          await record('POST', request.clone());
          return HttpResponse.json({ translation: { ...MOCK_SECTION_TRANSLATION, locale: 'de' } });
        }),
        http.put(`${HC_BASE}/sections/:id/translations/:locale`, async ({ request, params }) => {
          await record('PUT', request.clone());
          return HttpResponse.json({
            translation: {
              ...MOCK_SECTION_TRANSLATION,
              id: 7101,
              locale: params['locale'] as string,
              draft: false,
            },
          });
        }),
      );
      return writes;
    };

    it('creates the translation when the locale has none, mapping name/description', async () => {
      const writes = captureWrites();
      const result = await findTool('set_section_translation').handler({
        section_id: 600,
        locale: 'de',
        name: 'Häufige Fragen',
        description: 'Oft gestellte Fragen',
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.method).toBe('POST');
      expect(writes[0]?.payload).toEqual({
        locale: 'de',
        title: 'Häufige Fragen',
        body: 'Oft gestellte Fragen',
        // Creating publishes by default, so the section is actually reachable.
        draft: false,
      });
      expect(result.content[0]?.text).toContain('Translation created for section #600 in "de"');
      expect(result.content[0]?.text).toContain('(published)');
    });

    it('defaults the description to empty on creation rather than omitting it', async () => {
      const writes = captureWrites();
      await findTool('set_section_translation').handler({
        section_id: 600,
        locale: 'de',
        name: 'Häufige Fragen',
      });
      expect(writes[0]?.payload).toEqual({
        locale: 'de',
        title: 'Häufige Fragen',
        body: '',
        draft: false,
      });
    });

    it('refuses to create without a name, naming the section and the locale', async () => {
      await expect(
        findTool('set_section_translation').handler({ section_id: 600, locale: 'de' }),
      ).rejects.toThrow(/section #600 has no "de" translation yet.*"name" is required/s);
    });

    it('updates an existing translation, sending only the fields passed', async () => {
      const writes = captureWrites();
      const result = await findTool('set_section_translation').handler({
        section_id: 600,
        locale: 'fr',
        draft: false,
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.method).toBe('PUT');
      // Publishing a draft must not blank the existing name or description.
      expect(writes[0]?.payload).toEqual({ draft: false });
      expect(result.content[0]?.text).toContain('Translation updated for section #600 in "fr"');
      expect(result.content[0]?.text).toContain('(published)');
    });

    it('clears the description when an empty string is passed explicitly', async () => {
      const writes = captureWrites();
      await findTool('set_section_translation').handler({
        section_id: 600,
        locale: 'fr',
        description: '',
      });
      expect(writes[0]?.payload).toEqual({ body: '' });
    });

    it("writes to Zendesk's spelling of the locale, not the caller's casing", async () => {
      const writes = captureWrites();
      await findTool('set_section_translation').handler({
        section_id: 600,
        locale: 'FR',
        name: 'FAQ (fr)',
      });
      expect(writes[0]?.method).toBe('PUT');
      expect(writes[0]?.path).toMatch(/\/sections\/600\/translations\/fr$/);
    });

    it('refuses a no-op update rather than reporting a write that changed nothing', async () => {
      const writes = captureWrites();
      await expect(
        findTool('set_section_translation').handler({ section_id: 600, locale: 'fr' }),
      ).rejects.toThrow(/Nothing to write.*already has a "fr" translation/s);
      expect(writes).toHaveLength(0);
    });

    it('reports a translation left as a draft as not visible to end users', async () => {
      mswServer.use(
        http.put(`${HC_BASE}/sections/:id/translations/:locale`, () =>
          HttpResponse.json({
            translation: { ...MOCK_SECTION_TRANSLATION, locale: 'fr', draft: true },
          }),
        ),
      );
      const result = await findTool('set_section_translation').handler({
        section_id: 600,
        locale: 'fr',
        draft: true,
      });
      expect(result.content[0]?.text).toContain('(draft, not visible to end users)');
    });
  });

  describe('set_category_translation', () => {
    it('creates the translation on the categories endpoint with the mapped fields', async () => {
      let path = '';
      let payload: Record<string, unknown> = {};
      mswServer.use(
        http.post(`${HC_BASE}/categories/:id/translations`, async ({ request }) => {
          path = new URL(request.url).pathname;
          const body = (await request.json()) as Record<string, unknown>;
          payload = (body['translation'] as Record<string, unknown>) ?? {};
          return HttpResponse.json({
            translation: { ...MOCK_CATEGORY_TRANSLATION, locale: 'de', title: 'Allgemein' },
          });
        }),
      );
      const result = await findTool('set_category_translation').handler({
        category_id: 800,
        locale: 'de',
        name: 'Allgemein',
        draft: true,
      });
      expect(path).toMatch(/\/categories\/800\/translations$/);
      expect(payload).toEqual({ locale: 'de', title: 'Allgemein', body: '', draft: true });
      expect(result.content[0]?.text).toContain('Translation created for category #800 in "de"');
    });

    it('updates an existing category translation instead of creating a duplicate', async () => {
      const result = await findTool('set_category_translation').handler({
        category_id: 800,
        locale: 'fr',
        name: 'Général',
      });
      expect(result.content[0]?.text).toContain('Translation updated for category #800 in "fr"');
    });

    it('refuses to create without a name, naming the category', async () => {
      await expect(
        findTool('set_category_translation').handler({ category_id: 800, locale: 'de' }),
      ).rejects.toThrow(/category #800 has no "de" translation yet/);
    });
  });

  describe('find_translation_gaps', () => {
    // The default fixtures give category 800 a published `fr` translation and
    // section 600 a draft one, i.e. one gap of each interesting kind once the
    // listing is widened.
    const seedTree = (sectionIds: number[], categoryIds: number[]) => {
      mswServer.use(
        http.get(`${HC_BASE}/sections`, () =>
          HttpResponse.json({
            sections: sectionIds.map((id) => ({ ...MOCK_SECTION, id, name: `Section ${id}` })),
            meta: { has_more: false, after_cursor: '' },
            count: sectionIds.length,
          }),
        ),
        http.get(`${HC_BASE}/categories`, () =>
          HttpResponse.json({
            categories: categoryIds.map((id) => ({
              ...MOCK_CATEGORY,
              id,
              name: `Category ${id}`,
            })),
            meta: { has_more: false, after_cursor: '' },
            count: categoryIds.length,
          }),
        ),
      );
    };

    it('tells a missing translation apart from an unpublished draft', async () => {
      seedTree([600, 601, 602], [800, 801]);
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('# Translation gaps — "fr"');
      expect(text).toContain('**Section 600** (600) — draft translation (not published)');
      expect(text).toContain('**Section 601** (601) — no translation');
      // 602 and 800 have a published `fr` translation, so they are not gaps.
      expect(text).not.toContain('(602)');
      expect(text).not.toContain('(800)');
      expect(text).toContain('**Category 801** (801) — no translation');
      expect(text).toContain('3 node(s) need a published "fr" translation');
      expect(text).toContain('set_section_translation');
    });

    it('reports the number of nodes actually scanned per level', async () => {
      seedTree([600, 601, 602], [800, 801]);
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      expect(result.content[0]?.text).toContain('## Sections (3 scanned)');
      expect(result.content[0]?.text).toContain('## Categories (2 scanned)');
    });

    it('says so positively when nothing is missing', async () => {
      seedTree([602], [800]);
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain(
        'No gaps: all 1 category/ies and 1 section(s) scanned have a published "fr" translation',
      );
      expect(text).not.toContain('node(s) need a published');
    });

    it('narrows the audit to one category, fetching that category directly', async () => {
      const paths: string[] = [];
      seedTree([600], [800, 801]);
      mswServer.use(
        http.get(`${HC_BASE}/categories/:id`, ({ request, params }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json({
            category: { ...MOCK_CATEGORY, id: Number(params['id']), name: 'Legal' },
          });
        }),
        http.get(`${HC_BASE}/categories/:cid/sections`, ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json({
            sections: [{ ...MOCK_SECTION, id: 601, name: 'Section 601' }],
            meta: { has_more: false, after_cursor: '' },
            count: 1,
          });
        }),
      );
      const result = await findTool('find_translation_gaps').handler({
        locale: 'fr',
        category_id: 801,
      });
      const text = result.content[0]?.text ?? '';
      // The scoped category is read on its own, not filtered out of a capped
      // listing that could omit it entirely.
      expect(paths).toContain('/api/v2/help_center/categories/801');
      expect(paths.some((p) => p.endsWith('/categories/801/sections'))).toBe(true);
      expect(text).toContain('## Categories (1 scanned)');
      expect(text).toContain('**Legal** (801) — no translation');
      expect(text).toContain('**Section 601** (601) — no translation');
      expect(text).not.toContain('(800)');
      expect(text).not.toContain('(600)');
    });

    it('does not claim an empty level is fully translated', async () => {
      seedTree([], [800]);
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('## Sections (0 scanned)');
      expect(text).toContain('_(none to scan at this level)_');
      expect(text).not.toContain('every one scanned has a published translation\n\n_(none to');
    });

    it('warns when the audited locale is not active, instead of crying gap', async () => {
      seedTree([600], [800]);
      const result = await findTool('find_translation_gaps').handler({ locale: 'es' });
      const text = result.content[0]?.text ?? '';
      // MOCK_LOCALES is en-us + fr.
      expect(text).toContain('"es" is not an active locale');
      expect(text).toContain('en-us, fr');
      expect(text).toContain('**Section 600** (600) — no translation');
    });

    it('does not warn for an active locale spelled with a different case', async () => {
      seedTree([600], [800]);
      const result = await findTool('find_translation_gaps').handler({ locale: 'FR' });
      expect(result.content[0]?.text).not.toContain('is not an active locale');
    });

    it('caps the scan and names what it left out', async () => {
      seedTree(
        Array.from({ length: 61 }, (_, i) => 1000 + i),
        [800],
      );
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      const text = result.content[0]?.text ?? '';
      // 1 category consumes one slot of the 60-node budget, leaving 59 sections.
      expect(text).toContain('## Sections (59 scanned)');
      expect(text).toContain('the scan stopped at its 60-node cap');
      expect(text).toContain('covering 1/1 categories and 59/61 sections');
      expect(text).toContain('ZENDESK_TRANSLATION_GAP_SCAN_MAX_NODES');
    });

    it('does not pass off a level the cap never reached as an empty one', async () => {
      // 60 categories spend the whole budget, so the sections below it are not
      // scanned at all. Saying "none to scan at this level" there would read as
      // "this Help Center has no sections", the opposite of the truth.
      seedTree(
        [600, 601],
        Array.from({ length: 60 }, (_, i) => 900 + i),
      );
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('## Sections (0 scanned)');
      expect(text).not.toContain('_(none to scan at this level)_');
      expect(text).toContain('the 60-node cap was spent before this level');
      expect(text).toContain('2 left unchecked');
      expect(text).toContain('covering 60/60 categories and 0/2 sections');
    });

    it('probes the tree in bounded waves rather than one burst', async () => {
      let inFlight = 0;
      let peak = 0;
      seedTree(
        Array.from({ length: 20 }, (_, i) => 1000 + i),
        [],
      );
      mswServer.use(
        http.get(`${HC_BASE}/sections/:id/translations`, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return HttpResponse.json({ translations: [] });
        }),
      );
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      // Zendesk caps concurrent requests per account, and one 429 would sink the
      // whole audit, so the fan-out stays small however many nodes are scanned.
      expect(peak).toBeLessThanOrEqual(5);
      expect(result.content[0]?.text).toContain('## Sections (20 scanned)');
    });

    it('flags a tree too large to enumerate from a single listing page', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/sections`, () =>
          HttpResponse.json({
            sections: [MOCK_SECTION],
            meta: { has_more: true, after_cursor: 'next' },
            count: 1,
          }),
        ),
      );
      const result = await findTool('find_translation_gaps').handler({ locale: 'fr' });
      expect(result.content[0]?.text).toContain('only the first page of each was considered');
    });

    it('asks Zendesk for the audited locale only', async () => {
      const queries: string[] = [];
      seedTree([600], [800]);
      mswServer.use(
        http.get(`${HC_BASE}/sections/:id/translations`, ({ request }) => {
          queries.push(new URL(request.url).search);
          return HttpResponse.json({ translations: [] });
        }),
      );
      await findTool('find_translation_gaps').handler({ locale: 'fr' });
      expect(queries).toEqual(['?locales=fr']);
    });

    it("asks for the locale in Zendesk's own casing, whatever the caller passed", async () => {
      // Locales are stored lower-cased upstream. Should the `locales` filter be
      // case-sensitive — undocumented either way — a verbatim "FR" would come back
      // empty and report every node as untranslated, while the active-locale check
      // (case-insensitive) stayed mute. Normalizing removes the question.
      const queries: string[] = [];
      seedTree([600], [800]);
      mswServer.use(
        http.get(`${HC_BASE}/sections/:id/translations`, ({ request }) => {
          queries.push(new URL(request.url).search);
          return HttpResponse.json({
            translations: [{ ...MOCK_SECTION_TRANSLATION, locale: 'fr', draft: false }],
          });
        }),
      );
      const result = await findTool('find_translation_gaps').handler({ locale: 'FR' });
      expect(queries).toEqual(['?locales=fr']);
      expect(result.content[0]?.text).not.toContain('(600) — no translation');
    });
  });

  describe('list_permission_groups', () => {
    it('lists permission groups', async () => {
      const tool = findTool('list_permission_groups');
      const result = await tool.handler({});
      expect(result.content[0]?.text).toContain('Editors');
      expect(result.content[0]?.text).toContain('12001');
    });

    it('explains the Guide-admin requirement (and the fallback) on a 403', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/guide/permission_groups', () =>
          HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
        ),
      );
      const tool = findTool('list_permission_groups');
      const error = await tool.handler({}).then(
        () => {
          throw new Error('expected list_permission_groups to reject on 403');
        },
        (err: unknown) => err as Error,
      );
      expect(error.message).toMatch(/Guide.?admin|admin/i);
      expect(error.message).toMatch(/get_article/);
    });
  });

  describe('create_article', () => {
    it('creates an article with permission_group_id', async () => {
      const tool = findTool('create_article');
      const result = await tool.handler({
        section_id: 600,
        title: 'New article',
        body: '<p>Content</p>',
        permission_group_id: 12001,
        draft: true,
        promoted: false,
      });
      expect(result.content[0]?.text).toContain('Article #5000 created');
    });
  });

  describe('update_article', () => {
    it('updates an article', async () => {
      const tool = findTool('update_article');
      const result = await tool.handler({ article_id: 5000, draft: false });
      expect(result.content[0]?.text).toContain('Article #5000 updated');
    });

    it('forwards position to reposition the article within its section', async () => {
      const tool = findTool('update_article');
      const result = await tool.handler({ article_id: 5000, position: 7 });
      expect(result.content[0]?.text).toContain('**Position**: 7');
    });

    it('documents how to move an article to the end of its section', () => {
      const tool = findTool('update_article');
      const field = (tool.inputSchema as { shape: { position: { description?: string } } }).shape
        .position;
      expect(field.description).toContain('P + 1');
      expect(tool.inputSchema.parse({ article_id: 5000, position: 3 })).toMatchObject({
        position: 3,
      });
    });
  });

  describe('reorder_article', () => {
    // Stateful section mock: GET returns the section's articles in effective order,
    // PUT mutates positions and records the write sequence. This lets the tool's
    // post-write verification observe the effect, the way a real manual section
    // behaves. Pass fixedOrder to simulate an auto-sorted section (GET ignores the
    // written positions). Pass foreignSections to place a looked-up article in
    // another section.
    const seedSection = (
      sectionId: number,
      articles: Array<{ id: number; position: number }>,
      opts: {
        fixedOrder?: number[];
        foreignSections?: Record<number, number>;
        missing?: number[];
        failPutOn?: number;
      } = {},
    ) => {
      const state = new Map(articles.map((a) => [a.id, a.position]));
      const writes: Array<{ id: number; position: number }> = [];
      const listPaths: string[] = [];
      const article = (id: number, secId: number) => ({
        ...MOCK_ARTICLE,
        id,
        section_id: secId,
        position: state.get(id) ?? 0,
      });
      mswServer.use(
        http.get(`${HC_BASE}/articles/:id`, ({ params }) => {
          const id = Number(params['id']);
          if (opts.missing?.includes(id)) return new HttpResponse(null, { status: 404 });
          return HttpResponse.json({
            article: article(id, opts.foreignSections?.[id] ?? sectionId),
          });
        }),
        // Locale-scoped path: reorder_article lists the section under the
        // article's locale (Zendesk 400s the locale-less endpoint when the
        // section's default sort is locale-dependent).
        http.get(`${HC_BASE}/:locale/sections/${sectionId}/articles`, ({ request }) => {
          listPaths.push(new URL(request.url).pathname);
          const ids = opts.fixedOrder
            ? opts.fixedOrder
            : [...state.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([id]) => id);
          const ordered = ids.map((id) => article(id, sectionId));
          return HttpResponse.json({
            articles: ordered,
            meta: { has_more: false, after_cursor: '' },
            count: ordered.length,
          });
        }),
        http.put(`${HC_BASE}/articles/:id`, async ({ request, params }) => {
          const id = Number(params['id']);
          if (opts.failPutOn === id) return new HttpResponse(null, { status: 500 });
          const body = (await request.json().catch(() => ({}))) as {
            article?: { position?: number };
          };
          const position = body.article?.position;
          if (typeof position === 'number') {
            state.set(id, position);
            writes.push({ id, position });
          }
          return HttpResponse.json({ article: { ...MOCK_ARTICLE, id, position } });
        }),
      );
      return { writes, listPaths };
    };

    const seq = (n: number, position: number) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, position }));

    it('lists the section scoped to the article locale (avoids the locale-less 400)', async () => {
      const { listPaths } = seedSection(600, [
        { id: 1, position: 0 },
        { id: 2, position: 1 },
      ]);
      await findTool('reorder_article').handler({ article_id: 1, target: 'bottom' });
      // MOCK_ARTICLE.source_locale is "en-us"; every section listing must carry it.
      expect(listPaths.length).toBeGreaterThan(0);
      expect(listPaths.every((p) => p.includes('/en-us/sections/600/articles'))).toBe(true);
    });

    it('moves an article to the bottom in a single write', async () => {
      const { writes } = seedSection(600, [
        { id: 1, position: 0 },
        { id: 2, position: 1 },
        { id: 3, position: 2 },
      ]);
      const result = await findTool('reorder_article').handler({ article_id: 1, target: 'bottom' });
      expect(writes).toEqual([{ id: 1, position: 3 }]);
      expect(result.content[0]?.text).toContain('moved to bottom');
      expect(result.content[0]?.text).toContain('1 article repositioned');
    });

    it('moves an article before a reference using an existing gap (single write)', async () => {
      const { writes } = seedSection(600, [
        { id: 1, position: 0 },
        { id: 2, position: 10 },
        { id: 3, position: 20 },
      ]);
      const result = await findTool('reorder_article').handler({
        article_id: 3,
        target: 'before',
        reference_article_id: 2,
      });
      expect(writes).toEqual([{ id: 3, position: 1 }]);
      expect(result.content[0]?.text).toContain('before article #2');
    });

    it('breaks ties to move a tied article to the top (the #134 case)', async () => {
      const { writes } = seedSection(600, [
        { id: 1, position: 0 },
        { id: 2, position: 0 },
        { id: 3, position: 0 },
        { id: 4, position: 0 },
      ]);
      const result = await findTool('reorder_article').handler({ article_id: 4, target: 'top' });
      // id 4 already at 0 is left alone; siblings bumped so it is uniquely first.
      expect(writes).toEqual([
        { id: 1, position: 1 },
        { id: 2, position: 2 },
        { id: 3, position: 3 },
      ]);
      expect(result.content[0]?.text).toContain('moved to top');
    });

    it('renumbers the section contiguously when normalize is true', async () => {
      const { writes } = seedSection(600, [
        { id: 1, position: 0 },
        { id: 2, position: 5 },
        { id: 3, position: 9 },
      ]);
      await findTool('reorder_article').handler({
        article_id: 3,
        target: 'top',
        normalize: true,
      });
      expect(writes).toEqual([
        { id: 3, position: 0 },
        { id: 1, position: 1 },
        { id: 2, position: 2 },
      ]);
    });

    it('reports a no-op when the article is already in place', async () => {
      const { writes } = seedSection(600, [
        { id: 1, position: 0 },
        { id: 2, position: 1 },
      ]);
      const result = await findTool('reorder_article').handler({ article_id: 1, target: 'top' });
      expect(writes).toEqual([]);
      expect(result.content[0]?.text).toContain('already positioned');
    });

    it('detects an auto-sorted section after writing and returns guidance', async () => {
      // GET always returns the same order regardless of written positions.
      const { writes } = seedSection(
        600,
        [
          { id: 1, position: 0 },
          { id: 2, position: 1 },
          { id: 3, position: 2 },
        ],
        { fixedOrder: [1, 2, 3] },
      );
      const result = await findTool('reorder_article').handler({ article_id: 3, target: 'top' });
      expect(writes.length).toBeGreaterThan(0); // writes were attempted
      expect(result.content[0]?.text).toContain('sorted automatically');
      expect(result.content[0]?.text).toContain('Order articles by');
    });

    it('refuses a large reorder without confirm, then proceeds with confirm', async () => {
      const seeded = seedSection(600, seq(25, 0)); // 25 articles tied at 0
      const tool = findTool('reorder_article');
      const refused = await tool.handler({ article_id: 25, target: 'top' });
      expect(seeded.writes).toEqual([]); // nothing written
      expect(refused.content[0]?.text).toContain('above the safety threshold');

      const seeded2 = seedSection(600, seq(25, 0));
      const done = await findTool('reorder_article').handler({
        article_id: 25,
        target: 'top',
        confirm: true,
      });
      expect(seeded2.writes.length).toBe(24); // 24 siblings bumped, id 25 stays at 0
      expect(done.content[0]?.text).toContain('moved to top');
    });

    it('short-circuits an auto-sorted section up front without writing, at any size', async () => {
      // A strict inversion in the effective order is proof the section ignores
      // position; the tool must refuse before writing regardless of the write count.
      const { writes } = seedSection(
        600,
        [
          { id: 1, position: 5 },
          { id: 2, position: 3 },
          { id: 3, position: 8 },
        ],
        { fixedOrder: [1, 2, 3] }, // positions 5,3,8 along the display order → inversion
      );
      const result = await findTool('reorder_article').handler({ article_id: 3, target: 'top' });
      expect(writes).toEqual([]); // refused before any write, even though it's a small reorder
      expect(result.content[0]?.text).toContain('sorted automatically');
    });

    it('reports how far it got and that a re-run is safe when a write fails midway', async () => {
      const { writes } = seedSection(
        600,
        [
          { id: 1, position: 0 },
          { id: 2, position: 0 },
          { id: 3, position: 0 },
          { id: 4, position: 0 },
        ],
        { failPutOn: 2 },
      );
      // Moving id 4 to top writes 1->1, 2->2, 3->3; the write to id 2 fails.
      await expect(
        findTool('reorder_article').handler({ article_id: 4, target: 'top' }),
      ).rejects.toThrow(/failed after 1\/3 position write\(s\) \(on article #2\)[\s\S]*re-running/);
      expect(writes).toEqual([{ id: 1, position: 1 }]); // only the write before the failure applied
    });

    it('rejects target before/after without a reference', async () => {
      await expect(
        findTool('reorder_article').handler({ article_id: 1, target: 'before' }),
      ).rejects.toThrow(/requires reference_article_id/);
    });

    it('rejects a reference on top/bottom targets', async () => {
      await expect(
        findTool('reorder_article').handler({
          article_id: 1,
          target: 'top',
          reference_article_id: 2,
        }),
      ).rejects.toThrow(/must be omitted/);
    });

    it('rejects a reference equal to the moved article', async () => {
      await expect(
        findTool('reorder_article').handler({
          article_id: 1,
          target: 'before',
          reference_article_id: 1,
        }),
      ).rejects.toThrow(/must differ/);
    });

    it('reports when the reference is in a different section', async () => {
      seedSection(600, [{ id: 1, position: 0 }], { foreignSections: { 2: 700 } });
      await expect(
        findTool('reorder_article').handler({
          article_id: 1,
          target: 'after',
          reference_article_id: 2,
        }),
      ).rejects.toThrow(/section #700/);
    });

    it('reports when the reference article does not exist', async () => {
      seedSection(600, [{ id: 1, position: 0 }], { missing: [2] });
      await expect(
        findTool('reorder_article').handler({
          article_id: 1,
          target: 'before',
          reference_article_id: 2,
        }),
      ).rejects.toThrow(/#2 was not found/);
    });

    it('validates the target enum via the schema', () => {
      const tool = findTool('reorder_article');
      expect(() => tool.inputSchema.parse({ article_id: 1, target: 'sideways' })).toThrow();
      expect(tool.inputSchema.parse({ article_id: 1, target: 'top' })).toMatchObject({
        target: 'top',
        normalize: false,
        confirm: false,
      });
    });
  });

  describe('archive_article', () => {
    it('archives the article when confirm is true', async () => {
      const tool = findTool('archive_article');
      const result = await tool.handler({ article_id: 5000, confirm: true });
      expect(result.content[0]?.text).toContain('Article #5000 archived');
    });

    it('refuses without archiving when confirm is false', async () => {
      // The default MSW handler returns 204, so a regressed guard would let the
      // call succeed and this assertion would fail — no extra override needed.
      const tool = findTool('archive_article');
      await expect(tool.handler({ article_id: 5000, confirm: false })).rejects.toThrow(/confirm/i);
    });

    it('requires confirm in the schema', () => {
      const tool = findTool('archive_article');
      expect(() => tool.inputSchema.parse({ article_id: 5000 })).toThrow();
      expect(tool.inputSchema.parse({ article_id: 5000, confirm: true })).toMatchObject({
        confirm: true,
      });
    });

    it('is annotated as a destructive write operation', () => {
      const tool = findTool('archive_article');
      expect(tool.readOnly).toBe(false);
      expect(tool.annotations.destructiveHint).toBe(true);
    });

    it('points callers to update_article draft for a plain unpublish', () => {
      const tool = findTool('archive_article');
      expect(tool.description).toContain('update_article');
    });
  });

  describe('list_content_tags', () => {
    it('lists content tags sorted by name ascending, spanning past the old cap', async () => {
      const tool = findTool('list_content_tags');
      const result = await tool.handler({ sort_by: 'name', sort_order: 'asc', page_size: 30 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('scanner');
      expect(text).toContain('ct_001');
      // The tags #132 could not confirm are now enumerable, and the listing
      // reaches past `debug mode` (the alphabetical point the old cap stopped at).
      expect(text.indexOf('ai')).toBeLessThan(text.indexOf('debug mode'));
      expect(text.indexOf('debug mode')).toBeLessThan(text.indexOf('mistral'));
    });

    it('reverses order for descending sort', async () => {
      const tool = findTool('list_content_tags');
      const result = await tool.handler({ sort_by: 'name', sort_order: 'desc', page_size: 30 });
      const text = result.content[0]?.text ?? '';
      expect(text.indexOf('mistral')).toBeLessThan(text.indexOf('ai'));
    });

    it('filters by name prefix', async () => {
      const tool = findTool('list_content_tags');
      const result = await tool.handler({
        name_prefix: 'mi',
        sort_by: 'name',
        sort_order: 'asc',
        page_size: 30,
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('mistral');
      expect(text).not.toContain('scanner');
    });

    it('surfaces the pagination cursor when more results remain', async () => {
      mswServer.use(manyContentTagsHandler);
      const tool = findTool('list_content_tags');
      const result = await tool.handler({ sort_by: 'name', sort_order: 'asc', page_size: 1 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('More available');
      expect(text).toContain('next-page-cursor');
    });

    it('caps page_size at the content-tags endpoint limit of 30 (#162)', () => {
      const tool = findTool('list_content_tags');
      // The Guide content-tags endpoint 400s on page[size] > 30, so the schema
      // rejects out-of-range values instead of letting them hit the API.
      expect(() => tool.inputSchema.parse({ page_size: 31 })).toThrow();
      expect(tool.inputSchema.parse({ page_size: 30 })).toMatchObject({ page_size: 30 });
      // Default is the endpoint's max, not the shared 100 that used to leak in.
      expect(tool.inputSchema.parse({}).page_size).toBe(30);
    });
  });

  describe('create_content_tag', () => {
    it('creates a content tag', async () => {
      const tool = findTool('create_content_tag');
      const result = await tool.handler({ name: 'accessibility' });
      expect(result.content[0]?.text).toContain('Content tag created');
      expect(result.content[0]?.text).toContain('accessibility');
    });
  });

  describe('list_labels', () => {
    it('lists article labels', async () => {
      const tool = findTool('list_labels');
      const result = await tool.handler({});
      expect(result.content[0]?.text).toContain('getting-started');
    });
  });

  describe('list_user_segments', () => {
    it('lists user segments', async () => {
      const tool = findTool('list_user_segments');
      const result = await tool.handler({});
      expect(result.content[0]?.text).toContain('Signed-in users');
      expect(result.content[0]?.text).toContain('15001');
    });

    it('explains the Guide-admin requirement (and the fallback) on a 403', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/user_segments`, () =>
          HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
        ),
      );
      const tool = findTool('list_user_segments');
      const error = await tool.handler({}).then(
        () => {
          throw new Error('expected list_user_segments to reject on 403');
        },
        (err: unknown) => err as Error,
      );
      expect(error.message).toMatch(/Guide.?admin|admin/i);
      expect(error.message).toMatch(/get_article/);
    });
  });

  describe('list_article_attachments', () => {
    it('lists attachments for an article', async () => {
      const tool = findTool('list_article_attachments');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('screenshot.png');
      expect(result.content[0]?.text).toContain('20001');
    });

    it('reports an explicit message when the article has no attachments', async () => {
      mswServer.use(
        http.get(`${HC_BASE}/articles/:id/attachments`, () =>
          HttpResponse.json({ article_attachments: [], count: 0 }),
        ),
      );
      const tool = findTool('list_article_attachments');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toBe('No attachments found on article #5000.');
    });
  });

  describe('create_article_attachment', () => {
    it('creates an attachment', async () => {
      const tool = findTool('create_article_attachment');
      const result = await tool.handler({
        article_id: 5000,
        file_name: 'doc.pdf',
        file_base64: btoa('fake content'),
        content_type: 'application/pdf',
      });
      expect(result.content[0]?.text).toContain('Attachment created');
      expect(result.content[0]?.text).toContain('screenshot.png');
    });
  });

  describe('get_article_outline', () => {
    it('returns compact outline with sections and available translations', async () => {
      const tool = findTool('get_article_outline');
      const result = await tool.handler({ article_id: 5000 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Outline — Article #5000');
      expect(text).toContain('Intro');
      expect(text).toContain('Setup');
      expect(text).toContain('Available translations');
      expect(text).toContain('fr');
      expect(text).toContain('en-us');
    });

    it('flags outdated translations', async () => {
      const tool = findTool('get_article_outline');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('(outdated)');
    });
  });

  describe('get_article_section', () => {
    it('returns a single section as markdown', async () => {
      const tool = findTool('get_article_section');
      const result = await tool.handler({
        article_id: 5000,
        locale: 'en-us',
        section_index: 1,
        format: 'markdown',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Setup');
      expect(text).toContain('one two three four');
      expect(text).toContain('Format: markdown');
    });

    it('returns html when format=html', async () => {
      const tool = findTool('get_article_section');
      const result = await tool.handler({
        article_id: 5000,
        locale: 'en-us',
        section_index: 1,
        format: 'html',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('<p>');
      expect(text).toContain('Format: html');
    });

    it('throws when section_index is out of range', async () => {
      const tool = findTool('get_article_section');
      await expect(
        tool.handler({ article_id: 5000, locale: 'en-us', section_index: 99 }),
      ).rejects.toThrow();
    });

    it('defaults format to "html" for round-trip safety', () => {
      const tool = findTool('get_article_section');
      const parsed = tool.inputSchema.parse({
        article_id: 5000,
        locale: 'en-us',
        section_index: 0,
      });
      expect((parsed as { format: string }).format).toBe('html');
    });
  });

  describe('update_article_section', () => {
    it('updates a section and confirms the new word count', async () => {
      const tool = findTool('update_article_section');
      const result = await tool.handler({
        article_id: 5000,
        locale: 'fr',
        section_index: 1,
        content: 'un deux trois',
        format: 'markdown',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Section [1]');
      expect(text).toContain('updated for article #5000');
      expect(text).toContain('(fr)');
    });

    it('accepts raw HTML when format=html', async () => {
      const tool = findTool('update_article_section');
      const result = await tool.handler({
        article_id: 5000,
        locale: 'fr',
        section_index: 0,
        content: '<p>Nouveau contenu</p>',
        format: 'html',
      });
      expect(result.content[0]?.text).toContain('updated for article #5000');
    });

    it('defaults format to "html" for round-trip safety', () => {
      const tool = findTool('update_article_section');
      const parsed = tool.inputSchema.parse({
        article_id: 5000,
        locale: 'fr',
        section_index: 0,
        content: '<p>x</p>',
      });
      expect((parsed as { format: string }).format).toBe('html');
    });
  });

  describe('compare_translations', () => {
    it('returns a section diff table', async () => {
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Translation diff');
      expect(text).toContain('| Idx | Heading | Status');
      expect(text).toContain('Setup');
    });

    it('does not flag a longer-but-faithful section as divergent (issue #135)', async () => {
      // en-us "Setup" is 4 words, fr "Setup" is 2 — a benign length gap that the
      // old word-count heuristic mislabelled `different`. Both are present, so it
      // must now be `ok`, and the ambiguous `different` status must be gone.
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('| 1 | Setup | ok |');
      expect(text).not.toContain('different');
    });

    it('flags the target as likely behind when the source was edited later', async () => {
      // Primary freshness signal, derived from updated_at: source (en-us) edited
      // after the target (fr) → the translation is very likely behind.
      mswServer.use(
        http.get(`${HC_BASE}/articles/:id/translations/:locale`, ({ params }) => {
          const locale = params['locale'] as string;
          const updated_at = locale === 'en-us' ? '2026-05-01T00:00:00Z' : '2026-01-01T00:00:00Z';
          return HttpResponse.json({
            translation: {
              ...MOCK_TRANSLATION,
              locale,
              updated_at,
              body: '<h2>Intro</h2><p>x</p>',
            },
          });
        }),
      );
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Freshness');
      expect(text.toLowerCase()).toContain('behind');
    });

    it('reports the target as up to date when the source is not newer', async () => {
      // Both translations share the fixture updated_at, so the source is not
      // newer than the target → up to date.
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Freshness[^\n]*up to date/i);
    });

    it('surfaces the target outdated flag in the header when set', async () => {
      // en-us is outdated:true in the translations list fixture.
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'fr',
        target_locale: 'en-us',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('outdated flag');
      expect(text.toLowerCase()).toContain('yes');
    });

    it('matches the outdated flag case-insensitively against the locale list', async () => {
      // Zendesk accepts a mixed-case locale in the request URL but reports it
      // canonically lowercased in the list, so "EN-US" must still resolve to
      // the outdated:true en-us entry rather than falling back to "unknown".
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'fr',
        target_locale: 'EN-US',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('outdated flag');
      expect(text.toLowerCase()).toContain('yes');
      expect(text).not.toContain('unknown');
    });

    it('reports outdated "unknown" when the list omits the flag for an existing target', async () => {
      // Defensive path: the target translation exists but its list entry carries
      // no `outdated` field (some tenants/endpoints omit it). Must degrade to
      // "unknown" rather than crash or invent a value. This branch is not
      // reproducible against a live tenant (the list there always returns the
      // flag), so it is only covered here.
      mswServer.use(
        http.get(`${HC_BASE}/articles/:id/translations`, () =>
          HttpResponse.json({
            translations: [{ ...MOCK_TRANSLATION, locale: 'fr' }],
          }),
        ),
      );
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Outdated[^\n]*unknown/i);
    });

    it('reports the target as not outdated when the flag is false', async () => {
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Outdated[^\n]*\bno\b/i);
    });

    it('reports a section missing in the target and a structural mismatch', async () => {
      // de has only the Intro section; en-us has Intro + Setup.
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'de',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('| 1 | Setup | missing |');
      expect(text.toLowerCase()).toContain('mismatch');
    });

    it('reports a section present only in the target as extra', async () => {
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'de',
        target_locale: 'en-us',
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('| 1 | Setup | extra |');
    });

    it('description surfaces freshness and the outdated flag, and treats word counts as informational', () => {
      const tool = findTool('compare_translations');
      const description = tool.description.toLowerCase();
      expect(description).toContain('freshness');
      expect(description).toContain('outdated');
      expect(description).toContain('informational');
      // The old contract keyed the status off a 25% word-count ratio; that is gone.
      expect(tool.description).not.toContain('25%');
    });
  });
});
