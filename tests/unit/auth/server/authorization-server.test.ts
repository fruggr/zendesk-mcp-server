import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactEncrypt } from 'jose';
import Keyv from 'keyv';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthorizationServer,
  createAuthorizationServer,
  prepareAuthorizationServer,
} from '../../../../src/auth/server/authorization-server';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import type { Config } from '../../../../src/config';
import type { Logger } from '../../../../src/utils/logger';
import { makeConfig } from '../../../integration/harness';
import {
  authorize,
  DCR_REDIRECT,
  exchangeCode,
  refresh,
  registerDcrClient,
  signInWithDcr,
} from '../../../integration/oauth-client';
import { createZendeskOAuthMock, localServerPassthrough } from '../../../msw-handlers';
import { mswServer } from '../../../setup';

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

const RING = deriveKeyRing(Buffer.alloc(32, 7).toString('base64'));

const build = (persistent: Keyv, logger?: Logger, issuer = 'https://mcp.example.com') =>
  createAuthorizationServer({
    config: makeConfig({ transport: 'http' }),
    issuer,
    ring: RING,
    persistent,
    isAllowedOrigin: () => false,
    logger,
  });

const forge = (issuer: string, claims: Record<string, unknown>) =>
  new CompactEncrypt(
    new TextEncoder().encode(
      JSON.stringify({
        iss: issuer,
        aud: `${issuer}/mcp`,
        exp: Math.floor(Date.now() / 1000) + 60,
        zd: 'zd-token',
        gid: 'g-1',
        sub: 'zendesk:1',
        client_id: 'c-1',
        ...claims,
      }),
    ),
  )
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: RING[0].accessToken.kid })
    .encrypt(RING[0].accessToken.key);

/** A store whose reads of one collection can be made to fail. */
const faultyStore = () => {
  const map = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  const faults = { failing: undefined as string | undefined, error: new Error('store down') };
  const store = {
    opts: {},
    on() {
      return store;
    },
    get: async (key: string) => {
      if (faults.failing && key.includes(`${faults.failing}:`)) throw faults.error;
      return map.get(key);
    },
    set: async (key: string, value: unknown, ttl?: number) => {
      map.set(key, value);
      ttls.set(key, ttl);
      return true;
    },
    delete: async (key: string) => map.delete(key),
    clear: async () => map.clear(),
  };
  const nameOf = (key: string) => /^(?:keyv:)?(.+):[\w-]{43}$/.exec(key)?.[1];
  return {
    map,
    faults,
    /** The TTL (ms) each collection's records were last written with. */
    ttls: () => Object.fromEntries([...ttls].map(([key, ttl]) => [nameOf(key), ttl])),
    keyv: new Keyv({ store, emitErrors: false, throwOnErrors: true }),
    collections: () => [...new Set([...map.keys()].map(nameOf))].sort(),
  };
};

