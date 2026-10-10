import { type BrandSubdomainResolver, fetchAllBrands } from '../client/brands';
import { helpCenterGet, ZendeskApiError } from '../client/zendesk-api';
import {
  ARTICLE_RESOURCES_SCAN_MAX_PAGES,
  ARTICLE_RESOURCES_TTL_MS,
  MAX_PAGE_SIZE,
} from '../constants';
import type { ZendeskArticle, ZendeskListResponse } from '../types';
import { htmlToMarkdown } from '../utils/article-sections';
import { formatArticleSummary, truncateIfNeeded } from '../utils/formatting';
import { buildCursorParams, extractPaginationMeta } from '../utils/pagination';

/** Name of the companion tool that lists promoted articles (`help-center.ts`). */
export const LIST_PROMOTED_ARTICLES_TOOL = 'list_promoted_articles';

/** A promoted article reduced to what the resource list needs (uri + display). */
export interface PromotedArticleRef {
  id: number;
  title: string;
  /**
   * Brand the article was listed under (the id-or-subdomain naming the brand
   * in multi/all mode). Undefined when the server addresses a single Help
   * Center, whose URIs carry no brand dimension.
   */
  brand?: string;
}

/** Result of a promoted-article scan: the refs, plus whether the cap cut it short. */
export interface PromotedArticleList {
  refs: PromotedArticleRef[];
  /** True when the page cap was hit with more pages remaining (some omitted). */
  truncated: boolean;
}

/** Result of the raw scan: the full promoted articles, plus cost/coverage signals. */
export interface PromotedArticleScan {
  articles: ZendeskArticle[];
  /** True when the page cap was hit with more pages remaining (some omitted). */
  truncated: boolean;
  /** Article pages fetched = number of Zendesk API requests this scan cost. */
  pagesScanned: number;
}

/**
 * Scan the Help Center for promoted ("featured") articles with the CALLER'S
 * token, so the result respects that user's read permissions. The API exposes no
 * server-side `promoted` filter (only label_names / sort), so we page through
 * `/articles` and filter `promoted` client-side, bounded by `maxPages` to keep
 * the scan tractable on a large Help Center. `truncated` signals the cap was hit.
 *
 * `subdomain` is the EFFECTIVE one — the account's, or the resolved brand's own
 * (a brand is only ever <subdomain>.zendesk.com). Returns the FULL promoted
 * articles so callers that need rich metadata (the `list_promoted_articles`
 * tool) get everything; the resource provider maps these down to lean refs
 * before caching so the per-session cache doesn't retain bodies.
 */
export const fetchPromotedArticles = async (
  subdomain: string,
  token: string,
  maxPages: number = ARTICLE_RESOURCES_SCAN_MAX_PAGES,
): Promise<PromotedArticleScan> => {
  const promoted: ZendeskArticle[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
      subdomain,
      token,
      '/articles',
      buildCursorParams(MAX_PAGE_SIZE, cursor),
    );
    const articles = response.articles ?? [];
    for (const article of articles) {
      if (article.promoted) {
        promoted.push(article);
      }
    }
    pages += 1;
    const meta = extractPaginationMeta(response, articles.length);
    cursor = meta.has_more ? (meta.after_cursor ?? undefined) : undefined;
    if (cursor && pages >= maxPages) {
      truncated = true;
      break;
    }
  } while (cursor);

  return { articles: promoted, truncated, pagesScanned: pages };
};

/**
 * Fetch a single article by id (optionally a translated locale) with the
 * caller's token and render it as Markdown: the shared metadata summary plus the
 * body converted from HTML (rather than a raw HTML dump), capped by the response
 * character limit. Reuses the same formatting as the `get_article` tool.
 * `subdomain` is the EFFECTIVE one — the account's, or the resolved brand's own.
 */
export const fetchArticleMarkdown = async (
  subdomain: string,
  token: string,
  id: number,
  locale?: string,
): Promise<string> => {
  const path = locale ? `/${locale}/articles/${id}` : `/articles/${id}`;
  const { article } = await helpCenterGet<{ article: ZendeskArticle }>(subdomain, token, path);
  const text = [formatArticleSummary(article), '', htmlToMarkdown(article.body)].join('\n');
  return truncateIfNeeded(
    text,
    'This resource takes no parameters; read a long article one part at a time with get_article_outline then get_article_section.',
  );
};

export interface ArticleResourcesProvider {
  /** List the promoted articles for the resource template's `list` callback. */
  listPromoted(): Promise<PromotedArticleList>;
  /**
   * Render one article (any id) as Markdown for a resource read. In multi/all
   * mode `brand` carries the {brand} slot of the URI — an id or subdomain,
   * resolved and allow-list-checked exactly like a tool call's brand_id. In
   * unset/single mode there is no brand dimension and the argument is ignored.
   */
  readArticle(id: number, brand?: string): Promise<string>;
}

