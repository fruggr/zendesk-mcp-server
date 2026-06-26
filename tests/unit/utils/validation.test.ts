import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { parseToolParams } from '../../../src/utils/validation';

const schema = z.object({
  page_size: z.number().int().min(1).max(100).default(100),
  cursor: z.string().optional(),
});

describe('parseToolParams', () => {
  it('returns parsed params and applies defaults for valid input', () => {
    expect(parseToolParams(schema, { page_size: 5 })).toEqual({ page_size: 5 });
    expect(parseToolParams(schema, {})).toEqual({ page_size: 100 });
  });

  it('rejects unknown parameters instead of silently dropping them (#100)', () => {
    expect(() => parseToolParams(schema, { per_page: 3 })).toThrow(/per_page/);
  });

  it('names the unknown parameter and lists the valid ones', () => {
    const error = (() => {
      try {
        parseToolParams(schema, { per_page: 3 });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain('per_page');
    expect(error?.message).toContain('page_size');
    expect(error?.message).toContain('cursor');
  });

  it('still surfaces type errors on known parameters', () => {
    expect(() => parseToolParams(schema, { page_size: 'big' })).toThrow();
  });
});
