#!/usr/bin/env tsx
/**
 * Read-only ground-truth probe for ticket metrics and SLA alerting (#122).
 *
 * The tools return formatted text, never raw Zendesk JSON, and the endpoints
 * this feature would rest on are thinly documented. This probe answers, from
 * the live tenant:
 *
 *   Q1. Search `include=tickets(slas)`: does live SLA come back for scope
 *       queries (assignee:me, group:..., all open)? How many results carry it?
 *       Which group scoping syntax does Search accept?
 *   Q2. Views: does `GET /views/{id}/execute` carry the "Next SLA breach"
 *       column (`sla_next_breach_at`) with a usable value? Where in the row?
 *       Does any other view endpoint honour an SLA sideload?
 *   Q3. Ticket metrics: the shape of `GET /tickets/{id}/metrics`, and whether
 *       the `metric_sets` sideload is honoured by Search and show_many (one
 *       call for a whole queue instead of one per ticket).
 *
 * GETs only. It prints keys, ids, stages, timestamps and numbers — never a
 * subject, description, comment or name — so the output can be pasted into a
 * PR comment as is.
 *
 * Usage (credentials resolved by `live-auth.ts`, never by the caller):
 *   pnpm tsx scripts/probe-sla-alerts-shape.ts [--view <id>] [--ticket <id>]
 */
import { zendeskGet } from '../src/client/zendesk-api';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

type Json = Record<string, unknown>;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value !== undefined && !/^\d+$/.test(value)) fail(`${name} takes a numeric id`);
  return value;
};

const cliViewId = flag('--view');
const cliTicketId = flag('--ticket');

const subdomain =
  resolveLiveSubdomain() ??
  fail('No subdomain: set ZENDESK_SUBDOMAIN, or run from a checkout whose .mcp.json declares one.');
const source = resolveLiveToken(subdomain) ?? fail(missingTokenHelp(subdomain));

const section = (title: string): void => console.log(`\n===== ${title} =====`);
const dump = (label: string, value: unknown): void =>
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);

// A probe step that fails is a finding, not a reason to stop the run.
const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    console.log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

const isSlaKey = (key: string): boolean => /sla|breach/i.test(key);

