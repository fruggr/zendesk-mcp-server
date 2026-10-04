/**
 * The last good copy of each CIMD client's document, served when a later fetch
 * fails. Policy: `docs/decisions/oauth-authorization-server.md` ("Client
 * registration").
 */

import type { Logger } from '../../utils/logger';
import type { SealedCollection } from './store';
import { createCimdFetch, type Fetch, inferNativeApplication } from './trusted-clients';

/** A client document as fetched. */
export interface CimdLastGood {
  readonly document: Record<string, unknown>;
  /** Epoch ms of the fetch. */
  readonly fetchedAt: number;
}

export interface CimdDocuments {
  /** oidc-provider's `fetch`: CIMD documents rewritten, failures served the last good copy. */
  readonly fetch: Fetch;
  /** oidc-provider accepted this client (`allowClient`): the document just fetched for it is valid. */
  accepted(clientId: string): void;
  /** A token was issued to this client: keep its document, if it was fetched since. */
  granted(clientId: string): Promise<void>;
}

export interface CimdDocumentsOptions {
  readonly lastGood: SealedCollection<CimdLastGood>;
  readonly logger: Logger;
}

/** How long a kept copy may stand in for its document, after it was fetched. */
export const LAST_GOOD_TTL_S = 7 * 24 * 3600;

// A served copy is re-checked against its host every minute.
const STALE_MAX_AGE_S = 60;

// Documents fetched or accepted but not yet kept; oidc-provider caches as many.
const PENDING_LIMIT = 100;

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

const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > PENDING_LIMIT) map.delete(map.keys().next().value as string);
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
 * A copy is kept only once oidc-provider has accepted the document and a token
 * was issued to its client: an unauthenticated caller can make the server
 * fetch any URL, but not write to the grant store.
 */
export const createCimdDocuments = (
  baseFetch: Fetch,
  { lastGood, logger }: CimdDocumentsOptions,
): CimdDocuments => {
  const rewrite = createCimdFetch(baseFetch);
  const fetched = new Map<string, CimdLastGood>();
  const accepted = new Map<string, CimdLastGood>();

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

  const serve = (copy: CimdLastGood): Response =>
    Response.json(inferNativeApplication(copy.document), {
      headers: { 'cache-control': `max-age=${STALE_MAX_AGE_S}` },
    });

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
    return serve(copy);
  };

  const succeeded = async (url: string, response: Response): Promise<Response> => {
    const document = await ownDocument(response.clone(), url);
    if (document && response.status === 200) {
      remember(fetched, url, { document, fetchedAt: Date.now() });
      return response;
    }
    // Not this client's document: a bot-protection page, say, at a URL whose
    // document was kept. Where nothing was (a JWKS), it is handed on silently.
    const copy = await kept(url);
    if (!copy) return response;
    report(url, { status: response.status, error: 'not a client document' }, copy);
    await response.body?.cancel();
    return serve(copy);
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
    accepted: (clientId) => {
      const candidate = fetched.get(clientId);
      if (!candidate) return;
      fetched.delete(clientId);
      remember(accepted, clientId, candidate);
    },
    granted: async (clientId) => {
      const candidate = accepted.get(clientId);
      if (!candidate) return;
      accepted.delete(clientId);
      try {
        await lastGood.set(clientId, candidate, LAST_GOOD_TTL_S);
      } catch (err) {
        logger.warn('oauth_cimd_last_good_store_failed', { url: clientId, error: messageOf(err) });
      }
    },
  };
};
