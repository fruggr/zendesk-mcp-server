export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;

// The Guide content-tags endpoint (/guide/content_tags) caps page[size] at 30
// and 400s on anything larger, unlike the other Help Center list endpoints that
// allow up to 100. Reusing the shared MAX_PAGE_SIZE (100) here always failed
// (issue #162), so list_content_tags gets its own limit.
export const CONTENT_TAGS_MAX_PAGE_SIZE = 30;
export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// Read a positive-integer override from the environment, falling back to a safe
// default. Unchecked Number() coercion is unsafe here: an empty string yields 0
// and a typo yields NaN, either of which would silently break the guardrail that
// relies on the value. Missing/empty/non-positive values and anything that is not
// a positive safe integer (fractions like "1.5", values beyond 2^53) fall back —
// these constants are all counts/sizes, so a fractional or unsafe value is a typo.
const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// TTL for the per-session Help Center topology cache (zendesk-hc://topology).
// The tenant's structure (locales, category/section tree, segments) changes
// rarely, so a short TTL keeps a session's repeated reads cheap without going
// stale for long after a reorg.
export const TOPOLOGY_TTL_MS = 5 * 60 * 1000;

// TTL for the per-session promoted-articles cache backing the article resources'
// list callback (zendesk-hc://article/{id}). Promoted/featured status changes
// rarely, so a short TTL keeps a session's repeated resources/list calls cheap
// without going stale for long.
export const ARTICLE_RESOURCES_TTL_MS = 5 * 60 * 1000;

// Max article pages scanned to find promoted articles. The Help Center API has no
// server-side promoted filter (only label_names / sort_by / sort_order), so the
// list callback pages through /articles and filters `promoted` client-side; this
// bounds that scan on a large Help Center. Promoted articles beyond the cap are
// omitted (and the truncation is logged). Override via
// ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES.
export const ARTICLE_RESOURCES_SCAN_MAX_PAGES = positiveIntEnv(
  'ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES',
  20,
);

// Max category + section nodes probed by find_translation_gaps. Unlike articles,
// sections and categories have no "missing translations" endpoint, and the
// locale-filtered listing cannot answer the question either — it omits a node with
// no translation without saying why, and still returns one whose translation is a
// draft — so the only honest answer costs one translations request per node. This bounds
// that fan-out on a large Help Center; nodes beyond the cap are left unscanned
// and the tool says so. Override via ZENDESK_TRANSLATION_GAP_SCAN_MAX_NODES.
export const TRANSLATION_GAP_SCAN_MAX_NODES = positiveIntEnv(
  'ZENDESK_TRANSLATION_GAP_SCAN_MAX_NODES',
  60,
);

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
export const MAX_ATTACHMENT_BYTES = positiveIntEnv('ZENDESK_MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024);

// Maximum number of images embedded as base64 in a single tool call. Remaining
// images are returned as text references. Override via ZENDESK_MAX_EMBEDDED_IMAGES.
export const MAX_EMBEDDED_IMAGE_COUNT = positiveIntEnv('ZENDESK_MAX_EMBEDDED_IMAGES', 10);

// Hard cap on comment pages fetched when collecting ticket attachments.
// Overridable via ZENDESK_MAX_COMMENT_PAGES for tickets with many comments.
export const MAX_COMMENT_PAGES = positiveIntEnv('ZENDESK_MAX_COMMENT_PAGES', 10);

// Blast-radius guard for reorder_article. Reordering an article can require
// rewriting the `position` of several neighbours (to break ties or shift a run);
// if that write set exceeds this many articles the tool refuses unless the caller
// passes confirm:true, so a single "move to top" can't silently rewrite hundreds
// of articles. Override via ZENDESK_REORDER_CONFIRM_THRESHOLD.
export const REORDER_CONFIRM_THRESHOLD = positiveIntEnv('ZENDESK_REORDER_CONFIRM_THRESHOLD', 20);

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
