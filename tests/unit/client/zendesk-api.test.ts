import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { isZendeskNetworkError, type ZendeskNetworkError } from '../../../src/client/retry';
import {
  fetchZendeskBinary,
  helpCenterGet,
  helpCenterPost,
  helpCenterPut,
  helpCenterUpload,
  ZendeskApiError,
  zendeskGet,
  zendeskPost,
  zendeskPut,
  zendeskUpload,
} from '../../../src/client/zendesk-api';
import { mswServer } from '../../setup';

const SUB = 'testsubdomain';
const TOKEN = 'test-bearer-token';

describe('zendeskGet', () => {
  it('fetches data with Bearer auth', async () => {
    const result = await zendeskGet<{ user: { id: number } }>(SUB, TOKEN, '/users/me');
    expect(result.user.id).toBe(9999);
  });

  it('passes query params', async () => {
    const result = await zendeskGet<{ tickets: unknown[] }>(SUB, TOKEN, '/tickets', {
      'page[size]': '10',
    });
    expect(result.tickets).toHaveLength(1);
  });

  it('throws ZendeskApiError on 404', async () => {
    // Capture the rejection rather than asserting inside a `catch`, which never
    // runs — and so never fails — if the call stops throwing. Same idiom as
    // tests/unit/auth/token-store.test.ts.
    const error = await zendeskGet(SUB, TOKEN, '/tickets/404').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZendeskApiError);
    expect((error as ZendeskApiError).status).toBe(404);
    expect((error as ZendeskApiError).message).toContain('not found');
  });

  it('throws on 401 with auth message', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/forbidden', () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );
    await expect(zendeskGet(SUB, TOKEN, '/forbidden')).rejects.toThrow(/expired/);
  });

  it('throws on 429 with rate limit message', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/ratelimited', () =>
        HttpResponse.json({}, { status: 429 }),
      ),
    );
    await expect(zendeskGet(SUB, TOKEN, '/ratelimited')).rejects.toThrow(/Rate limit/);
  });
});

describe('zendeskPost', () => {
  it('posts data and returns result', async () => {
    const result = await zendeskPost<{ ticket: { id: number; subject: string } }>(
      SUB,
      TOKEN,
      '/tickets',
      { ticket: { subject: 'New ticket' } },
    );
    expect(result.ticket.id).toBe(42);
  });
});

describe('zendeskPut', () => {
  it('puts data and returns result', async () => {
    const result = await zendeskPut<{ ticket: { status: string } }>(SUB, TOKEN, '/tickets/1', {
      ticket: { status: 'solved' },
    });
    expect(result.ticket.status).toBe('solved');
  });
});

describe('helpCenterGet', () => {
  it('fetches help center data', async () => {
    const result = await helpCenterGet<{ categories: unknown[] }>(SUB, TOKEN, '/categories');
    expect(result.categories).toHaveLength(1);
  });
});

describe('helpCenterPost', () => {
  it('posts to help center', async () => {
    const result = await helpCenterPost<{ translation: { locale: string } }>(
      SUB,
      TOKEN,
      '/articles/5000/translations',
      { translation: { locale: 'fr', title: 'Test', body: 'Body' } },
    );
    expect(result.translation.locale).toBe('fr');
  });
});

describe('helpCenterPut', () => {
  it('puts to help center', async () => {
    const result = await helpCenterPut<{ article: { id: number } }>(SUB, TOKEN, '/articles/5000', {
      article: { title: 'Updated' },
    });
    expect(result.article.id).toBe(5000);
  });
});

