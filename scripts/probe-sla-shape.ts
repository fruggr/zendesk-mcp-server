#!/usr/bin/env tsx
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
/**
 * Ground-truth capture for the Zendesk SLA sideload (issue #92 / PR #93).
 *
 * The MCP tools only ever return *formatted text*, never the raw Zendesk JSON,
 * so the exact shape of the `slas` sideload (which is not crisply documented)
 * cannot be observed through them. This one-shot probe hits the live tenant
 * directly and prints the RAW JSON for:
 *   - GET /api/v2/tickets/{id}.json?include=slas   (the per-ticket SLA sideload)
 *   - GET /api/v2/slas/policies.json               (the policy matrix)
 *
 * It only prints the SLA-relevant keys (top-level key list + `slas` payload +
 * policies), never ticket subjects/bodies, so there is minimal PII to redact.
 *
 * Usage (same auth model as scripts/mcp-live.ts):
 *   ZENDESK_SUBDOMAIN=fruggr ZENDESK_OAUTH_TOKEN=<token> \
 *     pnpm tsx scripts/probe-sla-shape.ts <ticket_id>
 *
 * If you have already authenticated the server once (stdio OAuth flow), the
 * access token cached on disk for the subdomain is used automatically and
 * ZENDESK_OAUTH_TOKEN can be omitted.
 *
 * Paste the output into a PR comment so the maintainer can align the
 * TypeScript types, the `findSlaForTicket` correlation key and the MSW mock
 * (MOCK_SLA_SIDELOAD) to the real shape.
 */
import { zendeskGet } from '../src/client/zendesk-api';
import { loadConfig } from '../src/config';

const ticketId = process.argv[2];
if (!ticketId || !/^\d+$/.test(ticketId)) {
  console.error(
    'Usage: pnpm tsx scripts/probe-sla-shape.ts <ticket_id>\n' +
      '  ticket_id must be a numeric id of a ticket that is covered by an SLA policy.',
  );
  process.exit(1);
}

const config = loadConfig([]);
const { subdomain } = config;

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

  // Both `slas` and `metric_events` are documented single-ticket sideloads.
  // `slas` is the primary source (live countdown); `metric_events` is the
  // documented fallback (apply_sla / breach / update_status events).
  const ticket = await zendeskGet<Record<string, unknown>>(
    subdomain,
    token,
    `/tickets/${ticketId}`,
    { include: 'slas,metric_events' },
  );
  // Print only the structural ground truth, not the ticket body.
  dump('GET /tickets/{id}?include=slas,metric_events — top-level keys', Object.keys(ticket));
  dump('slas payload', ticket['slas'] ?? '(no "slas" key present)');
  dump(
    'metric_events payload (fallback)',
    ticket['metric_events'] ?? '(no "metric_events" key present)',
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
