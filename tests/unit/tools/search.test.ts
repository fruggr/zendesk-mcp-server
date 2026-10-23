import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { CHARACTER_LIMIT } from '../../../src/constants';
import type { ToolContext } from '../../../src/tools/definitions';
import { createSearchTools } from '../../../src/tools/search';
import { MOCK_TICKET } from '../../msw-handlers';
import { mswServer } from '../../setup';
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

    it('names the next page in its header while more remain', async () => {
      // The default handler reports count 2; one per page leaves a second page.
      const result = await tool.handler({ query: 'test', per_page: 1, page: 1 });
      expect(firstText(result)?.split('\n')[0]).toBe(
        'Total: 2 | Page 1 (2 results) | Next page: 2',
      );
    });

    it('defaults to a page of 25 (#388)', () => {
      expect(tool.inputSchema.parse({ query: 'test' })).toMatchObject({ per_page: 25, page: 1 });
    });

    const searchReturns = (results: Record<string, unknown>[], count: number) =>
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/search', () =>
          HttpResponse.json({ results, count }),
        ),
      );

    it('cuts a long ticket description to the shared excerpt', async () => {
      searchReturns([{ ...MOCK_TICKET, result_type: 'ticket', description: 'z'.repeat(500) }], 1);
      const text = firstText(await tool.handler({ query: 'test', per_page: 25, page: 1 }));
      expect(text).toContain(`\n${'z'.repeat(200)}… (excerpt; full text: get_ticket)`);
      expect(text).not.toContain('z'.repeat(201));
    });

    it('stops at the last whole result and names the call that resumes after it', async () => {
      searchReturns(
        Array.from({ length: 100 }, (_, i) => ({
          ...MOCK_TICKET,
          id: i + 1,
          result_type: 'ticket',
          subject: 's'.repeat(CHARACTER_LIMIT / 40),
        })),
        300,
      );
      const text = firstText(await tool.handler({ query: 'test', per_page: 100, page: 1 })) ?? '';
      const ids = [...text.matchAll(/^## \[ticket\] #(\d+)$/gm)].map((m) => Number(m[1]));
      const shown = ids.length;
      expect(ids).toEqual(Array.from({ length: shown }, (_, i) => i + 1));
      expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
      // The cut drops the next-page hint, which would skip the results left out.
      expect(text.startsWith('Total: 300 | Page 1 (100 results)\n\n')).toBe(true);
      expect(
        text.endsWith(
          `--- Showing ${shown} of the 100 results on this page: the next one would pass the ${CHARACTER_LIMIT}-character response limit. To continue, call again with per_page: ${shown} and page: 2. ---`,
        ),
      ).toBe(true);
    });

    it('is readOnly', () => {
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });
});