const main = async (): Promise<void> => {
  const token = await source.getToken();
  const get = (path: string, params?: Record<string, string>): Promise<Json> =>
    zendeskGet<Json>(subdomain, token, path, params);
  console.log(`Probing ${subdomain} with the ${source.origin}.`);

  section('Token identity');
  const me = await attempt('GET /users/me', () => get('/users/me'));
  const user = (me?.['user'] as Json | undefined) ?? {};
  dump('role', { id: user['id'], role: user['role'], role_type: user['role_type'] });

  section('Q1. Search include=tickets(slas) per scope query');
  const queries = [
    'type:ticket status<solved',
    'type:ticket status<solved assignee:me',
    'type:ticket status<solved group:me',
    'type:ticket status<solved assignee:none',
  ];
  const discovered: number[] = [];
  for (const query of queries) {
    const res = await attempt(query, () =>
      get('/search', { query, include: 'tickets(slas)', per_page: '100' }),
    );
    if (!res) continue;
    const results = (res['results'] as Json[] | undefined) ?? [];
    const withSla = results.filter(
      (r) => ((r['slas'] as Json | undefined)?.['policy_metrics'] as unknown[])?.length > 0,
    );
    for (const r of withSla) if (typeof r['id'] === 'number') discovered.push(r['id']);
    dump(query, {
      count: res['count'],
      returned: results.length,
      with_live_sla: withSla.length,
      sample: withSla.slice(0, 3).map((r) => ({ id: r['id'], slas: r['slas'] })),
    });
  }

  section('Q2. Views and the Next SLA breach column');
  const viewsRes = await attempt('GET /views?active=true', () => get('/views', { active: 'true' }));
  const views = (viewsRes?.['views'] as Json[] | undefined) ?? [];
  const columnIds = (v: Json): unknown[] =>
    (((v['execution'] as Json | undefined)?.['columns'] as Json[] | undefined) ?? []).map(
      (c) => c['id'],
    );
  const withSlaColumn = views.filter((v) => columnIds(v).some((id) => isSlaKey(String(id))));
  dump('active views', views.length);
  dump(
    'views whose columns mention sla/breach',
    withSlaColumn.map((v) => ({ id: v['id'], columns: columnIds(v) })),
  );
  const viewId = cliViewId ?? (withSlaColumn[0]?.['id'] as number | undefined)?.toString();
  if (!viewId) {
    console.log(
      'No view carries an SLA column and no --view was given: add the "Next SLA breach" ' +
        'column to a view in the Zendesk UI and re-run with --view <id>.',
    );
  } else {
    const exec = await attempt(`GET /views/${viewId}/execute`, () =>
      get(`/views/${viewId}/execute`, { 'page[size]': '5' }),
    );
    if (exec) {
      dump('execute top-level keys', Object.keys(exec));
      dump('execute columns', exec['columns']);
      const rows = (exec['rows'] as Json[] | undefined) ?? [];
      dump(
        'first rows (keys, ticket keys, sla/breach values)',
        rows.slice(0, 5).map((row) => ({
          keys: Object.keys(row),
          ticket_keys: Object.keys((row['ticket'] as Json | undefined) ?? {}),
          ticket_id: (row['ticket'] as Json | undefined)?.['id'],
          sla_values: Object.fromEntries(Object.entries(row).filter(([k]) => isSlaKey(k))),
          ticket_sla_values: Object.fromEntries(
            Object.entries((row['ticket'] as Json | undefined) ?? {}).filter(([k]) => isSlaKey(k)),
          ),
        })),
      );
    }
    const viewTickets = await attempt(`GET /views/${viewId}/tickets?include=slas`, () =>
      get(`/views/${viewId}/tickets`, { include: 'slas', per_page: '5' }),
    );
    if (viewTickets) {
      const tickets = (viewTickets['tickets'] as Json[] | undefined) ?? [];
      dump('/views/{id}/tickets?include=slas top-level keys', Object.keys(viewTickets));
      dump(
        'first tickets: slas key present?',
        tickets.slice(0, 5).map((t) => ({ id: t['id'], slas: t['slas'] ?? '(absent)' })),
      );
    }
  }

  section('Q3. Ticket metrics');
  const ticketId = cliTicketId ?? discovered[0]?.toString();
  if (!ticketId) {
    console.log('No SLA-covered ticket discovered and no --ticket given; skipping metrics.');
    return;
  }
  const metrics = await attempt(`GET /tickets/${ticketId}/metrics`, () =>
    get(`/tickets/${ticketId}/metrics`),
  );
  if (metrics) dump('ticket_metric', metrics['ticket_metric'] ?? metrics);

  const searchMetrics = await attempt('Search include=tickets(metric_sets)', () =>
    get('/search', {
      query: 'type:ticket status<solved',
      include: 'tickets(metric_sets)',
      per_page: '5',
    }),
  );
  if (searchMetrics) {
    const results = (searchMetrics['results'] as Json[] | undefined) ?? [];
    dump('Search metric_sets top-level keys', Object.keys(searchMetrics));
    dump(
      'Search metric_sets on first results',
      results
        .slice(0, 2)
        .map((r) => ({ id: r['id'], metric_set: r['metric_set'] ?? '(absent on result)' })),
    );
  }

  const many = await attempt('show_many include=metric_sets', () =>
    get('/tickets/show_many', { ids: ticketId, include: 'metric_sets' }),
  );
  if (many) {
    dump('show_many metric_sets top-level keys', Object.keys(many));
    dump('show_many metric_sets payload', many['metric_sets'] ?? '(no "metric_sets" key)');
  }
};

main()
  .catch((error) => {
    console.error('probe-sla-alerts-shape failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => source.dispose());
