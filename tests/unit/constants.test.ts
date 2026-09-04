import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('CHARACTER_LIMIT (positiveIntEnv)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const load = async () => (await import('../../src/constants')).CHARACTER_LIMIT;

  it('defaults to 25000 when unset or empty', async () => {
    // Stubbed rather than left to the ambient environment: positiveIntEnv reads
    // the variable at import time, so a value set in the test process would
    // decide this assertion. Empty is also the case the shell produces with
    // `ZENDESK_CHARACTER_LIMIT="$UNSET"`, and it must fall back too.
    vi.stubEnv('ZENDESK_CHARACTER_LIMIT', '');
    expect(await load()).toBe(25_000);
  });

  it('honors a lower override, which is what makes truncation testable', async () => {
    vi.stubEnv('ZENDESK_CHARACTER_LIMIT', '500');
    expect(await load()).toBe(500);
  });

  it('falls back to the default on a non-positive value', async () => {
    vi.stubEnv('ZENDESK_CHARACTER_LIMIT', '0');
    expect(await load()).toBe(25_000);
  });

  it('falls back to the default on a fractional value', async () => {
    vi.stubEnv('ZENDESK_CHARACTER_LIMIT', '1.5');
    expect(await load()).toBe(25_000);
  });
});

describe('REORDER_CONFIRM_THRESHOLD (positiveIntEnv)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const load = async () => (await import('../../src/constants')).REORDER_CONFIRM_THRESHOLD;

  it('defaults to 20 when unset', async () => {
    expect(await load()).toBe(20);
  });

  it('honors a valid positive integer', async () => {
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', '5');
    expect(await load()).toBe(5);
  });

  it('falls back to the default on a fractional value', async () => {
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', '1.5');
    expect(await load()).toBe(20);
  });

  it('falls back to the default on a non-numeric or non-positive value', async () => {
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', 'lots');
    expect(await load()).toBe(20);
    // Re-evaluate the module a second time within this test with a new value.
    vi.resetModules();
    vi.stubEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', '0');
    expect(await load()).toBe(20);
  });
});
