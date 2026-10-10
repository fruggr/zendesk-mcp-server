import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrandSubdomainResolver, fetchAllBrands } from '../../../src/client/brands';
import { mswServer } from '../../setup';

const SUBDOMAIN = 'testsubdomain';
const TOKEN = 'test-token';

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchAllBrands', () => {
  it('returns every brand across cursor pages', async () => {
    const brands = await fetchAllBrands(SUBDOMAIN, TOKEN);
    expect(brands.map((b) => b.id)).toEqual([360001234567, 424242, 777777]);
  });
});

describe('createBrandSubdomainResolver', () => {
  it('resolves a brand id to its subdomain', async () => {
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('424242')).resolves.toBe('brand424242');
  });

  it('resolves a brand subdomain to itself', async () => {
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('brand424242')).resolves.toBe('brand424242');
  });

  it('matches a brand subdomain case-insensitively', async () => {
    // A caller writing "Docs" or --brand-ids Support must resolve the brand
    // whose subdomain is lowercase: Zendesk subdomains are lowercase by
    // construction, so casing carries no meaning.
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('BRAND424242')).resolves.toBe('brand424242');
    await expect(resolve('Brand424242')).resolves.toBe('brand424242');
  });

  it('caches the resolution per id-or-subdomain across calls', async () => {
    let calls = 0;
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () => {
        calls += 1;
        return HttpResponse.json({
          brands: [
            {
              id: 424242,
              name: 'Second brand',
              brand_url: 'https://brand424242.zendesk.com',
              subdomain: 'brand424242',
              host_mapping: null,
              default: false,
              active: true,
            },
          ],
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await resolve('424242');
    await resolve('424242');
    await resolve('424242');
    expect(calls).toBe(1);
  });

  it('rejects an unknown id or subdomain with a neutral error that does not blame server config', async () => {
    // The bad brand_id may well come from the AGENT's per-call argument, where
    // pointing at --brand-ids is a red herring: the message names the fact and
    // the discovery tool, not the deploy-time flag.
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('999999')).rejects.toThrow(
      'Unknown brand "999999": no brand with that id or subdomain exists on this account; call list_brands to see the available brands.',
    );
    await expect(resolve('nonexistent')).rejects.toThrow(/Unknown brand "nonexistent"/);
    await expect(resolve('nonexistent')).rejects.not.toThrow(/--brand-ids/);
  });

  it.each(['ok.evil.com', 'evil.com/ok', 'ok@evil', '-lead', 'Upper', ''])(
    'refuses to route to a brand whose subdomain is not a bare DNS label (%j)',
    async (bad) => {
      // The subdomain becomes the host the bearer token is sent to.
      mswServer.use(
        http.get(`https://${SUBDOMAIN}.zendesk.com/api/v2/brands`, () =>
          HttpResponse.json({ brands: [{ id: 555, subdomain: bad }] }),
        ),
      );
      const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
      await expect(resolve('555')).rejects.toThrow(
        'Brand 555 has an unexpected subdomain; refusing to send a request to it.',
      );
    },
  );

  it('accepts a subdomain with digits and inner hyphens', async () => {
    mswServer.use(
      http.get(`https://${SUBDOMAIN}.zendesk.com/api/v2/brands`, () =>
        HttpResponse.json({ brands: [{ id: 556, subdomain: 'help-2024' }] }),
      ),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('556')).resolves.toBe('help-2024');
  });

  it('follows cursor pagination so brands past the first page resolve', async () => {
    const base = 'https://testsubdomain.zendesk.com/api/v2';
    const seenParams: (string | null)[] = [];
    mswServer.use(
      http.get(`${base}/brands`, ({ request }) => {
        const url = new URL(request.url);
        seenParams.push(url.searchParams.get('page[after]'));
        if (url.searchParams.get('page[after]') === 'cursor2') {
          return HttpResponse.json({
            brands: [
              {
                id: 777777,
                name: 'Third brand',
                brand_url: 'https://brand777777.zendesk.com',
                subdomain: 'brand777777',
                host_mapping: null,
                default: false,
                active: true,
              },
            ],
            meta: { has_more: false, after_cursor: '' },
          });
        }
        return HttpResponse.json({
          brands: [],
          meta: { has_more: true, after_cursor: 'cursor2' },
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('777777')).resolves.toBe('brand777777');
    // The first page was fetched with no cursor, the second with cursor2.
    expect(seenParams).toEqual([null, 'cursor2']);
  });

  it('treats a page with no brands key as empty', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () =>
        HttpResponse.json({ meta: { has_more: false, after_cursor: '' } }),
      ),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('424242')).rejects.toThrow(/Unknown brand/);
  });

  it('sends page[size] on the FIRST request, not just on cursor-follow-ups', async () => {
    // Regression: without page[size] the endpoint offset-paginates, answers
    // without meta.after_cursor, and brands past the first page resolve as
    // Unknown. The very first request must already carry the page size.
    const seenSizes: (string | null)[] = [];
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', ({ request }) => {
        seenSizes.push(new URL(request.url).searchParams.get('page[size]'));
        return HttpResponse.json({
          brands: [
            {
              id: 424242,
              name: 'Second brand',
              brand_url: 'https://brand424242.zendesk.com',
              subdomain: 'brand424242',
              host_mapping: null,
              default: false,
              active: true,
            },
          ],
          meta: { has_more: false, after_cursor: '' },
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await resolve('424242');
    expect(seenSizes).toHaveLength(1);
    expect(seenSizes[0]).toBe('100');
  });

  it('throws when has_more is true but after_cursor is missing', async () => {
    // Cursor-progress guard: a "more pages" signal with no usable cursor would
    // otherwise loop forever or silently stop after page 1.
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () =>
        HttpResponse.json({ brands: [], meta: { has_more: true, after_cursor: '' } }),
      ),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('424242')).rejects.toThrow(/no usable after_cursor/);
  });

  it('evicts a rejected fetch so the next lookup retries with a fresh request', async () => {
    // A transient 401 must not be cached forever: the first call fails, the
    // second re-fetches (fresh token) and succeeds, and the third is served
    // from the cache of that successful fetch. (A 5xx would be replayed by the
    // client itself, never reaching this cache as a rejection.)
    let calls = 0;
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: 'expired token' }, { status: 401 });
        }
        return HttpResponse.json({
          brands: [
            {
              id: 424242,
              name: 'Second brand',
              brand_url: 'https://brand424242.zendesk.com',
              subdomain: 'brand424242',
              host_mapping: null,
              default: false,
              active: true,
            },
          ],
          meta: { has_more: false, after_cursor: '' },
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('424242')).rejects.toThrow();
    await expect(resolve('424242')).resolves.toBe('brand424242');
    await resolve('424242');
    expect(calls).toBe(2);
  });

  it('throws when after_cursor is identical to the cursor just sent (no progress)', async () => {
    // Cursor-progress guard: the server echoed the same cursor back, so the
    // next request would re-fetch the same page and report duplicate brands.
    let calls = 0;
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () => {
        calls += 1;
        return HttpResponse.json({
          brands: [],
          meta: { has_more: true, after_cursor: 'cursor2' },
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('424242')).rejects.toThrow(/no usable after_cursor/);
    // First page (no cursor) → after_cursor 'cursor2'; second page sends
    // 'cursor2' and gets 'cursor2' back → guard trips on the second response.
    expect(calls).toBe(2);
  });

  it('serves the cached list within the TTL, then refetches once it expires', async () => {
    // A brand added after startup must resolve without a restart: the fulfilled
    // list expires (BRAND_LIST_TTL_MS), so a lookup past the TTL walks /brands
    // again. Within the TTL the cached list is served (one walk total).
    vi.useFakeTimers();
    let calls = 0;
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () => {
        calls += 1;
        return HttpResponse.json({
          brands: [
            {
              id: 424242,
              name: 'Second brand',
              brand_url: 'https://brand424242.zendesk.com',
              subdomain: 'brand424242',
              host_mapping: null,
              default: false,
              active: true,
            },
            // The "new" brand only appears in the response from the second
            // walk on, as if it had been created after startup.
            ...(calls > 1
              ? [
                  {
                    id: 999999,
                    name: 'New brand',
                    brand_url: 'https://brand999999.zendesk.com',
                    subdomain: 'brand999999',
                    host_mapping: null,
                    default: false,
                    active: true,
                  },
                ]
              : []),
          ],
          meta: { has_more: false, after_cursor: '' },
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await expect(resolve('424242')).resolves.toBe('brand424242');
    await expect(resolve('999999')).rejects.toThrow(/Unknown brand/);
    await resolve('424242');
    expect(calls).toBe(1);

    // 4 minutes later: still cached, the new brand is not visible yet.
    vi.advanceTimersByTime(4 * 60 * 1000);
    await resolve('424242');
    expect(calls).toBe(1);

    // Past the 5-minute TTL the next lookup refetches and the new brand resolves.
    vi.advanceTimersByTime(2 * 60 * 1000);
    await expect(resolve('999999')).resolves.toBe('brand999999');
    expect(calls).toBe(2);
  });

  it('refetches a list cached exactly TTL-old — expiry starts AT the TTL', async () => {
    // Boundary: at Date.now() - at === BRAND_LIST_TTL_MS the cache is already
    // stale (expiry is `>=`, not `>`), so the lookup refetches.
    vi.useFakeTimers();
    let calls = 0;
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () => {
        calls += 1;
        return HttpResponse.json({
          brands: [
            {
              id: 424242,
              name: 'Second brand',
              brand_url: 'https://brand424242.zendesk.com',
              subdomain: 'brand424242',
              host_mapping: null,
              default: false,
              active: true,
            },
          ],
          meta: { has_more: false, after_cursor: '' },
        });
      }),
    );
    const resolve = createBrandSubdomainResolver(SUBDOMAIN, () => TOKEN);
    await resolve('424242');
    expect(calls).toBe(1);

    // One ms short of the TTL: still cached.
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    await resolve('424242');
    expect(calls).toBe(1);

    // Exactly at the TTL: stale, refetch.
    vi.advanceTimersByTime(1);
    await resolve('424242');
    expect(calls).toBe(2);
  });
});
