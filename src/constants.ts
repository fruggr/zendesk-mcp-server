export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;
export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// TTL for the per-session Help Center topology cache (zendesk-hc://topology).
// The tenant's structure (locales, category/section tree, segments) changes
// rarely, so a short TTL keeps a session's repeated reads cheap without going
// stale for long after a reorg.
export const TOPOLOGY_TTL_MS = 5 * 60 * 1000;

// Local port the OAuth PKCE flow listens on for the browser callback. Must match
// the redirect URL registered in the Zendesk OAuth client. Deliberately picked
// outside the usual dev range (3000/5000/8080…) and below the OS ephemeral
// ranges (Linux ≥ 32768, Windows ≥ 49152) so it is neither commonly taken nor
// grabbed by a transient socket. Override via ZENDESK_OAUTH_CALLBACK_PORT /
// --callback-port (and register the matching redirect URL in Zendesk).
export const DEFAULT_CALLBACK_PORT = 27439;

// Per-attachment cap for inline image content. Images larger than this are
// returned as text references instead of base64 image content blocks. The
// default is aligned with the Anthropic vision API per-image limit; override
// via ZENDESK_MAX_ATTACHMENT_BYTES (bytes).
export const MAX_ATTACHMENT_BYTES = Number(
  process.env['ZENDESK_MAX_ATTACHMENT_BYTES'] ?? 5 * 1024 * 1024,
);

// Maximum number of images embedded as base64 in a single tool call. Remaining
// images are returned as text references. Override via ZENDESK_MAX_EMBEDDED_IMAGES.
export const MAX_EMBEDDED_IMAGE_COUNT = Number(process.env['ZENDESK_MAX_EMBEDDED_IMAGES'] ?? 10);

// Hard cap on comment pages fetched when collecting ticket attachments.
// Overridable via ZENDESK_MAX_COMMENT_PAGES for tickets with many comments.
export const MAX_COMMENT_PAGES = Number(process.env['ZENDESK_MAX_COMMENT_PAGES'] ?? 10);

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
