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

describe('MAX_RESPONSE_BYTES (positiveIntEnv)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const load = async () => (await import('../../src/constants')).MAX_RESPONSE_BYTES;
  // The stdio ceiling less the envelope reserve, both non-overridable.
  const DEFAULT_BUDGET = 10 * 1024 * 1024 - 64 * 1024;

  it('defaults to the stdio ceiling less the envelope reserve', async () => {
    expect(await load()).toBe(DEFAULT_BUDGET);
  });

  it('honors a valid positive integer', async () => {
    vi.stubEnv('ZENDESK_MAX_RESPONSE_BYTES', String(512 * 1024));
    expect(await load()).toBe(512 * 1024);
  });

  it('falls back to the default when empty or non-numeric', async () => {
    vi.stubEnv('ZENDESK_MAX_RESPONSE_BYTES', '');
    expect(await load()).toBe(DEFAULT_BUDGET);
    vi.resetModules();
    vi.stubEnv('ZENDESK_MAX_RESPONSE_BYTES', 'not-a-number');
    expect(await load()).toBe(DEFAULT_BUDGET);
  });

  // Lowering is the useful direction; raising would emit past what the transport
  // carries and break the client, where no guard of ours runs.
  it('clamps an override above the budget instead of obeying it', async () => {
    vi.stubEnv('ZENDESK_MAX_RESPONSE_BYTES', String(50 * 1024 * 1024));
    expect(await load()).toBe(DEFAULT_BUDGET);
  });
});

describe('MAX_BASE64_INPUT_MB', () => {
  it('is the file size the base64 ceiling allows', async () => {
    vi.resetModules();
    const { MAX_BASE64_INPUT_CHARS, MAX_BASE64_INPUT_MB } = await import('../../src/constants');
    // Base64 carries 3 bytes per 4 characters. Asserted against the megabyte
    // figure the tool descriptions quote, so a change to either is caught here.
    expect(MAX_BASE64_INPUT_MB).toBe(7.45);
    expect(MAX_BASE64_INPUT_CHARS).toBe(10 * 1024 * 1024 - 64 * 1024);
  });
});
