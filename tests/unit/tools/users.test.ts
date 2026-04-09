import { describe, it, expect } from 'vitest';
import { createUserTools } from '../../../src/tools/users';
import type { ToolContext } from '../../../src/tools/definitions';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

const findTool = (name: string) => {
  const tools = createUserTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

describe('user tools', () => {
  it('creates 5 tools', () => {
    expect(createUserTools(ctx)).toHaveLength(5);
  });

  describe('get_current_user', () => {
    it('returns the authenticated user', async () => {
      const tool = findTool('get_current_user');
      const result = await tool.handler({});
      expect(result.content[0]?.text).toContain('Test User');
      expect(result.content[0]?.text).toContain('test@example.com');
      expect(result.content[0]?.text).toContain('admin');
    });

    it('has all readOnly tools', () => {
      const tools = createUserTools(ctx);
      for (const tool of tools) {
        expect(tool.readOnly).toBe(true);
      }
    });
  });

  describe('search_users', () => {
    it('searches users', async () => {
      const tool = findTool('search_users');
      const result = await tool.handler({ query: 'test', per_page: 100, page: 1 });
      expect(result.content[0]?.text).toContain('Test User');
    });
  });

  describe('get_user', () => {
    it('gets user by id', async () => {
      const tool = findTool('get_user');
      const result = await tool.handler({ user_id: 9999 });
      expect(result.content[0]?.text).toContain('Test User');
    });
  });

  describe('get_organization', () => {
    it('gets organization by id', async () => {
      const tool = findTool('get_organization');
      const result = await tool.handler({ organization_id: 400 });
      expect(result.content[0]?.text).toContain('Test Org');
    });
  });

  describe('list_organizations', () => {
    it('lists organizations', async () => {
      const tool = findTool('list_organizations');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).toContain('Test Org');
    });
  });
});
