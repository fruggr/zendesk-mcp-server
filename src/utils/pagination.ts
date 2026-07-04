import type { PaginationMeta, ZendeskListResponse } from '../types';

// Shared parameter descriptions for offset-based pagination. The `per_page` /
// `page` pair is byte-identical across every offset endpoint (search,
// search_tickets, search_users, search_articles, list_sla_policies), so the text
// lives here once instead of being re-typed (and drifting) per tool. Keep them
// informative enough to clear the tool-quality gate (tests/unit/tools/tool-quality.test.ts).
export const PER_PAGE_DESC =
  'Number of results per page for offset pagination (1-100). Pair with `page` to walk large result sets; the response header reports the total count and whether more pages remain.';
export const PAGE_DESC =
  '1-based page number for offset pagination. Increment it while keeping `per_page` fixed to fetch subsequent pages; page 1 is the first page.';

// Cursor-based pagination (for list endpoints: /tickets, /organizations, etc.)
export const buildCursorParams = (pageSize: number, cursor?: string): Record<string, string> => {
  const params: Record<string, string> = {
    'page[size]': String(pageSize),
  };
  if (cursor) {
    params['page[after]'] = cursor;
  }
  return params;
};

// Offset-based pagination (for search endpoints: /search, /help_center/articles/search)
export const buildOffsetParams = (perPage: number, page?: number): Record<string, string> => {
  const params: Record<string, string> = {
    per_page: String(perPage),
  };
  if (page && page > 1) {
    params['page'] = String(page);
  }
  return params;
};

// Cursor list endpoints (e.g. /tickets) return no `count` wrapper, which
// previously surfaced as a misleading "Results: 0" footer even when a full page
// came back (#100). Fall back to the number of items on the returned page so the
// footer reflects what was actually returned.
export const extractPaginationMeta = <T>(
  response: ZendeskListResponse<T>,
  itemCount: number,
): PaginationMeta => ({
  has_more: response.meta?.has_more ?? response.next_page != null,
  after_cursor: response.meta?.after_cursor ?? null,
  count: response.count ?? itemCount,
});

// For search responses — offset-based, count is always present
export const extractSearchPaginationMeta = <T>(
  response: ZendeskListResponse<T>,
  perPage: number,
  page: number,
): PaginationMeta => {
  const count = response.count ?? 0;
  const has_more = count > page * perPage;
  return {
    has_more,
    after_cursor: has_more ? String(page + 1) : null,
    count,
  };
};
