import { describe, expect, it } from 'vitest';
import { getSessionToken, runWithSessionToken } from '../../../src/auth/session-token';

describe('session-token', () => {
  it('exposes the token to code running inside runWithSessionToken', () => {
    const observed = runWithSessionToken('tkn-123', () => getSessionToken());
    expect(observed).toBe('tkn-123');
  });

  it('propagates the token across awaited work', async () => {
    const observed = await runWithSessionToken('tkn-async', async () => {
      await Promise.resolve();
      return getSessionToken();
    });
    expect(observed).toBe('tkn-async');
  });

  it('keeps concurrent calls isolated', async () => {
    const [a, b] = await Promise.all([
      runWithSessionToken('alpha', async () => {
        await Promise.resolve();
        return getSessionToken();
      }),
      runWithSessionToken('bravo', async () => {
        await Promise.resolve();
        return getSessionToken();
      }),
    ]);
    expect(a).toBe('alpha');
    expect(b).toBe('bravo');
  });

  it('throws a helpful error when called outside any session', () => {
    expect(() => getSessionToken()).toThrow(/No Zendesk OAuth token available/);
  });
});
