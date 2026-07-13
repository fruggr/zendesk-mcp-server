#!/usr/bin/env tsx
/**
 * Ground-truth capture for the Ticket Audits shape (issue #123 / get_ticket_history).
 *
 * The MCP tools only ever return *formatted text*, never the raw Zendesk JSON,
 * so the exact shape the new get_ticket_history formatter depends on cannot be
 * observed through them. This one-shot probe hits the live tenant directly and
 * prints the RAW JSON (comment bodies redacted) for the sources the tool relies
 * on, so the maintainer can confirm the implementation matches reality before
 * trusting the rest of the validation plan:
 *   - GET /api/v2/users/me.json                          (token identity)
 *   - GET /api/v2/tickets/{id}/audits.json?page[size]=   (the audit trail)
 *   - GET /api/v2/users/show_many.json?ids=              (author/assignee names)
 *   - GET /api/v2/groups/show_many.json?ids=             (group names — least documented)
 *
 * It confirms the pieces the formatter assumes:
 *   - the response envelope: `audits` array + `meta.{has_more,after_cursor}` (cursor pagination);
 *   - each audit's `created_at`, `author_id`, `via.channel`, `events[]`;
 *   - `Change`/`Create` events carrying `field_name` / `value` / `previous_value`
 *     (strings, except `tags` = array and SLA metrics = `{minutes,...}` object);
 *   - which event `type`s actually occur on this tenant (so the meaningful/noise
 *     split is grounded, not guessed);
 *   - that /users/show_many and /groups/show_many return `{users:[{id,name}]}` /
 *     `{groups:[{id,name}]}`.
 *
 * Comment/voice bodies are redacted to "[redacted]" (the tool never renders them
 * anyway), so there is minimal PII to scrub; ticket subjects are never printed.
 *
 * Usage (zero setup in an env where the zendesk-local MCP server is configured):
 *   pnpm tsx scripts/probe-audits-shape.ts [ticket_id]
 *
 * Pass a ticket_id with a rich history (reassigned, status-changed), or omit it
 * to let the probe pick the most-updated ticket it can find. Subdomain is read
 * from ZENDESK_SUBDOMAIN, else the zendesk-local entry in .mcp.json; the token
 * from ZENDESK_OAUTH_TOKEN, else the on-disk cached access token. Override:
 *   ZENDESK_SUBDOMAIN=fruggr ZENDESK_OAUTH_TOKEN=<token> \
 *     pnpm tsx scripts/probe-audits-shape.ts [ticket_id]
 *
 * Paste the output into a PR comment so the maintainer can align types, the
 * meaningful-event set, and the test mocks to the tenant's real audit shape.
 */
import { readFileSync } from 'node:fs';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { zendeskGet } from '../src/client/zendesk-api';

const cliTicketId = process.argv[2];
if (cliTicketId && !/^\d+$/.test(cliTicketId)) {
  console.error(
    'Usage: pnpm tsx scripts/probe-audits-shape.ts [ticket_id]\n' +
      '  ticket_id (optional) must be numeric; omit it to auto-pick a recently-updated ticket.',
  );
  process.exit(1);
}

const resolveSubdomain = (): string => {
  const fromEnv = process.env['ZENDESK_SUBDOMAIN'];
  if (fromEnv) return fromEnv;
  try {
    const mcp = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
    const sub = mcp?.mcpServers?.['zendesk-local']?.env?.ZENDESK_SUBDOMAIN;
    if (typeof sub === 'string' && sub) return sub;
  } catch {
    // fall through to the error below
  }
  console.error(
    'No Zendesk subdomain. Set ZENDESK_SUBDOMAIN, or run from a checkout whose ' +
      '.mcp.json configures the zendesk-local server.',
  );
  process.exit(1);
};

const subdomain = resolveSubdomain();

