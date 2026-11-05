#!/usr/bin/env tsx
/**
 * Read-only probe for #417: what happens to a ticket's organization when only
 * its requester changes.
 *
 *   Q1. When an audit changes `requester_id`, does the same audit change
 *       `organization_id`? If so, is the new organization the new requester's
 *       default one (`organization_memberships[].default`)?
 *
 * It answers from history already on the tenant (requester changes agents made
 * by hand), so nothing is written. Source: `GET /ticket_audits` (admins only),
 * newest first, or the audits of the tickets given with `--ticket`.
 *
 * GETs only. It prints ids, field names, channels and timestamps — never a
 * subject, a body or a name — so the output can be pasted into a PR comment.
 *
 * Usage (credentials resolved by `live-auth.ts`, never by the caller):
 *   pnpm tsx scripts/probe-requester-org.ts [--pages <n>] [--ticket <id>]...
 */
import { zendeskGet } from '../src/client/zendesk-api';
import type { ZendeskAudit, ZendeskListResponse } from '../src/types';
import { buildCursorParams, extractPaginationMeta } from '../src/utils/pagination';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const argValues = (flag: string): string[] =>
  process.argv.flatMap((arg, i) =>
    arg === flag && process.argv[i + 1] ? [process.argv[i + 1] as string] : [],
  );

const maxPages = Number(argValues('--pages')[0] ?? 20);
const tickets = argValues('--ticket').map(Number).filter(Number.isInteger);

const subdomain =
  resolveLiveSubdomain() ??
  fail('No subdomain: set ZENDESK_SUBDOMAIN, or run from a checkout whose .mcp.json declares one.');
const source = resolveLiveToken(subdomain) ?? fail(missingTokenHelp(subdomain));
const token = await source.getToken();

// A probe step that fails is a finding, not a reason to stop the run.
const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    console.log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

interface AuditPage {
  audits: ZendeskAudit[];
  before_cursor?: string | null;
  after_cursor?: string | null;
  [key: string]: unknown;
}

const audits: ZendeskAudit[] = [];

if (tickets.length > 0) {
  // A ticket's audits come oldest first, 100 a page: walk every page, or a
  // recent requester change on a long ticket would be missed.
  for (const id of tickets) {
    let cursor: string | undefined;
    do {
      const params = buildCursorParams(100, cursor);
      const page = await attempt(`GET /tickets/${id}/audits`, () =>
        zendeskGet<ZendeskListResponse<ZendeskAudit>>(
          subdomain,
          token,
          `/tickets/${id}/audits`,
          params,
        ),
      );
      const batch = page?.audits ?? [];
      audits.push(...batch);
      const meta = page ? extractPaginationMeta(page, batch.length) : undefined;
      cursor = meta?.has_more ? (meta.after_cursor ?? undefined) : undefined;
    } while (cursor);
  }
} else {
  // The order and cursor keys of this endpoint are themselves unverified: the
  // first page's keys are printed, and the walk follows before_cursor (older).
  let cursor: string | undefined;
  for (let n = 1; n <= maxPages; n++) {
    const params: Record<string, string> = { limit: '1000' };
    if (cursor) params['cursor'] = cursor;
    const page = await attempt(`GET /ticket_audits (page ${n})`, () =>
      zendeskGet<AuditPage>(subdomain, token, '/ticket_audits', params),
    );
    if (!page) break;
    if (n === 1) {
      const first = page.audits[0]?.created_at;
      const last = page.audits.at(-1)?.created_at;
      console.log(
        `page 1 keys: ${Object.keys(page)
          .sort((a, b) => a.localeCompare(b))
          .join(', ')}`,
      );
      console.log(`page 1 order: first=${first} last=${last}`);
    }
    audits.push(...page.audits);
    cursor = page.before_cursor ?? undefined;
    if (!cursor || page.audits.length === 0) break;
  }
}

const times = audits.map((a) => a.created_at).sort((a, b) => a.localeCompare(b));
const span = times.length ? `${times[0]} .. ${times.at(-1)}` : 'none';
console.log(`\naudits scanned: ${audits.length} (${span})`);

const changeOf = (audit: ZendeskAudit, field: string) =>
  audit.events.find((e) => e.type === 'Change' && e.field_name === field);

const requesterChanges = audits.filter((audit) => changeOf(audit, 'requester_id'));

interface Membership {
  organization_id: number;
  default: boolean | null;
}

console.log('\n===== Q1: organization on a requester change =====');
console.log(`audits changing requester_id: ${requesterChanges.length}`);

for (const audit of requesterChanges) {
  const req = changeOf(audit, 'requester_id');
  const org = changeOf(audit, 'organization_id');
  const newRequester = Number(req?.value);
  const memberships = await attempt(`GET /users/${newRequester}/organization_memberships`, () =>
    zendeskGet<{ organization_memberships: Membership[] }>(
      subdomain,
      token,
      `/users/${newRequester}/organization_memberships`,
    ),
  );
  const list = memberships?.organization_memberships ?? [];
  const defaultOrg = list.find((m) => m.default)?.organization_id ?? 'none';
  const otherFields = audit.events
    .filter((e) => e.type === 'Change' && e.field_name !== 'requester_id')
    .map((e) => e.field_name)
    .join(',');
  console.log(
    [
      `ticket ${audit.ticket_id} audit ${audit.id} ${audit.created_at} via=${audit.via?.channel ?? '?'}`,
      `  requester ${String(req?.previous_value)} -> ${String(req?.value)}`,
      org
        ? `  organization_id CHANGED ${String(org.previous_value)} -> ${String(org.value)} (new = new requester's default: ${String(org.value) === String(defaultOrg)})`
        : '  organization_id NOT changed in this audit',
      `  new requester memberships: ${list.length}, default org: ${defaultOrg}`,
      `  other changed fields in this audit: ${otherFields || 'none'}`,
    ].join('\n'),
  );
}

if (requesterChanges.length === 0) {
  console.log(
    'inconclusive: no requester change in the scanned audits. Re-run with --pages <n> or --ticket <id> on a ticket whose requester was changed.',
  );
}
source.dispose();
