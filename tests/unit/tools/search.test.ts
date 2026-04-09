import { describe, it, expect } from 'vitest';
import { createSearchTools } from '../../../src/tools/search';
import type { ToolContext } from '../../../src/tools/definitions';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

describe('search tools', () => {
  it('creates 1 tool', () => {
    expect(createSearchTools(ctx)).toHaveLength(1);
  });

  describe('search', () => {
    it('performs unified search with total count', async () => {
      const tool = createSearchTools(ctx)[0]!;
      const result = await tool.handler({ query: 'test', per_page: 100, page: 1 });
      expect(result.content[0]?.text).toContain('Total: 2');
      expect(result.content[0]?.text).toContain('ticket');
      expect(result.content[0]?.text).toContain('user');
    });

    it('is readOnly', () => {
      const tool = createSearchTools(ctx)[0]!;
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });
});
