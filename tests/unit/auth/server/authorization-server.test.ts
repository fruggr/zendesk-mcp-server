import Keyv from 'keyv';
import { describe, expect, it, vi } from 'vitest';
import { createAuthorizationServer } from '../../../../src/auth/server/authorization-server';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import type { Logger } from '../../../../src/utils/logger';
import { makeConfig } from '../../../integration/harness';

const recordingLogger = () => {
  const events: [string, string][] = [];
  const logger: Logger = {
    debug: (e) => events.push(['debug', e]),
    info: (e) => events.push(['info', e]),
    warn: (e) => events.push(['warn', e]),
    error: (e) => events.push(['error', e]),
    attachServer: vi.fn(),
  };
  return { logger, events };
};

const build = (persistent: Keyv, logger?: Logger) =>
  createAuthorizationServer({
    config: makeConfig({ transport: 'http' }),
    issuer: 'https://mcp.example.com',
    ring: deriveKeyRing(Buffer.alloc(32, 7).toString('base64')),
    persistent,
    isAllowedOrigin: () => false,
    logger,
  });

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
    const store = {
      opts: {},
      on() {
        return store;
      },
      get: async () => {
        throw new Error('store down');
      },
      set: async () => undefined,
      delete: async () => false,
      clear: async () => undefined,
    };
    const failing = new Keyv({ store, emitErrors: false, throwOnErrors: true });
    const { logger, events } = recordingLogger();
    await expect(build(failing, logger).revokeGrant('g-1')).resolves.toBeUndefined();
    expect(events).toContainEqual(['warn', 'oauth_grant_revoke_failed']);
  });
});
