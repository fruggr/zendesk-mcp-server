import { describe, expect, it } from 'vitest';
import {
  buildCursorParams,
  buildOffsetParams,
  extractOffsetPaginationMeta,
  extractPaginationMeta,
  extractSearchPaginationMeta,
} from '../../../src/utils/pagination';

describe('buildCursorParams', () => {
  it('builds params with page size only', () => {
    expect(buildCursorParams(25)).toEqual({ 'page[size]': '25' });
  });

  it('includes cursor when provided', () => {
    expect(buildCursorParams(10, 'abc123')).toEqual({
      'page[size]': '10',
      'page[after]': 'abc123',
    });
  });

  it('omits cursor when undefined', () => {
    const params = buildCursorParams(50, undefined);
    expect(params).not.toHaveProperty('page[after]');
  });
});

describe('buildOffsetParams', () => {
  it('builds params with per_page only', () => {
    expect(buildOffsetParams(50)).toEqual({ per_page: '50' });
  });

  it('omits page 1, which is what the API serves by default', () => {
    // Sending `page=1` is redundant; the assertion pins the omission so the
    // guard cannot be relaxed to `page >= 1` unnoticed.
    expect(buildOffsetParams(50, 1)).toEqual({ per_page: '50' });
  });

  it('includes the page number from page 2 onwards', () => {
    expect(buildOffsetParams(50, 2)).toEqual({ per_page: '50', page: '2' });
  });

  it('omits page 0 rather than sending it verbatim', () => {
    expect(buildOffsetParams(50, 0)).toEqual({ per_page: '50' });
  });
});

describe('extractOffsetPaginationMeta', () => {
  it('uses offset math when the count wrapper is present', () => {
    const meta = extractOffsetPaginationMeta({ macros: [], count: 150 }, 0, 100, 1);
    expect(meta).toEqual({ count: 150, has_more: true, after_cursor: '2' });
  });

  it('falls back to the returned page length when count is absent', () => {
    const meta = extractOffsetPaginationMeta({ sla_policies: [] }, 7, 100, 1);
    expect(meta).toEqual({ count: 7, has_more: false, after_cursor: null });
  });

  it('treats an explicit zero count as present, not as absent', () => {
    // `count: 0` is falsy but not missing: an endpoint reporting "no results"
    // must go through the offset math and report 0, not fall back to the
    // item count. Guards the `!= null` check against a truthiness rewrite.
    const meta = extractOffsetPaginationMeta({ macros: [], count: 0 }, 7, 100, 1);
    expect(meta).toEqual({ count: 0, has_more: false, after_cursor: null });
  });
});

describe('extractSearchPaginationMeta', () => {
  it('reports more pages while the count exceeds what has been served', () => {
    expect(extractSearchPaginationMeta({ results: [], count: 101 }, 100, 1)).toEqual({
      count: 101,
      has_more: true,
      after_cursor: '2',
    });
  });

  it('stops at the exact boundary: a full final page is not "more"', () => {
    // count === page * perPage. The off-by-one that `>=` would introduce
    // advertises a page that does not exist.
    expect(extractSearchPaginationMeta({ results: [], count: 100 }, 100, 1)).toEqual({
      count: 100,
      has_more: false,
      after_cursor: null,
    });
  });

  it('accounts for the pages already served when pointing at the next one', () => {
    expect(extractSearchPaginationMeta({ results: [], count: 250 }, 100, 2)).toEqual({
      count: 250,
      has_more: true,
      after_cursor: '3',
    });
  });

  it('treats a missing count as zero', () => {
    expect(extractSearchPaginationMeta({ results: [] }, 100, 1)).toEqual({
      count: 0,
      has_more: false,
      after_cursor: null,
    });
  });
});

describe('extractPaginationMeta', () => {
  it('extracts meta from cursor-based response', () => {
    const meta = extractPaginationMeta(
      {
        meta: { has_more: true, after_cursor: 'next123' },
        count: 42,
      },
      3,
    );
    expect(meta).toEqual({ has_more: true, after_cursor: 'next123', count: 42 });
  });

  it('falls back to next_page for offset-based pagination', () => {
    const meta = extractPaginationMeta(
      {
        next_page: 'https://example.com/api?page=2',
        count: 10,
      },
      3,
    );
    expect(meta.has_more).toBe(true);
  });

  it('falls back to the page item count when the response omits count (#100)', () => {
    // The /tickets cursor endpoint returns no `count` wrapper, which previously
    // surfaced as a misleading "Results: 0" footer even when a full page came back.
    const meta = extractPaginationMeta(
      { tickets: [], meta: { has_more: true, after_cursor: 'c' } },
      25,
    );
    expect(meta.count).toBe(25);
    expect(meta.has_more).toBe(true);
  });

  it('prefers the response count over the item count when present', () => {
    const meta = extractPaginationMeta(
      { count: 250, meta: { has_more: true, after_cursor: 'c' } },
      25,
    );
    expect(meta.count).toBe(250);
  });

  it('returns has_more false when no next_page and no meta', () => {
    const meta = extractPaginationMeta({ next_page: null }, 0);
    expect(meta.has_more).toBe(false);
    expect(meta.after_cursor).toBeNull();
    expect(meta.count).toBe(0);
  });
});
