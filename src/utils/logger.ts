import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LogLevel } from '../config';

type Fields = Record<string, unknown>;

/**
 * Minimal structured logger with two sinks:
 *  - stderr (always, gated by the configured level) — the universal floor that
 *    every mainstream MCP client captures to a log file;
 *  - MCP `notifications/message` (when a server is attached and advertises the
 *    `logging` capability) — surfaced by clients that support it, ignored
 *    gracefully by those that don't.
 *
 * Both sinks share a single level gate (`LOG_LEVEL`); MCP clients may further
 * raise the floor via `logging/setLevel`, which the SDK filters on its own.
 */
export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** Attach an McpServer so logs are also emitted as MCP notifications. */
  attachServer(server: Pick<McpServer, 'sendLoggingMessage'>): void;
}

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Our 4 levels mapped onto the MCP logging levels (note: `warning`, not `warn`).
const MCP_LEVEL: Record<LogLevel, 'debug' | 'info' | 'warning' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};

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

// Recursively redact: a sensitive *key* anywhere in the tree (top-level or
// nested in objects/arrays) has its value replaced, so `{ oauth: { token } }`
// can't leak. Primitives are returned as-is.
const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitive(key) ? '[REDACTED]' : redactValue(val);
    }
    return out;
  }
  return value;
};

const redact = (fields: Fields): Fields => {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSensitive(key) ? '[REDACTED]' : redactValue(value);
  }
  return out;
};

const renderValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
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
  attachServer: noop,
};

export const createLogger = (level: LogLevel): Logger => {
  const min = SEVERITY[level];
  let server: Pick<McpServer, 'sendLoggingMessage'> | undefined;

  const emit = (lvl: LogLevel, event: string, fields?: Fields): void => {
    if (SEVERITY[lvl] < min) return;

    const safe = fields ? redact(fields) : {};
    console.error(formatLine(lvl, event, safe));

    if (server) {
      try {
        void server
          .sendLoggingMessage({
            level: MCP_LEVEL[lvl],
            logger: 'zendesk-mcp-server',
            // `event` last so a caller-supplied `fields.event` can't shadow the
            // canonical event name.
            data: { ...safe, event },
          })
          .catch(noop);
      } catch {
        // Forwarding is best-effort (e.g. transport not connected yet);
        // it must never break the flow that emitted the log.
      }
    }
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    attachServer: (s) => {
      server = s;
    },
  };
};
