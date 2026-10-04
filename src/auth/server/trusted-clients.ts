/**
 * Which CIMD clients skip our consent screen, and the fetch shim applied to CIMD
 * documents, which also serves a document's last good copy when its host fails.
 * Policy: `docs/decisions/oauth-authorization-server.md` ("Consent", "Client
 * registration").
 */

import type { Logger } from '../../utils/logger';
import type { SealedCollection } from './store';

// The only mainstream CIMD clients whose redirect URIs are HTTPS today (fetched
// 2026-09-24). Exact client ids, never domains: claude.ai and chatgpt.com also
// host loopback clients (Claude Code, Codex) that must see the screen.
export const DEFAULT_TRUSTED_CLIENTS: readonly string[] = [
  'https://claude.ai/oauth/mcp-oauth-client-metadata',
  'https://chatgpt.com/oauth/client.json',
];

export const trustedClientSet = (
  extra: readonly string[],
  includeDefaults: boolean,
): ReadonlySet<string> => new Set([...(includeDefaults ? DEFAULT_TRUSTED_CLIENTS : []), ...extra]);

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '[::1]' || IPV4_LOOPBACK.test(hostname);

const parse = (uri: string): URL | undefined => (URL.canParse(uri) ? new URL(uri) : undefined);

/** HTTPS and not loopback: a code sent there cannot land on the user's machine. */
export const isSkipEligibleRedirect = (uri: string): boolean => {
  const url = parse(uri);
  return url !== undefined && url.protocol === 'https:' && !isLoopbackHost(url.hostname);
};

export interface ConsentSkipRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The redirect URIs of the client as oidc-provider resolved it (the fetched document for CIMD). */
  readonly registeredRedirectUris: readonly string[];
}

/**
 * Skip the consent screen only for an allowlisted client id, asking for a
 * redirect URI its own document lists, over HTTPS and off loopback. The
 * document is served from the client's own domain, so the code cannot be
 * diverted to an attacker.
 */
export const canSkipConsent = (
  request: ConsentSkipRequest,
  trusted: ReadonlySet<string>,
): boolean =>
  trusted.has(request.clientId) &&
  request.registeredRedirectUris.includes(request.redirectUri) &&
  isSkipEligibleRedirect(request.redirectUri);

const isLoopbackHttp = (uri: unknown): boolean => {
  const url = typeof uri === 'string' ? parse(uri) : undefined;
  return url !== undefined && url.protocol === 'http:' && isLoopbackHost(url.hostname);
};

/**
 * Some CIMD documents (Claude Code, Zed) list only loopback redirect URIs but do
 * not declare `application_type: native`, so oidc-provider matches the port
 * exactly and rejects the random port the client listens on (RFC 8252 §7.3 says
 * any port). Such a document is a native app by every other sign.
 */
export const inferNativeApplication = (document: unknown): unknown => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const { application_type: applicationType, redirect_uris: redirectUris } = document as Record<
    string,
    unknown
  >;
  const allLoopback =
    Array.isArray(redirectUris) && redirectUris.length > 0 && redirectUris.every(isLoopbackHttp);
  return applicationType === undefined && allLoopback
    ? { ...document, application_type: 'native' }
    : document;
};

// Above oidc-provider's own limit for CIMD documents (5 KB), so an oversized
// body still reaches the library and is rejected there, with its error.
const MAX_INSPECTED_BYTES = 16 * 1024;

const readCapped = async (response: Response): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= MAX_INSPECTED_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks);
};

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A client document as last fetched, raw (before `inferNativeApplication`). */
export interface CimdLastGood {
  readonly document: Record<string, unknown>;
  /** Epoch ms of the successful fetch. */
  readonly fetchedAt: number;
}

export interface CimdFetchOptions {
  /** Where the last good copy of each client document is kept; none keeps nothing. */
  readonly lastGood?: SealedCollection<CimdLastGood> | undefined;
  readonly logger?: Logger | undefined;
}

/** How long a last good copy may stand in for its document, after its last successful fetch. */
export const LAST_GOOD_TTL_S = 7 * 24 * 3600;

