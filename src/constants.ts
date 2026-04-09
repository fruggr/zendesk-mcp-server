export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;
export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

export const getBaseUrl = (subdomain: string): string =>
  `https://${subdomain}.zendesk.com/api/v2`;

export const getHelpCenterBaseUrl = (subdomain: string): string =>
  `https://${subdomain}.zendesk.com/api/v2/help_center`;

export const getOAuthUrls = (subdomain: string) => ({
  authorizeUrl: `https://${subdomain}.zendesk.com/oauth/authorizations/new`,
  tokenUrl: `https://${subdomain}.zendesk.com/oauth/tokens`,
});
