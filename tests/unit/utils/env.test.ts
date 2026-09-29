import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('readEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const load = async () => (await import('../../../src/utils/env')).readEnv;

  it('reads a variable under its own name', async () => {
    vi.stubEnv('PORT', '8080');
    expect((await load())('PORT')).toEqual({ name: 'PORT', value: '8080' });
  });

  it('reports an unset variable under its own name', async () => {
    vi.stubEnv('OAUTH_TOKEN_FILE', undefined);
    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({
      name: 'OAUTH_TOKEN_FILE',
      value: undefined,
    });
  });

  it('keeps an empty value, so the caller can reject it by name', async () => {
    vi.stubEnv('OAUTH_TOKEN_FILE', '');
    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({ name: 'OAUTH_TOKEN_FILE', value: '' });
  });

  it('no longer falls back to the name removed in 3.0.0', async () => {
    vi.stubEnv('OAUTH_TOKEN_FILE', undefined);
    vi.stubEnv('ZENDESK_TOKEN_FILE', '/old.json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({
      name: 'OAUTH_TOKEN_FILE',
      value: undefined,
    });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
