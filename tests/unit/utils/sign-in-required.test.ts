import { describe, expect, it } from 'vitest';
import { isSignInRequired, signInRequiredError } from '../../../src/utils/sign-in-required';

describe('signInRequiredError', () => {
  it('says the next tool call signs in, and is recognised as such', () => {
    const error = signInRequiredError();
    expect(error.message).toBe('Not signed in to Zendesk: the next tool call starts the sign-in.');
    expect(isSignInRequired(error)).toBe(true);
  });

  it('recognises nothing else', () => {
    expect(isSignInRequired(new Error('Not signed in'))).toBe(false);
    expect(isSignInRequired({ name: 'SignInRequiredError' })).toBe(false);
    expect(isSignInRequired(Object.assign(new Error('x'), { name: '' }))).toBe(false);
    expect(isSignInRequired(undefined)).toBe(false);
  });
});
