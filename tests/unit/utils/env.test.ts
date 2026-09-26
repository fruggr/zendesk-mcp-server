import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The one-time warning is module state, so each test takes a fresh module.
const load = async () => (await import('../../../src/utils/env')).readEnv;

describe('readEnv', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('OAUTH_TOKEN_FILE', undefined);
    vi.stubEnv('ZENDESK_TOKEN_FILE', undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('reads a variable that was never renamed, silently', async () => {
    vi.stubEnv('PORT', '8080');
    expect((await load())('PORT')).toEqual({ name: 'PORT', value: '8080' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('reports an unset variable under its current name', async () => {
    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({
      name: 'OAUTH_TOKEN_FILE',
      value: undefined,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('reads the current name silently when only it is set', async () => {
    vi.stubEnv('OAUTH_TOKEN_FILE', '/new.json');
    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({
      name: 'OAUTH_TOKEN_FILE',
      value: '/new.json',
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('falls back to the legacy name, naming it and warning once', async () => {
    vi.stubEnv('ZENDESK_TOKEN_FILE', '/old.json');
    const readEnv = await load();

    expect(readEnv('OAUTH_TOKEN_FILE')).toEqual({
      name: 'ZENDESK_TOKEN_FILE',
      value: '/old.json',
    });
    readEnv('OAUTH_TOKEN_FILE');

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"[zendesk-mcp] [warn] deprecated_env_var name=ZENDESK_TOKEN_FILE replacement=OAUTH_TOKEN_FILE removal=3.0.0"`,
    );
  });

  it('falls back to an empty legacy value, so the caller can reject it by name', async () => {
    vi.stubEnv('ZENDESK_TOKEN_FILE', '');
    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({ name: 'ZENDESK_TOKEN_FILE', value: '' });
  });

  it('prefers the current name when both are set, still flagging the legacy one', async () => {
    vi.stubEnv('OAUTH_TOKEN_FILE', '/new.json');
    vi.stubEnv('ZENDESK_TOKEN_FILE', '/old.json');

    expect((await load())('OAUTH_TOKEN_FILE')).toEqual({
      name: 'OAUTH_TOKEN_FILE',
      value: '/new.json',
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('warns once per legacy name, not once overall', async () => {
    vi.stubEnv('ZENDESK_TOKEN_FILE', '/old.json');
    vi.stubEnv('ZENDESK_MAX_COMMENT_PAGES', '3');
    const readEnv = await load();

    readEnv('OAUTH_TOKEN_FILE');
    readEnv('COMMENT_MAX_PAGES');

    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(errSpy.mock.calls[1]?.[0]).toContain('name=ZENDESK_MAX_COMMENT_PAGES');
  });

  it('survives a dead stderr', async () => {
    errSpy.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    vi.stubEnv('ZENDESK_TOKEN_FILE', '/old.json');
    expect((await load())('OAUTH_TOKEN_FILE').value).toBe('/old.json');
  });
});
