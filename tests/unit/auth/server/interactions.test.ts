import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpResponse, http } from 'msw';
import type Provider from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_MEMORY_TTL_S,
  consentMemoryKey,
  createInteractionRoutes,
  type InteractionDeps,
} from '../../../../src/auth/server/interactions';
import type { ZendeskTokenSet } from '../../../../src/auth/server/upstream';
import type { Logger } from '../../../../src/utils/logger';
import { createZendeskOAuthMock } from '../../../msw-handlers';
import { mswServer } from '../../../setup';

/**
 * The interaction routes against a scripted stand-in for oidc-provider: each
 * test sets what `interactionDetails` answers and reads back what the routes
 * handed to `interactionFinished`, the Grant and the stores. Zendesk is MSW.
 */

const ISSUER = 'https://mcp.example.com';
const RESOURCE = `${ISSUER}/mcp`;
const TRUSTED = 'https://trusted.example/client.json';
const TRUSTED_REDIRECT = 'https://trusted.example/callback';
const DCR = 'dcr-client';
const DCR_REDIRECT = 'http://127.0.0.1:9/callback';
const ACCOUNT = 'zendesk:9999';
const EXPIRED =
  'This sign-in has expired or was opened in another browser. Start the connection again from your MCP client.';

interface Details {
  prompt: { name: string; details: Record<string, unknown> };
  params: Record<string, unknown>;
  session?: { accountId: string };
}

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writes: number;
  writeHead(status: number, headers?: Record<string, string>): FakeResponse;
  end(body?: string): void;
}

const fakeRes = (): FakeResponse => ({
  status: 0,
  headers: {},
  body: '',
  headersSent: false,
  writes: 0,
  writeHead(status, headers = {}) {
    if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    this.writes += 1;
    return this;
  },
  end(body = '') {
    this.body = body;
  },
});

const REQ = {} as IncomingMessage;
const asRes = (res: FakeResponse) => res as unknown as ServerResponse;

interface GrantRecord {
  accountId: string;
  clientId: string;
  oidc: string[];
  resources: [string, string][];
}

function FakeGrant(init: { accountId: string; clientId: string }) {
  const record: GrantRecord = { ...init, oidc: [], resources: [] };
  fake.grants.push(record);
  return {
    addOIDCScope: (scope: string) => record.oidc.push(scope),
    addResourceScope: (indicator: string, scope: string) =>
      record.resources.push([indicator, scope]),
    save: async () => `grant-${fake.grants.length}`,
  };
}

const fake = {
  details: undefined as Details | Error | undefined,
  finished: [] as [Record<string, unknown>, unknown][],
  finishError: undefined as Error | undefined,
  grants: [] as GrantRecord[],
  clients: {} as Record<string, { redirectUris: string[]; clientName?: string }>,
};

const provider = {
  interactionDetails: async (_req: unknown, res: FakeResponse) => {
    if (fake.details instanceof Error) {
      if ('writeFirst' in fake.details) res.writeHead(500);
      throw fake.details;
    }
    return fake.details;
  },
  interactionFinished: async (
    _req: unknown,
    res: FakeResponse,
    result: Record<string, unknown>,
    options: unknown,
  ) => {
    const error = fake.finishError;
    fake.finishError = undefined;
    if (error) throw error;
    fake.finished.push([result, options]);
    res.writeHead(303, { Location: '/auth/resumed' });
    res.end();
  },
  Grant: FakeGrant,
  Client: { find: async (id: string) => fake.clients[id] },
} as unknown as Provider;

const recordingLogger = () => {
  const events: [string, string, unknown][] = [];
  const record =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      events.push([level, event, fields]);
    };
  const logger: Logger = {
    debug: () => undefined,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    attachServer: vi.fn(),
  };
  return { logger, events };
};

const memory = () => {
  const values = new Map<string, true>();
  const sets: [string, true, number | undefined][] = [];
  return {
    values,
    sets,
    collection: {
      get: async (id: string) => values.get(id),
      set: async (id: string, value: true, ttl?: number) => {
        sets.push([id, value, ttl]);
        values.set(id, value);
      },
      delete: async (id: string) => {
        values.delete(id);
      },
    },
  };
};

