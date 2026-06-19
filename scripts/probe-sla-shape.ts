#!/usr/bin/env tsx
/**
 * Ground-truth capture for live per-ticket SLA (issue #92 / PR #93).
 *
 * The MCP tools only ever return *formatted text*, never the raw Zendesk JSON,
 * so the exact shape of the SLA data (which is not crisply documented) cannot be
 * observed through them. This one-shot probe hits the live tenant directly and
 * prints the RAW JSON for every candidate per-ticket SLA source, each probed in
 * ISOLATION so an unrecognized sibling sideload can't mask a valid one:
 *   - GET /api/v2/users/me.json                             (token role: admin?)
 *   - GET /api/v2/tickets/{id}.json?include=slas            (NOT honored here)
 *   - GET /api/v2/tickets/{id}.json?include=metric_events   (SLA `sla` objects?)
 *   - GET /api/v2/tickets/{id}/metrics.json                 (generic metric_set)
 *   - GET /api/v2/tickets/show_many.json?ids={id}&include=  (sideload honored?)
 *   - GET /api/v2/search.json?query=...requester:{id}       (single-ticket reuse?)
 *   - GET /api/v2/slas/policies.json                        (the policy matrix)
 *
 * A first probe of `?include=metric_events` came back as just `["ticket"]`, but
 * that run was INCONCLUSIVE, not a refutation: the research report flags two
 * preconditions for SLA data to surface — the token must be an admin, and the
 * ticket must actually have an SLA policy applied (priority set, policy matched;
 * Group SLAs may only surface via metric_events). So this probe now:
 *   1. prints the token's role up front (warns if it is not admin), and
 *   2. uses Search (`include=tickets(slas)`) to AUTO-DISCOVER a ticket that
 *      genuinely carries live `policy_metrics`, and probes that one when the id
 *      passed on the CLI has no live SLA (or no id is passed at all).
 * It also highlights any `sla` / `group_sla` object found on a metric event —
 * that object (policy {id,title} + target minutes + business/calendar + breach)
 * is the candidate source for a get_ticket SLA block.
 *
 * It only prints SLA-relevant keys (top-level key lists, payloads, ids), never
 * ticket subjects/bodies, so there is minimal PII to redact.
 *
 * Usage (zero setup in an env where the zendesk-local MCP server is configured):
 *   pnpm tsx scripts/probe-sla-shape.ts [ticket_id]
 *
 * Pass a ticket_id known to be covered by an SLA, or omit it to let the probe
 * discover one. The subdomain is read from ZENDESK_SUBDOMAIN, else from the
 * zendesk-local entry in .mcp.json. The token is read from ZENDESK_OAUTH_TOKEN,
 * else from the access token cached on disk when the server was authenticated
 * once (stdio OAuth flow). Override either explicitly when needed:
 *   ZENDESK_SUBDOMAIN=fruggr ZENDESK_OAUTH_TOKEN=<token> \
 *     pnpm tsx scripts/probe-sla-shape.ts [ticket_id]
 *
 * Paste the output into a PR comment so the maintainer can decide whether
 * get_ticket can surface SLA via metric_events, and align types/mocks.
 */
import { readFileSync } from 'node:fs';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { zendeskGet } from '../src/client/zendesk-api';

const cliTicketId = process.argv[2];
if (cliTicketId && !/^\d+$/.test(cliTicketId)) {
  console.error(
    'Usage: pnpm tsx scripts/probe-sla-shape.ts [ticket_id]\n' +
      '  ticket_id (optional) must be numeric; omit it to auto-discover an SLA-covered ticket.',
  );
  process.exit(1);
}

// The probe only needs a subdomain + a token to make GETs — not the full server
// config. Resolve the subdomain from the same places the server uses, so it runs
// with zero manual setup: ZENDESK_SUBDOMAIN, else the subdomain `.mcp.json`
// already configures the local server with (its env is injected into the MCP
// subprocess only, never the interactive shell, which is why a bare run fails).
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

const hasLiveSla = (slas: unknown): boolean =>
  Array.isArray((slas as { policy_metrics?: unknown[] } | undefined)?.policy_metrics) &&
  ((slas as { policy_metrics: unknown[] }).policy_metrics.length ?? 0) > 0;

