import { describe, expect, it } from 'vitest';
import { grantCovers, requestedScope, supportedScopes } from '../../../src/auth/oauth-scopes';

describe('requestedScope', () => {
  it('asks for read only in read-only mode', () => {
    expect(requestedScope(true)).toBe('read');
  });

  it('asks for read and write otherwise', () => {
    expect(requestedScope(false)).toBe('read write');
  });
});

describe('supportedScopes', () => {
  // Derived from requestedScope, so the OAuth discovery metadata cannot drift
  // from what the authorize request actually asks for.
  it('advertises read only in read-only mode', () => {
    expect(supportedScopes(true)).toEqual(['read']);
  });

  it('advertises read and write otherwise', () => {
    expect(supportedScopes(false)).toEqual(['read', 'write']);
  });
});

describe('grantCovers', () => {
  it.each([
    // A record written before the server tracked grants: the only scope it ever
    // requested was `read write`, so an absent scope IS that grant.
    { granted: undefined, requested: 'read', covered: true, why: 'legacy record covers read' },
    {
      granted: undefined,
      requested: 'read write',
      covered: true,
      why: 'legacy record covers read write',
    },
    // The one case that forces a re-authentication: OAuth cannot widen a grant.
    { granted: 'read', requested: 'read write', covered: false, why: 'read cannot cover write' },
    { granted: 'read write', requested: 'read', covered: true, why: 'a broader grant is fine' },
    { granted: 'read write', requested: 'read write', covered: true, why: 'exact match' },
    { granted: 'read', requested: 'read', covered: true, why: 'exact match, narrow' },
    { granted: 'write read', requested: 'read write', covered: true, why: 'order is irrelevant' },
    { granted: 'read  write', requested: 'read write', covered: true, why: 'extra whitespace' },
    { granted: '', requested: 'read', covered: false, why: 'an empty grant covers nothing' },
    // Padding must not become a token of its own: an unfiltered split would
    // look for an empty scope the grant cannot contain.
    { granted: 'read write', requested: ' read ', covered: true, why: 'padded request' },
  ])('$why', ({ granted, requested, covered }) => {
    expect(grantCovers(granted, requested)).toBe(covered);
  });

  it('treats a hand-edited non-string scope like an untracked grant', () => {
    // loadToken casts the on-disk JSON without validating this field, so a
    // hand-written `"scope": null` must not throw inside the token store.
    expect(grantCovers(null as unknown as string, 'read write')).toBe(true);
  });
});
