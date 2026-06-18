#!/usr/bin/env tsx
/**
 * Ground-truth capture for the Zendesk SLA sideload (issue #92 / PR #93).
 *
 * The MCP tools only ever return *formatted text*, never the raw Zendesk JSON,
 * so the exact shape of the SLA data (which is not crisply documented) cannot be
 * observed through them. This one-shot probe hits the live tenant directly and
 * prints the RAW JSON for every candidate per-ticket SLA source, each probed in
 * ISOLATION so an unrecognized sibling sideload can't mask a valid one:
 *   - GET /api/v2/tickets/{id}.json?include=slas           (NOT honored here)
 *   - GET /api/v2/tickets/{id}.json?include=metric_events  (SLA `sla` objects?)
 *   - GET /api/v2/tickets/{id}/metrics.json                (generic metric_set)
 *   - GET /api/v2/slas/policies.json                       (the policy matrix)
 *
 * It only prints the SLA-relevant keys (top-level key list + payloads), never
 * ticket subjects/bodies, so there is minimal PII to redact.
 *
 * Usage (zero setup in an env where the zendesk-local MCP server is configured):
 *   pnpm tsx scripts/probe-sla-shape.ts <ticket_id>
 *
 * The subdomain is read from ZENDESK_SUBDOMAIN, else from the zendesk-local entry
 * in .mcp.json. The token is read from ZENDESK_OAUTH_TOKEN, else from the access
 * token cached on disk when the server was authenticated once (stdio OAuth flow).
 * Override either explicitly when needed:
 *   ZENDESK_SUBDOMAIN=fruggr ZENDESK_OAUTH_TOKEN=<token> \
 *     pnpm tsx scripts/probe-sla-shape.ts <ticket_id>
 *
 * Paste the output into a PR comment so the maintainer can align the
 * TypeScript types, the `findSlaForTicket` correlation key and the MSW mock
 * (MOCK_SLA_SIDELOAD) to the real shape.
 */
import { readFileSync } from 'node:fs';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { zendeskGet } from '../src/client/zendesk-api';

const ticketId = process.argv[2];
if (!ticketId || !/^\d+$/.test(ticketId)) {
  console.error(
    'Usage: pnpm tsx scripts/probe-sla-shape.ts <ticket_id>\n' +
      '  ticket_id must be a numeric id of a ticket that is covered by an SLA policy.',
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

const main = async (): Promise<void> => {
  const token = resolveToken();

  // Probe each candidate single-ticket SLA source in ISOLATION, so an
  // unrecognized sibling sideload can't mask a valid one (the first probe
  // requested `slas,metric_events` together and got back only `["ticket"]`,
  // which couldn't tell us whether `metric_events` itself is honored here).

  // (a) `slas` on Show Ticket — expected NOT honored (silently dropped).
  const ticketSlas = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${ticketId}`,
    {
      include: 'slas',
    },
  );
  dump('GET /tickets/{id}?include=slas — top-level keys', Object.keys(ticketSlas));
  dump('slas payload', ticketSlas['slas'] ?? '(no "slas" key present)');

  // (b) `metric_events` on Show Ticket — per Zendesk docs each SLA metric event
  // carries an `sla`/`group_sla` object (policy {id,title,description} + target
  // in minutes + business/calendar + the breach timestamp). If present, this is
  // the richer source for the get_ticket SLA block. Print the first event of
  // each distinct type so the shape (esp. the `sla` object) is visible.
  const ticketEvents = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${ticketId}`,
    {
      include: 'metric_events',
    },
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
  } else {
    dump('metric_events payload', events ?? '(no "metric_events" key present)');
  }

  // (c) The per-ticket metric_set (reply/resolution timing) — confirm it carries
  // NO SLA policy/target/breach, i.e. it cannot stand in for the SLA block.
  const metrics = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${ticketId}/metrics`,
  );
  dump(
    'GET /tickets/{id}/metrics — ticket_metric (no SLA policy/target/breach expected)',
    metrics['ticket_metric'] ?? metrics,
  );

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
