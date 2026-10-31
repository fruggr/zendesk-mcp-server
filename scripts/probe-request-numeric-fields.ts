#!/usr/bin/env tsx
/**
 * Read-only probe for the numeric answers of `create_request` (#420).
 *
 * `create_request`'s `custom_fields[].value` says "text otherwise", while the
 * ticket tools say "text or a number otherwise". Whether an end user may send a
 * JSON number for a numeric question is unverified, and it only matters if a
 * form an end user can pick asks one:
 *
 *   Q1. Which active, end-user-visible forms carry an active, portal-visible
 *       custom field of type integer or decimal (form id, field id, type,
 *       required_in_portal)?
 *
 * Q2, what Zendesk does with a number versus a string from an end user, needs a
 * submission under an end-user sign-in; the functional validation plan of #420
 * carries it, with this probe's output as its input.
 *
 * GETs only. It prints ids, types and flags — never a title or a name — so the
 * output can be pasted into a PR comment as is.
 *
 * Usage (credentials resolved by `live-auth.ts`, never by the caller):
 *   pnpm tsx scripts/probe-request-numeric-fields.ts
 */
import { zendeskGet } from '../src/client/zendesk-api';
import type { ZendeskTicketField, ZendeskTicketForm } from '../src/types';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

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

const NUMERIC_TYPES = new Set(['integer', 'decimal']);

const forms = await attempt('GET /ticket_forms', () =>
  zendeskGet<{ ticket_forms: ZendeskTicketForm[]; next_page: string | null }>(
    subdomain,
    token,
    '/ticket_forms',
    { per_page: '100' },
  ),
);
const fields = await attempt('GET /ticket_fields', () =>
  zendeskGet<{ ticket_fields: ZendeskTicketField[]; next_page: string | null }>(
    subdomain,
    token,
    '/ticket_fields',
    { per_page: '100' },
  ),
);

// "none" is a finding only when both listings were read whole.
const complete =
  forms !== undefined && fields !== undefined && !forms.next_page && !fields.next_page;
if (!complete) {
  console.log('NOTE: a listing failed or has a further page this probe does not read.');
}

const numeric = new Map(
  (fields?.ticket_fields ?? [])
    .filter(
      (field) => field.active && field.visible_in_portal === true && NUMERIC_TYPES.has(field.type),
    )
    .map((field) => [field.id, field]),
);
const endUserForms = (forms?.ticket_forms ?? []).filter(
  (form) => form.active && form.end_user_visible,
);

console.log('\n===== Q1: numeric questions on end-user forms =====');
console.log(
  `forms visible to end users: ${endUserForms.length}; portal-visible numeric fields: ${numeric.size}`,
);
const rows = endUserForms.flatMap((form) =>
  form.ticket_field_ids.flatMap((id) => {
    const field = numeric.get(id);
    return field
      ? [
          `form ${form.id}${form.default ? ' (default)' : ''} -> field ${field.id} type=${field.type} required_in_portal=${field.required_in_portal === true}`,
        ]
      : [];
  }),
);
const verdict = complete
  ? 'none: no end-user form asks a numeric question'
  : 'inconclusive: the scan is incomplete, see the NOTE above';
console.log(rows.length ? rows.join('\n') : verdict);
source.dispose();
