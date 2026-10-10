import { BRAND_LIST_TTL_MS, MAX_PAGE_SIZE } from '../constants';
import type { ZendeskBrand, ZendeskListResponse } from '../types';
import { zendeskGet } from './zendesk-api';

/**
 * Brand id-or-subdomain → the brand's subdomain. Zendesk addresses brands by
 * host, not by an id in the path: a brand's Guide lives at
 * `https://<brand.subdomain>.zendesk.com/api/v2/help_center`. The allow-list
 * (`--brand-ids`) mixes ids and subdomains; both resolve to the subdomain here,
 * once per (account subdomain, id-or-subdomain) and cached: brands change
 * almost never, and every Help Center tool call would otherwise pay a
 * `GET /api/v2/brands` round-trip first.
 */
const BRAND_SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/;

export type BrandSubdomainResolver = (idOrSubdomain: string) => Promise<string>;

/**
 * Fetch every brand of the account (cursor-paginated). `page[size]` is sent on
 * the FIRST request too: without it Zendesk falls back to OFFSET pagination,
 * which answers without `meta.after_cursor`, and the loop below would stop
 * after page 1 — a brand past the first 100 would resolve as Unknown.
 */
export const fetchAllBrands = async (subdomain: string, token: string): Promise<ZendeskBrand[]> => {
  // Stryker disable next-line ArrayDeclaration: a seeded array would only add a
  // non-brand entry, which no id/subdomain lookup can match — equivalent.
  const brands: ZendeskBrand[] = [];
  let cursor: string | undefined;
  do {
    const response = await zendeskGet<ZendeskListResponse<ZendeskBrand>>(
      subdomain,
      token,
      '/brands',
      {
        'page[size]': String(MAX_PAGE_SIZE),
        ...(cursor ? { 'page[after]': cursor } : {}),
      },
    );
    // Stryker disable next-line ArrayDeclaration: same reasoning as the seed
    // above — a junk fallback entry is unresolvable by id or subdomain.
    brands.push(...(response.brands ?? []));
    const meta = response.meta;
    if (meta?.has_more) {
      // Cursor-pagination contract: more pages must come with a NEW cursor. A
      // missing or repeated one means the server is stuck (or offset-paginating
      // despite page[size]) — looping would either spin forever or re-fetch the
      // same page and report duplicate brands.
      if (!meta.after_cursor || meta.after_cursor === cursor) {
        throw new Error(
          'GET /brands reported more pages but returned no usable after_cursor (missing or identical to the cursor just sent). Cannot continue pagination safely.',
        );
      }
      cursor = meta.after_cursor;
    } else {
      cursor = undefined;
    }
  } while (cursor);
  return brands;
};

export const createBrandSubdomainResolver = (
  subdomain: string,
  getToken: () => string | Promise<string>,
): BrandSubdomainResolver => {
  // The brand LIST is cached once (one memoised promise), not per id-or-subdomain
  // key: every lookup resolves against the same fetch, so N allow-list entries
  // and any number of distinct brand_ids cost one /brands walk total, not N+1.
  // A rejection is evicted so the next lookup retries with a fresh token rather
  // than caching a transient 401/5xx forever. A fulfilled list expires after
  // BRAND_LIST_TTL_MS so a brand added after startup resolves without a restart.
  let cached: { at: number; promise: Promise<ZendeskBrand[]> } | undefined;
  const brands = (): Promise<ZendeskBrand[]> => {
    if (!cached || Date.now() - cached.at >= BRAND_LIST_TTL_MS) {
      const promise = (async () => fetchAllBrands(subdomain, await getToken()))();
      cached = { at: Date.now(), promise };
      promise.catch(() => {
        cached = undefined;
      });
    }
    return cached.promise;
  };

  return async (idOrSubdomain) => {
    const all = await brands();
    const brand =
      all.find((b) => String(b.id) === idOrSubdomain) ??
      // Zendesk subdomains are lowercase by construction, so a caller's casing
      // ("Docs" for the "docs" brand) carries no meaning — match ignoring case.
      all.find((b) => b.subdomain.toLowerCase() === idOrSubdomain.toLowerCase());
    if (!brand) {
      // Neutral on purpose: the bad id-or-subdomain may come from the agent's
      // per-call brand_id just as well as from --brand-ids, so blaming the
      // server config here would send half the callers on the wrong chase.
      throw new Error(
        `Unknown brand "${idOrSubdomain}": no brand with that id or subdomain exists on this account; call list_brands to see the available brands.`,
      );
    }
    // The subdomain becomes the host the bearer token is sent to: refuse
    // anything that is not a bare DNS label rather than trust the API blindly.
    if (!BRAND_SUBDOMAIN.test(brand.subdomain)) {
      throw new Error(
        `Brand ${brand.id} has an unexpected subdomain; refusing to send a request to it.`,
      );
    }
    return brand.subdomain;
  };
};
