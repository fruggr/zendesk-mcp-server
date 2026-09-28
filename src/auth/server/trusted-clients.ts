/**
 * Which CIMD clients skip our consent screen, and the fetch shim applied to CIMD
 * documents. Policy and seed list: `docs/decisions/oauth-authorization-server.md`
 * ("Consent") and the #127 plan (§2).
 */

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

/**
 * Wrap oidc-provider's `fetch` so CIMD documents go through
 * `inferNativeApplication`. The request options are passed through untouched:
 * they carry the library's SSRF-guarded dispatcher, timeout and redirect policy.
 * Anything that is not a client document (a JWKS, an error) is returned as read.
 */
export const createCimdFetch =
  (baseFetch: Fetch): Fetch =>
  async (url, options) => {
    const response = await baseFetch(url, options);
    if (!response.ok) return response;
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
    const isClientDocument =
      typeof (parsed as { client_id?: unknown } | null)?.client_id === 'string';
    if (!isClientDocument) return rebuilt(Buffer.from(bytes));
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(inferNativeApplication(parsed)), {
      status: response.status,
      headers,
    });
  };
