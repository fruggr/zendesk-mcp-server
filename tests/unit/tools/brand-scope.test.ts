import { describe, expect, it } from 'vitest';
import { resolveBrand } from '../../../src/tools/help-center';

// A trivial resolver that maps id-or-subdomain to a deterministic subdomain:
// numeric ids become `brand<id>`, anything else passes through.
const stubResolver = (idOrSubdomain: string): Promise<string> =>
  Promise.resolve(/^\d+$/.test(idOrSubdomain) ? `brand${idOrSubdomain}` : idOrSubdomain);

describe('resolveBrand', () => {
  describe('unset (no --brand-ids)', () => {
    it('returns undefined when no per-call brand is given', async () => {
      await expect(resolveBrand(undefined, undefined, stubResolver)).resolves.toBeUndefined();
    });

    it('rejects a per-call brand_id', async () => {
      await expect(resolveBrand(111, undefined, stubResolver)).rejects.toThrow(
        /without --brand-ids/,
      );
    });
  });

  describe('single entry (hard lock)', () => {
    it('returns the configured brand when no per-call brand is given', async () => {
      await expect(resolveBrand(undefined, ['222'], stubResolver)).resolves.toBe('brand222');
    });

    it('accepts a subdomain as the lock entry', async () => {
      await expect(resolveBrand(undefined, ['support'], stubResolver)).resolves.toBe('support');
    });

    it('rejects any per-call brand_id, even one equal to the lock', async () => {
      // Hard lock, no escape: the schema has no brand_id field, so a caller
      // that passes one anyway is rejected rather than silently honoured.
      await expect(resolveBrand(222, ['222'], stubResolver)).rejects.toThrow('--brand-ids');
    });

    it('rejects a per-call brand_id that disagrees with the lock', async () => {
      await expect(resolveBrand(111, ['222'], stubResolver)).rejects.toThrow('--brand-ids');
    });
  });

  describe('multi entry (allow-list)', () => {
    it('requires a per-call brand_id', async () => {
      await expect(resolveBrand(undefined, ['111', '222'], stubResolver)).rejects.toThrow(
        /brand_id is required/,
      );
    });

    it('accepts a per-call brand_id in the list', async () => {
      await expect(resolveBrand(111, ['111', '222'], stubResolver)).resolves.toBe('brand111');
    });

    it('accepts a per-call brand_id matching a subdomain entry by resolution', async () => {
      // Entry 'brand333' resolves to itself; per-call 333 resolves to 'brand333'.
      await expect(resolveBrand(333, ['brand333', '111'], stubResolver)).resolves.toBe('brand333');
    });

    it('rejects a per-call brand_id not in the list', async () => {
      await expect(resolveBrand(999, ['111', '222'], stubResolver)).rejects.toThrow(/not allowed/);
    });

    it('tolerates an unresolvable allow-list entry when the per-call brand is valid', async () => {
      // A typo'd or since-deleted entry must not break calls naming a valid brand.
      // 'brand111' is no exact match for 111, so every entry is resolved and the
      // failing 'typo' resolution is the one being tolerated.
      const flakyResolver = (s: string): Promise<string> =>
        s === 'typo' ? Promise.reject(new Error('Unknown brand "typo"')) : stubResolver(s);
      await expect(resolveBrand(111, ['brand111', 'typo'], flakyResolver)).resolves.toBe(
        'brand111',
      );
    });

    it('short-circuits an exact id match before resolving allow-list entries', async () => {
      // The per-call brand_id matches an entry verbatim, so no entry resolution
      // happens at all — the bad entry is never even looked up.
      const flakyResolver = (s: string): Promise<string> =>
        s === 'typo' ? Promise.reject(new Error('Unknown brand "typo"')) : stubResolver(s);
      await expect(resolveBrand(111, ['111', 'typo'], flakyResolver)).resolves.toBe('brand111');
    });

    it('still rejects a per-call brand that matches no entry even when another entry is bad', async () => {
      const flakyResolver = (s: string): Promise<string> =>
        s === 'typo' ? Promise.reject(new Error('Unknown brand "typo"')) : stubResolver(s);
      await expect(resolveBrand(999, ['111', 'typo'], flakyResolver)).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  describe("'all'", () => {
    it('requires a per-call brand_id', async () => {
      await expect(resolveBrand(undefined, ['all'], stubResolver)).rejects.toThrow(
        /brand_id is required/,
      );
    });

    it('accepts any per-call brand_id', async () => {
      await expect(resolveBrand(999, ['all'], stubResolver)).resolves.toBe('brand999');
    });
  });
});
