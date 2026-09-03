#!/usr/bin/env tsx
/**
 * READ-ONLY ground-truth capture for the end-user Requests surface (issue #48).
 *
 * Why this exists. `src/types.ts` declares `ZendeskTicketForm`,
 * `ZendeskFormCondition` and `ZendeskRequestCommentAuthor` from a written API
 * probe report rather than from payloads the implementer saw. The MCP tools
 * cannot close that gap: they return *rendered* text, never the raw upstream
 * JSON, so a field we named wrongly would render as a silently missing line
 * rather than as an error. This prints the raw keys so the types can be
 * checked against reality.
 *
 * It is strictly read-only: three GETs, no writes, no ticket created. It reuses
 * the token the running server already uses -- either ZENDESK_OAUTH_TOKEN, or
 * the cached token file for the subdomain.
 *
 * Usage:
 *   pnpm tsx scripts/probe-request-shapes.ts
 *
 * Output is deliberately keys-and-types, not values: no subject, no body, no
 * name, no email is printed, so it is safe to paste into a public PR comment.
 * The one exception is `end_user_conditions`, printed in full because its shape
 * is what we are least sure of and it contains only field ids and option
 * values.
 */
import { readFileSync } from 'node:fs';
import { resolveTokenPath } from '../src/auth/token-persistence';
import { zendeskGet } from '../src/client/zendesk-api';

const subdomain = process.env['ZENDESK_SUBDOMAIN'];
if (!subdomain) {
  console.error('Set ZENDESK_SUBDOMAIN (the same one the running server uses).');
  process.exit(1);
}

const readCachedToken = (): string | undefined => {
  try {
    const raw = readFileSync(resolveTokenPath(subdomain), 'utf8');
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed.access_token;
  } catch {
    return undefined;
  }
};

const token = process.env['ZENDESK_OAUTH_TOKEN'] ?? readCachedToken();
if (!token) {
  console.error(
    'No token found. Export ZENDESK_OAUTH_TOKEN, or sign in once through the ' +
      'running server so the token file is written. This script never starts an OAuth flow.',
  );
  process.exit(1);
}

const describeValue = (val: unknown): string => {
  if (val === null) return 'null';
  if (Array.isArray(val)) return `array[${val.length}]`;
  return typeof val;
};

/** Key → runtime type, so a missing or misnamed field is obvious. */
const shapeOf = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, describeValue(val)]),
  );
};

const section = (title: string): void => {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
};

const main = async (): Promise<void> => {
  section('1. GET /ticket_forms?active=true&end_user_visible=true&fallback_to_default=true');
  const forms = await zendeskGet<{ ticket_forms?: Record<string, unknown>[] }>(
    subdomain,
    token,
    '/ticket_forms',
    { active: 'true', end_user_visible: 'true', fallback_to_default: 'true' },
  );
  const formList = forms.ticket_forms ?? [];
  console.log(`forms returned: ${formList.length}`);
  console.log('keys on the first form:', shapeOf(formList[0]));
  // The one place we print values: ids and option values only, and it is the
  // shape src/types.ts is least sure of.
  for (const form of formList) {
    const conditions = form['end_user_conditions'];
    console.log(`form ${String(form['id'])}: end_user_conditions =`, JSON.stringify(conditions));
  }

  section('2. GET /ticket_fields (first page) — the portal flags');
  const fields = await zendeskGet<{
    ticket_fields?: Record<string, unknown>[];
    count?: number;
    next_page?: string | null;
  }>(subdomain, token, '/ticket_fields', { per_page: '100' });
  const fieldList = fields.ticket_fields ?? [];
  console.log(
    `fields returned: ${fieldList.length} | count says: ${String(fields.count)} | next_page: ${
      fields.next_page ? 'present' : 'null'
    }`,
  );
  console.log('keys on the first field:', shapeOf(fieldList[0]));
  const portalKeys = [
    'visible_in_portal',
    'required_in_portal',
    'editable_in_portal',
    'title_in_portal',
  ];
  for (const key of portalKeys) {
    const present = fieldList.filter((f) => key in f).length;
    console.log(`  ${key}: present on ${present}/${fieldList.length}`);
  }

  section('3. GET /requests/{id}/comments — the users sideload');
  const requests = await zendeskGet<{ requests?: Record<string, unknown>[] }>(
    subdomain,
    token,
    '/requests',
    { per_page: '1' },
  );
  const first = (requests.requests ?? [])[0];
  if (!first) {
    console.log('No request is visible to this token, so the sideload cannot be captured here.');
    console.log('Report this as a partial result rather than a failure.');
    return;
  }
  console.log('keys on a request:', shapeOf(first));
  const comments = await zendeskGet<{
    comments?: Record<string, unknown>[];
    users?: Record<string, unknown>[];
  }>(subdomain, token, `/requests/${String(first['id'])}/comments`);
  console.log(`comments: ${(comments.comments ?? []).length}`);
  console.log('keys on a comment:', shapeOf((comments.comments ?? [])[0]));
  console.log(
    'users sideload present:',
    comments.users !== undefined,
    '| keys on a sideloaded user:',
    shapeOf((comments.users ?? [])[0]),
  );
};

main().catch((error: unknown) => {
  console.error('Probe failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
