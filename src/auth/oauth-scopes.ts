/**
 * The OAuth scope the server asks Zendesk for, and the one predicate that
 * decides whether a cached token's grant is still good enough.
 *
 * Both scope strings live here rather than in `constants.ts` on purpose: they
 * are behavioural strings whose mutants must be killed by assertions
 * (`docs/decisions/mutation-testing.md`, "OAuth parameters and scopes"), and
 * `src/auth/**` is inside the mutation scope while `constants.ts` is not.
 * Keeping them next to the predicate that consumes them keeps both under the
 * same gate.
 */

// Zendesk's two global scopes: `read` covers every GET endpoint (sideloads
// included), `write` adds POST/PUT/DELETE.
const READ_SCOPE = 'read';
const READ_WRITE_SCOPE = 'read write';

/**
 * The scope to request for a given tool surface. `--read-only` already filters
 * every write tool out of the surface, so asking Zendesk for `write` on top of
 * that would be requesting an authority the server cannot even exercise — and
 * an OAuth client whose allowed scopes stop at `read` rejects the whole
 * authorize request with `invalid_scope`, minting no token at all (#283).
 */
export const requestedScope = (readOnly: boolean): string =>
  readOnly ? READ_SCOPE : READ_WRITE_SCOPE;

/**
 * The same decision as a list, for the RFC 9728 / RFC 8414 `scopes_supported`
 * metadata. Derived from `requestedScope` so what the HTTP transport advertises
 * provably cannot drift from what the stdio flow requests.
 */
export const supportedScopes = (readOnly: boolean): string[] => requestedScope(readOnly).split(' ');

// Hoisted: the predicate below runs on every token read.
// Stryker disable next-line Regex: the empty-token filter below makes `/\s/`
// and `/\s+/` produce identical output, so the quantifier is clarity, not
// behaviour, and no test can tell the two apart.
const WHITESPACE = /\s+/;

const scopeTokens = (scope: string): string[] =>
  scope.split(WHITESPACE).filter((s) => s.length > 0);

/**
 * Whether a token granted `granted` may still be used to serve a request for
 * `requested` — a flat "every requested token is present" subset test.
 *
 * Coverage rather than equality, because one token file is shared by every
 * server on this subdomain: a write-mode server re-authenticates once and
 * upgrades the record, after which a read-only sibling accepts it. An equality
 * check would make the two re-authenticate in turn, forever.
 *
 * A `granted` that is not a string means the record predates scope tracking.
 * That is not a guess: `read write` is the only scope this server has ever
 * requested, so any record written by any released version carries that grant —
 * hence `true`, and nobody is pushed through a sign-in on upgrade. The
 * `typeof` (rather than an `undefined` check) also absorbs a hand-edited
 * `"scope": null`, which `loadToken` would otherwise pass through unvalidated.
 *
 * What this deliberately does NOT model is Zendesk's scope hierarchy: a
 * granular grant such as `tickets:read` is judged not to cover a `read`
 * request, and vice versa. Both misjudgements only ever cost one extra
 * interactive sign-in, and neither is reachable while `read` and `read write`
 * are the only scopes requested. Granular scopes (#284) must replace this
 * predicate rather than extend it.
 */
export const grantCovers = (granted: string | undefined, requested: string): boolean => {
  if (typeof granted !== 'string') return true;
  const held = new Set(scopeTokens(granted));
  return scopeTokens(requested).every((token) => held.has(token));
};
