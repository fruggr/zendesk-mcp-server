import { createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveKeyRing,
  deriveKeySet,
  MIN_SECRET_BYTES,
  parseSecretList,
} from '../../../../src/auth/server/keys';

const SECRET_A = Buffer.alloc(32, 1).toString('base64');
const SECRET_B = Buffer.alloc(32, 2).toString('base64');

describe('parseSecretList', () => {
  it('splits a comma-separated list, newest first, ignoring blanks and spaces', () => {
    const [first, second, ...rest] = parseSecretList(` ${SECRET_A} , ,${SECRET_B}`);
    expect(first).toEqual(Buffer.alloc(32, 1));
    expect(second).toEqual(Buffer.alloc(32, 2));
    expect(rest).toHaveLength(0);
  });

  it('rejects an empty list', () => {
    expect(() => parseSecretList(' , ')).toThrow('OAuth master secret is empty.');
  });

  it('rejects an entry shorter than 32 bytes without echoing it', () => {
    const short = Buffer.alloc(MIN_SECRET_BYTES - 1, 7).toString('base64');
    expect(() => parseSecretList(`${SECRET_A},${short}`)).toThrow(
      'OAuth master secret must decode to at least 32 bytes of base64 (generate one with: openssl rand -base64 32).',
    );
    try {
      parseSecretList(short);
    } catch (err) {
      expect(String(err)).not.toContain(short);
    }
  });

  it('accepts exactly 32 bytes', () => {
    expect(parseSecretList(Buffer.alloc(32).toString('base64'))).toHaveLength(1);
  });
});

describe('deriveKeySet', () => {
  it('is deterministic: the same secret yields the same keys across restarts', () => {
    const a = deriveKeySet(Buffer.alloc(32, 1));
    const b = deriveKeySet(Buffer.alloc(32, 1));
    expect(a.signingJwk).toEqual(b.signingJwk);
    expect(a.accessToken.kid).toBe(b.accessToken.kid);
    expect(a.accessToken.key.export()).toEqual(b.accessToken.key.export());
    expect(a.atRest.key.export()).toEqual(b.atRest.key.export());
    expect(a.cookieKey).toBe(b.cookieKey);
  });

  it('separates purposes: no two derived keys share material or kid', () => {
    const set = deriveKeySet(Buffer.alloc(32, 1));
    const materials = [
      set.signingJwk.d,
      set.accessToken.key.export().toString('base64url'),
      set.atRest.key.export().toString('base64url'),
      set.cookieKey,
    ];
    expect(new Set(materials).size).toBe(4);
    expect(new Set([set.signingJwk.kid, set.accessToken.kid, set.atRest.kid]).size).toBe(3);
  });

  it('gives different secrets different keys and kids', () => {
    const a = deriveKeySet(Buffer.alloc(32, 1));
    const b = deriveKeySet(Buffer.alloc(32, 2));
    expect(a.signingJwk.kid).not.toBe(b.signingJwk.kid);
    expect(a.accessToken.kid).not.toBe(b.accessToken.kid);
    expect(a.atRest.kid).not.toBe(b.atRest.kid);
    expect(a.cookieKey).not.toBe(b.cookieKey);
  });

  it('never exposes the master secret in a kid', () => {
    const master = randomBytes(32);
    const set = deriveKeySet(master);
    for (const kid of [set.signingJwk.kid, set.accessToken.kid, set.atRest.kid]) {
      expect(kid).toHaveLength(16);
      expect(master.toString('base64url')).not.toContain(kid);
    }
  });

  it('produces a usable Ed25519 signing JWK', () => {
    const { signingJwk } = deriveKeySet(Buffer.alloc(32, 1));
    expect(signingJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' });
    const { d: _private, ...publicJwk } = signingJwk;
    const data = Buffer.from('payload');
    const signature = sign(null, data, { key: signingJwk as never, format: 'jwk' });
    expect(
      verify(null, data, createPublicKey({ key: publicJwk as never, format: 'jwk' }), signature),
    ).toBe(true);
  });

  it('derives 256-bit symmetric keys', () => {
    const set = deriveKeySet(Buffer.alloc(32, 1));
    expect(set.accessToken.key.symmetricKeySize).toBe(32);
    expect(set.atRest.key.symmetricKeySize).toBe(32);
    expect(Buffer.from(set.cookieKey, 'base64url')).toHaveLength(32);
  });
});

describe('deriveKeyRing', () => {
  it('keeps the list order, so the newest secret is first', () => {
    const ring = deriveKeyRing(`${SECRET_B},${SECRET_A}`);
    expect(ring).toHaveLength(2);
    expect(ring[0].atRest.kid).toBe(deriveKeySet(Buffer.alloc(32, 2)).atRest.kid);
    expect(ring[1]?.atRest.kid).toBe(deriveKeySet(Buffer.alloc(32, 1)).atRest.kid);
  });
});
