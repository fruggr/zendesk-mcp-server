#!/usr/bin/env tsx
/**
 * Ground-truth capture for the Views API (issue #121).
 *
 * The MCP tools only ever return *formatted text*, never the raw Zendesk JSON,
 * so the exact shape of the Views responses (which is thinly documented) cannot
 * be observed through them. get_view_tickets makes one high-risk assumption we
 * could only *guess* from the docs: that each row of `GET /views/{id}/execute`
 * carries the ticket id at `row.ticket.id` (the docs show a partial `"ticket": {}`
 * and inline column values). If that guess is wrong, get_view_tickets silently
 * returns zero tickets for a non-empty view. This one-shot, READ-ONLY probe hits
 * the live tenant directly and prints the RAW JSON for each endpoint the feature
 * relies on:
 *   - GET /api/v2/users/me.json                    (token identity)
 *   - GET /api/v2/views.json?active=true           (view object shape)
 *   - GET /api/v2/views/count_many.json?ids=...     (view_counts shape + fresh)
 *   - GET /api/v2/views/{id}/execute.json           (columns/rows — WHERE is the id?)
 *   - GET /api/v2/tickets/show_many.json?ids=...     (hydration returns full tickets?)
 *
 * It auto-discovers a non-empty view to execute so an empty rows[] can't be
 * blamed on "that view happened to have no tickets". For each of the first rows
 * it prints exactly how the tool would extract the id (row.ticket.id, else an
 * inlined id/ticket_id column), so a mismatch is obvious. It prints column
 * definitions and row *keys* rather than dumping every ticket subject; only if no
 * id is extractable does it dump a full row for diagnosis (may contain a subject —
 * redact before pasting).
 *
 * Usage (zero setup in an env where the zendesk-local MCP server is configured):
 *   pnpm tsx scripts/probe-views-shape.ts [view_id]
 *
 * Pass a view_id known to be non-empty, or omit it to let the probe discover one.
 * The subdomain is read from ZENDESK_SUBDOMAIN, else from the zendesk-local entry
 * in .mcp.json. The token is read from ZENDESK_OAUTH_TOKEN, else from the access
 * token cached on disk when the server was authenticated once. Override either:
 *   ZENDESK_SUBDOMAIN=fruggr ZENDESK_OAUTH_TOKEN=<token> \
 *     pnpm tsx scripts/probe-views-shape.ts [view_id]
 *
 * Paste the output into a PR comment so the maintainer can align the execute-row
 * types, the id-extraction logic, and the test mocks to reality.
 */
import { readFileSync } from 'node:fs';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { zendeskGet } from '../src/client/zendesk-api';