const resolveToken = (): string => {
  const fromEnv = process.env['ZENDESK_OAUTH_TOKEN'];
  if (fromEnv) return fromEnv;
  const cached = loadToken(resolveTokenPath(subdomain));
  if (cached?.accessToken) return cached.accessToken;
  console.error(
    `No token available. Export ZENDESK_OAUTH_TOKEN, or authenticate the server once for "${subdomain}" ` +
      `so a token is cached at ${resolveTokenPath(subdomain)}.`,
  );
  process.exit(1);
};

const dump = (label: string, value: unknown): void => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(value, null, 2));
};

// Free-text Change/Create fields whose value carries content (not shape) — their
// before/after values are redacted so a captured payload never leaks them.
const FREE_TEXT_FIELDS = new Set(['subject', 'description']);

// Redact free-text content from an event so the shape stays visible without PII:
// comment bodies/recipients, and the value/previous_value of free-text fields.
const redactEvent = (ev: unknown): unknown => {
  const e = { ...(ev as Record<string, unknown>) };
  for (const key of ['body', 'html_body', 'plain_body', 'recipients']) {
    if (key in e) e[key] = '[redacted]';
  }
  if (
    (e['type'] === 'Change' || e['type'] === 'Create') &&
    FREE_TEXT_FIELDS.has(String(e['field_name']))
  ) {
    if ('value' in e) e['value'] = '[redacted]';
    if ('previous_value' in e) e['previous_value'] = '[redacted]';
  }
  return e;
};

// Redact the audit `via.source` email addresses (from/to) that email-channel
// tickets carry, while keeping `via.channel` and the rest of the shape.
const redactVia = (via: unknown): unknown => {
  if (!via || typeof via !== 'object') return via;
  const v = { ...(via as Record<string, unknown>) };
  const source = v['source'];
  if (source && typeof source === 'object') {
    const s = { ...(source as Record<string, unknown>) };
    for (const dir of ['from', 'to']) {
      const entry = s[dir];
      if (entry && typeof entry === 'object' && 'address' in entry) {
        s[dir] = { ...(entry as Record<string, unknown>), address: '[redacted]' };
      }
    }
    v['source'] = s;
  }
  return v;
};

const redactAudit = (audit: unknown): unknown => {
  const a = { ...(audit as Record<string, unknown>) };
  if (Array.isArray(a['events'])) a['events'] = a['events'].map(redactEvent);
  if ('via' in a) a['via'] = redactVia(a['via']);
  return a;
};

// The user/group id fields a Change/Create value carries — mirrors the tool.
const USER_FIELDS = new Set(['assignee_id', 'requester_id', 'submitter_id']);

