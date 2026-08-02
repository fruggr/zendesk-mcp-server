import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { createStrictParamsParser } from '../../../src/utils/validation';

const parse = createStrictParamsParser(
  z.object({
    page_size: z.number().int().min(1).max(100).default(100),
    cursor: z.string().optional(),
  }),
);

describe('createStrictParamsParser', () => {
  it('returns parsed params and applies defaults for valid input', () => {
    expect(parse({ page_size: 5 })).toEqual({ page_size: 5 });
    expect(parse({})).toEqual({ page_size: 100 });
  });

  it('rejects unknown parameters instead of silently dropping them (#100)', () => {
    expect(() => parse({ per_page: 3 })).toThrow(/per_page/);
  });

  it('names the unknown parameter and lists the valid ones', () => {
    // The whole message is pinned, not just its parts: the valid-key list is
    // sorted so an LLM reading the error gets a stable, scannable list, and
    // the separators are what make it readable at all.
    expect(() => parse({ per_page: 3 })).toThrow(
      'Unknown parameter(s): per_page. Valid parameters: cursor, page_size.',
    );
  });

  it('lists every unknown parameter, not just the first', () => {
    expect(() => parse({ per_page: 3, sort_by: 'id' })).toThrow(
      /Unknown parameter\(s\): (per_page, sort_by|sort_by, per_page)\./,
    );
  });

  it('says "(none)" rather than trailing off when the tool takes no parameters', () => {
    const parseNoParams = createStrictParamsParser(z.object({}));
    expect(() => parseNoParams({ anything: 1 })).toThrow(
      'Unknown parameter(s): anything. Valid parameters: (none).',
    );
  });

  it('propagates the raw Zod error (not the rewritten message) for known-parameter failures', () => {
    const error = (() => {
      try {
        parse({ page_size: 'big' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    // A type error on a *known* field must surface the original ZodError so the
    // SDK reports the field-level detail, not the unknown-parameter rewrite.
    expect(error).toMatchObject({
      issues: [expect.objectContaining({ path: ['page_size'] })],
    });
  });
});
