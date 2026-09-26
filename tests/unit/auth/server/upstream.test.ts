import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { generateCodeChallenge } from '../../../../src/auth/browser-oauth';
import {
  buildZendeskAuthorizeUrl,
  exchangeZendeskCode,
  fetchZendeskIdentity,
  isUpstreamAuthError,
  refreshZendeskTokens,
} from '../../../../src/auth/server/upstream';
import { createZendeskOAuthMock, MOCK_USER } from '../../../msw-handlers';
import { mswServer } from '../../../setup';

const UPSTREAM = { subdomain: 'testsubdomain', clientId: 'testsubdomain_zendesk' };
const REDIRECT = 'http://localhost:3000/oauth/callback';
const TOKEN_URL = 'https://testsubdomain.zendesk.com/oauth/tokens';

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
    });
  });

  it('names an unreachable token endpoint', async () => {
    mswServer.use(http.post(TOKEN_URL, () => HttpResponse.error()));
    await expect(
      exchangeZendeskCode(UPSTREAM, { code: 'x', redirectUri: REDIRECT, codeVerifier: 'v' }),
    ).rejects.toThrow('Zendesk token endpoint unreachable.');
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
    await expect(fetchZendeskIdentity(UPSTREAM, 't')).rejects.toThrow(message);
  });
});
