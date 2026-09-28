import { describe, expect, it } from 'vitest';
import { providerErrorPage } from '../../../../src/auth/server/provider';

describe('providerErrorPage', () => {
  it('names the error and its description', () => {
    expect(
      providerErrorPage({ error: 'invalid_client', error_description: 'client is invalid' }),
    ).toContain('<p>invalid_client: client is invalid</p>');
  });

  it('explains an error that comes without a description', () => {
    expect(providerErrorPage({ error: 'access_denied' })).toMatchInlineSnapshot(
      `"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><h1>Sign-in failed</h1><p>access_denied: the authorization request was rejected</p></body></html>"`,
    );
  });
});
