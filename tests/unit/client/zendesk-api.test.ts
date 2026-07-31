import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  helpCenterGet,
  helpCenterPost,
  helpCenterPut,
  ZendeskApiError,
  zendeskGet,
  zendeskPost,
  zendeskPut,
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
