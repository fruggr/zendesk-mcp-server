import { type Logger, silentLogger } from '../../utils/logger';
import { createKeyLock, type SealedCollection } from './store';
import {
  isUpstreamAuthError,
  refreshZendeskTokens,
  ZENDESK_REFRESH_TOKEN_TTL_S,
  type ZendeskTokenSet,
  type ZendeskUpstream,
} from './upstream';

// Refresh a little before Zendesk's expiry so a token handed to a tool call
// does not lapse mid-request.
export const ZENDESK_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ZendeskGrants {
  /** Record the Zendesk tokens obtained at sign-in for one of our grants. */
  save(grantId: string, tokens: ZendeskTokenSet): Promise<void>;
  /**
   * A Zendesk access token valid for at least the refresh margin, refreshing
   * (and persisting the rotated pair) when needed. Rejects with a grant-unavailable
   * error when the grant has no Zendesk tokens or Zendesk refuses the refresh: the
   * user must sign in again. Any other failure is rethrown and the grant kept.
   */
  accessToken(grantId: string): Promise<string>;
  remove(grantId: string): Promise<void>;
}

export interface ZendeskGrantsOptions {
  readonly records: SealedCollection<ZendeskTokenSet>;
  readonly upstream: ZendeskUpstream;
  readonly logger?: Logger | undefined;
  readonly refresh?: typeof refreshZendeskTokens | undefined;
  readonly now?: (() => number) | undefined;
  /** How long before Zendesk's expiry to refresh; at least our access-token lifetime. */
  readonly refreshMarginMs?: number | undefined;
}

export const grantUnavailableError = (): Error =>
  Object.assign(new Error('The Zendesk authorization behind this grant is no longer valid.'), {
    name: 'ZendeskGrantUnavailable',
  });

export const isGrantUnavailableError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ZendeskGrantUnavailable';

// RFC 6749: an invalid or expired refresh token is a 400, a bad client a 401.
const isRefusal = (err: unknown): boolean =>
  isUpstreamAuthError(err) && (err.status === 400 || err.status === 401);

/**
 * Zendesk tokens per grant of ours. Both layers rotate their refresh tokens, so
 * two concurrent Zendesk refreshes would spend the same single-use token: the
 * refresh is serialised per grant. Only this step is locked, never our own
 * `/token` endpoint (ADR, Tokens).
 */
export const createZendeskGrants = (options: ZendeskGrantsOptions): ZendeskGrants => {
  const { records, upstream } = options;
  const logger = options.logger ?? silentLogger;
  const refresh = options.refresh ?? refreshZendeskTokens;
  const now = options.now ?? Date.now;
  const margin = options.refreshMarginMs ?? ZENDESK_REFRESH_MARGIN_MS;
  const withLock = createKeyLock();

  const needsRefresh = (tokens: ZendeskTokenSet): boolean =>
    // Stryker disable next-line ConditionalExpression: without the guard, undefined - now() is NaN and NaN <= margin is false, the same answer.
    tokens.expiresAt !== undefined && tokens.expiresAt - now() <= margin;

  const refreshed = async (grantId: string, refreshToken: string): Promise<string> => {
    let fresh: ZendeskTokenSet;
    try {
      fresh = await refresh(upstream, refreshToken, logger);
    } catch (err) {
      logger.warn('oauth_upstream_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Only Zendesk refusing the refresh token ends the grant. An outage may
      // leave that token unspent, so the next attempt can still succeed.
      if (!isRefusal(err)) throw err;
      await records.delete(grantId);
      throw grantUnavailableError();
    }
    await records.set(grantId, fresh, ZENDESK_REFRESH_TOKEN_TTL_S);
    return fresh.accessToken;
  };

  return {
    save: (grantId, tokens) => records.set(grantId, tokens, ZENDESK_REFRESH_TOKEN_TTL_S),
    // Under the lock: a refresh already running would otherwise write the
    // rotated tokens back after the removal.
    remove: (grantId) => withLock(grantId, () => records.delete(grantId)),
    accessToken: (grantId) =>
      withLock(grantId, async () => {
        const tokens = await records.get(grantId);
        if (!tokens) throw grantUnavailableError();
        if (!needsRefresh(tokens)) return tokens.accessToken;
        if (!tokens.refreshToken) throw grantUnavailableError();
        return refreshed(grantId, tokens.refreshToken);
      }),
  };
};
