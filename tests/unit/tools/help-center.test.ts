import { describe, it, expect } from 'vitest';
import { createHelpCenterTools } from '../../../src/tools/help-center';
import type { ToolContext } from '../../../src/tools/definitions';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

const findTool = (name: string) => {
  const tools = createHelpCenterTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

describe('help center tools', () => {
  it('creates 17 tools', () => {
    expect(createHelpCenterTools(ctx)).toHaveLength(17);
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
      const result = await tool.handler({ page_size: 25, sort_by: 'created_at', sort_order: 'desc' });
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
  });

  describe('list_content_tags', () => {
    it('lists content tags', async () => {
      const tool = findTool('list_content_tags');
      const result = await tool.handler({});
      expect(result.content[0]?.text).toContain('scanner');
      expect(result.content[0]?.text).toContain('ct_001');
    });
  });

  describe('create_content_tag', () => {
    it('creates a content tag', async () => {
      const tool = findTool('create_content_tag');
      const result = await tool.handler({ name: 'accessibility' });
      expect(result.content[0]?.text).toContain('Content tag created');
      expect(result.content[0]?.text).toContain('scanner');
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
  });

  describe('list_article_attachments', () => {
    it('lists attachments for an article', async () => {
      const tool = findTool('list_article_attachments');
      const result = await tool.handler({ article_id: 5000 });
      expect(result.content[0]?.text).toContain('screenshot.png');
      expect(result.content[0]?.text).toContain('20001');
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
});
