#!/usr/bin/env tsx
/**
 * Read-only size probe for the ticket list tools (#388).
 *
 * search_tickets, list_tickets and get_view_tickets render each ticket with
 * `formatTicket` (header lines + full description) plus an SLA block, and the
 * whole response is cut at CHARACTER_LIMIT. Which part dominates decides the
 * fix, so this probe renders live tickets with the server's own formatters and
 * prints only character counts:
 *
 *   Q1. Per ticket: header / description / SLA block size, as min, median, p90, max.
 *   Q2. How many whole tickets a default page (100) fits before the limit.
 *   Q3. How often descriptions exceed 200 / 500 / 2000 chars.
 *
 * GETs only. It prints counts and ids — never a subject, description or name —
 * so the output can be pasted into a PR comment as is.
 *
 * Usage (credentials resolved by `live-auth.ts`, never by the caller):
 *   pnpm tsx scripts/probe-388-list-sizes.ts [--query "<search>"] [--view <id>]
 */
import { zendeskGet } from '../src/client/zendesk-api';
import { CHARACTER_LIMIT } from '../src/constants';
import type {
  ZendeskListResponse,
  ZendeskTicket,
  ZendeskView,
  ZendeskViewExecuteResponse,
} from '../src/types';
import {
  formatNextBreachBlock,
  formatSlaBlock,
  formatTicket,
  formatTicketSummary,
} from '../src/utils/formatting';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const cliQuery = flag('--query');
const query = cliQuery ?? 'status<solved';
const cliViewId = flag('--view');
if (cliViewId !== undefined && !/^\d+$/.test(cliViewId)) fail('--view takes a numeric id');

const subdomain =
  resolveLiveSubdomain() ??
  fail('No subdomain: set ZENDESK_SUBDOMAIN, or run from a checkout whose .mcp.json declares one.');
const source = resolveLiveToken(subdomain) ?? fail(missingTokenHelp(subdomain));

const section = (title: string): void => console.log(`\n===== ${title} =====`);

// A probe step that fails is a finding, not a reason to stop the run.
const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    console.log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

const stats = (values: number[]): Record<string, number> => {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    median: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? 0,
    mean: Math.round(sum / sorted.length),
    sum,
  };
};

// formatList joins items with a blank line after a pagination header; mirror it
// to count how many whole tickets land before the cut.
const wholeItemsThatFit = (blocks: string[], headerLength: number): number => {
  let used = headerLength;
  let fitted = 0;
  for (const block of blocks) {
    used += 2 + block.length;
    if (used > CHARACTER_LIMIT) break;
    fitted += 1;
  }
  return fitted;
};

const report = (label: string, tickets: ZendeskTicket[], extra: (t: ZendeskTicket) => string) => {
  const header = tickets.map((t) => formatTicket({ ...t, description: '' }).length);
  const description = tickets.map((t, i) => formatTicket(t).length - (header[i] ?? 0));
  const sla = tickets.map((t) => extra(t).length);
  const blocks = tickets.map((t) => formatTicket(t) + extra(t));
  const rawDescription = tickets.map((t) => (t.description ?? '').length);
  console.log(`${label}: ${tickets.length} tickets, CHARACTER_LIMIT ${CHARACTER_LIMIT}`);
  console.log('  header chars      ', JSON.stringify(stats(header)));
  console.log('  description chars ', JSON.stringify(stats(description)));
  console.log('  sla block chars   ', JSON.stringify(stats(sla)));
  console.log('  total per ticket  ', JSON.stringify(stats(blocks.map((b) => b.length))));
  console.log(
    '  descriptions over 200 / 500 / 2000 chars:',
    [200, 500, 2000].map((n) => rawDescription.filter((d) => d > n).length).join(' / '),
  );
  const summaries = tickets.map((t) => formatTicketSummary(t) + extra(t));
  console.log(
    `  whole tickets fitting the limit, full descriptions (pre-#388 baseline): ${wholeItemsThatFit(blocks, 40)} of ${tickets.length}`,
  );
  console.log(
    `  whole tickets fitting the limit, excerpts (current list rendering): ${wholeItemsThatFit(summaries, 40)} of ${tickets.length}`,
  );
  console.log(
    '  per-ticket sizes (id: header+description+sla):',
    tickets
      .slice(0, 100)
      .map((t, i) => `${t.id}:${header[i]}+${description[i]}+${sla[i]}`)
      .join(' '),
  );
};

const main = async (): Promise<void> => {
  const token = await source.getToken();
  console.log(`Probing ${subdomain} with the ${source.origin}.`);

  // The query can carry a name or an email, so it stays out of the pasteable output.
  section(
    `Q1-Q3. search_tickets (${cliQuery === undefined ? 'default query' : '--query value'}, per_page 100, include=tickets(slas))`,
  );
  const search = await attempt('GET /search', () =>
    zendeskGet<ZendeskListResponse<ZendeskTicket>>(subdomain, token, '/search', {
      query: `type:ticket ${query}`,
      include: 'tickets(slas)',
      per_page: '100',
    }),
  );
  if (search) {
    console.log(`count: ${search.count ?? '(absent)'}`);
    report('search_tickets', search.results ?? [], (t) => formatSlaBlock(t.slas));
    const metrics = (search.results ?? []).map((t) => t.slas?.policy_metrics?.length ?? 0);
    console.log('  sla metrics per ticket', JSON.stringify(stats(metrics)));
  }

  section('list_tickets (page[size] 100)');
  const list = await attempt('GET /tickets', () =>
    zendeskGet<ZendeskListResponse<ZendeskTicket>>(subdomain, token, '/tickets', {
      'page[size]': '100',
    }),
  );
  if (list) report('list_tickets', list.tickets ?? [], () => '');

  section('get_view_tickets (page[size] 100, up to 3 non-empty views)');
  const views = cliViewId
    ? [{ id: Number(cliViewId) }]
    : ((
        await attempt('GET /views?active=true', () =>
          zendeskGet<ZendeskListResponse<ZendeskView>>(subdomain, token, '/views', {
            active: 'true',
          }),
        )
      )?.views ?? []);
  let probed = 0;
  for (const view of views) {
    if (probed >= 3) break;
    const exec = await attempt(`GET /views/${view.id}/execute`, () =>
      zendeskGet<ZendeskViewExecuteResponse>(subdomain, token, `/views/${view.id}/execute`, {
        'page[size]': '100',
      }),
    );
    const rows = exec?.rows ?? [];
    if (rows.length === 0) continue;
    probed += 1;
    const ids = rows.map((r) => r.ticket?.id).filter((id): id is number => typeof id === 'number');
    const many = await attempt(`GET /tickets/show_many (view ${view.id})`, () =>
      zendeskGet<{ tickets: ZendeskTicket[] }>(subdomain, token, '/tickets/show_many', {
        ids: ids.join(','),
      }),
    );
    const breach = new Map(rows.map((r) => [r.ticket?.id, r.ticket?.sla_policy_metric]));
    report(`view ${view.id}`, many?.tickets ?? [], (t) => formatNextBreachBlock(breach.get(t.id)));
  }
  if (probed === 0) console.log('No non-empty active view found.');
};

main()
  .catch((error) => {
    console.error('probe-388-list-sizes failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => source.dispose());
