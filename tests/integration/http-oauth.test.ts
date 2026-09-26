import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompactEncrypt, decodeJwt, decodeProtectedHeader, exportJWK, SignJWT } from 'jose';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveKeyRing } from '../../src/auth/server/keys';
import type { Config } from '../../src/config';
import { type HttpServerHandle, startHttpTransport } from '../../src/transports/http';
import { createZendeskOAuthMock, localServerPassthrough } from '../msw-handlers';
import { mswServer } from '../setup';
import { makeConfig } from './harness';
import {
  authorize,
  callMcp,
  createCookieJar,
  DCR_REDIRECT,
  exchangeCode,
  refresh,
  registerDcrClient,
  signInWithDcr,
  tokenRequest,
} from './oauth-client';

const OLD = Buffer.alloc(32, 5).toString('base64');
const NEW = Buffer.alloc(32, 6).toString('base64');

const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CHATGPT = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const UNKNOWN = 'https://tools.example.com/oauth/client.json';

const chatgptKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

// The documents as fetched on 2026-09-24 (see the #127 plan), served from memory.
const cimdDocuments = async (): Promise<Record<string, unknown>> => ({
  [CLAUDE]: {
    client_id: CLAUDE,
    client_name: 'Claude',
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  [CLAUDE_CODE]: {
    client_id: CLAUDE_CODE,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  [CHATGPT]: {
    client_id: CHATGPT,
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_CALLBACK],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    token_endpoint_auth_signing_alg: 'RS256',
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  },
  'https://chatgpt.com/oauth/jwks.json': {
    keys: [{ ...(await exportJWK(chatgptKeys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }],
  },
  [UNKNOWN]: {
    client_id: UNKNOWN,
    client_name: 'Some Tool',
    redirect_uris: ['https://tools.example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
});

const cimdRequests: string[] = [];

const cimdFetch = async (input: string | URL | Request): Promise<Response> => {
  cimdRequests.push(String(input));
  const doc = (await cimdDocuments())[String(input)];
  return doc ? Response.json(doc) : new Response('not found', { status: 404 });
};

describe('HTTP authorization server', () => {
  let handle: HttpServerHandle | undefined;
  let base = '';
  let zendesk: ReturnType<typeof createZendeskOAuthMock>;
  let dir: string;

  const start = async (overrides: Partial<Config> = {}, accessTtlSeconds?: number) => {
    if (accessTtlSeconds !== undefined) {
      zendesk = createZendeskOAuthMock({ accessTtlSeconds });
      mswServer.use(localServerPassthrough, ...zendesk.handlers);
    }
    handle = await startHttpTransport(
      makeConfig({
        transport: 'http',
        oauthStore: 'memory://',
        oauthMasterSecret: OLD,
        ...overrides,
      }),
      undefined,
      { cimdFetch },
    );
    base = `http://127.0.0.1:${handle.port}`;
    return handle;
  };

  const restart = async (overrides: Partial<Config>) => {
    const port = handle?.port ?? 0;
    await handle?.close();
    return start({ port, ...overrides });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmcp-as-'));
    zendesk = createZendeskOAuthMock();
    mswServer.use(localServerPassthrough, ...zendesk.handlers);
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('discovery', () => {
    it('advertises DCR, CIMD, RFC 9207 iss, PKCE S256 and the client auth methods ChatGPT needs', async () => {
      await start({ publicUrl: 'https://mcp.example.com' });
      // As a TLS-terminating reverse proxy in front would forward it.
      const meta = await (
        await fetch(`${base}/.well-known/oauth-authorization-server`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mcp.example.com' },
        })
      ).json();
      expect({
        issuer: meta.issuer,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        registration_endpoint: meta.registration_endpoint,
        client_id_metadata_document_supported: meta.client_id_metadata_document_supported,
        authorization_response_iss_parameter_supported:
          meta.authorization_response_iss_parameter_supported,
        code_challenge_methods_supported: meta.code_challenge_methods_supported,
        grant_types_supported: meta.grant_types_supported,
        token_endpoint_auth_methods_supported: meta.token_endpoint_auth_methods_supported,
        scopes_supported: meta.scopes_supported,
        userinfo_endpoint: meta.userinfo_endpoint,
        end_session_endpoint: meta.end_session_endpoint,
      }).toMatchInlineSnapshot(`
        {
          "authorization_endpoint": "https://mcp.example.com/auth",
          "authorization_response_iss_parameter_supported": true,
          "client_id_metadata_document_supported": true,
          "code_challenge_methods_supported": [
            "S256",
          ],
          "end_session_endpoint": undefined,
          "grant_types_supported": [
            "authorization_code",
            "refresh_token",
          ],
          "issuer": "https://mcp.example.com",
          "registration_endpoint": "https://mcp.example.com/reg",
          "scopes_supported": [
            "read",
            "write",
            "offline_access",
            "openid",
          ],
          "token_endpoint": "https://mcp.example.com/token",
          "token_endpoint_auth_methods_supported": [
            "none",
            "private_key_jwt",
            "client_secret_basic",
            "client_secret_post",
          ],
          "userinfo_endpoint": undefined,
        }
      `);
    });

    it('narrows every advertised scope to read under --read-only', async () => {
      await start({ readOnly: true });
      const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
      const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      expect(prm.scopes_supported).toEqual(['read']);
      expect(meta.scopes_supported).not.toContain('write');
    });

    it('serves the derived signing key, never the library development keys', async () => {
      await start();
      const jwks = await (await fetch(`${base}/jwks`)).json();
      expect(jwks.keys.map((k: { kid: string }) => k.kid)).toEqual([
        deriveKeyRing(OLD)[0].signingJwk.kid,
      ]);
      expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
      expect(jwks.keys[0].d).toBeUndefined();
    });
  });

  describe('DCR clients', () => {
    it('show the consent screen once, then sign in without it', async () => {
      await start();
      const { clientId, result, tokens } = await signInWithDcr(base);
      expect(result.consentShown).toBe(true);
      expect(result.iss).toBe(base);
      expect(tokens.status).toBe(200);
      expect(tokens.body).toMatchObject({
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      });
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);

      const again = await authorize(base, { clientId, redirectUri: DCR_REDIRECT });
      expect(again.consentShown).toBe(false);
      expect(again.code).toEqual(expect.any(String));
      expect(zendesk.state.codeExchanges).toBe(2);
    });

    it('send the user back with access_denied when consent is refused', async () => {
      await start();
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
        deny: true,
      });
      expect(result.consentShown).toBe(true);
      expect(result.code).toBeUndefined();
      expect(result.error).toBe('access_denied');
    });

    it('send the user back with access_denied when Zendesk refuses the sign-in', async () => {
      await start();
      mswServer.use(
        http.post('https://testsubdomain.zendesk.com/oauth/tokens', () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      expect(result.error).toBe('access_denied');
    });

    it('request only the read scope from Zendesk under --read-only', async () => {
      await start({ readOnly: true });
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
        scope: 'read',
      });
      expect(result.code).toEqual(expect.any(String));
      const tokens = await exchangeCode(base, body.client_id ?? '', DCR_REDIRECT, result);
      expect(tokens.body.scope).toBe('read');
    });
  });

  describe('CIMD clients', () => {
    it('skip consent for claude.ai, whose redirect is HTTPS and in its own document', async () => {
      await start();
      const result = await authorize(base, { clientId: CLAUDE, redirectUri: CLAUDE_CALLBACK });
      expect(result.consentShown).toBe(false);
      expect(result.code).toEqual(expect.any(String));
      expect(result.iss).toBe(base);
      const tokens = await exchangeCode(base, CLAUDE, CLAUDE_CALLBACK, result);
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });

    it('show consent to claude.ai once the built-in allowlist is dropped', async () => {
      await start({ defaultTrustedClients: false });
      const result = await authorize(base, { clientId: CLAUDE, redirectUri: CLAUDE_CALLBACK });
      expect(result.consentShown).toBe(true);
      expect(result.code).toEqual(expect.any(String));
    });

    it('skip consent for a client added with --oauth-trusted-client', async () => {
      await start({ oauthTrustedClients: [UNKNOWN] });
      const result = await authorize(base, {
        clientId: UNKNOWN,
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.consentShown).toBe(false);
    });

    it('show consent to an unknown client', async () => {
      await start();
      const result = await authorize(base, {
        clientId: UNKNOWN,
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.consentShown).toBe(true);
    });

    it('accept Claude Code on a random loopback port, behind the consent screen', async () => {
      await start();
      const redirectUri = 'http://127.0.0.1:53123/callback';
      const result = await authorize(base, { clientId: CLAUDE_CODE, redirectUri });
      expect(result.consentShown).toBe(true);
      expect(result.code).toEqual(expect.any(String));
      expect((await exchangeCode(base, CLAUDE_CODE, redirectUri, result)).status).toBe(200);
    });

    it('refuse a redirect the document does not list', async () => {
      await start();
      const result = await authorize(base, {
        clientId: CLAUDE,
        redirectUri: 'https://evil.example/cb',
      });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_redirect_uri');
    });

    it('authenticate ChatGPT with private_key_jwt and skip its consent', async () => {
      await start();
      const result = await authorize(base, { clientId: CHATGPT, redirectUri: CHATGPT_CALLBACK });
      expect(result.consentShown).toBe(false);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(CHATGPT)
        .setSubject(CHATGPT)
        .setAudience(base)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(chatgptKeys.privateKey);
      const tokens = await tokenRequest(base, {
        grant_type: 'authorization_code',
        client_id: CHATGPT,
        code: result.code ?? '',
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: result.verifier,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      });
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });
  });

  describe('error paths', () => {
    const html = async (res: Response) => ({ status: res.status, body: await res.text() });

    it('answers an expired or foreign sign-in link with a plain error page', async () => {
      await start();
      const unknown = await html(
        await fetch(`${base}/interaction/unknown-uid`, { redirect: 'manual' }),
      );
      expect(unknown.status).toBe(400);
      expect(unknown.body).toContain('This sign-in has expired or was opened in another browser.');
      const bad = await html(
        await fetch(`${base}/interaction/not%20a%20uid`, { redirect: 'manual' }),
      );
      expect(bad.status).toBe(404);
      const noRoute = await html(
        await fetch(`${base}/interaction/abc/whatever`, { redirect: 'manual' }),
      );
      expect(noRoute.status).toBe(404);
    });

    it('rejects a Zendesk callback whose state is not an interaction id', async () => {
      await start();
      const res = await fetch(`${base}/oauth/callback?code=x&state=%2F%2Fevil.example`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });

    it('relays a Zendesk callback without a code as a refused sign-in', async () => {
      await start();
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/oauth/authorizations/new', ({ request }) => {
          const url = new URL(request.url);
          const back = new URL(url.searchParams.get('redirect_uri') ?? '');
          back.searchParams.set('error', 'access_denied');
          back.searchParams.set('state', url.searchParams.get('state') ?? '');
          return new HttpResponse(null, { status: 302, headers: { location: back.toString() } });
        }),
      );
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      expect(result.error).toBe('access_denied');
    });

    it('refuses the sign-in when Zendesk does not say who the user is', async () => {
      await start();
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/users/me', () =>
          HttpResponse.json({ user: { id: null } }),
        ),
      );
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      expect(result.error).toBe('access_denied');
    });

    it('refuses a token for another resource', async () => {
      await start();
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
        resource: 'https://other.example/mcp',
      });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_target');
    });

    it('never fetches a client metadata document over plain HTTP', async () => {
      await start();
      const result = await authorize(base, {
        clientId: 'http://tools.example.com/oauth/client.json',
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_client');
    });
  });

  describe('access tokens', () => {
    it('reject a raw Zendesk token (no passthrough), a foreign audience and an expired token', async () => {
      await start();
      const { tokens } = await signInWithDcr(base);
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);

      const raw = await callMcp(base, 'zd-access-2');
      expect(raw.status).toBe(401);
      expect(raw.wwwAuthenticate).toBe(
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token. Sign in through this server: its OAuth authorization server is named in the protected resource metadata."`,
      );

      const [keys] = deriveKeyRing(OLD);
      const forge = (claims: Record<string, unknown>) =>
        new CompactEncrypt(
          new TextEncoder().encode(
            JSON.stringify({
              iss: base,
              aud: `${base}/mcp`,
              exp: Math.floor(Date.now() / 1000) + 60,
              zd: 'zd-access-2',
              gid: 'g',
              sub: 's',
              ...claims,
            }),
          ),
        )
          .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: keys.accessToken.kid })
          .encrypt(keys.accessToken.key);
      expect((await callMcp(base, await forge({}))).status).toBe(200);
      expect((await callMcp(base, await forge({ aud: 'https://other.example/mcp' }))).status).toBe(
        401,
      );
      expect((await callMcp(base, await forge({ iss: 'https://other.example' }))).status).toBe(401);
      expect(
        (await callMcp(base, await forge({ exp: Math.floor(Date.now() / 1000) - 1 }))).status,
      ).toBe(401);
      expect((await callMcp(base, await forge({ zd: undefined }))).status).toBe(401);
      expect((await callMcp(base, undefined)).status).toBe(401);
    });
  });

  describe('refresh', () => {
    it('rotates our refresh token and keeps the Zendesk one until it nears expiry', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(200);
      expect(next.body.refresh_token).not.toBe(tokens.body.refresh_token);
      expect(zendesk.state.refreshes).toBe(0);
      expect((await callMcp(base, next.body.access_token)).status).toBe(200);
    });

    it('never spends a Zendesk refresh token twice, however parallel refreshes interleave', async () => {
      // A Zendesk token shorter than our access token is refreshed on every
      // issuance, so every one of these refreshes reaches Zendesk. How ours
      // interleave is timing: truly concurrent ones all pass, one that lands
      // after another consumed the token is a replay and ends the grant. Either
      // way the per-grant lock keeps Zendesk from seeing a reused token.
      await start({}, 60);
      const { clientId, tokens } = await signInWithDcr(base);
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => refresh(base, clientId, tokens.body.refresh_token ?? '')),
      );
      for (const result of results) {
        expect(result.status === 200 || result.body.error === 'invalid_grant').toBe(true);
      }
      expect(results.some((result) => result.status === 200)).toBe(true);
      expect(zendesk.state.refreshFailures).toBe(0);
    });

    it('revokes the whole grant when a consumed refresh token is replayed', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      const replay = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(replay.body.error).toBe('invalid_grant');
      const latest = await refresh(base, clientId, next.body.refresh_token ?? '');
      expect(latest.body.error).toBe('invalid_grant');
    });

    it('ends the grant when Zendesk refuses the upstream refresh', async () => {
      await start({}, 60);
      const { clientId, tokens } = await signInWithDcr(base);
      mswServer.use(
        http.post('https://testsubdomain.zendesk.com/oauth/tokens', () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(400);
      expect(next.body.error).toBe('invalid_grant');
    });
  });

  describe('provider configuration', () => {
    it('signs in to Zendesk again on every authorization, even with a live browser session', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const jar = createCookieJar();
      expect((await authorize(base, { clientId, redirectUri: DCR_REDIRECT, jar })).code).toEqual(
        expect.any(String),
      );
      const again = await authorize(base, { clientId, redirectUri: DCR_REDIRECT, jar });
      expect(again.code).toEqual(expect.any(String));
      expect(again.hops).toContain('GET 302 /oauth/authorizations/new');
      expect(zendesk.state.codeExchanges).toBe(2);
      const silent = await authorize(base, {
        clientId,
        redirectUri: DCR_REDIRECT,
        jar,
        extra: { prompt: 'none' },
      });
      expect({ error: silent.error, description: silent.errorDescription }).toEqual({
        error: 'interaction_required',
        description: 'every authorization signs in to Zendesk again',
      });
    });

    it('registers a DCR client as a public code-flow client with refresh by default', async () => {
      await start();
      const res = await fetch(`${base}/reg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [DCR_REDIRECT] }),
      });
      const body = await res.json();
      expect(res.status).toBe(201);
      expect({
        grant_types: body.grant_types,
        response_types: body.response_types,
        token_endpoint_auth_method: body.token_endpoint_auth_method,
        id_token_signed_response_alg: body.id_token_signed_response_alg,
      }).toMatchInlineSnapshot(`
        {
          "grant_types": [
            "authorization_code",
            "refresh_token",
          ],
          "id_token_signed_response_alg": "EdDSA",
          "response_types": [
            "code",
          ],
          "token_endpoint_auth_method": "none",
        }
      `);
      const result = await authorize(base, { clientId: body.client_id, redirectUri: DCR_REDIRECT });
      const tokens = await exchangeCode(base, body.client_id, DCR_REDIRECT, result);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });

    it('advertises and accepts the code flow only', async () => {
      await start();
      const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      expect(meta.response_types_supported).toEqual(['code']);
      const { body } = await registerDcrClient(base, { response_types: ['code id_token'] });
      expect(body.error).toBe('invalid_client_metadata');
    });

    const forwardedHttpsCookies = async () => {
      const { body } = await registerDcrClient(base);
      const res = await fetch(
        `${base}/auth?client_id=${body.client_id}&redirect_uri=${encodeURIComponent(DCR_REDIRECT)}&response_type=code&scope=read&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
        { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } },
      );
      return new Set(res.headers.getSetCookie().map((c) => /;\s*secure/i.test(c)));
    };

    it('trusts X-Forwarded-Proto behind an HTTPS public URL, so its cookies are Secure', async () => {
      await start({ publicUrl: 'https://mcp.example.com' });
      expect(await forwardedHttpsCookies()).toEqual(new Set([true]));
    });

    it('ignores X-Forwarded-Proto behind a plain HTTP public URL', async () => {
      await start({ publicUrl: 'http://mcp.example.com' });
      expect(await forwardedHttpsCookies()).toEqual(new Set([false]));
    });

    it('refuses a provider request from an origin outside the CORS allowlist', async () => {
      await start({ corsOrigins: ['https://app.example'] });
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const res = await fetch(`${base}/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: 'nope',
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: `origin https://evil.example not allowed for client: ${clientId}`,
      });
    });

    it('renders an error it cannot send back to the client as an HTML page', async () => {
      await start();
      const res = await fetch(
        `${base}/auth?client_id=unknown&response_type=code&redirect_uri=${encodeURIComponent(DCR_REDIRECT)}`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toMatchInlineSnapshot(
        `"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><h1>Sign-in failed</h1><p>invalid_client: client is invalid</p></body></html>"`,
      );
    });

    it('fetches a client metadata document over HTTPS on the default port only', async () => {
      await start();
      const fetched = async (clientId: string) => {
        cimdRequests.length = 0;
        await authorize(base, { clientId, redirectUri: 'https://tools.example.com/callback' });
        return cimdRequests.length > 0;
      };
      expect(await fetched('https://tools.example.com:8443/oauth/client.json')).toBe(false);
      expect(await fetched('http://tools.example.com/oauth/client.json')).toBe(false);
      expect(await fetched('https://tools.example.com:443/oauth/client.json')).toBe(true);
      expect(await fetched(UNKNOWN)).toBe(true);
    });
  });

  describe('provider protocol', () => {
    const form = (path: string, params: Record<string, string>) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
        body: new URLSearchParams(params),
      });

    it('requires PKCE, from confidential clients too', async () => {
      await start();
      const refusal = async (client: string, redirectUri: string) => {
        const res = await fetch(
          `${base}/auth?client_id=${encodeURIComponent(client)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=read`,
          { redirect: 'manual' },
        );
        const back = new URL(res.headers.get('location') ?? '', base);
        return [back.searchParams.get('error'), back.searchParams.get('error_description')];
      };
      const expected = [
        'invalid_request',
        'Authorization Server policy requires PKCE to be used for this request',
      ];
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      expect(await refusal(clientId, DCR_REDIRECT)).toEqual(expected);
      expect(await refusal(CHATGPT, CHATGPT_CALLBACK)).toEqual(expected);
    });

    it('defaults the resource to /mcp and issues for the granted one when the token request names none', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const result = await authorize(base, {
        clientId,
        redirectUri: DCR_REDIRECT,
        resource: null,
      });
      const res = await form('/token', {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: DCR_REDIRECT,
        code: result.code ?? '',
        code_verifier: result.verifier,
      });
      const tokens = await res.json();
      expect(res.status).toBe(200);
      expect((await callMcp(base, tokens.access_token)).status).toBe(200);
      const next = await form('/token', {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      });
      expect(next.status).toBe(200);
      expect((await callMcp(base, (await next.json()).access_token)).status).toBe(200);
    });

    it('revokes a refresh token at the revocation endpoint', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const res = await form('/token/revocation', {
        client_id: clientId,
        token: tokens.body.refresh_token ?? '',
      });
      expect(res.status).toBe(200);
      expect((await refresh(base, clientId, tokens.body.refresh_token ?? '')).body.error).toBe(
        'invalid_grant',
      );
    });

    it('issues an ID token for the Zendesk account when openid is asked for', async () => {
      await start();
      const result = await authorize(base, {
        clientId: CLAUDE,
        redirectUri: CLAUDE_CALLBACK,
        scope: 'openid read write',
      });
      const tokens = await tokenRequest(base, {
        grant_type: 'authorization_code',
        client_id: CLAUDE,
        redirect_uri: CLAUDE_CALLBACK,
        code: result.code ?? '',
        code_verifier: result.verifier,
      });
      const idToken = (tokens.body as { id_token?: string }).id_token ?? '';
      expect(decodeJwt(idToken)).toMatchObject({ sub: 'zendesk:9999', aud: CLAUDE, iss: base });
      expect(decodeProtectedHeader(idToken).alg).toBe('EdDSA');
    });

    it('keeps an interaction ten minutes and a browser session twelve hours', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const jar = createCookieJar();
      const lifetimes = new Map<string, number>();
      const record = jar.store;
      jar.store = (res: Response) => {
        for (const cookie of res.headers.getSetCookie()) {
          const expires = /expires=([^;]+)/i.exec(cookie)?.[1];
          if (expires) {
            lifetimes.set(cookie.split('=')[0] ?? '', Date.parse(expires) - Date.now());
          }
        }
        record(res);
      };
      await authorize(base, { clientId, redirectUri: DCR_REDIRECT, jar });
      const minutes = (name: string) => Math.round((lifetimes.get(name) ?? 0) / 60_000);
      expect(minutes('_interaction')).toBe(10);
      expect(minutes('_session')).toBe(12 * 60);
    });

    it('narrows the grantable scopes to read under --read-only', async () => {
      await start({ readOnly: true });
      const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      expect(meta.scopes_supported).toEqual(['read', 'offline_access', 'openid']);
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const result = await authorize(base, {
        clientId,
        redirectUri: DCR_REDIRECT,
        scope: 'read write',
      });
      const tokens = await exchangeCode(base, clientId, DCR_REDIRECT, result);
      expect(tokens.body.scope).toBe('read');
    });
  });

  describe('persistence and keys', () => {
    const fileStore = () => pathToFileURL(join(dir, 'store', 'oauth-store.json')).href;

    it('keeps users signed in across a restart with a file store and the same secret', async () => {
      await start({ oauthStore: fileStore() });
      const { clientId, tokens } = await signInWithDcr(base);
      await restart({ oauthStore: fileStore() });
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(200);
      expect((await callMcp(base, next.body.access_token)).status).toBe(200);
    });

    it('stores no raw token, no Zendesk token and no account id', async () => {
      await start({ oauthStore: fileStore() });
      const { clientId, tokens } = await signInWithDcr(base);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      const raw = readFileSync(join(dir, 'store', 'oauth-store.json'), 'utf8');
      for (const secret of [
        tokens.body.refresh_token,
        next.body.refresh_token,
        clientId,
        'zd-',
        '9999',
      ]) {
        expect(raw).not.toContain(secret);
      }
    });

    it('rotates the secret: old tokens work while the old secret is listed, and not after', async () => {
      await start({ oauthStore: fileStore(), oauthMasterSecret: OLD });
      const { clientId, tokens } = await signInWithDcr(base);

      await restart({ oauthStore: fileStore(), oauthMasterSecret: `${NEW},${OLD}` });
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);
      const underBoth = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(underBoth.status).toBe(200);

      await restart({ oauthStore: fileStore(), oauthMasterSecret: NEW });
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(401);
      expect((await callMcp(base, underBoth.body.access_token)).status).toBe(200);
      // The DCR client was re-encrypted when read under both secrets, so it survives.
      expect((await refresh(base, clientId, underBoth.body.refresh_token ?? '')).status).toBe(200);
    });

    it('refuses to start on a supplied secret shorter than 32 bytes, before binding a port', async () => {
      await expect(
        start({ oauthMasterSecret: Buffer.alloc(16).toString('base64') }),
      ).rejects.toThrow('OAuth master secret must decode to at least 32 bytes');
      handle = undefined;
    });

    it('generates and persists a secret when none is supplied, and reuses it on restart', async () => {
      const previous = process.env['XDG_CONFIG_HOME'];
      process.env['XDG_CONFIG_HOME'] = dir;
      try {
        await start({ oauthMasterSecret: undefined, oauthStore: fileStore() });
        const secretFile = join(dir, 'fruggr', 'zendesk-mcp-server', 'oauth-master-secret');
        expect(existsSync(secretFile)).toBe(true);
        const { tokens } = await signInWithDcr(base);
        await restart({ oauthMasterSecret: undefined, oauthStore: fileStore() });
        expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);
      } finally {
        if (previous === undefined) delete process.env['XDG_CONFIG_HOME'];
        else process.env['XDG_CONFIG_HOME'] = previous;
      }
    });

    it('signs its cookies', async () => {
      await start();
      const { body } = await registerDcrClient(base);
      const res = await fetch(
        `${base}/auth?client_id=${body.client_id}&redirect_uri=${encodeURIComponent(DCR_REDIRECT)}&response_type=code&scope=read&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      const names = res.headers.getSetCookie().map((c) => c.split('=')[0]);
      expect(names).toContain('_interaction');
      expect(names).toContain('_interaction.sig');
    });
  });
});
