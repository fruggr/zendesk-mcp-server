import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { generateCodeChallenge } from '../../../../src/auth/browser-oauth';
import {
  buildZendeskAuthorizeUrl,
  exchangeZendeskCode,
  fetchZendeskIdentity,
  isUpstreamAuthError,
  refreshZendeskTokens,
} from '../../../../src/auth/server/upstream';
import { ZendeskApiError } from '../../../../src/client/zendesk-api';
import type { Logger } from '../../../../src/utils/logger';
import { createZendeskOAuthMock, MOCK_USER } from '../../../msw-handlers';
import { mswServer } from '../../../setup';

const UPSTREAM = { subdomain: 'testsubdomain', clientId: 'testsubdomain_zendesk' };
const REDIRECT = 'http://localhost:3000/oauth/callback';
const TOKEN_URL = 'https://testsubdomain.zendesk.com/oauth/tokens';

const recordingLogger = () => {
  const events: [string, string, unknown][] = [];
  const logger: Logger = {
    debug: (e, f) => events.push(['debug', e, f]),
    info: (e, f) => events.push(['info', e, f]),
    warn: (e, f) => events.push(['warn', e, f]),
    error: (e, f) => events.push(['error', e, f]),
    attachServer: vi.fn(),
  };
  return { logger, events };
};

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
};

const signIn = async (mock: ReturnType<typeof createZendeskOAuthMock>) => {
  const verifier = 'v'.repeat(43);
  const authorize = buildZendeskAuthorizeUrl(UPSTREAM, {
    redirectUri: REDIRECT,
    scope: 'read write',
    state: 'st',
    codeChallenge: generateCodeChallenge(verifier),
  });
  const res = await fetch(authorize, { redirect: 'manual' });
  const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
  return { code, verifier, mock };
};

describe('buildZendeskAuthorizeUrl', () => {
  it('asks Zendesk for a PKCE code on the shared public client', () => {
    expect(
      buildZendeskAuthorizeUrl(UPSTREAM, {
        redirectUri: REDIRECT,
        scope: 'read write',
        state: 's t',
        codeChallenge: 'chal',
      }),
    ).toMatchInlineSnapshot(
      `"https://testsubdomain.zendesk.com/oauth/authorizations/new?response_type=code&client_id=testsubdomain_zendesk&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Foauth%2Fcallback&scope=read+write&state=s+t&code_challenge=chal&code_challenge_method=S256"`,
    );
  });
});

describe('exchangeZendeskCode', () => {
  it('exchanges the code with the verifier and asks for the maximum lifetimes', async () => {
    const mock = createZendeskOAuthMock();
    mswServer.use(...mock.handlers);
    const { code, verifier } = await signIn(mock);
    const before = Date.now();
    const tokens = await exchangeZendeskCode(UPSTREAM, {
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(tokens.accessToken).toMatch(/^zd-access-/);
    expect(tokens.refreshToken).toMatch(/^zd-refresh-/);
    expect(tokens.scope).toBe('read write');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 172800 * 1000);
    const sent = mock.state.tokenRequests[0];
    expect(Object.fromEntries(sent ?? [])).toEqual({
      client_id: 'testsubdomain_zendesk',
      expires_in: '172800',
      refresh_token_expires_in: '7776000',
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(sent?.has('client_secret')).toBe(false);
  });

  it('reports a refused exchange with an ASCII message and never the Zendesk body', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ error: 'invalid_grant', detail: 'ünïcode' }, { status: 400 }),
      ),
    );
    const failure = exchangeZendeskCode(UPSTREAM, {
      code: 'x',
      redirectUri: REDIRECT,
      codeVerifier: 'v',
    });
    await expect(failure).rejects.toThrow('Zendesk refused the authorization_code grant (400).');
    await failure.catch((err: unknown) => {
      expect(isUpstreamAuthError(err)).toBe(true);
      expect((err as { status?: number }).status).toBe(400);
      expect(Object.hasOwn(err as Error, 'cause')).toBe(false);
    });
  });

  it('posts a form-encoded body and logs the grant type with the status', async () => {
    const seen: { method: string; contentType: string | null }[] = [];
    mswServer.use(
      http.post(TOKEN_URL, ({ request }) => {
        seen.push({ method: request.method, contentType: request.headers.get('content-type') });
        return HttpResponse.json({ access_token: 'a', token_type: 'bearer' });
      }),
    );
    const { logger, events } = recordingLogger();
    await exchangeZendeskCode(
      UPSTREAM,
      { code: 'x', redirectUri: REDIRECT, codeVerifier: 'v' },
      logger,
    );
    expect(seen).toEqual([{ method: 'POST', contentType: 'application/x-www-form-urlencoded' }]);
    expect(events).toEqual([
      ['debug', 'oauth_upstream_token', { grant: 'authorization_code', status: 200 }],
    ]);
  });

  it('names an unreachable token endpoint', async () => {
    mswServer.use(http.post(TOKEN_URL, () => HttpResponse.error()));
    const err = await rejection(
      exchangeZendeskCode(UPSTREAM, { code: 'x', redirectUri: REDIRECT, codeVerifier: 'v' }),
    );
    expect(err.message).toBe('Zendesk token endpoint unreachable.');
    expect(isUpstreamAuthError(err)).toBe(true);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(Object.hasOwn(err, 'status')).toBe(false);
  });

  it('leaves expiresAt unset when Zendesk reports no expiry', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ access_token: 'a', token_type: 'bearer' })),
    );
    const tokens = await exchangeZendeskCode(UPSTREAM, {
      code: 'x',
      redirectUri: REDIRECT,
      codeVerifier: 'v',
    });
    expect(tokens).toEqual({
      accessToken: 'a',
      refreshToken: undefined,
      expiresAt: undefined,
      scope: undefined,
    });
  });
});

