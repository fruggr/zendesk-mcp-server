// Current name → the name it replaced. `ZENDESK_*` is reserved for the Zendesk
// side (AGENTS.md, "Environment variables"); these server knobs dropped it, and
// the old names keep working until 3.0.0 removes them.
const LEGACY_NAMES: ReadonlyMap<string, string> = new Map([
  ['OAUTH_TOKEN_FILE', 'ZENDESK_TOKEN_FILE'],
  ['OAUTH_CALLBACK_PORT', 'ZENDESK_OAUTH_CALLBACK_PORT'],
  ['LISTEN_HOST', 'HOST'],
  ['RESPONSE_CHARACTER_LIMIT', 'ZENDESK_CHARACTER_LIMIT'],
  ['RESPONSE_MAX_BYTES', 'ZENDESK_MAX_RESPONSE_BYTES'],
  ['ATTACHMENT_MAX_BYTES', 'ZENDESK_MAX_ATTACHMENT_BYTES'],
  ['EMBEDDED_IMAGES_MAX', 'ZENDESK_MAX_EMBEDDED_IMAGES'],
  ['COMMENT_MAX_PAGES', 'ZENDESK_MAX_COMMENT_PAGES'],
  ['TICKET_FIELD_SCAN_MAX_PAGES', 'ZENDESK_TICKET_FIELD_SCAN_MAX_PAGES'],
  ['ARTICLE_RESOURCES_SCAN_MAX_PAGES', 'ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES'],
  ['REORDER_CONFIRM_THRESHOLD', 'ZENDESK_REORDER_CONFIRM_THRESHOLD'],
]);

const warned = new Set<string>();

// Direct to stderr, in the logger's line format: constants read their variables
// at import time, before any logger exists.
const warnDeprecated = (legacy: string, current: string): void => {
  if (warned.has(legacy)) return;
  warned.add(legacy);
  try {
    console.error(
      `[zendesk-mcp] [warn] deprecated_env_var name=${legacy} replacement=${current} removal=3.0.0`,
    );
  } catch {
    // Best-effort sink: a dead stderr must not break startup.
  }
};

/**
 * Reads `name`, falling back to the legacy name it replaced. `name` in the result
 * is the variable the value came from, so an error about it names what the
 * operator actually set.
 */
export const readEnv = (name: string): { name: string; value: string | undefined } => {
  const value = process.env[name];
  const legacy = LEGACY_NAMES.get(name);
  const legacyValue = legacy === undefined ? undefined : process.env[legacy];
  if (legacy === undefined || legacyValue === undefined) return { name, value };

  warnDeprecated(legacy, name);
  return value === undefined ? { name: legacy, value: legacyValue } : { name, value };
};
