import {
  createHash,
  createPrivateKey,
  createSecretKey,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import type { JWK } from 'jose';

/**
 * The four keys the authorization server needs, all derived from one master
 * secret. Why one secret, and why HKDF: `docs/decisions/oauth-authorization-server.md`
 * ("Keys and secrets").
 */
export interface KeySet {
  /** Ed25519 private JWK for `oidc-provider`'s `jwks` (the public half is served at /jwks). */
  readonly signingJwk: JWK;
  /** Encrypts the JWE access tokens (`dir` + `A256GCM`). */
  readonly accessToken: { readonly kid: string; readonly key: KeyObject };
  /** Encrypts store payloads at rest. */
  readonly atRest: { readonly kid: string; readonly key: KeyObject };
  /** Keygrip HMAC key for `oidc-provider`'s `cookies.keys`. */
  readonly cookieKey: string;
}

/** Newest first: the first set signs and encrypts, every set verifies and decrypts. */
export type KeyRing = readonly [KeySet, ...KeySet[]];

export const MIN_SECRET_BYTES = 32;

// An Ed25519 private key *is* a 32-byte seed; wrapping it in this fixed PKCS#8
// header (RFC 8410) lets node:crypto import it without any key generation.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const derive = (master: Buffer, purpose: string, length = 32): Buffer =>
  Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `zendesk-mcp/${purpose}/v1`, length));

// A kid names the secret a key came from without revealing it: hashing a
// further derivation keeps the kid one-way even though it is public.
const kidFor = (master: Buffer, purpose: string): string =>
  createHash('sha256')
    .update(derive(master, `kid/${purpose}`, 16))
    .digest('base64url')
    .slice(0, 16);

/**
 * Parse `OAUTH_MASTER_SECRET`: base64 entries, comma-separated, newest first.
 * Errors never echo the value.
 */
export const parseSecretList = (raw: string): [Buffer, ...Buffer[]] => {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => Buffer.from(entry, 'base64'));
  const [first, ...rest] = entries;
  if (!first) throw new Error('OAuth master secret is empty.');
  if (entries.some((secret) => secret.length < MIN_SECRET_BYTES)) {
    throw new Error(
      `OAuth master secret must decode to at least ${MIN_SECRET_BYTES} bytes of base64 ` +
        '(generate one with: openssl rand -base64 32).',
    );
  }
  return [first, ...rest];
};

export const deriveKeySet = (master: Buffer): KeySet => {
  const signingKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, derive(master, 'signing')]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    signingJwk: {
      ...signingKey.export({ format: 'jwk' }),
      kid: kidFor(master, 'signing'),
      use: 'sig',
      alg: 'EdDSA',
    },
    accessToken: {
      kid: kidFor(master, 'access-token'),
      key: createSecretKey(derive(master, 'access-token')),
    },
    atRest: { kid: kidFor(master, 'at-rest'), key: createSecretKey(derive(master, 'at-rest')) },
    cookieKey: derive(master, 'cookie').toString('base64url'),
  };
};

export const deriveKeyRing = (raw: string): KeyRing => {
  const [first, ...rest] = parseSecretList(raw);
  return [deriveKeySet(first), ...rest.map(deriveKeySet)];
};