const build = (overrides: Partial<InteractionDeps> = {}) => {
  const saved: [string, ZendeskTokenSet][] = [];
  const consent = memory();
  const { logger, events } = recordingLogger();
  const routes = createInteractionRoutes({
    provider,
    upstream: { subdomain: 'testsubdomain', clientId: 'testsubdomain_zendesk' },
    issuer: ISSUER,
    readOnly: false,
    zendeskGrants: {
      save: async (grantId, tokens) => {
        saved.push([grantId, tokens]);
      },
      accessToken: async () => 'unused',
      remove: async () => undefined,
    },
    consentMemory: consent.collection,
    trustedClients: new Set([TRUSTED]),
    logger,
    ...overrides,
  });
  return { routes, saved, consent, events };
};

const at = (path: string) => new URL(path, ISSUER);

const loginPrompt = (clientId: string): Details => ({
  prompt: { name: 'login', details: {} },
  params: { client_id: clientId },
});

const consentPrompt = (clientId: string, redirectUri: string, details = {}): Details => ({
  prompt: {
    name: 'consent',
    details: { missingResourceScopes: { [RESOURCE]: ['read', 'write'] }, ...details },
  },
  params: { client_id: clientId, redirect_uri: redirectUri },
  session: { accountId: ACCOUNT },
});

const get = async (routes: ReturnType<typeof build>['routes'], path: string) => {
  const res = fakeRes();
  await routes.handle({ ...REQ, method: 'GET' } as IncomingMessage, asRes(res), at(path));
  return res;
};

const post = async (routes: ReturnType<typeof build>['routes'], path: string) => {
  const res = fakeRes();
  await routes.handle({ ...REQ, method: 'POST' } as IncomingMessage, asRes(res), at(path));
  return res;
};

/** Login step, Zendesk round trip, callback: the upstream tokens end up pending. */
const signIn = async (
  routes: ReturnType<typeof build>['routes'],
  uid: string,
  clientId: string,
) => {
  fake.details = loginPrompt(clientId);
  const start = await get(routes, `/interaction/${uid}`);
  const zendesk = await fetch(start.headers['Location'] ?? '', { redirect: 'manual' });
  const hop = fakeRes();
  routes.upstreamCallback(asRes(hop), new URL(zendesk.headers.get('location') ?? ''));
  return { start, hop, callback: await get(routes, hop.headers['Location'] ?? '') };
};

