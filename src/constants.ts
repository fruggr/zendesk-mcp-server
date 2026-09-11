// Unchecked Number() coercion is unsafe here: '' yields 0 and a typo NaN, either
// silently breaking the guardrail that reads the value. These constants are all
// counts and sizes, so a fraction or an unsafe integer is a typo — fall back.
const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Ceiling on one tool response; past it the text is cut and a notice explains
// what to do (truncateIfNeeded). The default protects the client's context
// budget, so raising it is rarely right; it is overridable mainly to exercise
// truncation on a small tenant.
export const CHARACTER_LIMIT = positiveIntEnv('ZENDESK_CHARACTER_LIMIT', 25_000);
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;

// The Guide content-tags endpoint (/guide/content_tags) caps page[size] at 30
// and 400s on anything larger, unlike the other Help Center list endpoints that
// allow up to 100. Reusing the shared MAX_PAGE_SIZE (100) here always failed
// (issue #162), so list_content_tags gets its own limit.
export const CONTENT_TAGS_MAX_PAGE_SIZE = 30;

// Not an API cap (the endpoint allows 100): the binding constraint is
// CHARACTER_LIMIT, because comment bodies are long. A default of 100 would
// truncate almost every first page — the failure this tool exists to fix (#265).
// Callers who want more follow the cursor.
export const DEFAULT_TICKET_COMMENT_PAGE_SIZE = 20;
export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

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

// Bounds the promoted-article scan on a large Help Center: the API has no
// server-side promoted filter, so the list callback pages through /articles and
// filters client-side. Promoted articles beyond the cap are omitted, and the
// truncation logged.
export const ARTICLE_RESOURCES_SCAN_MAX_PAGES = positiveIntEnv(
  'ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES',
  20,
);

// Must match the redirect URL registered in the Zendesk OAuth client. Picked
// outside the usual dev range (3000/5000/8080…) and below the OS ephemeral ranges
// (Linux ≥ 32768, Windows ≥ 49152), so it is neither commonly taken nor grabbed
// by a transient socket.
export const DEFAULT_CALLBACK_PORT = 27439;

// Per-attachment cap for inline image content. Images larger than this are
// returned as text references instead of base64 image content blocks. The
// default is aligned with the Anthropic vision API per-image limit; override
// via ZENDESK_MAX_ATTACHMENT_BYTES (bytes).
export const MAX_ATTACHMENT_BYTES = positiveIntEnv('ZENDESK_MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024);

// Maximum number of images embedded as base64 in a single tool call. Remaining
// images are returned as text references. Override via ZENDESK_MAX_EMBEDDED_IMAGES.
export const MAX_EMBEDDED_IMAGE_COUNT = positiveIntEnv('ZENDESK_MAX_EMBEDDED_IMAGES', 10);

// Largest JSON-RPC message the stdio transport accepts, and the ceiling the
// payload guards derive from. Ours rather than the SDK's default: the caps
// derived from it are published as `maxLength`, and a contract that moves when a
// dependency bumps its own is one nobody decided (docs/mcp-metadata.md). Not
// overridable.
export const STDIO_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

// Room for what wraps our content: the JSON-RPC envelope, plus a request id the
// client picks and the spec does not bound. Measured at 53 bytes for a plain
// response — oversized on purpose, which buys the guards independence from an
// envelope we do not control.
const ENVELOPE_RESERVE_BYTES = 64 * 1024;

// One budget for the content of a message, applied deliberately in both
// directions: what we may emit, and what we accept. Named so the two cannot
// drift apart by editing one expression.
const MESSAGE_CONTENT_BUDGET_BYTES = STDIO_MAX_MESSAGE_BYTES - ENVELOPE_RESERVE_BYTES;

// Outbound: total weight of one tool response. The two caps above bound each
// image and how many, never the sum (#205). The override can only lower it; a
// larger value is clamped, because emitting past what the transport carries
// fails on the client's side.
export const MAX_RESPONSE_BYTES = Math.min(
  positiveIntEnv('ZENDESK_MAX_RESPONSE_BYTES', MESSAGE_CONTENT_BUDGET_BYTES),
  MESSAGE_CONTENT_BUDGET_BYTES,
);

// Inbound: longest base64 string accepted on an attachment input, and the summed
// ceiling for the array parameters. Published as `maxLength` for an agent to read
// before calling; it cannot prevent the overflow itself, as the read buffer bursts
// before anything is parsed. Not overridable, so the schema is environment-independent.
export const MAX_BASE64_INPUT_CHARS = MESSAGE_CONTENT_BUDGET_BYTES;

// The inbound ceiling as file megabytes, for the tool descriptions. Base64 carries
// 3 bytes per 4 characters. Exported rather than derived per module so the two
// tool files cannot advertise different figures for one ceiling.
export const MAX_BASE64_INPUT_MB = Number.parseFloat(
  (((MAX_BASE64_INPUT_CHARS / 4) * 3) / (1024 * 1024)).toFixed(2),
);

// Hard cap on comment pages fetched when collecting ticket attachments.
// Overridable via ZENDESK_MAX_COMMENT_PAGES for tickets with many comments.
export const MAX_COMMENT_PAGES = positiveIntEnv('ZENDESK_MAX_COMMENT_PAGES', 10);

// Blast-radius guard: moving one article can rewrite the `position` of several
// neighbours, so past this many the tool refuses without confirm:true — a single
// "move to top" must not silently rewrite hundreds of articles.
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
