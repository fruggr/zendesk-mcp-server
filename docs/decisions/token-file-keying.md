# The token file is keyed by subdomain, OAuth client and scope

**Status**: accepted (issue #300, PR #301)

## Context

The persisted OAuth token file used to be named after the Zendesk subdomain
alone. One machine running two servers against one subdomain — the common
setup being a read-write instance beside a `--read-only` one — therefore had
both processes read-modify-writing a single record. Each seeds its in-memory
copy from disk at startup and afterwards writes without re-reading, so the last
writer won.

Three things went wrong, and the reporter could not tell them apart:

- **A read-only server inheriting write authority.** The read-only instance
  requests the `read` scope (#283). The read-write one loads that record, finds
  the grant too narrow, re-authenticates and overwrites the file with a
  `read write` token. On its next start the read-only instance loads *that*
  record and accepts it, because `grantCovers` is a superset test. `--read-only`
  still filters the tool surface, but no longer bounds what the credential can
  do at the API.
- **A vanishing token.** Zendesk rotates the refresh token on every use. After a
  restart both processes hold the same one; the first to refresh invalidates the
  other's copy, and the loser treats its rejection as a dead credential — which
  means deleting the file, taking the winner's still-valid record with it.
- **A dead-end sign-in.** Two first-time flows at once collide on the fixed
  callback port.

Separate OAuth clients per instance, which the setup was heading towards, make
the second failure strictly worse: a refresh token minted for one client is
rejected by the other, and the rejection deletes the shared file.

## Decision

The file name carries the whole key: `(subdomain, oauthClientId, scope)`, as
`<subdomain>--<client>--<scope>--<digest>.json`. Two servers whose credentials
cannot substitute for each other no longer address one record.

Nothing else changes. `ZENDESK_TOKEN_FILE` still overrides the path outright,
and remains the answer for the one case the key does not separate: two Zendesk
*accounts* on the same subdomain, client and scope.

No new configuration axis. A server cannot learn the name its MCP client gave it
— `mcpServers` keys are not transmitted, and `initialize` carries `clientInfo`,
which is identical for both instances — so an instance identifier would have to
be typed by hand, to separate cases the triple already separates.

## Why a digest, on top of a readable name

Sanitizing maps every unsafe character to `_`, so it is not injective: the
clients `a b` and `a_b` produce one name. Windows folds case on top of that, and
the name is capped so a long client id cannot overflow the filesystem's
per-component limit — a third way for two keys to collide. Each collision
silently recreates the bug this keying removes, so the readable part is for
humans and a digest over the raw key is what actually keeps records apart. It is
hex rather than base64url for the same reason: a case-insensitive filesystem
must not fold two digests together either.

The digest is taken over a JSON array of the parts, not over the parts joined by
a separator. Nothing bounds what a subdomain or client id may contain —
`config.ts` only requires a non-empty string — so a part holding the separator
byte would let one key's tail impersonate the next key's head and land on its
file, which is the collision the digest exists to rule out.

The name itself is never parsed back, so a client id containing the `--` joiner
is harmless.

SHA-256 is right here, and a slow KDF would be wrong. A scanner reads
`oauthClientId` as a password on the name alone — it carries "auth" — and asks
for one. It is not a password: an OAuth client id is public by construction,
travelling in the authorize URL on every sign-in; nothing is ever verified
against this digest, which only disambiguates a filename; and the same id
already sits in clear in the very name the digest completes. Stretching it would
buy nothing against any of that, and would cost a stretch on every process
start. The alert is dismissed as a false positive rather than designed around.

## Why no migration from the old layout

No existing file matches the new key, so everyone signs in once more. A
read-through fallback to `<subdomain>.json` was rejected: it would have both
instances converge on the same refresh token for the length of the transition —
replaying the rotation race one last time — in exchange for a transitional code
path to remove later.

The cost is not only the sign-in: the old file would stay on disk holding a live
refresh token that nothing reads and nothing rotates. Leaving that to the user,
on the strength of a troubleshooting entry they have no reason to open, is not
good enough for a credential — so the server deletes it on startup
(`removeLegacyToken`), under two guards:

- **never when `ZENDESK_TOKEN_FILE` is set.** An override may name the legacy
  file, which makes it the *live* record — deleting it would cost a sign-in on
  every start. Comparing it against the active path was tried first and is not
  enough: the same file can be named relatively, through `..`, through a
  symlink, or in another case on a case-insensitive filesystem, and no string
  match catches all of those. Skipping the sweep entirely whenever an override
  is in play has no such gap, and costs nothing — without an override the active
  name always ends in `--<digest>.json`, so it can never *be* the legacy name.
- **never a file that no longer parses as a token record.** This one is a shape
  check, not proof of ownership — `loadToken` would accept any JSON carrying an
  `accessToken` string. What makes deleting safe is the *location*: the file
  sits in our own vendor-namespaced config dir, which nothing else writes to.
  Someone deliberately keeping a file of their own there reaches it through
  `ZENDESK_TOKEN_FILE`, and the first guard has already stood the sweep down.

The price is that an install pinned to a `ZENDESK_TOKEN_FILE` keeps its orphan.
That is the right trade: whoever set that variable chose where the file lives,
and `docs/troubleshooting.md` tells them what to do with the old one.

One more case is accepted rather than solved: a server still on a pre-#301
version, running beside an upgraded one on the same subdomain, with no override
on either. The sweep deletes the file that older process persists to — and it
can do so repeatedly. The old process rewrites the file on its next refresh, the
next start of the upgraded server sweeps it again, and every restart of the old
process that lands while the file is gone costs another sign-in. Where an MCP
client respawns stdio servers per session, that is once a session, not once.

Avoiding it would mean knowing, from inside one process, whether another version
is running elsewhere. Nothing in the process does, and every approximation — an
mtime threshold, a lock, a marker file — is permanent machinery bought for a
transient case, in code that exists to be deleted. The exposure ends when every
instance on the machine is upgraded, which is also when the sweep stops having
anything to find.

This is the one thing that keeps the old layout alive in the code, so it is
migration-only and tracked for removal (#305) rather than left to become
permanent. Note what it does *not* do: deleting a refresh token is not revoking
it. The grant stands until Zendesk expires it, which is why
`docs/troubleshooting.md` still points a user on a shared machine at revocation.

## Why the port is the mutex, and there is no lockfile

Several instances share one registered redirect URL, so only one can hold a
sign-in at a time. `listen()` already enforces that atomically and the kernel
releases the port when the process dies. A lockfile would add failure modes it
cannot remove — a stale lock after `kill -9`, a TTL to tune, a PID to validate
across reused PIDs, containers and namespaces — and a runtime directory to
choose, which is not the config dir: `%APPDATA%` roams between machines, and a
lock guarding a `localhost` port must not.

Waiting for the port was rejected too. It frees only when the other sign-in
completes, up to the five-minute auth timeout, while `getToken` has to return
promptly — it hands the authorize URL back to the agent rather than holding the
tool call open. A background retry would also pop a browser tab minutes later,
unprompted.

So the second instance fails fast with a message naming the likely cause, and
the caller's own retry — the same contract the "authenticate and retry" error
already sets — is what picks the port up once it frees.