const cliViewId = process.argv[2];
if (cliViewId && !/^\d+$/.test(cliViewId)) {
  console.error(
    'Usage: pnpm tsx scripts/probe-views-shape.ts [view_id]\n' +
      '  view_id (optional) must be numeric; omit it to auto-discover a non-empty view.',
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

// Mirror the tool's extraction (see extractRowTicketId in src/tools/tickets.ts).
const extractRowTicketId = (row: Record<string, unknown>): number | undefined => {
  const ticket = row['ticket'] as { id?: unknown } | undefined;
  if (typeof ticket?.id === 'number') return ticket.id;
  for (const key of ['id', 'ticket_id']) {
    if (typeof row[key] === 'number') return row[key] as number;
  }
  return undefined;
};

const main = async (): Promise<void> => {
  const token = resolveToken();

  // (0) Token identity — views are per-agent scoped, so this shows whose queue
  // the probe sees (not admin-gated, unlike the SLA probe).
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

  // (1) List Views — the object shape list_views renders (id/title/active/description).
  const viewsResp = await zendeskGet<{ views?: Record<string, unknown>[] }>(
    subdomain,
    token,
    '/views',
    { active: 'true', 'page[size]': '100' },
  );
  const views = viewsResp.views ?? [];
  dump(
    'GET /views?active=true — first view (representative shape)',
    views[0] ?? '(no active views)',
  );
  dump(
    'GET /views?active=true — all view ids/titles',
    views.map((v) => ({ id: v['id'], title: v['title'], active: v['active'] })),
  );
  console.log(`\n(${views.length} active views)`);
  if (views.length === 0) {
    console.error('\nNo active views to probe. Create a view or run with a different token.');
    process.exit(1);
  }

  // (2) count_many — the raw view_counts shape (view_id/value/pretty/fresh). Used
  // to pick a non-empty view to execute.
  const ids = views.map((v) => Number(v['id'])).filter((n) => Number.isFinite(n));
  const countsResp = await zendeskGet<{ view_counts?: Record<string, unknown>[] }>(
    subdomain,
    token,
    '/views/count_many',
    { ids: ids.slice(0, 20).join(',') },
  );
  const counts = countsResp.view_counts ?? [];
  dump('GET /views/count_many — raw view_counts (first 20 ids)', counts);

  let targetId = cliViewId;
  if (!targetId) {
    const nonEmpty = counts.find(
      (c) => typeof c['value'] === 'number' && (c['value'] as number) > 0,
    );
    targetId = String(nonEmpty?.['view_id'] ?? views[0]?.['id']);
    console.log(`\n-> No view_id passed; executing view ${targetId} (auto-discovered non-empty).`);
  }

  // (3) Execute View — THE critical shape. Where does the ticket id live on a row?
  const exec = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/views/${targetId}/execute`,
    { 'page[size]': '20' },
  );
  dump(`GET /views/${targetId}/execute — top-level keys`, Object.keys(exec));
  dump('execute columns', exec['columns'] ?? '(no columns)');
  const rows = (exec['rows'] as Record<string, unknown>[] | undefined) ?? [];
  console.log(`\n(${rows.length} rows returned)`);
  const extraction = rows.slice(0, 5).map((row, i) => ({
    row_index: i,
    row_keys: Object.keys(row),
    'row.ticket': row['ticket'] ?? '(no ticket key)',
    extracted_id: extractRowTicketId(row),
  }));
  dump('execute rows — id extraction per row (extracted_id MUST be a number)', extraction);
  const extractedIds = rows
    .map((r) => extractRowTicketId(r))
    .filter((id): id is number => typeof id === 'number');
  dump('execute meta / pagination keys', {
    meta: exec['meta'],
    count: exec['count'],
    next_page: exec['next_page'],
  });
  // No ids to hydrate — exit cleanly instead of calling show_many with an empty
  // `ids` list. Two distinct causes, distinguished so the reader knows which:
  if (extractedIds.length === 0) {
    if (rows.length === 0) {
      console.log(
        `\nView ${targetId} returned 0 rows (empty view). The hydration step needs a ` +
          'non-empty view — re-run with an explicit non-empty view id: ' +
          'pnpm tsx scripts/probe-views-shape.ts <view_id>',
      );
    } else {
      console.log(
        '\n!!! NO ticket id extractable from any row — get_view_tickets would return EMPTY for ' +
          'this non-empty view. The row shape differs from the assumption; full first row below ' +
          '(may contain a ticket subject — REDACT before pasting):',
      );
      dump('execute rows[0] — FULL (diagnosis only)', rows[0]);
    }
    return;
  }

  // (4) show_many hydration — confirm it returns FULL tickets for those ids, and
  // whether the returned order matches the requested order (the tool re-sorts, so
  // a mismatch here is expected and handled — this just documents it).
  const many = await zendeskGet<{ tickets?: Record<string, unknown>[] }>(
    subdomain,
    token,
    '/tickets/show_many',
    { ids: extractedIds.slice(0, 20).join(',') },
  );
  const tickets = many.tickets ?? [];
  dump(
    'GET /tickets/show_many — first ticket keys (full ticket expected)',
    Object.keys(tickets[0] ?? {}),
  );
  dump('show_many — requested vs returned id order', {
    requested: extractedIds.slice(0, 20),
    returned: tickets.map((t) => t['id']),
  });
};

main().catch((error) => {
  console.error('probe-views-shape failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
