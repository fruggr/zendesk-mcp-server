import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Logger, silentLogger } from '../utils/logger';
import { readPackageInfo } from '../utils/package-info';

/**
 * On-disk OAuth token record. `expiresAt` is an absolute epoch-ms timestamp
 * (derived from the OAuth `expires_in`) so expiry survives restarts; `undefined`
 * means a non-expiring token (Zendesk's default until expiration is enabled).
 */
export interface PersistedToken {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  // The scope Zendesk *granted*, as reported by the token response. Absent on a
  // record written before the server tracked grants -- which means `read write`,
  // the only scope it ever requested back then (see grantCovers).
  scope?: string | undefined;
}

const isWindows = process.platform === 'win32';

/**
 * Config-dir segments derived from the *scoped* package name
 * (`@fruggr/zendesk-mcp-server` → `fruggr` + `zendesk-mcp-server`) so the path is
 * vendor-namespaced and can't collide with another `zendesk-mcp-server`.
 */
// Splits an npm scoped name into [scope, package]; hoisted so it is compiled once.
const SCOPED_PACKAGE_NAME = /^@([^/]+)\/(.+)$/;

const appDirSegments = (): string[] => {
  const { name } = readPackageInfo();
  const scoped = SCOPED_PACKAGE_NAME.exec(name);
  return scoped?.[1] && scoped[2] ? [scoped[1], scoped[2]] : [name];
};

// OS config dir holding the token files, one per key: `%APPDATA%` on Windows,
// `$XDG_CONFIG_HOME` (falling back to `~/.config`) elsewhere.
const configDir = (): string => {
  const segments = appDirSegments();
  if (isWindows) {
    const base = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, ...segments);
  }
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, ...segments);
};

/**
 * What makes one persisted credential distinct from another: two servers
 * differing on any of these hold tokens that cannot substitute for each other.
 */
export interface TokenKey {
  subdomain: string;
  oauthClientId: string;
  scope: string;
}

// Key parts are attacker-shaped at worst (a crafted subdomain); sanitize so
// none can escape the config dir or smuggle a path separator.
const safeName = (part: string): string => part.replace(/[^a-z0-9-]/gi, '_');

// Leaves the digest, its separator and `.json` well inside the 255-byte limit
// every mainstream filesystem puts on one path component.
const READABLE_BUDGET = 120;

// The readable name above is lossy three ways over, so this digest is what
// actually keeps two keys off one file: `docs/decisions/token-file-keying.md`.
// JSON, not a delimiter, because nothing bounds what a key part may contain;
// hex, because a case-insensitive filesystem folds a base64url digest.
// Not a password hash, whatever a scanner's name heuristic makes of
// `oauthClientId`: the id is public by construction (it travels in the
// authorize URL), nothing is verified against this digest, and the same id is
// already in clear in the filename it completes. A slow KDF would buy nothing.
const keyDigest = (key: TokenKey): string =>
  createHash('sha256')
    .update(JSON.stringify([key.subdomain, key.oauthClientId, key.scope]))
    .digest('hex')
    .slice(0, 8);

/**
 * Path to the token file for one credential. Keyed on the whole `TokenKey`, so
 * a read-only server, a read-write one and one on another OAuth client each get
 * their own record instead of clobbering a shared file. Why that triple, and
 * why no migration from the old subdomain-only layout:
 * `docs/decisions/token-file-keying.md`.
 * `ZENDESK_TOKEN_FILE` overrides with an explicit path — the way to separate
 * two Zendesk accounts that share a subdomain, client and scope.
 */
export const resolveTokenPath = (key: TokenKey): string => {
  const override = process.env['ZENDESK_TOKEN_FILE'];
  if (override) return override;
  const readable = [key.subdomain, key.oauthClientId, key.scope]
    .map(safeName)
    .join('--')
    .slice(0, READABLE_BUDGET);
  return join(configDir(), `${readable}--${keyDigest(key)}.json`);
};

// Atomic write (tmp + rename) so a crash mid-write can't leave a truncated file,
// with owner-only perms on the file and its dir where the OS supports it.
const writeFileAtomic = (path: string, record: PersistedToken): void => {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  if (!isWindows) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (!isWindows) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort: tightening the dir is a bonus, not a requirement.
    }
  }
};

// A missing file or unparseable/garbage content is treated as "no token yet"
// rather than an error: persistence must never wedge the auth flow.
export const loadToken = (path: string): PersistedToken | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && typeof (raw as PersistedToken).accessToken === 'string') {
      return raw as PersistedToken;
    }
  } catch {
    // absent or corrupt → no token
  }
  return undefined;
};

export const saveToken = (
  path: string,
  record: PersistedToken,
  logger: Logger = silentLogger,
): void => {
  try {
    writeFileAtomic(path, record);
    logger.debug('token_persisted');
  } catch (err) {
    // Never fail the auth flow because the token couldn't be cached to disk.
    logger.warn('token_persist_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const clearToken = (path: string, logger: Logger = silentLogger): void => {
  try {
    rmSync(path, { force: true });
    logger.debug('token_cleared');
  } catch (err) {
    logger.warn('token_clear_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
