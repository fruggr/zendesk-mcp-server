import { describe, it, expect } from 'vitest';
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