describe('createInteractionRoutes', () => {
  let zendesk: ReturnType<typeof createZendeskOAuthMock>;
  let now = 1_700_000_000_000;

  beforeEach(() => {
    fake.details = undefined;
    fake.finished = [];
    fake.finishError = undefined;
    fake.grants = [];
    fake.clients = {
      [TRUSTED]: { redirectUris: [TRUSTED_REDIRECT], clientName: 'Trusted Tool' },
      [DCR]: { redirectUris: [DCR_REDIRECT], clientName: 'DCR <Tool>' },
    };
    now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    zendesk = createZendeskOAuthMock();
    mswServer.use(...zendesk.handlers);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('login', () => {
    it('sends the browser to Zendesk with PKCE, our callback and the full scope', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(302);
      expect(res.headers['Cache-Control']).toBe('no-store');
      const location = new URL(res.headers['Location'] ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(
        'https://testsubdomain.zendesk.com/oauth/authorizations/new',
      );
      const params = Object.fromEntries(location.searchParams);
      expect(params['code_challenge']).toMatch(/^[\w-]{43}$/);
      expect({ ...params, code_challenge: '<challenge>' }).toMatchInlineSnapshot(`
        {
          "client_id": "testsubdomain_zendesk",
          "code_challenge": "<challenge>",
          "code_challenge_method": "S256",
          "redirect_uri": "https://mcp.example.com/oauth/callback",
          "response_type": "code",
          "scope": "read write",
          "state": "uid-1",
        }
      `);
    });

    it('asks Zendesk for read only under --read-only', async () => {
      const { routes } = build({ readOnly: true });
      fake.details = loginPrompt(DCR);
      const res = await get(routes, '/interaction/uid-1');
      expect(new URL(res.headers['Location'] ?? '').searchParams.get('scope')).toBe('read');
    });

    it('hops from the Zendesk callback to the interaction, carrying only the code', () => {
      const { routes } = build();
      const withCode = fakeRes();
      routes.upstreamCallback(asRes(withCode), at('/oauth/callback?code=zd-1&state=uid-1&x=y'));
      expect(withCode.status).toBe(302);
      expect(withCode.headers).toEqual({
        Location: '/interaction/uid-1/callback?code=zd-1',
        'Cache-Control': 'no-store',
      });
      const withoutCode = fakeRes();
      routes.upstreamCallback(asRes(withoutCode), at('/oauth/callback?error=denied&state=uid-1'));
      expect(withoutCode.headers['Location']).toBe('/interaction/uid-1/callback');
    });

    it('answers a Zendesk callback without a usable state with an error page', () => {
      const { routes } = build();
      for (const query of ['?code=x', '?code=x&state=%2F%2Fevil.example']) {
        const res = fakeRes();
        routes.upstreamCallback(asRes(res), at(`/oauth/callback${query}`));
        expect(res.status).toBe(400);
        expect(res.headers).toEqual({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        expect(res.body).toContain('<h1>Sign-in failed</h1>');
        expect(res.body).toContain(EXPIRED);
      }
    });

    it('finishes the login as the Zendesk user, keeping the earlier submission', async () => {
      const { routes } = build();
      const { callback } = await signIn(routes, 'uid-1', DCR);
      expect(callback.status).toBe(303);
      expect(fake.finished).toEqual([
        [{ login: { accountId: ACCOUNT } }, { mergeWithLastSubmission: true }],
      ]);
      expect(zendesk.state.codeExchanges).toBe(1);
      expect(zendesk.state.tokenRequests[0]?.get('redirect_uri')).toBe(
        'https://mcp.example.com/oauth/callback',
      );
    });

    it('refuses a callback without a code, or one no login step started', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      await get(routes, '/interaction/uid-1');
      await get(routes, '/interaction/uid-1/callback');
      await get(routes, '/interaction/uid-2/callback?code=zd-1');
      const refused = {
        error: 'access_denied',
        error_description: 'The Zendesk sign-in was cancelled or refused.',
      };
      expect(fake.finished.map(([result]) => result)).toEqual([refused, refused]);
      expect(zendesk.state.tokenRequests).toHaveLength(0);
    });

    it('uses a verifier once only', async () => {
      const { routes } = build();
      const { hop } = await signIn(routes, 'uid-1', DCR);
      await get(routes, hop.headers['Location'] ?? '');
      expect(fake.finished[1]?.[0]).toEqual({
        error: 'access_denied',
        error_description: 'The Zendesk sign-in was cancelled or refused.',
      });
    });

    it('forgets a verifier once the ten-minute interaction lifetime is over', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      const callbackFor = async (uid: string) => {
        const start = await get(routes, `/interaction/${uid}`);
        const back = await fetch(start.headers['Location'] ?? '', { redirect: 'manual' });
        const hop = fakeRes();
        routes.upstreamCallback(asRes(hop), new URL(back.headers.get('location') ?? ''));
        return hop.headers['Location'] ?? '';
      };
      const inTime = await callbackFor('uid-1');
      const late = await callbackFor('uid-2');
      now += 10 * 60 * 1000 - 1;
      await get(routes, inTime);
      expect(fake.finished[0]?.[0]).toEqual({ login: { accountId: ACCOUNT } });
      now += 1;
      await get(routes, late);
      expect(fake.finished[1]?.[0]).toMatchObject({ error: 'access_denied' });
    });

    it('turns a Zendesk refusal into access_denied and logs it', async () => {
      mswServer.use(
        http.post('https://testsubdomain.zendesk.com/oauth/tokens', () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      const { routes, events } = build();
      await signIn(routes, 'uid-1', DCR);
      const description = 'Zendesk refused the authorization_code grant (400).';
      expect(fake.finished).toEqual([
        [
          { error: 'access_denied', error_description: description },
          { mergeWithLastSubmission: true },
        ],
      ]);
      expect(events).toEqual([['warn', 'oauth_upstream_login_failed', { error: description }]]);
    });

    it('lets any other failure through', async () => {
      const { routes, events } = build();
      fake.finishError = new Error('provider down');
      await expect(signIn(routes, 'uid-1', DCR)).rejects.toThrow('provider down');
      expect(fake.finished).toEqual([]);
      expect(events).toEqual([]);
    });
  });

  describe('consent', () => {
    it('skips the screen for a trusted client on its own HTTPS redirect, with the pending tokens', async () => {
      const { routes, saved, events, consent } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT, { missingOIDCScope: [] });
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(303);
      expect(fake.grants).toEqual([
        {
          accountId: ACCOUNT,
          clientId: TRUSTED,
          oidc: [],
          resources: [[RESOURCE, 'read write']],
        },
      ]);
      expect(saved.map(([grantId, tokens]) => [grantId, tokens.accessToken])).toEqual([
        ['grant-1', 'zd-access-2'],
      ]);
      expect(fake.finished[1]).toEqual([
        { consent: { grantId: 'grant-1' } },
        { mergeWithLastSubmission: true },
      ]);
      expect(events).toEqual([['info', 'oauth_grant_created', { clientId: TRUSTED }]]);
      expect(consent.sets).toEqual([]);
    });

    it('grants the missing OIDC scopes and resource scopes it is asked for', async () => {
      const { routes } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT, {
        missingOIDCScope: ['openid', 'offline_access'],
      });
      await get(routes, '/interaction/uid-1');
      expect(fake.grants[0]?.oidc).toEqual(['openid offline_access']);
    });

    it('grants nothing more when the prompt names no missing scope', async () => {
      const { routes } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = {
        ...consentPrompt(TRUSTED, TRUSTED_REDIRECT),
        prompt: { name: 'consent', details: {} },
      };
      await get(routes, '/interaction/uid-1');
      expect(fake.grants[0]).toMatchObject({ oidc: [], resources: [] });
      expect(fake.finished[1]?.[0]).toEqual({ consent: { grantId: 'grant-1' } });
    });

    it('denies a skipped consent whose Zendesk sign-in is no longer pending', async () => {
      const { routes, saved } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      now += 10 * 60 * 1000;
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT);
      await get(routes, '/interaction/uid-1');
      expect(fake.finished[1]?.[0]).toEqual({
        error: 'access_denied',
        error_description: 'The Zendesk sign-in expired. Try again.',
      });
      expect(saved).toEqual([]);
    });

    it('keeps the pending tokens for ten minutes', async () => {
      const { routes, saved } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      now += 10 * 60 * 1000 - 1;
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT);
      await get(routes, '/interaction/uid-1');
      expect(saved).toHaveLength(1);
    });

    it('shows the screen to an untrusted client, naming it, its scopes and its redirect', async () => {
      const { routes } = build();
      await signIn(routes, 'uid-1', DCR);
      fake.details = consentPrompt(DCR, DCR_REDIRECT, {
        missingResourceScopes: { [RESOURCE]: ['read', 'write'], 'https://other/mcp': ['read'] },
      });
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(200);
      expect(res.headers).toEqual({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      expect(res.body).toContain('<h1>Allow DCR &lt;Tool&gt; to use your Zendesk account?</h1>');
      expect(res.body).toContain(
        '<ul><li>Read your Zendesk data</li><li>Create and change Zendesk data on your behalf</li></ul>',
      );
      expect(res.body).toContain('<strong>testsubdomain.zendesk.com</strong>');
      expect(res.body).toContain('action="/interaction/uid-1/confirm"');
      expect(fake.grants).toEqual([]);
    });

    it('shows no scope when the prompt names none, and the client id when the client is gone', async () => {
      const { routes } = build();
      fake.details = {
        prompt: { name: 'consent', details: {} },
        params: { client_id: 'gone', redirect_uri: DCR_REDIRECT },
        session: { accountId: ACCOUNT },
      };
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<h1>Allow gone to use your Zendesk account?</h1>');
      expect(res.body).toContain('<ul></ul>');
    });

    it('skips the screen for a client this user already approved with the same redirect URIs', async () => {
      const { routes, consent } = build();
      consent.values.set(consentMemoryKey(ACCOUNT, DCR, [DCR_REDIRECT]), true);
      await signIn(routes, 'uid-1', DCR);
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(303);
      expect(fake.finished[1]?.[0]).toEqual({ consent: { grantId: 'grant-1' } });
    });

    it('remembers an approval for ninety days, then grants', async () => {
      const { routes, consent, events } = build();
      await signIn(routes, 'uid-1', DCR);
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await post(routes, '/interaction/uid-1/confirm');
      expect(res.status).toBe(303);
      expect(CONSENT_MEMORY_TTL_S).toBe(7_776_000);
      expect(consent.sets).toEqual([
        [consentMemoryKey(ACCOUNT, DCR, [DCR_REDIRECT]), true, CONSENT_MEMORY_TTL_S],
      ]);
      expect(fake.finished[1]?.[0]).toEqual({ consent: { grantId: 'grant-1' } });
      expect(events).toEqual([['info', 'oauth_grant_created', { clientId: DCR }]]);
    });

    it('refuses a confirmation whose Zendesk sign-in is no longer pending, remembering nothing', async () => {
      const { routes, consent } = build();
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      await post(routes, '/interaction/uid-1/confirm');
      expect(consent.sets).toEqual([]);
      expect(fake.finished[0]?.[0]).toEqual({
        error: 'access_denied',
        error_description: 'The Zendesk sign-in expired. Try again.',
      });
    });

    it('looks a client that is gone up in the consent memory under no redirect URI', async () => {
      const { routes, consent } = build();
      consent.values.set(consentMemoryKey(ACCOUNT, 'gone', []), true);
      fake.details = consentPrompt('gone', DCR_REDIRECT);
      const res = await get(routes, '/interaction/uid-1');
      // Remembered, so no consent page: straight to the (here expired) sign-in check.
      expect(res.status).toBe(303);
      expect(fake.finished[0]?.[0]).toEqual({
        error: 'access_denied',
        error_description: 'The Zendesk sign-in expired. Try again.',
      });
    });

    it('refuses a confirmation without a session instead of failing', async () => {
      const { routes } = build();
      fake.details = { ...consentPrompt(DCR, DCR_REDIRECT), session: undefined };
      await post(routes, '/interaction/uid-1/confirm');
      expect(fake.finished[0]?.[0]).toMatchObject({ error: 'access_denied' });
    });

    it('answers a confirmation outside the consent step with an error page', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      const res = await post(routes, '/interaction/uid-1/confirm');
      expect(res.status).toBe(400);
      expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(res.body).toContain('<h1>Sign-in failed</h1>');
      expect(res.body).toContain(EXPIRED);
      expect(fake.finished).toEqual([]);
    });

    it('sends a refusal back as access_denied', async () => {
      const { routes } = build();
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await post(routes, '/interaction/uid-1/abort');
      expect(res.status).toBe(303);
      expect(fake.finished).toEqual([
        [
          { error: 'access_denied', error_description: 'The user declined access.' },
          { mergeWithLastSubmission: true },
        ],
      ]);
    });
  });

  describe('routing', () => {
    it('answers anything but the four interaction routes with a 404 page', async () => {
      const { routes } = build();
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const responses = [
        await get(routes, '/interaction/not%20a%20uid'),
        await get(routes, '/interaction/'),
        await post(routes, '/interaction/uid-1'),
        await post(routes, '/interaction/uid-1/callback'),
        await get(routes, '/interaction/uid-1/confirm'),
        await get(routes, '/interaction/uid-1/abort'),
        await post(routes, '/interaction/uid-1/whatever'),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.headers).toEqual({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        expect(res.body).toContain('<h1>Not found</h1>');
        expect(res.body).toContain(EXPIRED);
      }
      expect(fake.finished).toEqual([]);
    });

    it('answers an expired or foreign interaction cookie with an error page', async () => {
      const { routes } = build();
      for (const name of ['SessionNotFound', 'InvalidRequest']) {
        fake.details = Object.assign(new Error('gone'), { name });
        const res = await get(routes, '/interaction/uid-1');
        expect(res.status).toBe(400);
        expect(res.body).toContain('<h1>Sign-in failed</h1>');
      }
    });

    it('leaves a response alone once the provider has started it', async () => {
      const { routes } = build();
      fake.details = Object.assign(new Error('gone'), {
        name: 'SessionNotFound',
        writeFirst: true,
      });
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(500);
      expect(res.writes).toBe(1);
    });

    it('lets any other error through, even one named like an expired link', async () => {
      const { routes } = build();
      fake.details = Object.assign(new Error('boom'), { name: 'TypeError' });
      await expect(get(routes, '/interaction/uid-1')).rejects.toThrow('boom');
      const impostor = { name: 'SessionNotFound' };
      fake.details = undefined;
      vi.spyOn(provider, 'interactionDetails').mockRejectedValueOnce(impostor);
      await expect(get(routes, '/interaction/uid-1')).rejects.toBe(impostor);
    });
  });
});

describe('consentMemoryKey', () => {
  it('hashes the account, the client and the redirect URIs in any order', () => {
    const key = consentMemoryKey('zendesk:1', 'c', ['https://b/cb', 'https://a/cb']);
    expect(key).toMatchInlineSnapshot(`"dKYDqquQF7-t4anXohbZcOSYLPVx412P1NBp0doGvLc"`);
    expect(consentMemoryKey('zendesk:1', 'c', ['https://a/cb', 'https://b/cb'])).toBe(key);
    expect(consentMemoryKey('zendesk:1', 'c', ['https://a/cb'])).not.toBe(key);
    expect(consentMemoryKey('zendesk:2', 'c', ['https://b/cb', 'https://a/cb'])).not.toBe(key);
  });
});
