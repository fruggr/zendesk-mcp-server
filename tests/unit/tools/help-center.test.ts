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
  it('creates 10 tools', () => {
    expect(createHelpCenterTools(ctx)).toHaveLength(10);
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

  describe('create_article', () => {
    it('creates an article', async () => {
      const tool = findTool('create_article');
      const result = await tool.handler({
        section_id: 600,
        title: 'New article',
        body: '<p>Content</p>',
        draft: true,
        promoted: false,
      });
      expect(result.content[0]?.text).toContain('Article #5000 created');
    });
  });

  describe('update_article', () => {
    it('updates an article', async () => {
      const tool = findTool('update_article');
      const result = await tool.handler({ article_id: 5000, title: 'Updated' });
      expect(result.content[0]?.text).toContain('Article #5000 updated');
    });
  });
});