// A served copy is re-checked against its host every minute.
const STALE_MAX_AGE_S = 60;

export const CIMD_FETCH_HINT =
  'A client document could not be fetched: its client cannot sign in or refresh unless a ' +
  'last good copy is served. See https://github.com/fruggr/zendesk-mcp-server/blob/main/' +
  'docs/troubleshooting.md#http-the-log-shows-oauth_client_fetch_failed';

// Blocked, rate-limited or down: the document still exists. A 404, a 410 or a
// redirect says it does not, or not there, and is never papered over.
const isTransientFailure = (status: number): boolean =>
  status === 403 || status === 408 || status === 429 || status >= 500;

const asClientDocument = (parsed: unknown): Record<string, unknown> | undefined =>
  typeof (parsed as { client_id?: unknown } | null)?.client_id === 'string'
    ? (parsed as Record<string, unknown>)
    : undefined;

// undici's "fetch failed" says nothing on its own: the cause names the DNS,
// TLS or socket error.
const messageOf = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
};

/**
 * Wrap oidc-provider's `fetch` so CIMD documents go through
 * `inferNativeApplication`. The request options are passed through untouched:
 * they carry the library's SSRF-guarded dispatcher, timeout and redirect policy.
 * Anything that is not a client document (a JWKS, an error) is returned as read.
 *
 * With `lastGood`, a document served at its own `client_id` is kept, and served
 * again when a later fetch is blocked, rate-limited, fails at the host or on the
 * network. Error responses themselves are never kept.
 */
export const createCimdFetch = (baseFetch: Fetch, options: CimdFetchOptions = {}): Fetch => {
  const { lastGood, logger } = options;

  const keep = async (url: string, document: Record<string, unknown>): Promise<void> => {
    try {
      await lastGood?.set(url, { document, fetchedAt: Date.now() }, LAST_GOOD_TTL_S);
    } catch (err) {
      logger?.warn('oauth_cimd_last_good_store_failed', { url, error: messageOf(err) });
    }
  };

  // A store that fails here must not turn a fetch failure into a server error.
  const kept = (url: string): Promise<CimdLastGood | undefined> | undefined =>
    lastGood?.get(url).catch((err: unknown) => {
      logger?.warn('oauth_cimd_last_good_read_failed', { url, error: messageOf(err) });
      return undefined;
    });

  const fallBack = async (
    url: string,
    failure: { status: number } | { error: string },
    transient: boolean,
  ): Promise<Response | undefined> => {
    const copy = transient ? await kept(url) : undefined;
    logger?.warn('oauth_client_fetch_failed', {
      url,
      ...failure,
      fallback: copy ? 'last_good' : 'none',
      ...(copy && { ageS: Math.floor((Date.now() - copy.fetchedAt) / 1000) }),
      hint: CIMD_FETCH_HINT,
    });
    if (!copy) return undefined;
    return Response.json(inferNativeApplication(copy.document), {
      headers: { 'cache-control': `max-age=${STALE_MAX_AGE_S}` },
    });
  };

  const rewrite = async (url: string, response: Response): Promise<Response> => {
    const bytes = await readCapped(response);
    const rebuilt = (body: Uint8Array | string) =>
      new Response(body, { status: response.status, headers: response.headers });
    if (bytes.length > MAX_INSPECTED_BYTES) return rebuilt(Buffer.from(bytes));
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      // Not JSON: left undefined, so it is handed on below like any non-document.
    }
    const document = asClientDocument(parsed);
    if (!document) return rebuilt(Buffer.from(bytes));
    if (document['client_id'] === url) await keep(url, document);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(inferNativeApplication(document)), {
      status: response.status,
      headers,
    });
  };

  return async (input, init) => {
    const url = String(input);
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      const copy = await fallBack(url, { error: messageOf(err) }, true);
      if (copy) return copy;
      throw err;
    }
    if (response.ok) return rewrite(url, response);
    return (
      (await fallBack(url, { status: response.status }, isTransientFailure(response.status))) ??
      response
    );
  };
};