// Pull the SLA-bearing object off a metric event under either documented key.
const slaObjectOf = (ev: unknown): unknown => {
  const e = ev as Record<string, unknown> | undefined;
  return e?.['sla'] ?? e?.['group_sla'] ?? null;
};

const main = async (): Promise<void> => {
  const token = resolveToken();

  // (0) Token role — `metric_events`/SLA data is admin-gated, so a non-admin
  // token is the first thing that would make this probe come back empty.
  let role: unknown = '(unknown)';
  try {
    const me = await zendeskGet<Record<string, unknown>>(subdomain, token, '/users/me');
    const user = (me['user'] as Record<string, unknown> | undefined) ?? {};
    role = { role: user['role'], role_type: user['role_type'], id: user['id'] };
    dump('GET /users/me — token identity (role MUST be admin for SLA data)', role);
    if (user['role'] !== 'admin') {
      console.log(
        '\n!!! WARNING: token role is not "admin" — SLA sideloads/metric_events are ' +
          'admin-gated, so empty results below are EXPECTED and INCONCLUSIVE. Re-run ' +
          'with an admin token (ZENDESK_OAUTH_TOKEN).',
      );
    }
  } catch (e) {
    console.log(`\n(could not read /users/me: ${e instanceof Error ? e.message : e})`);
  }

  // (1) Auto-discover a ticket that genuinely carries live SLA, via the one
  // source we KNOW works (Search `include=tickets(slas)`). This both confirms
  // the search shape and gives a guaranteed-covered ticket id to probe, so an
  // empty metric_events result can't be blamed on "this ticket had no SLA".
  let targetId = cliTicketId;
  try {
    const search = await zendeskGet<{ results?: Array<Record<string, unknown>> }>(
      subdomain,
      token,
      '/search',
      { query: 'type:ticket status<solved', include: 'tickets(slas)' },
    );
    const results = search.results ?? [];
    const covered = results.filter((r) => hasLiveSla(r['slas']));
    dump(
      'Search type:ticket include=tickets(slas) — ids WITH live policy_metrics',
      covered.map((r) => ({ id: r['id'], slas: r['slas'] })).slice(0, 5),
    );
    console.log(
      `\n(${covered.length}/${results.length} returned tickets carry live SLA policy_metrics)`,
    );
    if (!targetId && covered[0]?.['id'] != null) {
      targetId = String(covered[0]['id']);
      console.log(
        `\n-> No ticket_id passed; probing auto-discovered SLA-covered ticket ${targetId}.`,
      );
    } else if (targetId && !covered.some((r) => String(r['id']) === targetId)) {
      const fallback = covered[0]?.['id'];
      console.log(
        `\n!!! Ticket ${targetId} is NOT among the SLA-covered tickets above; its SLA probes ` +
          `may be empty for that reason.${fallback != null ? ` Consider re-running with ${fallback}.` : ''}`,
      );
    }
  } catch (e) {
    console.log(`\n(search discovery failed: ${e instanceof Error ? e.message : e})`);
  }

  if (!targetId) {
    console.error(
      '\nNo ticket to probe (none passed and none discovered with a live SLA). ' +
        'Pass an SLA-covered ticket_id explicitly.',
    );
    process.exit(1);
  }

  // (a) `slas` on Show Ticket — expected NOT honored (silently dropped).
  const ticketSlas = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${targetId}`,
    { include: 'slas' },
  );
  dump('GET /tickets/{id}?include=slas — top-level keys', Object.keys(ticketSlas));
  dump('slas payload', ticketSlas['slas'] ?? '(no "slas" key present)');

  // (b) `metric_events` on Show Ticket — the candidate richer source. Per the
  // Zendesk docs each SLA metric event carries an `sla`/`group_sla` object
  // (policy {id,title,description} + target minutes + business/calendar + breach
  // timestamp). Print one event per type, then isolate the SLA objects so we can
  // see whether stage + breach_at + policy + target are all reconstructable.
  const ticketEvents = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${targetId}`,
    { include: 'metric_events' },
  );
  dump('GET /tickets/{id}?include=metric_events — top-level keys', Object.keys(ticketEvents));
  const events = ticketEvents['metric_events'];
  if (Array.isArray(events)) {
    const byType = new Map<unknown, unknown>();
    for (const ev of events) {
      const type = (ev as Record<string, unknown>)?.['type'];
      if (!byType.has(type)) byType.set(type, ev);
    }
    dump(`metric_events — ${events.length} total, one sample per type`, [...byType.values()]);
    const slaObjects = events.map(slaObjectOf).filter((s) => s != null);
    dump(
      `metric_events — ${slaObjects.length} events carry an sla/group_sla object`,
      slaObjects.slice(0, 6),
    );
    if (slaObjects.length === 0) {
      console.log(
        '\n!!! No sla/group_sla object on any metric event. If the token is admin and the ' +
          'ticket is SLA-covered (see discovery above), get_ticket has NO reliable SLA source.',
      );
    }
  } else {
    dump('metric_events payload', events ?? '(no "metric_events" key present)');
  }

  // (c) The per-ticket metric_set (reply/resolution timing) — confirm it carries
  // NO SLA policy/target/breach, i.e. it cannot stand in for the SLA block.
  const metrics = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${targetId}/metrics`,
  );
  dump(
    'GET /tickets/{id}/metrics — ticket_metric (no SLA policy/target/breach expected)',
    metrics['ticket_metric'] ?? metrics,
  );

  // (d) Show MANY Tickets — a DIFFERENT endpoint than Show Ticket. Test whether
  // it honors the `slas` / `metric_events` sideload that Show Ticket silently
  // drops. If it does, get_ticket gains a CLEAN, reliable per-id SLA path (one
  // extra call, no pagination/indexing caveats) and the SLA can come back here.
  for (const inc of ['slas', 'metric_events'] as const) {
    const many = await zendeskGet<Record<string, unknown>>(subdomain, token, '/tickets/show_many', {
      ids: targetId,
      include: inc,
    });
    dump(`GET /tickets/show_many?ids={id}&include=${inc} — top-level keys`, Object.keys(many));
    dump(`show_many ${inc} payload`, many[inc] ?? `(no "${inc}" key present)`);
  }

  // (e) Search-by-correlation feasibility — there is NO `id:` operator, so the
  // only way to reuse the working Search `slas` sideload for ONE ticket is a
  // scoped query (here: same requester) matched back by exact id. Measure the
  // two failure modes of that approach: COVERAGE (is the target even in the
  // result set?) and how many siblings we'd have to page through.
  const targetTicket = (ticketSlas['ticket'] as Record<string, unknown> | undefined) ?? {};
  const requesterId = targetTicket['requester_id'];
  if (requesterId != null) {
    const scoped = await zendeskGet<{ results?: Array<Record<string, unknown>>; count?: number }>(
      subdomain,
      token,
      '/search',
      { query: `type:ticket requester:${requesterId}`, include: 'tickets(slas)' },
    );
    const results = scoped.results ?? [];
    const hit = results.find((r) => String(r['id']) === String(targetId));
    dump('Search by requester + correlate by id — feasibility of a get_ticket fallback', {
      requester_id: requesterId,
      total_count: scoped['count'],
      returned_on_first_page: results.length,
      target_found_on_first_page: Boolean(hit),
      target_slas: hit?.['slas'] ?? '(target NOT on first page — coverage gap)',
    });
  } else {
    console.log('\n(no requester_id on the target ticket; skipping search-correlation probe)');
  }

  const policies = await zendeskGet<Record<string, unknown>>(subdomain, token, '/slas/policies');
  dump('GET /slas/policies — top-level keys', Object.keys(policies));
  const rawSlaPolicies = policies['sla_policies'];
  if (!Array.isArray(rawSlaPolicies)) {
    dump(
      'GET /slas/policies — unexpected `sla_policies` shape',
      rawSlaPolicies ?? '(no "sla_policies" key present)',
    );
  }
  const list = Array.isArray(rawSlaPolicies) ? rawSlaPolicies : [];
  dump('GET /slas/policies — first policy (representative shape)', list[0] ?? '(no policies)');
  console.log(`\n(${list.length} SLA policies total)`);
};

main().catch((error) => {
  console.error('probe-sla-shape failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
