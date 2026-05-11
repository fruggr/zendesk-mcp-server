export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;
export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// Per-attachment cap for inline image content. Images larger than this are
// returned as text references instead of base64 image content blocks.
// Aligned with the Anthropic vision API per-image limit.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Maximum number of images embedded as base64 in a single tool call.
// Remaining images are returned as text references.
export const MAX_EMBEDDED_IMAGE_COUNT = 10;

// Thresholds used to nudge callers toward section-scoped article tools
// (get_article_outline / get_article_section / update_article_section)
// instead of fetching/rewriting the full body.
export const LARGE_ARTICLE_BODY_CHARS = 3_000;
export const LARGE_ARTICLE_SECTION_COUNT = 4;

export const getBaseUrl = (subdomain: string): string => `https://${subdomain}.zendesk.com/api/v2`;

export const getHelpCenterBaseUrl = (subdomain: string): string =>
  `https://${subdomain}.zendesk.com/api/v2/help_center`;

export const getOAuthUrls = (subdomain: string) => ({
  authorizeUrl: `https://${subdomain}.zendesk.com/oauth/authorizations/new`,
  tokenUrl: `https://${subdomain}.zendesk.com/oauth/tokens`,
});