describe('createAuthorizationServer', () => {
  it('names the resource after the issuer', () => {
    const as = build(new Keyv());
    expect(as.resource).toBe('https://mcp.example.com/mcp');
    expect(as.protectedResourceMetadata.authorization_servers).toEqual(['https://mcp.example.com']);
  });

  it('rejects anything that is not one of its tokens', async () => {
    const as = build(new Keyv());
    for (const bearer of ['', 'zd-access-1', 'a.b.c.d.e', 'eyJhbGciOiJkaXIifQ.x.y.z.w']) {
      expect(await as.verifyAccessToken(bearer)).toBeUndefined();
    }
  });

  it('never rejects when revoking a grant fails in the store, and logs why', async () => {
    const { keyv, faults } = faultyStore();
    faults.failing = 'Grant';
    const { logger, events } = recordingLogger();
    await expect(build(keyv, logger).revokeGrant('g-1')).resolves.toBeUndefined();
    expect(events).toEqual([['warn', 'oauth_grant_revoke_failed', { error: 'store down' }]]);
  });

  it('logs a store failure that is not an Error as its string', async () => {
    const { keyv, faults } = faultyStore();
    faults.failing = 'Grant';
    faults.error = 'socket closed' as unknown as Error;
    const { logger, events } = recordingLogger();
    await build(keyv, logger).revokeGrant('g-1');
    expect(events).toEqual([['warn', 'oauth_grant_revoke_failed', { error: 'socket closed' }]]);
  });

  it('revokes a grant it does not know without failing', async () => {
    const { logger, events } = recordingLogger();
    await build(new Keyv(), logger).revokeGrant('unknown');
    expect(events).toEqual([['info', 'oauth_grant_revoked', { reason: 'zendesk_unauthorized' }]]);
  });

  describe('verifyAccessToken', () => {
    const issuer = 'https://mcp.example.com';
    afterEach(() => vi.restoreAllMocks());

    it('hands back what the token carries', async () => {
      const as = build(new Keyv());
      const exp = Math.floor(Date.now() / 1000) + 60;
      expect(await as.verifyAccessToken(await forge(issuer, { exp }))).toEqual({
        zendeskAccessToken: 'zd-token',
        grantId: 'g-1',
        clientId: 'c-1',
        subject: 'zendesk:1',
        expiresAt: exp,
      });
      expect(
        await as.verifyAccessToken(await forge(issuer, { aud: ['https://x', `${issuer}/mcp`] })),
      ).toMatchObject({ grantId: 'g-1' });
    });

    it('rejects a token without a numeric expiry, a Zendesk token or a grant id', async () => {
      const as = build(new Keyv());
      for (const claims of [
        { exp: String(Math.floor(Date.now() / 1000) + 60) },
        { exp: undefined },
        { zd: 42 },
        { gid: undefined },
        { gid: 7 },
        { aud: undefined },
        { iss: undefined },
      ]) {
        expect(await as.verifyAccessToken(await forge(issuer, claims))).toBeUndefined();
      }
    });

    it('rejects a token from its expiry second on', async () => {
      const as = build(new Keyv());
      const token = await forge(issuer, { exp: 2_000_000_000 });
      vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000 - 1);
      expect(await as.verifyAccessToken(token)).toMatchObject({ expiresAt: 2_000_000_000 });
      vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
      expect(await as.verifyAccessToken(token)).toBeUndefined();
    });

    it('refuses a revoked grant for one access-token lifetime, and only that grant', async () => {
      const as = build(new Keyv());
      const revoked = await forge(issuer, { gid: 'g-1', exp: 2_000_000_000 });
      const other = await forge(issuer, { gid: 'g-2', exp: 2_000_000_000 });
      const start = 1_900_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(start);
      await as.revokeGrant('g-1');
      await as.revokeGrant('g-3');
      expect(await as.verifyAccessToken(revoked)).toBeUndefined();
      expect(await as.verifyAccessToken(other)).toMatchObject({ grantId: 'g-2' });
      vi.spyOn(Date, 'now').mockReturnValue(start + 3600 * 1000 - 1);
      expect(await as.verifyAccessToken(revoked)).toBeUndefined();
      vi.spyOn(Date, 'now').mockReturnValue(start + 3600 * 1000);
      expect(await as.verifyAccessToken(revoked)).toMatchObject({ grantId: 'g-1' });
    });
  });

  describe('over HTTP', () => {
    let server: Server | undefined;
    let base = '';
    let zendesk: ReturnType<typeof createZendeskOAuthMock>;

    const serve = async (
      persistent: Keyv,
      logger?: Logger,
      config: Partial<Config> = {},
    ): Promise<AuthorizationServer> => {
      let as: AuthorizationServer | undefined;
      server = createServer((req, res) => {
        void as?.handle(req, res).catch((err: unknown) => {
          res.statusCode = 599;
          res.end(String(err));
        });
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      as = createAuthorizationServer({
        config: makeConfig({ transport: 'http', ...config }),
        issuer: base,
        ring: RING,
        persistent,
        isAllowedOrigin: () => false,
        logger,
      });
      return as;
    };

    const useZendesk = (accessTtlSeconds?: number) => {
      zendesk = createZendeskOAuthMock(accessTtlSeconds === undefined ? {} : { accessTtlSeconds });
      mswServer.use(localServerPassthrough, ...zendesk.handlers);
    };

    beforeEach(() => useZendesk());
    afterEach(async () => {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    });

    it('mints tokens that carry the grant and the signed-in Zendesk user', async () => {
      const as = await serve(new Keyv());
      const { clientId, tokens } = await signInWithDcr(base);
      const verified = await as.verifyAccessToken(tokens.body.access_token ?? '');
      expect(verified).toEqual({
        zendeskAccessToken: 'zd-access-2',
        grantId: expect.any(String),
        clientId,
        subject: 'zendesk:9999',
        expiresAt: expect.any(Number),
      });
      const lifetime = (verified?.expiresAt ?? 0) - Date.now() / 1000;
      expect(lifetime).toBeGreaterThan(3500);
      expect(lifetime).toBeLessThanOrEqual(3600);
    });

    it('keeps its records in named collections of the persistent store', async () => {
      const store = faultyStore();
      await serve(store.keyv);
      await signInWithDcr(base);
      expect(store.ttls()).toMatchInlineSnapshot(`
        {
          "Client": undefined,
          "Consent": 7776000000,
          "Grant": 7776000000,
          "RefreshToken": 7776000000,
          "RefreshToken:grant": 7776000000,
          "ZendeskTokens": 7776000000,
        }
      `);
      expect(store.collections()).toMatchInlineSnapshot(`
        [
          "Client",
          "Consent",
          "Grant",
          "RefreshToken",
          "RefreshToken:grant",
          "ZendeskTokens",
        ]
      `);
    });

    it('ends a revoked grant: its tokens, its refresh token and its Zendesk tokens', async () => {
      const store = faultyStore();
      const { logger, events } = recordingLogger();
      const as = await serve(store.keyv, logger);
      const { clientId, tokens } = await signInWithDcr(base);
      const kept = await signInWithDcr(base);
      const { grantId } = (await as.verifyAccessToken(tokens.body.access_token ?? '')) ?? {};
      await as.revokeGrant(grantId ?? '');
      expect(events).toEqual([
        ['info', 'oauth_grant_created', { clientId }],
        ['info', 'oauth_grant_created', { clientId: kept.clientId }],
        ['info', 'oauth_grant_revoked', { reason: 'zendesk_unauthorized' }],
      ]);
      expect(await as.verifyAccessToken(tokens.body.access_token ?? '')).toBeUndefined();
      expect((await refresh(base, clientId, tokens.body.refresh_token ?? '')).body.error).toBe(
        'invalid_grant',
      );
      expect(await as.verifyAccessToken(kept.tokens.body.access_token ?? '')).toBeDefined();
      expect(
        (await refresh(base, kept.clientId, kept.tokens.body.refresh_token ?? '')).status,
      ).toBe(200);
    });

    it('answers a store failure while minting a token with a server error, and logs it', async () => {
      const store = faultyStore();
      const { logger, events } = recordingLogger();
      await serve(store.keyv, logger);
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const result = await authorize(base, { clientId, redirectUri: DCR_REDIRECT });
      store.faults.failing = 'ZendeskTokens';
      const tokens = await exchangeCode(base, clientId, DCR_REDIRECT, result);
      expect(tokens.status).toBe(500);
      expect(tokens.body.error).toBe('server_error');
      expect(events).toContainEqual(['error', 'oauth_server_error', { error: 'store down' }]);
    });

    it('refreshes a Zendesk token that would lapse within our access-token lifetime', async () => {
      useZendesk(3600);
      await serve(new Keyv());
      await signInWithDcr(base);
      expect(zendesk.state.refreshes).toBe(1);
    });

    it('keeps a Zendesk token that outlives our access token by the refresh margin', async () => {
      useZendesk(3600 + 5 * 60 + 60);
      await serve(new Keyv());
      await signInWithDcr(base);
      expect(zendesk.state.refreshes).toBe(0);
    });

    it('fetches client metadata documents with the global fetch unless told otherwise', async () => {
      const clientId = 'https://tools.example.com/oauth/client.json';
      mswServer.use(
        http.get(clientId, () =>
          HttpResponse.json({
            client_id: clientId,
            client_name: 'Some Tool',
            redirect_uris: ['https://tools.example.com/callback'],
            token_endpoint_auth_method: 'none',
          }),
        ),
      );
      await serve(new Keyv());
      const result = await authorize(base, {
        clientId,
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.consentShown).toBe(true);
      expect(result.code).toEqual(expect.any(String));
    });

    it('leaves a non-GET request on the Zendesk callback path to the provider', async () => {
      await serve(new Keyv());
      const res = await fetch(`${base}/oauth/callback?state=abc&code=x`, {
        method: 'POST',
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    });
  });
});

describe('prepareAuthorizationServer', () => {
  it('keeps the store as oauth-store.json in the config directory by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zmcp-prepare-'));
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    try {
      const { logger, events } = recordingLogger();
      const config = makeConfig({ transport: 'http', oauthMasterSecret: undefined });
      const buildServer = await prepareAuthorizationServer(config, logger);
      const as = buildServer('https://mcp.example.com', () => false);
      expect(as.issuer).toBe('https://mcp.example.com');
      expect(events.map(([level, event]) => [level, event])).toEqual([
        ['info', 'oauth_master_secret_generated'],
        ['warn', 'oauth_master_secret_beside_store'],
      ]);
      expect(existsSync(join(dir, 'fruggr', 'zendesk-mcp-server', 'oauth-master-secret'))).toBe(
        true,
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
