import { describe, it, expect } from 'vitest';
import { buildCursorParams, extractPaginationMeta } from '../../../src/utils/pagination';

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

describe('extractPaginationMeta', () => {
  it('extracts meta from cursor-based response', () => {
    const meta = extractPaginationMeta({
      meta: { has_more: true, after_cursor: 'next123' },
      count: 42,
    });
    expect(meta).toEqual({ has_more: true, after_cursor: 'next123', count: 42 });
  });

  it('falls back to next_page for offset-based pagination', () => {
    const meta = extractPaginationMeta({
      next_page: 'https://example.com/api?page=2',
      count: 10,
    });
    expect(meta.has_more).toBe(true);
  });

  it('returns has_more false when no next_page and no meta', () => {
    const meta = extractPaginationMeta({ next_page: null });
    expect(meta.has_more).toBe(false);
    expect(meta.after_cursor).toBeNull();
    expect(meta.count).toBe(0);
  });
});