// The policy itself is unit-tested in retry.test.ts; these check that every
// fetch call site in the client is actually wired to it.
describe('transient failure handling', () => {
  const counting = (
    method: 'get' | 'post' | 'put',
    path: string,
    respond: (hits: number) => Response,
  ) => {
    const calls = { count: 0 };
    mswServer.use(
      http[method](`https://testsubdomain.zendesk.com/api/v2${path}`, () => {
        calls.count += 1;
        return respond(calls.count);
      }),
    );
    return calls;
  };

  it('retries a GET through a 500 and returns the eventual success', async () => {
    const calls = counting('get', '/flaky', (hits) =>
      hits === 1 ? HttpResponse.json({}, { status: 500 }) : HttpResponse.json({ ok: true }),
    );

    await expect(zendeskGet<{ ok: boolean }>(SUB, TOKEN, '/flaky')).resolves.toStrictEqual({
      ok: true,
    });
    expect(calls.count).toBe(2);
  });

  it('retries a GET through a network failure', async () => {
    const calls = counting('get', '/flaky', (hits) =>
      hits === 1 ? HttpResponse.error() : HttpResponse.json({ ok: true }),
    );

    await expect(zendeskGet<{ ok: boolean }>(SUB, TOKEN, '/flaky')).resolves.toStrictEqual({
      ok: true,
    });
    expect(calls.count).toBe(2);
  });

  it('never replays a POST that failed with a 500, so a create cannot double', async () => {
    const calls = counting('post', '/tickets', () => HttpResponse.json({}, { status: 500 }));

    await expect(zendeskPost(SUB, TOKEN, '/tickets', { ticket: {} })).rejects.toThrow(
      /Zendesk API error 500/,
    );
    expect(calls.count).toBe(1);
  });

  it('never replays a PUT that failed with a 500, so a comment cannot double', async () => {
    const calls = counting('put', '/tickets/1', () => HttpResponse.json({}, { status: 500 }));

    await expect(
      zendeskPut(SUB, TOKEN, '/tickets/1', { ticket: { comment: { body: 'hi' } } }),
    ).rejects.toBeInstanceOf(ZendeskApiError);
    expect(calls.count).toBe(1);
  });

  it('never replays a POST that failed before any response', async () => {
    const calls = counting('post', '/tickets', () => HttpResponse.error());

    await expect(zendeskPost(SUB, TOKEN, '/tickets', { ticket: {} })).rejects.toSatisfy(
      isZendeskNetworkError,
    );
    expect(calls.count).toBe(1);
  });

  // The mirror image of the tests above: a 429 is the one case where the client
  // deliberately re-sends a mutation, because Zendesk refused it. `Retry-After: 0`
  // exercises that header without putting a real wait in the suite.
  it('replays a throttled POST exactly once', async () => {
    const calls = counting('post', '/tickets', (hits) =>
      hits === 1
        ? HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '0' } })
        : HttpResponse.json({ ticket: { id: 42 } }),
    );

    await expect(
      zendeskPost<{ ticket: { id: number } }>(SUB, TOKEN, '/tickets', { ticket: {} }),
    ).resolves.toStrictEqual({ ticket: { id: 42 } });
    expect(calls.count).toBe(2);
  });

  it('surfaces a 404 unretried, with its message intact', async () => {
    const calls = counting('get', '/tickets/404', () => HttpResponse.json({}, { status: 404 }));

    await expect(zendeskGet(SUB, TOKEN, '/tickets/404')).rejects.toThrow(/not found/);
    expect(calls.count).toBe(1);
  });
});

describe('network error context', () => {
  it('names the failing request without leaking the token or the query', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/flaky', () => HttpResponse.error()),
    );

    const error = await zendeskGet(SUB, TOKEN, '/flaky', {
      'page[size]': '10',
      secret: 'super-secret-value',
    }).catch((e: unknown) => e);

    expect(isZendeskNetworkError(error)).toBe(true);
    const message = (error as ZendeskNetworkError).message;
    expect(message).toContain('Network error on GET');
    expect(message).toContain('https://testsubdomain.zendesk.com/api/v2/flaky');
    expect(message).toContain('after 3 attempts');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('super-secret-value');
    expect(message).not.toContain('page[size]');
    // ASCII only: non-ASCII bytes break node:http headers on the auth paths.
    expect(message).toMatch(/^[ -~]*$/);
  });

  it('still carries the Bearer token on a tenant-host download', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/attachments/2.png', ({ request }) =>
        HttpResponse.text(request.headers.get('Authorization') ?? 'none', {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const { data, contentType } = await fetchZendeskBinary(
      SUB,
      TOKEN,
      'https://testsubdomain.zendesk.com/attachments/2.png',
    );

    expect(data.toString()).toBe(`Bearer ${TOKEN}`);
    expect(contentType).toBe('image/png');
  });

  it('wraps a binary download failure', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/attachments/1.png', () => HttpResponse.error()),
    );

    const error = await fetchZendeskBinary(
      SUB,
      TOKEN,
      'https://testsubdomain.zendesk.com/attachments/1.png',
    ).catch((e: unknown) => e);

    expect(isZendeskNetworkError(error)).toBe(true);
    expect((error as ZendeskNetworkError).method).toBe('GET');
  });

  it.each([
    [
      'zendeskUpload',
      () => zendeskUpload(SUB, TOKEN, 'a.png', Buffer.from('x'), 'image/png', 'agg-token'),
      'https://testsubdomain.zendesk.com/api/v2/uploads',
    ],
    [
      'helpCenterUpload',
      () => helpCenterUpload(SUB, TOKEN, '/articles/5000/attachments', new FormData()),
      'https://testsubdomain.zendesk.com/api/v2/help_center/articles/5000/attachments',
    ],
  ])('wraps a %s failure without retrying the upload', async (_label, call, target) => {
    const calls = { count: 0 };
    mswServer.use(
      http.post(target, () => {
        calls.count += 1;
        return HttpResponse.error();
      }),
    );

    const error = await call().catch((e: unknown) => e);

    expect(isZendeskNetworkError(error)).toBe(true);
    expect((error as ZendeskNetworkError).target).toBe(target);
    expect(calls.count).toBe(1);
  });
});

describe('auth header', () => {
  it('sends the OAuth token as a Bearer header', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/users/me', ({ request }) => {
        const auth = request.headers.get('Authorization');
        return HttpResponse.json({ user: { auth_header: auth } });
      }),
    );
    const result = await zendeskGet<{ user: { auth_header: string } }>(
      SUB,
      'my-oauth-token',
      '/users/me',
    );
    expect(result.user.auth_header).toBe('Bearer my-oauth-token');
  });
});
