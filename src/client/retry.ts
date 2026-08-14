export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 'pre-send': the request provably never reached Zendesk. */
export type NetworkPhase = 'pre-send' | 'unknown';

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4_000;

// Undici gives `fetch` no overall deadline — its headersTimeout/bodyTimeout
// default to 300 s — so a stalled socket would hold a tool call open long past
// the retry budget, which cannot fire while an attempt is pending. Transfers get
// a longer one: a large attachment on a slow link legitimately takes a while.
export const REQUEST_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 120_000;

/**
 * A deadline for one attempt. The abort surfaces as a `TimeoutError` whose `code`
 * is numeric, not a syscall string, so it classifies as `unknown`: a GET is
 * retried, a write is not — the request may have arrived before the deadline.
 */
export const deadlineSignal = (timeoutMs: number): AbortSignal => AbortSignal.timeout(timeoutMs);
// Beyond this, honoring Retry-After would park the tool call; surface the 429
// and let the caller come back later instead.
const MAX_RETRY_AFTER_MS = 5_000;

interface RetryPolicy {
  /** Which network failures may be replayed. */
  readonly network: NetworkPhase | 'any';
  /** Whether a 5xx may be replayed. */
  readonly serverErrors: boolean;
}

// The client sits below the tool layer, so the method is all it has to judge
// idempotency by — and `PUT /tickets/{id}` with a `comment` *appends* one, so PUT
// counts as a create too. Everything that is not a GET therefore only replays
// what provably did not apply: a 429 (Zendesk refused the request) or a
// connection that never opened. A 5xx may have applied — replaying a DELETE
// there would turn a completed delete into a misleading 404.
const POLICIES: Record<HttpMethod, RetryPolicy> = {
  GET: { network: 'any', serverErrors: true },
  DELETE: { network: 'pre-send', serverErrors: false },
  POST: { network: 'pre-send', serverErrors: false },
  PUT: { network: 'pre-send', serverErrors: false },
};

const DELAY_SECONDS = /^\d+$/;
// Every HTTP-date format starts with the day name; Date.parse is lenient enough
// to read '-1' as a year, so require it.
const HTTP_DATE_START = /^[A-Za-z]/;
const NON_ASCII = /[^ -~]/g;
const TOKEN_SEGMENT = /\/token\/[^/]+/;

// Typed as unknown so a missing code can be looked up as-is: no code is simply
// not in the set.
const PRE_SEND_CODES: ReadonlySet<unknown> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export interface RetryDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export const defaultRetryDeps: RetryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Non-ASCII bytes break `node:http` headers, so client error text stays ASCII. */
const toAscii = (text: string): string => text.replace(NON_ASCII, '?');

/**
 * Identifies the request without leaking a credential: uploads carry an upload
 * token in the query string, and an attachment `content_url` carries a download
 * token as a path segment (`/attachments/token/<token>/`).
 */
export const describeTarget = (url: string): string => {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname.replace(TOKEN_SEGMENT, '/token/[redacted]')}`;
};

/** First `code` in the cause chain, inspecting 5 levels so a cycle cannot hang. */
const errorCode = (err: unknown): string | undefined => {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
};

export const classifyNetworkError = (err: unknown): NetworkPhase =>
  PRE_SEND_CODES.has(errorCode(err)) ? 'pre-send' : 'unknown';

/**
 * A failure with no HTTP response at all: DNS, refused connection, reset socket.
 * Unlike the bare `fetch failed` that `fetch` throws, it names the request that
 * failed. An Error factory, not a class, to match the repo's functional style.
 */
export type ZendeskNetworkError = Error & {
  readonly method: HttpMethod;
  readonly target: string;
  readonly attempts: number;
};

// `fetch failed` / a bare Error name says nothing worth printing; a DOMException
// name like TimeoutError is the only label that failure carries.
const UNINFORMATIVE_NAMES: ReadonlySet<string> = new Set(['Error', 'TypeError']);

const failureDetail = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  const code = errorCode(cause);
  if (code !== undefined) return `${code}: ${cause.message}`;
  return UNINFORMATIVE_NAMES.has(cause.name) ? cause.message : `${cause.name}: ${cause.message}`;
};

const networkErrorMessage = (
  method: HttpMethod,
  target: string,
  attempts: number,
  cause: unknown,
): string => {
  const tries = attempts === 1 ? '1 attempt' : `${attempts} attempts`;
  return toAscii(`Network error on ${method} ${target} after ${tries}: ${failureDetail(cause)}`);
};

export const createZendeskNetworkError = (
  method: HttpMethod,
  target: string,
  attempts: number,
  cause: unknown,
): ZendeskNetworkError =>
  Object.assign(new Error(networkErrorMessage(method, target, attempts, cause), { cause }), {
    name: 'ZendeskNetworkError',
    method,
    target,
    attempts,
  } as const);

export const isZendeskNetworkError = (err: unknown): err is ZendeskNetworkError =>
  err instanceof Error &&
  err.name === 'ZendeskNetworkError' &&
  typeof (err as ZendeskNetworkError).target === 'string';

/** Exponential backoff with equal jitter: half the window fixed, half random. */
export const computeBackoffMs = (attempt: number, random: () => number): number => {
  const window = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(window / 2 + (window * random()) / 2);
};

/** `Retry-After` in ms — delay-seconds or HTTP-date. */
export const parseRetryAfter = (header: string | null, now = Date.now()): number | undefined => {
  if (header === null) return undefined;
  const value = header.trim();
  if (DELAY_SECONDS.test(value)) return Number(value) * 1000;
  if (!HTTP_DATE_START.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
};

/**
 * How long to wait before replaying this response, or undefined to accept it.
 * `Retry-After` wins over backoff wherever it appears — Zendesk sends it on a 503
 * during maintenance as well as on a 429 — and a value past the cap means the
 * response is surfaced rather than parking the call for that long.
 */
const retryDelayFor = (
  response: Response,
  policy: RetryPolicy,
  attempt: number,
  random: () => number,
): number | undefined => {
  const replayable = response.status === 429 || (response.status >= 500 && policy.serverErrors);
  if (!replayable) return undefined;

  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter === undefined) return computeBackoffMs(attempt, random);
  return retryAfter > MAX_RETRY_AFTER_MS ? undefined : retryAfter;
};

/**
 * Runs `attempt` until it succeeds, hits a terminal outcome, or spends the
 * attempt budget. Returns the last response for the caller to inspect (a
 * non-ok status is still the caller's to turn into a `ZendeskApiError`), and
 * throws `ZendeskNetworkError` when no response was ever obtained.
 */
export const fetchWithRetry = async (
  attempt: () => Promise<Response>,
  method: HttpMethod,
  target: string,
  deps: RetryDeps = defaultRetryDeps,
): Promise<Response> => {
  const policy = POLICIES[method];

  for (let tries = 1; ; tries += 1) {
    const last = tries >= MAX_ATTEMPTS;
    let response: Response;

    try {
      response = await attempt();
    } catch (err) {
      const replayable = policy.network === 'any' || classifyNetworkError(err) === policy.network;
      if (last || !replayable) throw createZendeskNetworkError(method, target, tries, err);
      await deps.sleep(computeBackoffMs(tries, deps.random));
      continue;
    }

    if (last) return response;
    const delayMs = retryDelayFor(response, policy, tries, deps.random);
    if (delayMs === undefined) return response;

    // This body is discarded; drain it so the socket is released. A truncated
    // body throws here, which must not escape the retry we are about to make.
    await response.text().catch(() => undefined);
    await deps.sleep(delayMs);
  }
};
