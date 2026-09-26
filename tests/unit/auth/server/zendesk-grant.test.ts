import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../../../src/auth/server/file-store';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import { createSealedCollection } from '../../../../src/auth/server/store';
import type { ZendeskTokenSet } from '../../../../src/auth/server/upstream';
import {
  createZendeskGrants,
  isGrantUnavailableError,
  ZENDESK_REFRESH_MARGIN_MS,
} from '../../../../src/auth/server/zendesk-grant';
import type { Logger } from '../../../../src/utils/logger';

const UPSTREAM = { subdomain: 'testsubdomain', clientId: 'c' };
const ring = deriveKeyRing(Buffer.alloc(32, 3).toString('base64'));

const setup = (refresh = vi.fn(), logger?: Logger) => {
  const records = createSealedCollection<ZendeskTokenSet>(
    createMemoryStore(),
    'ZendeskTokens',
    ring,
  );
  let clock = 1_000_000;
  const grants = createZendeskGrants({
    records,
    upstream: UPSTREAM,
    refresh,
    now: () => clock,
    logger,
  });
  return {
    grants,
    records,
    refresh,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
};

describe('createZendeskGrants', () => {
  it('returns the stored token while it is outside the refresh margin', async () => {
    const { grants, refresh, now } = setup();
    await grants.save('g', {
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: now() + ZENDESK_REFRESH_MARGIN_MS + 1,
    });
    expect(await grants.accessToken('g')).toBe('a1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never refreshes a token without expiry', async () => {
    const { grants, refresh } = setup();
    await grants.save('g', { accessToken: 'a1', refreshToken: 'r1' });
    expect(await grants.accessToken('g')).toBe('a1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes inside the margin and persists the rotated pair', async () => {
    const refresh = vi.fn(async () => ({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: Number.MAX_SAFE_INTEGER,
    }));
    const { grants, records, now } = setup(refresh);
    await grants.save('g', {
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: now() + ZENDESK_REFRESH_MARGIN_MS,
    });
    expect(await grants.accessToken('g')).toBe('a2');
    expect(refresh).toHaveBeenCalledWith(UPSTREAM, 'r1', expect.anything());
    expect(await records.get('g')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('spends the Zendesk refresh token once under concurrent requests', async () => {
    let resolveRefresh: (v: ZendeskTokenSet) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<ZendeskTokenSet>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { grants, now } = setup(refresh);
    await grants.save('g', { accessToken: 'a1', refreshToken: 'r1', expiresAt: now() });
    const pending = Promise.all([1, 2, 3, 4, 5].map(() => grants.accessToken('g')));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    resolveRefresh({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Number.MAX_SAFE_INTEGER });
    expect(await pending).toEqual(['a2', 'a2', 'a2', 'a2', 'a2']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('drops the grant when Zendesk refuses the refresh', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('Zendesk refused the refresh_token grant (400).');
    });
    const events: [string, unknown][] = [];
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (e, f) => events.push([e, f]),
      error: vi.fn(),
      attachServer: vi.fn(),
    };
    const { grants, records, now } = setup(refresh, logger);
    await grants.save('g', { accessToken: 'a1', refreshToken: 'r1', expiresAt: now() });
    const failure = grants.accessToken('g');
    await expect(failure).rejects.toThrow(
      'The Zendesk authorization behind this grant is no longer valid.',
    );
    await failure.catch((err: unknown) => expect(isGrantUnavailableError(err)).toBe(true));
    expect(await records.get('g')).toBeUndefined();
    expect(events).toEqual([
      [
        'oauth_upstream_refresh_failed',
        { error: 'Zendesk refused the refresh_token grant (400).' },
      ],
    ]);
  });

  it('rejects an unknown grant, and an expiring token that cannot be refreshed', async () => {
    const { grants, now } = setup();
    await expect(grants.accessToken('nope')).rejects.toSatisfy(isGrantUnavailableError);
    await grants.save('g', { accessToken: 'a1', expiresAt: now() });
    await expect(grants.accessToken('g')).rejects.toSatisfy(isGrantUnavailableError);
  });

  it('removes a grant', async () => {
    const { grants } = setup();
    await grants.save('g', { accessToken: 'a1' });
    await grants.remove('g');
    await expect(grants.accessToken('g')).rejects.toSatisfy(isGrantUnavailableError);
  });

  it('does not mistake another error for an unavailable grant', () => {
    expect(isGrantUnavailableError(new Error('x'))).toBe(false);
    expect(isGrantUnavailableError('ZendeskGrantUnavailable')).toBe(false);
  });
});
