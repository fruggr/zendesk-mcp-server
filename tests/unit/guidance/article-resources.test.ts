import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ZendeskApiError } from '../../../src/client/zendesk-api';
import {
  createArticleResourcesProvider,
  fetchArticleMarkdown,
  fetchPromotedArticles,
} from '../../../src/guidance/article-resources';
import { errorHandlers, MOCK_PROMOTED_ARTICLE, promotedArticlesHandler } from '../../msw-handlers';
import { mswServer } from '../../setup';

const SUBDOMAIN = 'testsubdomain';
const TOKEN = 'test-token';
const HC = `https://${SUBDOMAIN}.zendesk.com/api/v2/help_center`;

describe('fetchPromotedArticles', () => {
  it('returns only the promoted articles, filtering the rest out client-side', async () => {
    mswServer.use(promotedArticlesHandler);
    const { refs, truncated } = await fetchPromotedArticles(SUBDOMAIN, TOKEN);

    expect(truncated).toBe(false);
    expect(refs).toEqual([{ id: 5001, title: 'Featured guide', locale: 'en-us' }]);
  });

  it('returns an empty list when nothing is promoted', async () => {
    // The default /articles handler returns a single non-promoted article.
    const { refs, truncated } = await fetchPromotedArticles(SUBDOMAIN, TOKEN);
    expect(refs).toEqual([]);
    expect(truncated).toBe(false);
  });

  it('stops at the page cap and flags truncation when more pages remain', async () => {
    mswServer.use(
      http.get(`${HC}/articles`, () =>
        HttpResponse.json({
          articles: [MOCK_PROMOTED_ARTICLE],
          meta: { has_more: true, after_cursor: 'next-cursor' },
          count: 100,
        }),
      ),
    );

    const { refs, truncated } = await fetchPromotedArticles(SUBDOMAIN, TOKEN, 1);
    expect(truncated).toBe(true);
    expect(refs).toHaveLength(1);
  });
});

describe('fetchArticleMarkdown', () => {
  it('renders the article as Markdown (body converted from HTML, not a raw dump)', async () => {
    const text = await fetchArticleMarkdown(SUBDOMAIN, TOKEN, 5000);
    expect(text).toContain('## How to test (5000)');
    expect(text).toContain('Testing guide');
    expect(text).not.toContain('<p>');
  });

  it('fetches a translated locale when one is given', async () => {
    const text = await fetchArticleMarkdown(SUBDOMAIN, TOKEN, 5000, 'fr');
    expect(text).toContain('(5000)');
    expect(text).toContain('**Locale**: fr');
  });
});

describe('createArticleResourcesProvider', () => {
  it('coalesces listPromoted reads within the TTL into a single fetch', async () => {
    const getToken = vi.fn(() => TOKEN);
    const provider = createArticleResourcesProvider(getToken, SUBDOMAIN);

    const [a, b] = await Promise.all([provider.listPromoted(), provider.listPromoted()]);

    expect(a).toBe(b);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed listPromoted — the next call retries', async () => {
    let calls = 0;
    const getToken = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return TOKEN;
    });
    const provider = createArticleResourcesProvider(getToken, SUBDOMAIN);

    await expect(provider.listPromoted()).rejects.toThrow('boom');
    await expect(provider.listPromoted()).resolves.toEqual({ refs: [], truncated: false });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('notifies onUnauthorized when the promoted scan returns 401', async () => {
    mswServer.use(errorHandlers.articlesListUnauthorized);
    const onUnauthorized = vi.fn();
    const provider = createArticleResourcesProvider(() => TOKEN, SUBDOMAIN, onUnauthorized);

    await expect(provider.listPromoted()).rejects.toBeInstanceOf(ZendeskApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('reads any article id as Markdown', async () => {
    const provider = createArticleResourcesProvider(() => TOKEN, SUBDOMAIN);
    const text = await provider.readArticle(5000);
    expect(text).toContain('## How to test (5000)');
    expect(text).toContain('Testing guide');
  });

  it('notifies onUnauthorized when reading an article returns 401', async () => {
    mswServer.use(
      http.get(`${HC}/articles/:id`, () => new HttpResponse('unauthorized', { status: 401 })),
    );
    const onUnauthorized = vi.fn();
    const provider = createArticleResourcesProvider(() => TOKEN, SUBDOMAIN, onUnauthorized);

    await expect(provider.readArticle(5000)).rejects.toBeInstanceOf(ZendeskApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
