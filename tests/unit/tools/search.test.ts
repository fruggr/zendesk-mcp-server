import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createSearchTools } from '../../../src/tools/search';
import { testToolContext } from '../../tool-context';
import { firstText } from '../../tool-result';

const ctx: ToolContext = testToolContext({
  subdomain: 'testsubdomain',
  getToken: () => 'test-token',
});

describe('search tools', () => {
  it('creates 1 tool', () => {
    expect(createSearchTools(ctx)).toHaveLength(1);
  });

  describe('search', () => {
    const [tool] = createSearchTools(ctx);
    if (!tool) throw new Error('search tool not registered');

    it('performs unified search with total count', async () => {
      const result = await tool.handler({ query: 'test', per_page: 100, page: 1 });
      expect(firstText(result)).toContain('Total: 2');
      expect(firstText(result)).toContain('ticket');
      expect(firstText(result)).toContain('user');
    });

    it('is readOnly', () => {
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });
});