describe('refreshZendeskTokens', () => {
  it('rotates the pair, and a second use of the old refresh token fails', async () => {
    const mock = createZendeskOAuthMock();
    mswServer.use(...mock.handlers);
    const { code, verifier } = await signIn(mock);
    const first = await exchangeZendeskCode(UPSTREAM, {
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    const second = await refreshZendeskTokens(UPSTREAM, first.refreshToken ?? '');
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(Object.fromEntries(mock.state.tokenRequests[1] ?? [])).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
      expires_in: '172800',
    });
    await expect(refreshZendeskTokens(UPSTREAM, first.refreshToken ?? '')).rejects.toThrow(
      'Zendesk refused the refresh_token grant (400).',
    );
  });

  it('keeps the previous refresh token when Zendesk does not rotate it', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ access_token: 'a2', token_type: 'bearer' })),
    );
    expect((await refreshZendeskTokens(UPSTREAM, 'rt-1')).refreshToken).toBe('rt-1');
  });
});

describe('fetchZendeskIdentity', () => {
  it('resolves the account behind a live token', async () => {
    const mock = createZendeskOAuthMock();
    mswServer.use(...mock.handlers);
    const { code, verifier } = await signIn(mock);
    const tokens = await exchangeZendeskCode(UPSTREAM, {
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(await fetchZendeskIdentity(UPSTREAM, tokens.accessToken)).toEqual({
      id: MOCK_USER.id,
      name: MOCK_USER.name,
      role: MOCK_USER.role,
    });
  });

  it('refuses an anonymous answer and a failed call alike', async () => {
    const message = 'Could not resolve the Zendesk account of the signed-in user.';
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/users/me', () =>
        HttpResponse.json({ user: { id: null, name: 'Anonymous user' } }),
      ),
    );
    await expect(fetchZendeskIdentity(UPSTREAM, 't')).rejects.toThrow(message);
    mswServer.use(
      http.get(
        'https://testsubdomain.zendesk.com/api/v2/users/me',
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    const failed = await rejection(fetchZendeskIdentity(UPSTREAM, 't'));
    expect(failed.message).toBe(message);
    expect(isUpstreamAuthError(failed)).toBe(true);
    expect(failed.cause).toBeInstanceOf(ZendeskApiError);
  });

  it('refuses an answer that carries no user at all', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/users/me', () => HttpResponse.json({})),
    );
    const err = await rejection(fetchZendeskIdentity(UPSTREAM, 't'));
    expect(err.message).toBe('Could not resolve the Zendesk account of the signed-in user.');
    expect(Object.hasOwn(err, 'cause')).toBe(false);
  });
});

describe('isUpstreamAuthError', () => {
  it('recognises only an Error named UpstreamAuthError', () => {
    expect(isUpstreamAuthError(new Error('x'))).toBe(false);
    expect(isUpstreamAuthError({ name: 'UpstreamAuthError', message: 'x' })).toBe(false);
    expect(isUpstreamAuthError('UpstreamAuthError')).toBe(false);
  });
});
