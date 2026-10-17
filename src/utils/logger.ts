import type { LogLevel } from '../config';

type Fields = Record<string, unknown>;

/**
 * Minimal structured logger writing to stderr, gated by `LOG_LEVEL`: the
 * channel every mainstream MCP client captures to a log file. There is no MCP
 * sink (`notifications/message`): the `logging` capability is deprecated as of
 * 2026-07-28 (SEP-2577), and one process-wide sink would reach whichever HTTP
 * session it last pointed at. Rationale: `docs/decisions/protocol-eras.md`.
 */
export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Field keys whose values must never reach a sink, matched after normalising
// (lowercase, separators stripped) so `access_token`, `accessToken` and
// `ACCESS-TOKEN` all collapse to the same key. Diagnostic fields such as
// `errorCode`, `status` or `error` (a message) are intentionally NOT listed.
const REDACTED_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'code',
  'codeverifier',
  'authorization',
  'password',
  'secret',
  'apitoken',
  'bearer',
]);

const isSensitive = (key: string): boolean =>
  REDACTED_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));

// A sensitive *key* anywhere in the tree has its value replaced. `path` covers
// the current branch only, so an ancestor back-reference becomes `[circular]`
// while a value shared between siblings is still walked. Functions are dropped: a
// copied `toJSON` would be invoked by `JSON.stringify` and hand back the original.
const redactValue = (value: unknown, path: WeakSet<object> = new WeakSet()): unknown => {
  if (typeof value === 'function') return '[function]';
  if (!value || typeof value !== 'object') return value;
  if (path.has(value)) return '[circular]';

  path.add(value);
  const out = Array.isArray(value)
    ? value.map((item) => redactValue(item, path))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, val]) => [
          key,
          isSensitive(key) ? '[REDACTED]' : redactValue(val, path),
        ]),
      );
  path.delete(value);
  return out;
};

// Total over anything a caller can hand us: redaction reads objects that may
// fight back (a throwing getter, an exotic proxy), and losing the fields beats
// taking the caller down with them.
const sanitise = (fields?: Fields): Fields => {
  if (!fields) return {};
  try {
    return redactValue(fields) as Fields;
  } catch {
    return { fields: '[unredactable]' };
  }
};

const renderValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  // Only numbers need this: `JSON.stringify` below renders a boolean or `null`
  // identically, and NaN and the infinities are the reason it cannot render these.
  if (typeof value === 'number') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};

const formatLine = (level: LogLevel, event: string, fields: Fields): string => {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${renderValue(value)}`);
  return `[zendesk-mcp] [${level}] ${event}${parts.length ? ` ${parts.join(' ')}` : ''}`;
};

const noop = (): void => {};

export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

export const createLogger = (level: LogLevel): Logger => {
  const min = SEVERITY[level];

  const emit = (lvl: LogLevel, event: string, fields?: Fields): void => {
    if (SEVERITY[lvl] < min) return;
    try {
      console.error(formatLine(lvl, event, sanitise(fields)));
    } catch {
      // Best-effort sink: a dead stderr must not break the caller.
    }
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
};
