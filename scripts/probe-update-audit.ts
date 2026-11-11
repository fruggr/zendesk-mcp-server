#!/usr/bin/env tsx
/**
 * Probe for #417's follow-up: can update_ticket read an organization move from
 * the audit Zendesk returns with the update, instead of reading the ticket
 * before writing it?
 *
 *   Q1. Does `PUT /tickets/{id}` answer with an `audit` beside the `ticket`?
 *       Which keys does it carry, and for the field the update changed, which
 *       event `type` (the docs' example shows `Create`, stored audits show
 *       `Change`) with which keys (`field_name`, `value`, `previous_value`)?
 *   Q2. Is that audit the one stored on the ticket: same id, and the same
 *       events as `GET /tickets/{id}/audits/{audit_id}`? If so, the #432 spike
 *       (a requester change and its organization move land in one stored audit)
 *       carries over to the update response.
 *
 * The only probe here that writes, and only to a ticket the caller names with
 * `--ticket` and `--confirm-write`: it adds one tag, then puts the original tag
 * list back, and checks the restore. Nothing else on the ticket is sent.
 *
 * It prints keys, ids, event types and field names, never a subject, a body, a
 * name or the ticket's own tags.
 *
 * Usage (credentials resolved by `live-auth.ts`, never by the caller):
 *   pnpm tsx scripts/probe-update-audit.ts --ticket <id> --confirm-write
 */
import { zendeskGet, zendeskPut } from '../src/client/zendesk-api';
import type { ZendeskAudit, ZendeskAuditEvent, ZendeskTicket } from '../src/types';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

const PROBE_TAG = 'probe_update_audit';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const ticketId = Number(argValue('--ticket'));
if (!Number.isInteger(ticketId) || ticketId <= 0) {
  fail('Pass the test ticket to write to: --ticket <id>.');
}
if (!process.argv.includes('--confirm-write')) {
  fail(
    `This probe writes to ticket ${ticketId} (adds the tag "${PROBE_TAG}", then restores the tags). Re-run with --confirm-write.`,
  );
}

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

type UpdateResponse = { ticket?: ZendeskTicket; audit?: ZendeskAudit } & Record<string, unknown>;

const keysOf = (value: unknown): string =>
  value && typeof value === 'object'
    ? Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .join(', ')
    : String(value);

const describeEvent = (e: ZendeskAuditEvent): string =>
  `type=${e.type} field_name=${e.field_name ?? '-'} keys=[${keysOf(e)}]`;

// Tag events hold tag lists; only the probe tag is named, the ticket's own
// tags are reduced to a count.
const tagDelta = (e: ZendeskAuditEvent): string => {
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const now = list(e.value);
  const before = list(e.previous_value);
  return `value has ${PROBE_TAG}: ${now.includes(PROBE_TAG)} (${now.length} tags), previous_value has ${PROBE_TAG}: ${before.includes(PROBE_TAG)} (${before.length} tags)`;
};

const report = async (step: string, response: UpdateResponse | undefined): Promise<void> => {
  console.log(`\n===== ${step} =====`);
  if (!response) return;
  console.log(`response keys: ${keysOf(response)}`);
  const audit = response.audit;
  if (!audit) {
    console.log('Q1: no `audit` in the response');
    return;
  }
  console.log(`Q1: audit keys: ${keysOf(audit)}`);
  console.log(
    `Q1: audit id=${audit.id} ticket_id=${audit.ticket_id} via=${audit.via?.channel ?? '?'}`,
  );
  for (const e of audit.events ?? []) {
    console.log(
      `Q1: event ${describeEvent(e)}${e.field_name === 'tags' ? ` | ${tagDelta(e)}` : ''}`,
    );
  }

  const stored = await attempt(`GET /tickets/${ticketId}/audits/${audit.id}`, () =>
    zendeskGet<{ audit: ZendeskAudit }>(
      subdomain,
      token,
      `/tickets/${ticketId}/audits/${audit.id}`,
    ),
  );
  if (!stored) return;
  const shape = (events: ZendeskAuditEvent[] = []) =>
    JSON.stringify(
      events.map((e) => ({
        id: e.id,
        type: e.type,
        field_name: e.field_name,
        value: e.value,
        previous_value: e.previous_value,
      })),
    );
  console.log(`Q2: stored audit id matches: ${stored.audit.id === audit.id}`);
  console.log(
    `Q2: stored events: ${stored.audit.events.length}, response events: ${audit.events?.length ?? 0}`,
  );
  console.log(
    `Q2: same events (id, type, field_name, value, previous_value): ${shape(stored.audit.events) === shape(audit.events)}`,
  );
  for (const e of stored.audit.events) console.log(`Q2: stored event ${describeEvent(e)}`);
};

const before = await attempt(`GET /tickets/${ticketId}`, () =>
  zendeskGet<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticketId}`),
);
if (!before) {
  source.dispose();
  fail('Cannot read the ticket; nothing was written.');
}
const originalTags = before?.ticket.tags ?? [];
if (originalTags.includes(PROBE_TAG)) {
  source.dispose();
  fail(
    `Ticket ${ticketId} already carries "${PROBE_TAG}"; nothing was written. Remove it or pick another ticket.`,
  );
}
console.log(`ticket ${ticketId}: ${originalTags.length} tags before the probe`);

const added = await attempt(`PUT /tickets/${ticketId} (add tag)`, () =>
  zendeskPut<UpdateResponse>(subdomain, token, `/tickets/${ticketId}`, {
    ticket: { tags: [...originalTags, PROBE_TAG] },
  }),
);
await report('Update 1: add the probe tag', added);

const restored = await attempt(`PUT /tickets/${ticketId} (restore tags)`, () =>
  zendeskPut<UpdateResponse>(subdomain, token, `/tickets/${ticketId}`, {
    ticket: { tags: originalTags },
  }),
);
await report('Update 2: restore the original tags', restored);

const after = await attempt(`GET /tickets/${ticketId} (after)`, () =>
  zendeskGet<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticketId}`),
);
const same = (a: string[], b: string[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x.localeCompare(y)).join('\n') ===
    [...b].sort((x, y) => x.localeCompare(y)).join('\n');
console.log(
  `\nrestore check: tags back to the original set: ${after ? same(after.ticket.tags, originalTags) : 'unknown (read failed)'}`,
);
if (!after || !same(after.ticket.tags, originalTags)) {
  console.log(`ACTION NEEDED: remove the tag "${PROBE_TAG}" from ticket ${ticketId} by hand.`);
}
source.dispose();
