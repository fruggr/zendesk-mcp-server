#!/usr/bin/env tsx
/**
 * Read-only ground-truth probe, second spike for SLA alerting (#122).
 *
 *   Q4. Group scoping in Search: is `group:me` understood? Does `group:<id>`
 *       match the tickets of that group? Do several `group:` terms OR or AND?
 *       Measured against a ground truth: the open tickets whose `group_id` is
 *       one of the caller's groups.
 *   Q5. HTTP caching on the endpoints an alert poller would hit: does Zendesk
 *       send ETag / Last-Modified / Cache-Control, is the ETag stable across
 *       two identical GETs, does a conditional GET answer 304, and does a 304
 *       still consume rate-limit quota?
 *
 * Q5 needs response headers and conditional request headers, which
 * `zendeskGet` does not expose, so this probe calls `fetch` itself — with the
 * token `live-auth.ts` resolved, never one the caller supplies. GETs only. It
 * prints ids, counts and header values, never subjects, bodies or names.
 *
 * Usage:
 *   pnpm tsx scripts/probe-sla-scope-cache.ts [--view <id>] [--ticket <id>]
 */
import { getBaseUrl } from '../src/constants';
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

const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    console.log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

// Caching and quota headers only: never Set-Cookie or anything echoing auth.
const REPORTED_HEADER =
  /^(etag|last-modified|cache-control|vary|expires|age|x-rate-limit.*|ratelimit.*|zendesk-ratelimit.*|retry-after|x-zendesk-api-version)$/i;

const reportedHeaders = (res: Response): Record<string, string> =>
  Object.fromEntries([...res.headers].filter(([name]) => REPORTED_HEADER.test(name)));

const main = async (): Promise<void> => {
  const token = await source.getToken();
  const base = getBaseUrl(subdomain);
  const url = (path: string, params: Record<string, string> = {}): string => {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const rawGet = (target: string, extra: Record<string, string> = {}): Promise<Response> =>
    fetch(target, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra },
    });
  const getJson = async (path: string, params?: Record<string, string>): Promise<Json> => {
    const res = await rawGet(url(path, params));
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return (await res.json()) as Json;
  };
  console.log(`Probing ${subdomain} with the ${source.origin}.`);

  section('Q4. Group scoping in Search');
  const me = ((await getJson('/users/me'))['user'] as Json | undefined) ?? {};
  const memberships =
    ((await attempt('group memberships', () => getJson(`/users/${me['id']}/group_memberships`)))?.[
      'group_memberships'
    ] as Json[] | undefined) ?? [];
  const myGroups = memberships.map((m) => Number(m['group_id']));
  dump('caller', { id: me['id'], role: me['role'], group_ids: myGroups });

  // Ground truth: every open ticket (Search caps at 1000 results, 10 pages).
  const open: Json[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await attempt(`open tickets page ${page}`, () =>
      getJson('/search', {
        query: 'type:ticket status<solved',
        per_page: '100',
        page: String(page),
      }),
    );
    const results = (res?.['results'] as Json[] | undefined) ?? [];
    open.push(...results);
    if (!res?.['next_page']) break;
  }
  const byGroup = new Map<number, number>();
  for (const t of open) {
    const g = Number(t['group_id']);
    byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
  }
  const inMyGroups = open.filter((t) => myGroups.includes(Number(t['group_id']))).length;
  dump('ground truth', {
    open_tickets: open.length,
    open_by_group_id: Object.fromEntries(byGroup),
    open_in_my_groups: inMyGroups,
  });

  const count = async (query: string): Promise<unknown> => {
    const res = await attempt(query, () => getJson('/search', { query, per_page: '1' }));
    return res?.['count'] ?? '(failed)';
  };
  const queries = [
    'type:ticket status<solved group:me',
    ...myGroups.map((g) => `type:ticket status<solved group:${g}`),
  ];
  if (myGroups.length >= 2) {
    queries.push(
      `type:ticket status<solved ${myGroups
        .slice(0, 2)
        .map((g) => `group:${g}`)
        .join(' ')}`,
    );
  }
  const otherGroup = [...byGroup.keys()].find((g) => !myGroups.includes(g) && g > 0);
  if (otherGroup !== undefined && myGroups[0] !== undefined) {
    queries.push(`type:ticket status<solved group:${myGroups[0]} group:${otherGroup}`);
  }
  for (const q of queries) dump(q, await count(q));

  section('Q5. HTTP caching per endpoint');
  const sampleTicket = cliTicketId ?? String(open[0]?.['id'] ?? '');
  const targets: [string, string][] = [
    [
      'search slas (assignee:me)',
      url('/search', { query: 'type:ticket status<solved assignee:me', include: 'tickets(slas)' }),
    ],
  ];
  if (cliViewId) {
    targets.push(['view tickets slas', url(`/views/${cliViewId}/tickets`, { include: 'slas' })]);
  }
  if (sampleTicket) {
    targets.push([
      'show_many metric_sets',
      url('/tickets/show_many', { ids: sampleTicket, include: 'metric_sets' }),
    ]);
    targets.push(['ticket metrics', url(`/tickets/${sampleTicket}/metrics`)]);
  }
  for (const [label, target] of targets) {
    const first = await attempt(`${label} #1`, () => rawGet(target));
    const second = await attempt(`${label} #2`, () => rawGet(target));
    if (!first || !second) continue;
    const etag = first.headers.get('etag');
    const lastModified = first.headers.get('last-modified');
    const conditional: Record<string, string> = {};
    if (etag) conditional['If-None-Match'] = etag;
    if (lastModified) conditional['If-Modified-Since'] = lastModified;
    const third =
      Object.keys(conditional).length > 0
        ? await attempt(`${label} conditional`, () => rawGet(target, conditional))
        : undefined;
    dump(label, {
      first: { status: first.status, headers: reportedHeaders(first) },
      second: { status: second.status, headers: reportedHeaders(second) },
      etag_stable: etag !== null && etag === second.headers.get('etag'),
      conditional_sent: conditional,
      conditional: third
        ? { status: third.status, headers: reportedHeaders(third) }
        : '(not sent: no ETag nor Last-Modified)',
    });
  }
};

main()
  .catch((error) => {
    console.error('probe-sla-scope-cache failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => source.dispose());
