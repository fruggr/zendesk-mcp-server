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

/**
 * Name of the companion tool that lists promoted articles. Shared between the
 * tool definition (`help-center.ts`) and the `--no-article-resources` opt-out
 * filter (`server.ts`) so the two can never drift: renaming the tool here keeps
 * the filter dropping it, preserving the "zero Zendesk calls when off" invariant.
 */
export const LIST_PROMOTED_ARTICLES_TOOL = 'list_promoted_articles';

/** A promoted article reduced to what the resource list needs (uri + display). */
export interface PromotedArticleRef {
  id: number;
  title: string;
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
 * Returns the FULL promoted articles so callers that need rich metadata (the
 * `list_promoted_articles` tool) get everything; the resource provider maps these
 * down to lean refs before caching so the per-session cache doesn't retain bodies.
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
  return truncateIfNeeded(text);
};

export interface ArticleResourcesProvider {
  /** List the promoted articles for the resource template's `list` callback. */
  listPromoted(): Promise<PromotedArticleList>;
  /** Render one article (any id) as Markdown for a resource read. */
  readArticle(id: number): Promise<string>;
}

/**
 * Build an article-resources provider. `listPromoted` holds a memoized-promise
 * cache (TTL `ARTICLE_RESOURCES_TTL_MS`) to coalesce the repeated `resources/list`
 * calls a client makes; `readArticle` is a one-shot fetch (not cached). As with
 * `createTopologyProvider`, the cache is PER SESSION and must NOT be hoisted to
 * module scope — in HTTP mode this provider is instantiated per session, so a
 * shared cache would leak one caller's data to another. `getToken` is resolved
 * lazily at call time (never at construction) so connecting never triggers the
 * OAuth/PKCE flow. A 401 notifies `onUnauthorized` (stdio OAuth) to drop the
 * stale token, mirroring the topology provider and the tool dispatch path.
 */
export const createArticleResourcesProvider = (
  getToken: () => string | Promise<string>,
  subdomain: string,
  onUnauthorized?: () => void,
): ArticleResourcesProvider => {
  let cached: { at: number; promise: Promise<PromotedArticleList> } | undefined;

  const notifyIfUnauthorized = (err: unknown): void => {
    if (onUnauthorized && err instanceof ZendeskApiError && err.status === 401) {
      onUnauthorized();
    }
  };

  return {
    listPromoted() {
      const now = Date.now();
      if (cached && now - cached.at < ARTICLE_RESOURCES_TTL_MS) return cached.promise;

      const promise = (async () => {
        const token = await getToken();
        const { articles, truncated } = await fetchPromotedArticles(subdomain, token);
        // Map to lean refs before caching so the per-session cache holds only the
        // id + title, never the full article bodies from the scan.
        return { refs: articles.map((a) => ({ id: a.id, title: a.title })), truncated };
      })().catch((err: unknown) => {
        cached = undefined;
        notifyIfUnauthorized(err);
        throw err;
      });

      cached = { at: now, promise };
      return promise;
    },

    async readArticle(id) {
      try {
        const token = await getToken();
        return await fetchArticleMarkdown(subdomain, token, id);
      } catch (err) {
        notifyIfUnauthorized(err);
        throw err;
      }
    },
  };
};
