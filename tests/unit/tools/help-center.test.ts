import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createHelpCenterTools } from '../../../src/tools/help-center';
import { MOCK_ARTICLE, manyContentTagsHandler } from '../../msw-handlers';
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
  it('creates 22 tools', () => {
    expect(createHelpCenterTools(ctx)).toHaveLength(22);
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

    it('flags sections with diverging word counts as different', async () => {
      const tool = findTool('compare_translations');
      const result = await tool.handler({
        article_id: 5000,
        source_locale: 'en-us',
        target_locale: 'fr',
      });
      expect(result.content[0]?.text).toContain('different');
    });

    it('description clarifies that "different" is based on a word count ratio', () => {
      const tool = findTool('compare_translations');
      expect(tool.description.toLowerCase()).toContain('word count');
      expect(tool.description).toContain('25');
    });
  });
});
