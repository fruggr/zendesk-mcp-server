/**
 * The last good copy of each CIMD client's document, served when a later fetch
 * fails. Policy: `docs/decisions/oauth-authorization-server.md` ("Client
 * registration").
 */

import type { Logger } from '../../utils/logger';
import type { SealedCollection } from './store';
import { createCimdFetch, type Fetch } from './trusted-clients';

/** A client document, as `oidc-provider` validated it. */
export interface CimdLastGood {
  readonly document: Record<string, unknown>;
  /** Epoch ms it was kept. */
  readonly fetchedAt: number;
}

/** The `oidc-provider` client a token was just issued to. */
export interface GrantedClient {
  readonly clientId: string;
  /** Set (non-enumerable) by `oidc-provider` on a client resolved from its metadata document. */
  readonly clientIdMetadataDocument?: boolean;
  metadata(): Record<string, unknown>;
}

export interface CimdDocuments {
  /** oidc-provider's `fetch`: CIMD documents rewritten, failures served the last good copy. */
  readonly fetch: Fetch;
  /** A token was issued to this client: keep its validated document, unless a served copy built it. */
  granted(client: GrantedClient): Promise<void>;
}

export interface CimdDocumentsOptions {
  readonly lastGood: SealedCollection<CimdLastGood>;
  readonly logger: Logger;
}

/** How long a kept copy may stand in for its document, after it was kept. */
export const LAST_GOOD_TTL_S = 7 * 24 * 3600;

// A served copy is re-checked against its host every minute.
const STALE_MAX_AGE_S = 60;

export const CIMD_FETCH_HINT =
  'A client document, or a URL it names, could not be fetched: the client cannot sign in or ' +
  'refresh unless a last good copy is served. See https://github.com/fruggr/' +
  'zendesk-mcp-server/blob/main/docs/troubleshooting.md#http-the-log-shows-oauth_client_fetch_failed';

// Blocked, rate-limited or down: the document still exists. A 404, a 410 or a
// redirect says it does not, or not there, and is never papered over.
const isTransientFailure = (status: number): boolean =>
  status === 403 || status === 408 || status === 429 || status >= 500;

// undici's "fetch failed" says nothing on its own: the cause names the DNS,
// TLS or socket error.
const messageOf = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
};

// The document served at `url` for the client `url` names, or undefined.
const ownDocument = async (
  response: Response,
  url: string,
): Promise<Record<string, unknown> | undefined> => {
  const parsed: unknown = await response.json().catch(() => undefined);
  return (parsed as { client_id?: unknown } | undefined)?.client_id === url
    ? (parsed as Record<string, unknown>)
    : undefined;
};

/**
 * A copy is kept when a token is issued, from the client oidc-provider built
 * and validated: an unauthenticated caller can make the server fetch any URL,
 * but not write to the grant store, and a rejected document is never kept.
 */
export const createCimdDocuments = (
  baseFetch: Fetch,
  { lastGood, logger }: CimdDocumentsOptions,
): CimdDocuments => {
  const rewrite = createCimdFetch(baseFetch);
  // Clients whose last resolution was a served copy: a token issued to one of
  // them must not renew the copy, or an outage would never end its 7 days.
  const stale = new Set<string>();

  // A store that fails here must not turn a fetch failure into a server error.
  const kept = (url: string): Promise<CimdLastGood | undefined> =>
    lastGood.get(url).catch((err: unknown) => {
      logger.warn('oauth_cimd_last_good_read_failed', { url, error: messageOf(err) });
      return undefined;
    });

  const report = (
    url: string,
    failure: { status: number; error?: string } | { error: string },
    copy: CimdLastGood | undefined,
  ): void => {
    logger.warn('oauth_client_fetch_failed', {
      url,
      ...failure,
      fallback: copy ? 'last_good' : 'none',
      ...(copy && { ageS: Math.floor((Date.now() - copy.fetchedAt) / 1000) }),
      hint: CIMD_FETCH_HINT,
    });
  };

  const serve = (url: string, copy: CimdLastGood): Response => {
    stale.add(url);
    return Response.json(copy.document, {
      headers: { 'cache-control': `max-age=${STALE_MAX_AGE_S}` },
    });
  };

  // The copy in place of `failed`, or undefined when none was kept.
  const fallBack = async (
    url: string,
    failure: { status: number; error?: string } | { error: string },
    failed?: Response,
  ): Promise<Response | undefined> => {
    const copy = await kept(url);
    report(url, failure, copy);
    if (!copy) return undefined;
    await failed?.body?.cancel();
    return serve(url, copy);
  };

  const succeeded = async (url: string, response: Response): Promise<Response> => {
    const document = await ownDocument(response.clone(), url);
    if (document && response.status === 200) {
      stale.delete(url);
      return response;
    }
    // Not this client's document: a bot-protection page, say, at a URL whose
    // document was kept. Where nothing was (a JWKS), it is handed on silently.
    const copy = await kept(url);
    if (!copy) return response;
    report(url, { status: response.status, error: 'not a client document' }, copy);
    // Stryker disable next-line OptionalChaining: createCimdFetch always rebuilds a 2xx body, so it is never null here.
    await response.body?.cancel();
    return serve(url, copy);
  };

  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    let response: Response;
    try {
      response = await rewrite(input, init);
    } catch (err) {
      const copy = await fallBack(url, { error: messageOf(err) });
      if (copy) return copy;
      throw err;
    }
    if (response.ok) return succeeded(url, response);
    if (!isTransientFailure(response.status)) {
      logger.debug('oauth_client_fetch_failed', { url, status: response.status, fallback: 'none' });
      return response;
    }
    return (await fallBack(url, { status: response.status }, response)) ?? response;
  };

  return {
    fetch,
    granted: async (client) => {
      if (client.clientIdMetadataDocument !== true || stale.has(client.clientId)) return;
      try {
        await lastGood.set(
          client.clientId,
          { document: client.metadata(), fetchedAt: Date.now() },
          LAST_GOOD_TTL_S,
        );
      } catch (err) {
        logger.warn('oauth_cimd_last_good_store_failed', {
          url: client.clientId,
          error: messageOf(err),
        });
      }
    },
  };
};
