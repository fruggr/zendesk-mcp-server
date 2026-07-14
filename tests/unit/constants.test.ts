import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBaseUrl, getHelpCenterBaseUrl, getOAuthUrls } from '../../src/constants';

describe('getBaseUrl', () => {
  it('builds the Zendesk API base URL', () => {
    expect(getBaseUrl('mycompany')).toBe('https://mycompany.zendesk.com/api/v2');
  });
});

describe('getHelpCenterBaseUrl', () => {
  it('builds the Help Center API base URL', () => {
    expect(getHelpCenterBaseUrl('mycompany')).toBe(
      'https://mycompany.zendesk.com/api/v2/help_center',
    );
  });
});

describe('getOAuthUrls', () => {
  it('builds authorize and token URLs', () => {
    const urls = getOAuthUrls('mycompany');
    expect(urls.authorizeUrl).toBe('https://mycompany.zendesk.com/oauth/authorizations/new');
    expect(urls.tokenUrl).toBe('https://mycompany.zendesk.com/oauth/tokens');
  });
});

describe('REORDER_CONFIRM_THRESHOLD (positiveIntEnv)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async () => (await import('../../src/constants')).REORDER_CONFIRM_THRESHOLD;

  it('defaults to 20 when unset', async () => {
    vi.resetModules();
    expect(await load()).toBe(20);
  });

  it('honors a valid positive integer', async () => {
    vi.resetModules();
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', '5');
    expect(await load()).toBe(5);
  });

  it('falls back to the default on a fractional value', async () => {
    vi.resetModules();
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', '1.5');
    expect(await load()).toBe(20);
  });

  it('falls back to the default on a non-numeric or non-positive value', async () => {
    vi.resetModules();
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', 'lots');
    expect(await load()).toBe(20);
    vi.resetModules();
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', '0');
    expect(await load()).toBe(20);
  });
});
