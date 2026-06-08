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
}

const isWindows = process.platform === 'win32';

/**
 * Config-dir segments derived from the *scoped* package name
 * (`@fruggr/zendesk-mcp-server` → `fruggr` + `zendesk-mcp-server`) so the path is
 * vendor-namespaced and can't collide with another `zendesk-mcp-server`.
 */
const appDirSegments = (): string[] => {
  const { name } = readPackageInfo();
  const scoped = /^@([^/]+)\/(.+)$/.exec(name);
  return scoped?.[1] && scoped[2] ? [scoped[1], scoped[2]] : [name];
};

// OS config dir holding the per-subdomain token files: `%APPDATA%` on Windows,
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

// Zendesk subdomains are [a-z0-9-]; sanitize defensively so a crafted value
// can neither escape the config dir nor smuggle a path separator.
const safeName = (subdomain: string): string => subdomain.replace(/[^a-z0-9-]/gi, '_');

/**
 * Path to the token file for a subdomain. Each subdomain gets its **own** file
 * (`<subdomain>.json`, a single record) so concurrent processes for different
 * subdomains never read-modify-write a shared file — no merge, no clobber.
 * `ZENDESK_TOKEN_FILE` overrides with an explicit path (a single file; use the
 * default layout for multi-subdomain installs).
 */
export const resolveTokenPath = (subdomain: string): string => {
  const override = process.env['ZENDESK_TOKEN_FILE'];
  if (override) return override;
  return join(configDir(), `${safeName(subdomain)}.json`);
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