/**
 * Build an article-resources provider. `listPromoted` memoizes its promise (TTL
 * `ARTICLE_RESOURCES_TTL_MS`) to coalesce the repeated `resources/list` calls a
 * client makes; `readArticle` is a one-shot fetch. As with
 * `createTopologyProvider`, the cache is PER SESSION and must NOT be hoisted to
 * module scope — in HTTP mode a shared one would leak a caller's data to
 * another. `getToken` resolves lazily, so connecting never triggers the OAuth
 * flow, and a 401 notifies `onUnauthorized` to drop the stale token.
 *
 * Branding is resolved through the SHARED brand subdomain resolver, never a
 * second /brands walk: `brandIds` decides which brands `listPromoted` scans
 * (all of them in multi mode, so every allowed brand's promoted articles are
 * listed with their own URIs; 'all' scans every brand of the account), and
 * `readArticle` resolves the URI's {brand} through the same allow-list +
 * resolver the tools use.
 */
export const createArticleResourcesProvider = (
  getToken: () => string | Promise<string>,
  subdomain: string,
  onUnauthorized?: () => void,
  resolveBrandSubdomain: BrandSubdomainResolver = () => Promise.resolve(subdomain),
  brandIds?: string[],
): ArticleResourcesProvider => {
  let cached: { at: number; promise: Promise<PromotedArticleList> } | undefined;

  const notifyIfUnauthorized = (err: unknown): void => {
    if (onUnauthorized && err instanceof ZendeskApiError && err.status === 401) {
      onUnauthorized();
    }
  };

  // The brands whose promoted articles the list callback scans, named as the
  // URIs name them: in multi mode the allow-list entries themselves; in 'all'
  // mode every brand of the account (listed fresh — the same uncached walk
  // list_brands uses — so the URIs can carry each brand's subdomain); in
  // unset/single mode a single undefined entry — one Help Center, no brand
  // dimension.
  const isSingleLock = brandIds !== undefined && brandIds.length === 1 && brandIds[0] !== 'all';

  const listBrands = async (): Promise<(string | undefined)[]> => {
    if (brandIds === undefined || isSingleLock) {
      return [undefined];
    }
    if (brandIds[0] === 'all') {
      // Only brands that can actually serve a Help Center: an inactive brand
      // or one with Guide disabled would 404 the whole listing.
      const all = await fetchAllBrands(subdomain, await getToken());
      return all.filter((b) => b.active && b.has_help_center).map((b) => b.subdomain);
    }
    return brandIds;
  };

  // Resolve the effective Help Center subdomain for one listed/allowed brand
  // entry. Undefined = the account default brand — EXCEPT in single-lock mode,
  // where the undefined slot IS the locked brand and must resolve to it (the
  // lock would otherwise be bypassed by the article resources).
  const effectiveSubdomain = async (brand: string | undefined): Promise<string> => {
    if (brand !== undefined) return resolveBrandSubdomain(brand);
    if (isSingleLock) return resolveBrandSubdomain(brandIds[0] as string);
    return subdomain;
  };

  // One brand's promoted scan, mapped to lean refs. A 401 is the caller's
  // stale token, not a failing brand — it propagates so onUnauthorized
  // invalidates the token. Any other failure skips the brand and marks the
  // result truncated, so one bad brand (Guide disabled mid-session, a 5xx, a
  // stale host) doesn't empty the whole listing.
  const scanBrand = async (
    brand: string | undefined,
    token: string,
  ): Promise<{ refs: PromotedArticleRef[]; truncated: boolean }> => {
    try {
      // Resolution is inside the try: a bad allow-list entry (typo, or a brand
      // deleted after deploy) skips only this brand instead of emptying the
      // whole listing — the same tolerance the tools' allow-list path has.
      const hcSubdomain = await effectiveSubdomain(brand);
      const scan = await fetchPromotedArticles(
        hcSubdomain,
        token,
        ARTICLE_RESOURCES_SCAN_MAX_PAGES,
      );
      return {
        refs: scan.articles.map((a) =>
          brand === undefined ? { id: a.id, title: a.title } : { id: a.id, title: a.title, brand },
        ),
        truncated: scan.truncated,
      };
    } catch (err) {
      if (err instanceof ZendeskApiError && err.status === 401) throw err;
      return { refs: [], truncated: true };
    }
  };

  return {
    listPromoted() {
      const now = Date.now();
      if (cached && now - cached.at < ARTICLE_RESOURCES_TTL_MS) return cached.promise;

      const promise = (async () => {
        const token = await getToken();
        const brands = await listBrands();
        // One bounded scan per brand (sequential: each page is already a
        // request, and fanning brands out in parallel would multiply the burst
        // against the same rate-limited account).
        const refs: PromotedArticleRef[] = [];
        let truncated = false;
        for (const brand of brands) {
          const scan = await scanBrand(brand, token);
          truncated = truncated || scan.truncated;
          refs.push(...scan.refs);
        }
        return { refs, truncated };
      })().catch((err: unknown) => {
        cached = undefined;
        notifyIfUnauthorized(err);
        throw err;
      });

      cached = { at: now, promise };
      return promise;
    },

    async readArticle(id, brand) {
      try {
        const [token, hcSubdomain] = await Promise.all([getToken(), effectiveSubdomain(brand)]);
        return await fetchArticleMarkdown(hcSubdomain, token, id, undefined);
      } catch (err) {
        notifyIfUnauthorized(err);
        throw err;
      }
    },
  };
};
