import type { PaginationMeta, ZendeskListResponse } from '../types';

// Cursor-based pagination (for list endpoints: /tickets, /organizations, etc.)
export const buildCursorParams = (
  pageSize: number,
  cursor?: string,
): Record<string, string> => {
  const params: Record<string, string> = {
    'page[size]': String(pageSize),
  };
  if (cursor) {
    params['page[after]'] = cursor;
  }
  return params;
};

// Offset-based pagination (for search endpoints: /search, /help_center/articles/search)
export const buildOffsetParams = (
  perPage: number,
  page?: number,
): Record<string, string> => {
  const params: Record<string, string> = {
    per_page: String(perPage),
  };
  if (page && page > 1) {
    params['page'] = String(page);
  }
  return params;
};

export const extractPaginationMeta = <T>(response: ZendeskListResponse<T>): PaginationMeta => ({
  has_more: response.meta?.has_more ?? (response.next_page != null),
  after_cursor: response.meta?.after_cursor ?? null,
  count: response.count ?? 0,
});

// For search responses — offset-based, count is always present
export const extractSearchPaginationMeta = <T>(response: ZendeskListResponse<T>, perPage: number, page: number): PaginationMeta => {
  const count = response.count ?? 0;
  const has_more = count > page * perPage;
  return {
    has_more,
    after_cursor: has_more ? String(page + 1) : null,
    count,
  };
};