const main = async (): Promise<void> => {
  const token = resolveToken();

  // (0) Token identity — some audit detail is role-sensitive.
  try {
    const me = await zendeskGet<Record<string, unknown>>(subdomain, token, '/users/me');
    const user = (me['user'] as Record<string, unknown> | undefined) ?? {};
    dump('GET /users/me — token identity', {
      id: user['id'],
      role: user['role'],
      role_type: user['role_type'],
    });
  } catch (e) {
    console.log(`\n(could not read /users/me: ${e instanceof Error ? e.message : e})`);
  }

  // (1) Pick a target ticket. Prefer a CLI id; else the most-recently-updated
  // ticket (likely to have a non-trivial history: reassignments, status moves).
  let targetId = cliTicketId;
  if (!targetId) {
    try {
      const search = await zendeskGet<{ results?: Array<Record<string, unknown>> }>(
        subdomain,
        token,
        '/search',
        { query: 'type:ticket order_by:updated_at sort:desc', per_page: '5' },
      );
      const first = (search.results ?? [])[0];
      if (first?.['id'] != null) {
        targetId = String(first['id']);
        console.log(`\n-> No ticket_id passed; probing most-recently-updated ticket ${targetId}.`);
      }
    } catch (e) {
      console.log(`\n(auto-pick failed: ${e instanceof Error ? e.message : e})`);
    }
  }
  if (!targetId) {
    console.error('\nNo ticket to probe (none passed and auto-pick found none). Pass a ticket_id.');
    process.exit(1);
  }

  // (2) The audit trail — the envelope, the meta (cursor pagination), and the
  // event shapes the formatter reads.
  const audits = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${targetId}/audits`,
    { 'page[size]': '100' },
  );
  dump('GET /tickets/{id}/audits — top-level keys', Object.keys(audits));
  dump('audits meta (cursor pagination — expected has_more/after_cursor)', audits['meta']);

  const list = Array.isArray(audits['audits'])
    ? (audits['audits'] as Record<string, unknown>[])
    : [];
  console.log(`\n(${list.length} audits on the first page)`);

  // First two audits verbatim (redacted) — the founding Create audit and the
  // next update, so `created_at` / `author_id` / `via` / events are all visible.
  dump('First 2 audits (comment bodies redacted)', list.slice(0, 2).map(redactAudit));

  // Distinct event types across the page, plus one redacted sample per type, so
  // the meaningful-vs-noise split (and the Change field_name/value/previous_value
  // assumption) is grounded in what this tenant actually emits.
  const byType = new Map<unknown, unknown>();
  const fieldNames = new Set<unknown>();
  const userIds = new Set<number>();
  const groupIds = new Set<number>();
  const addId = (set: Set<number>, raw: unknown): void => {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) set.add(n);
  };
  for (const audit of list) {
    addId(userIds, audit['author_id']);
    const events = Array.isArray(audit['events'])
      ? (audit['events'] as Record<string, unknown>[])
      : [];
    for (const ev of events) {
      if (!byType.has(ev['type'])) byType.set(ev['type'], redactEvent(ev));
      if (ev['type'] === 'Change' || ev['type'] === 'Create') {
        fieldNames.add(ev['field_name']);
        const field = ev['field_name'] as string;
        if (USER_FIELDS.has(field)) {
          addId(userIds, ev['value']);
          addId(userIds, ev['previous_value']);
        } else if (field === 'group_id') {
          addId(groupIds, ev['value']);
          addId(groupIds, ev['previous_value']);
        }
      }
    }
  }
  dump('Distinct event `type`s on this page', [...byType.keys()]);
  dump('One redacted sample per event type', [...byType.values()]);
  dump('Distinct Change/Create field_names on this page', [...fieldNames]);

  // (3) Name resolution endpoints — confirm the show_many shapes the tool joins
  // against. /groups/show_many is the least-documented dependency.
  if (userIds.size > 0) {
    const users = await zendeskGet<Record<string, unknown>>(subdomain, token, '/users/show_many', {
      ids: [...userIds].join(','),
    });
    dump('GET /users/show_many — top-level keys', Object.keys(users));
    const arr = Array.isArray(users['users']) ? (users['users'] as Record<string, unknown>[]) : [];
    dump(
      'users show_many — {id,name} sample',
      arr.slice(0, 3).map((u) => ({ id: u['id'], name: u['name'] })),
    );
  } else {
    console.log('\n(no user ids referenced on this page; skipping /users/show_many)');
  }

  if (groupIds.size > 0) {
    try {
      const groups = await zendeskGet<Record<string, unknown>>(
        subdomain,
        token,
        '/groups/show_many',
        { ids: [...groupIds].join(',') },
      );
      dump('GET /groups/show_many — top-level keys', Object.keys(groups));
      const arr = Array.isArray(groups['groups'])
        ? (groups['groups'] as Record<string, unknown>[])
        : [];
      dump(
        'groups show_many — {id,name} sample',
        arr.slice(0, 3).map((g) => ({ id: g['id'], name: g['name'] })),
      );
    } catch (e) {
      console.log(
        `\n!!! /groups/show_many failed (${e instanceof Error ? e.message : e}). ` +
          'The tool tolerates this (falls back to bare group ids), but flag it so the ' +
          'endpoint/shape can be confirmed.',
      );
    }
  } else {
    console.log('\n(no group_id changes on this page; skipping /groups/show_many)');
  }
};

main().catch((error) => {
  console.error('probe-audits-shape failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
