import * as z from 'zod/v4';
import {
  fetchZendeskBinary,
  ZendeskApiError,
  zendeskGet,
  zendeskPost,
  zendeskPut,
} from '../client/zendesk-api';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TICKET_COMMENT_PAGE_SIZE,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMENT_PAGES,
  MAX_EMBEDDED_IMAGE_COUNT,
  MAX_PAGE_SIZE,
} from '../constants';
import type {
  PaginationMeta,
  ZendeskAudit,
  ZendeskComment,
  ZendeskGroup,
  ZendeskListResponse,
  ZendeskMacro,
  ZendeskMacroApplyComment,
  ZendeskMacroApplyResult,
  ZendeskSlaPolicy,
  ZendeskSlaSideloadEntry,
  ZendeskTicket,
  ZendeskTicketAttachment,
  ZendeskTicketField,
  ZendeskUser,
  ZendeskView,
  ZendeskViewCount,
  ZendeskViewCountManyResponse,
  ZendeskViewExecuteResponse,
  ZendeskViewExecuteRow,
} from '../types';
import {
  AUDIT_ENTITY_FIELDS,
  type AuditNames,
  formatAudit,
  formatComment,
  formatFieldValue,
  formatList,
  formatMacro,
  formatPagination,
  formatSlaBlock,
  formatSlaPolicy,
  formatTagDiff,
  formatTicket,
  formatTicketField,
  formatView,
  truncateIfNeeded,
} from '../utils/formatting';
import {
  buildCursorParams,
  buildOffsetParams,
  extractOffsetPaginationMeta,
  extractPaginationMeta,
  extractSearchPaginationMeta,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import {
  type AttachmentInput,
  attachmentSchema,
  formatAttachmentSuffix,
  uploadAttachments,
} from './attachments';
import type { ToolContext, ToolDefinition, ToolImageContent, ToolTextContent } from './definitions';

// The per-image cap in MB, for the skip message. Derived once: both operands
// are module constants.
const MAX_ATTACHMENT_MB = Number.parseFloat((MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(2));

const formatReference = (attachment: ZendeskTicketAttachment): string =>
  `**${attachment.file_name}** (id ${attachment.id}, ${attachment.content_type}, ${attachment.size} bytes) — ${attachment.content_url}`;

const buildEmbeddedImageBlocks = async (
  subdomain: string,
  token: string,
  attachment: ZendeskTicketAttachment,
  reference: string,
): Promise<Array<ToolTextContent | ToolImageContent>> => {
  const { data, contentType } = await fetchZendeskBinary(subdomain, token, attachment.content_url);
  return [
    { type: 'image', data: data.toString('base64'), mimeType: contentType },
    { type: 'text', text: reference },
  ];
};

// Zendesk has no endpoint to list a ticket's attachments directly.
// Attachments are always attached to comments, so the only way to collect
// them all is to walk through every comment page and extract their attachments.
const fetchAllTicketComments = async (
  subdomain: string,
  token: string,
  ticketId: number,
): Promise<ZendeskComment[]> => {
  const all: ZendeskComment[] = [];
  let cursor: string | undefined;
  let pages = 0;
  while (pages < MAX_COMMENT_PAGES) {
    const response = await zendeskGet<{
      comments: ZendeskComment[];
      meta?: { has_more: boolean; after_cursor: string };
    }>(subdomain, token, `/tickets/${ticketId}/comments`, {
      ...buildCursorParams(MAX_PAGE_SIZE, cursor),
      include_inline_images: 'true',
    });
    all.push(...response.comments);
    pages += 1;
    if (!response.meta?.has_more || !response.meta?.after_cursor) break;
    cursor = response.meta.after_cursor;
  }
  return all;
};

// The pagination fields of a comments page, narrowed out of the response: the
// whole object cannot be passed as ZendeskListResponse<ZendeskComment>, whose
// `users?: T[]` would clash with the side-load (see TicketCommentsResponse).
// `next_page` is deliberately NOT forwarded: extractPaginationMeta would raise
// `has_more` from it while leaving `after_cursor` null, and the footer would
// then offer "More available (cursor: null)" — a continuation this cursor-only
// tool cannot follow. offsetPageNote reports that case in words instead.
const commentPageMeta = (response: TicketCommentsResponse, itemCount: number): PaginationMeta =>
  extractPaginationMeta<ZendeskComment>(
    {
      ...(response.meta && { meta: response.meta }),
      ...(response.count !== undefined && { count: response.count }),
    },
    itemCount,
  );

// Zendesk documents cursor pagination on this endpoint, so this is a defensive
// path. If it ever answered offset-style, `next_page` says more comments exist
// while no cursor comes with them — and this tool sends and accepts only a
// cursor. Nothing it exposes reaches those comments: `page_size` goes out as
// `page[size]`, which an offset response has already ignored, and
// get_ticket(include_comments=true) sends no paging at all, so it lands on the
// same default page. Naming either would be advice that cannot work — the defect
// this whole change is about (#265) — so the note says plainly that the
// continuation is out of reach here and points at the one place that is not.
const offsetPageNote = (response: TicketCommentsResponse): string =>
  response.meta?.after_cursor == null && response.next_page != null
    ? '\n\n> ⚠ Zendesk paginated this response by offset rather than by cursor, so more comments exist beyond this page and no cursor leads to them. This tool pages by cursor only, and no parameter it accepts reaches the rest: read the remaining comments in Zendesk directly.'
    : '';

// How the page actually came back, read off the data rather than off what was
// asked for — a header that describes the wrong end is worse than none, and the
// truncation cut always lands on the trailing end (#265). Equal timestamps say
// nothing about the order (a one-comment page, or several posted within the same
// second), so those fall back to what was requested rather than guessing.
const commentPageOrder = (
  comments: ZendeskComment[],
  sortOrder: 'asc' | 'desc',
): 'newest first' | 'oldest first' => {
  const first = comments[0]?.created_at ?? '';
  const last = comments.at(-1)?.created_at ?? '';
  const newestFirst = first === last ? sortOrder === 'desc' : first > last;
  return newestFirst ? 'newest first' : 'oldest first';
};

// Fetch specific attachments by id. A 404 is swallowed: attachment ids come
// from an earlier listing the caller may have been holding for a while, and one
// stale id should drop out rather than fail the whole request. Any other error
// still propagates.
const fetchAttachmentsByIds = async (
  subdomain: string,
  token: string,
  ids: number[],
): Promise<ZendeskTicketAttachment[]> => {
  const attachments: ZendeskTicketAttachment[] = [];
  for (const id of ids) {
    try {
      const { attachment } = await zendeskGet<{ attachment: ZendeskTicketAttachment }>(
        subdomain,
        token,
        `/attachments/${id}`,
      );
      attachments.push(attachment);
    } catch (error) {
      if (!(error instanceof ZendeskApiError) || error.status !== 404) throw error;
    }
  }
  return attachments;
};

const collectAttachmentBlocks = async (
  subdomain: string,
  token: string,
  attachments: ZendeskTicketAttachment[],
): Promise<Array<ToolTextContent | ToolImageContent>> => {
  const blocks: Array<ToolTextContent | ToolImageContent> = [];
  let embeddedCount = 0;

  for (const attachment of attachments) {
    const reference = formatReference(attachment);
    const isImage = attachment.content_type.startsWith('image/');

    if (!isImage) {
      blocks.push({ type: 'text', text: reference });
      continue;
    }

    let skipReason: string | null = null;
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      skipReason = `skipped: exceeds ${MAX_ATTACHMENT_MB} MB per-image limit`;
    } else if (embeddedCount >= MAX_EMBEDDED_IMAGE_COUNT) {
      skipReason = `skipped: max ${MAX_EMBEDDED_IMAGE_COUNT} embedded images reached`;
    }

    if (skipReason) {
      blocks.push({ type: 'text', text: `${reference} — ${skipReason}` });
      continue;
    }

    try {
      blocks.push(...(await buildEmbeddedImageBlocks(subdomain, token, attachment, reference)));
      embeddedCount += 1;
    } catch (error) {
      const reason =
        error instanceof ZendeskApiError
          ? `download failed: ${error.status} ${error.statusText}`
          : 'download failed';
      blocks.push({ type: 'text', text: `${reference} — ${reason}` });
    }
  }

  return blocks;
};

// Correlate a top-level `slas` sideload back to a single ticket. Prefers an
// explicit ticket_id match; falls back to a lone entry without a ticket_id
// (the get_ticket case, where the sideload describes the one fetched ticket).
// get_ticket has no direct SLA source — Zendesk silently ignores the `slas`
// sideload on both Show Ticket and Show Many (#92). The only endpoint that
// returns live SLA is Search, so resolve a single ticket's SLA via a tightly
// scoped Search — its own requester, within a +/-1 day window around its
// creation day (the window absorbs account-timezone skew in search dates) — and
// correlate the result back by exact id. Best-effort by design: returns
// undefined (never mis-attributed data) when the ticket falls outside the
// result window (very high-volume requester) or Search is briefly unavailable
// / not yet indexed.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const fetchTicketSla = async (
  subdomain: string,
  token: string,
  ticket: ZendeskTicket,
): Promise<ZendeskSlaSideloadEntry | undefined> => {
  const day = ticket.created_at.slice(0, 10);
  if (!ISO_DAY.test(day)) return undefined;
  const shiftDay = (offset: number): string => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  try {
    const { results } = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(
      subdomain,
      token,
      '/search',
      {
        query: `type:ticket requester:${ticket.requester_id} created>${shiftDay(-1)} created<${shiftDay(1)}`,
        include: 'tickets(slas)',
        ...buildOffsetParams(MAX_PAGE_SIZE, 1),
      },
    );
    return (results ?? []).find((r) => r.id === ticket.id)?.slas;
  } catch {
    // SLA is supplementary — never fail get_ticket because the lookup faltered.
    return undefined;
  }
};

// count_many accepts at most 20 view ids per request; larger listings are
// chunked. Kept low deliberately — Zendesk rate-limits this endpoint tightly.
const VIEW_COUNT_BATCH = 20;

const chunk = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
};

// Fetch cached ticket counts for a page of views, best-effort. count_many is
// batched (<=20 ids) and heavily rate-limited, so a failed batch degrades to
// "no count" for those views rather than failing the whole listing.
const fetchViewCounts = async (
  subdomain: string,
  token: string,
  viewIds: number[],
): Promise<Map<number, ZendeskViewCount>> => {
  const counts = new Map<number, ZendeskViewCount>();
  for (const group of chunk(viewIds, VIEW_COUNT_BATCH)) {
    try {
      const { view_counts } = await zendeskGet<ZendeskViewCountManyResponse>(
        subdomain,
        token,
        '/views/count_many',
        { ids: group.join(',') },
      );
      for (const c of view_counts ?? []) counts.set(c.view_id, c);
    } catch {
      // Best-effort: leave these views without a count rather than failing.
    }
  }
  return counts;
};

// Resolve a view reference to an id. A numeric reference is used as-is; a string
// is always treated as a title (even an all-digits one — the numeric-id path is
// `typeof view === 'number'` only) and matched case-insensitively against the
// agent's active views. The active-views list is cursor-paginated to completion
// so a title on a later page still resolves; on no match the full set of
// available titles is returned so the caller can self-correct.
const resolveViewId = async (
  subdomain: string,
  token: string,
  view: string | number,
): Promise<{ id: number } | { available: string[] }> => {
  if (typeof view === 'number') return { id: view };
  const target = view.trim().toLowerCase();
  const available: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await zendeskGet<ZendeskListResponse<ZendeskView>>(
      subdomain,
      token,
      '/views',
      {
        active: 'true',
        ...buildCursorParams(MAX_PAGE_SIZE, cursor),
      },
    );
    const views = response.views ?? [];
    const match = views.find((v) => v.title.trim().toLowerCase() === target);
    if (match) return { id: match.id };
    available.push(...views.map((v) => v.title));
    cursor = response.meta?.has_more ? (response.meta.after_cursor ?? undefined) : undefined;
  } while (cursor);
  return { available };
};

// Read the ticket id off an execute row. The row's `ticket` object is partial but
// carries the id; fall back to an inlined id/ticket_id column just in case.
const extractRowTicketId = (row: ZendeskViewExecuteRow): number | undefined => {
  if (typeof row.ticket?.id === 'number') return row.ticket.id;
  for (const key of ['id', 'ticket_id']) {
    if (typeof row[key] === 'number') return row[key] as number;
  }
  return undefined;
};

// Execute a view (its own column set + configured sort) and return the ordered
// rows plus pagination meta. sort_by/sort_order override the view's sort.
const executeView = async (
  subdomain: string,
  token: string,
  viewId: number,
  opts: {
    sort_by?: string | undefined;
    sort_order?: string | undefined;
    page_size: number;
    cursor?: string | undefined;
  },
): Promise<{ rows: ZendeskViewExecuteRow[]; meta: PaginationMeta }> => {
  const params = buildCursorParams(opts.page_size, opts.cursor);
  if (opts.sort_by) params['sort_by'] = opts.sort_by;
  if (opts.sort_order) params['sort_order'] = opts.sort_order;
  const response = await zendeskGet<ZendeskViewExecuteResponse>(
    subdomain,
    token,
    `/views/${viewId}/execute`,
    params,
  );
  const rows = response.rows ?? [];
  return { rows, meta: extractPaginationMeta(response, rows.length) };
};

// Hydrate full tickets for the view-ordered ids and restore that order (show_many
// returns tickets in id order, not the requested order). /execute yields only
// partial tickets, so full, consistent detail comes from here — one batched call.
const hydrateViewTickets = async (
  subdomain: string,
  token: string,
  ids: number[],
): Promise<ZendeskTicket[]> => {
  if (ids.length === 0) return [];
  const { tickets } = await zendeskGet<{ tickets: ZendeskTicket[] }>(
    subdomain,
    token,
    '/tickets/show_many',
    { ids: ids.join(',') },
  );
  const byId = new Map((tickets ?? []).map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id)).filter((t): t is ZendeskTicket => t !== undefined);
};

// Collect the user and group ids referenced across a page of audits so their
// names can be resolved in one batched call each: users = every audit author plus
// assignee/requester/submitter change values; groups = group_id change values.
// Audit values arrive as unknown (string or number depending on the field), and
// 0 / null / "" all mean "unset". Only real positive ids are worth resolving.
const addPositiveId = (set: Set<number>, raw: unknown): void => {
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) set.add(n);
};

// A Change/Create event on a name-bearing field contributes its old and new
// values to the matching id set. Every other event contributes nothing.
const collectEventIds = (
  event: ZendeskAudit['events'][number],
  userIds: Set<number>,
  groupIds: Set<number>,
): void => {
  if (event.type !== 'Change' && event.type !== 'Create') return;
  const entity = event.field_name ? AUDIT_ENTITY_FIELDS[event.field_name] : undefined;
  if (!entity) return;
  const set = entity === 'user' ? userIds : groupIds;
  addPositiveId(set, event.value);
  addPositiveId(set, event.previous_value);
};

const collectAuditIds = (audits: ZendeskAudit[]): { userIds: number[]; groupIds: number[] } => {
  const userIds = new Set<number>();
  const groupIds = new Set<number>();
  for (const audit of audits) {
    addPositiveId(userIds, audit.author_id);
    for (const event of audit.events) collectEventIds(event, userIds, groupIds);
  }
  return { userIds: [...userIds], groupIds: [...groupIds] };
};

// Resolve one entity kind to an id->name map via batched show_many look-ups
// (chunked to the 100-id endpoint cap). Best-effort: a failed batch leaves those
// ids unresolved (rendered as bare ids) rather than failing the whole response —
// names are supplementary.
const resolveEntityNames = async <T extends { id: number; name: string }>(
  subdomain: string,
  token: string,
  path: string,
  key: 'users' | 'groups',
  ids: number[],
): Promise<Map<number, string>> => {
  const map = new Map<number, string>();
  for (const batch of chunk(ids, 100)) {
    try {
      const res = await zendeskGet<Record<string, T[]>>(subdomain, token, path, {
        ids: batch.join(','),
      });
      for (const entity of res[key] ?? []) map.set(entity.id, entity.name);
    } catch {
      // Best-effort: leave these ids unresolved.
    }
  }
  return map;
};

const resolveUserNames = (
  subdomain: string,
  token: string,
  ids: number[],
): Promise<Map<number, string>> =>
  resolveEntityNames<ZendeskUser>(subdomain, token, '/users/show_many', 'users', ids);

// The user and group names a rendered audit timeline needs, resolved together.
const resolveAuditNames = async (
  subdomain: string,
  token: string,
  userIds: number[],
  groupIds: number[],
): Promise<AuditNames> => {
  // The two look-ups hit independent endpoints — run them concurrently.
  const [users, groups] = await Promise.all([
    resolveUserNames(subdomain, token, userIds),
    resolveEntityNames<ZendeskGroup>(subdomain, token, '/groups/show_many', 'groups', groupIds),
  ]);
  return { users, groups };
};

// The List Comments response. Deliberately *not* ZendeskListResponse<ZendeskComment>:
// that generic declares `users?: T[]`, which would silently type the `include=users`
// side-load as an array of comments.
interface TicketCommentsResponse {
  comments?: ZendeskComment[];
  users?: ZendeskUser[];
  meta?: { has_more: boolean; after_cursor: string };
  count?: number;
  // Present only if Zendesk answers this endpoint with offset pagination
  // (ignoring `page[size]`). Forwarded so extractPaginationMeta's `next_page`
  // fallback still fires and a further page is never reported as "none left".
  next_page?: string | null;
}

// Resolve the authors of a comment page to display names. The `include=users`
// side-load is documented for email CCs, so it is treated as an optimisation
// rather than the mechanism: whatever it returns is used as-is, and the author
// ids it left out cost one batched show_many. The system actor (-1) has no user
// record and is labelled by the formatter, so it is never looked up.
const resolveCommentAuthors = async (
  subdomain: string,
  token: string,
  comments: ZendeskComment[],
  sideloaded: ZendeskUser[] = [],
): Promise<Map<number, string>> => {
  const authors = new Map(sideloaded.map((user) => [user.id, user.name]));
  const missing = [...new Set(comments.map((comment) => comment.author_id))].filter(
    (id) => id > 0 && !authors.has(id),
  );
  if (missing.length === 0) return authors;
  for (const [id, name] of await resolveUserNames(subdomain, token, missing)) {
    authors.set(id, name);
  }
  return authors;
};

// Keys the generic field diff must not emit. Two reasons, both in this set:
//   - `comment`/`fields`/`custom_fields` are routed to their own render paths, so
//     the scalar loop skips them regardless of whether they changed.
//   - `updated_at`/`generated_timestamp`/`encoded_id` are server-recomputed, so a
//     no-op preview can bump them and they'd surface as spurious changes.
// `id`/`url`/`created_at` are byte-identical across the two fetches and already
// drop out via the diff; they're listed as belt-and-suspenders. Erring toward
// over-suppression is the safe direction for a preview that precedes a real write.
const DIFF_SKIP_KEYS = new Set([
  'comment',
  'fields',
  'custom_fields',
  'id',
  'url',
  'created_at',
  'updated_at',
  'generated_timestamp',
  'encoded_id',
]);

// Value equality that also handles arrays/objects (tags, `via`, …) by structure
// rather than reference, so unchanged nested fields drop out of the diff.
const valuesEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

// Render a value for the diff, marking an absent/empty side so a `→` line never
// reads as "(blank) → x".
const shownValue = (v: unknown): string => {
  const s = formatFieldValue(v);
  return s === '' ? '(empty)' : s;
};

// A single `label: before → after` change line, or null when the two sides
// render identically. The null case also drops a field the apply response
// returns as `null` where the current ticket omits the key: both render as
// "(empty)", so it is a no-op and must not appear as a change.
const diffLine = (label: string, before: unknown, after: unknown): string | null => {
  const b = shownValue(before);
  const a = shownValue(after);
  return b === a ? null : `- **${label}**: ${b} → ${a}`;
};

// Both diff passes walk Zendesk payloads as bags of unknown values; the domain
// types describe the fields we care about, not the full API shape.
const asRecord = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

// Standard (non-custom) fields that the macro actually changed. Identity fields
// and anything unchanged drop out.
const diffStandardFields = (
  before: ZendeskTicket | undefined,
  after: ZendeskMacroApplyResult['ticket'],
): string[] => {
  const beforeObj = asRecord(before);
  const changes: string[] = [];
  for (const [key, afterVal] of Object.entries(asRecord(after))) {
    if (DIFF_SKIP_KEYS.has(key)) continue;
    const beforeVal = beforeObj[key];
    if (valuesEqual(beforeVal, afterVal)) continue;
    if (key === 'tags') {
      const tagLine = formatTagDiff(beforeVal, afterVal);
      if (tagLine) changes.push(tagLine);
      continue;
    }
    // No macro-settable standard field is a nested object; via /
    // satisfaction_rating and the like only differ incidentally between the two
    // reads, so skip them rather than dumping raw JSON.
    if (afterVal !== null && typeof afterVal === 'object' && !Array.isArray(afterVal)) continue;
    const line = diffLine(key, beforeVal, afterVal);
    if (line) changes.push(line);
  }
  return changes;
};

// Custom fields diff by id: the apply response carries every custom field, so
// compare each against the ticket's current value and keep only what changed.
const diffCustomFields = (
  before: ZendeskTicket | undefined,
  after: ZendeskMacroApplyResult['ticket'],
): string[] => {
  const afterFields = [after?.fields ?? after?.custom_fields ?? []].flat();
  const beforeById = new Map((before?.custom_fields ?? []).map((f) => [f.id, f.value] as const));
  const changes: string[] = [];
  for (const f of afterFields) {
    const line = diffLine(`custom field ${f.id}`, beforeById.get(f.id), f.value);
    if (line) changes.push(line);
  }
  return changes;
};

// Preview a macro's effect on a ticket as a real before → after diff. The apply
// endpoint returns the WHOLE resulting ticket (not just the macro's changes), so
// diffing it against the ticket's current state is what isolates the macro's
// actual effect; everything unchanged (identity fields, untouched custom fields)
// drops out. The apply endpoint mutates nothing, so the text ends by pointing at
// the write tools that persist the change — the deliberate two-step from #120.
const formatMacroPreviewDiff = (
  ticketId: number,
  macroId: number,
  before: ZendeskTicket | undefined,
  result: ZendeskMacroApplyResult | undefined,
): string => {
  // Guard the whole path so a malformed body degrades to a clean "no changes"
  // instead of a cryptic "cannot read properties of undefined" tool error.
  const after = result?.ticket ?? {};
  const comment: ZendeskMacroApplyComment | undefined = after.comment ?? result?.comment;

  const changes = [...diffStandardFields(before, after), ...diffCustomFields(before, after)];

  const lines = [
    `# Macro #${macroId} preview on ticket #${ticketId} (diff — nothing saved yet)`,
    '',
    '## Field changes',
    ...(changes.length > 0 ? changes : ['- none']),
  ];

  if (comment?.body) {
    const visibility = comment.public === false ? 'internal note' : 'public comment';
    lines.push('', `## Reply (${visibility})`, '', comment.body);
  } else {
    lines.push('', '## Reply', '- none');
  }

  lines.push(
    '',
    '## To apply these changes',
    'Nothing has been committed. Persist the field changes with `update_ticket` (or `manage_tags` for incremental tag edits), and post the reply with `add_public_comment` (public) or `add_private_note` (internal). Edit the reply text first if needed.',
  );

  return lines.join('\n');
};

export const createTicketTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'get_ticket',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket',
      description:
        'Retrieve a Zendesk ticket by ID, including its live SLA state (per-metric stage and breach countdown) when an SLA policy applies, plus its comments if requested. Returns ticket details (subject, status, priority, assignee, tags, description) and optionally all comments/internal notes. The per-ticket Show endpoint exposes no SLA, so the SLA block is resolved via a scoped search and may be absent for a very high-volume requester or a just-updated ticket; SLA targets and policy conditions live in list_sla_policies. This returns the ticket as it stands now; for the history of changes behind that state (who changed what, and when), use get_ticket_history. The comment thread is appended in one block — the first page of comments Zendesk returns, cut past the response character limit — so on a long ticket read it with list_ticket_comments, which pages the comments and returns the newest first.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket to fetch. Obtain it from search_tickets or list_tickets.',
          ),
        include_comments: z
          .boolean()
          .default(false)
          .describe(
            "When true, appends the full public comment and internal note thread to the response. Defaults to false to keep the payload small; enable it when you need the conversation, not just the ticket fields. On a long thread prefer list_ticket_comments — this flag appends one unpaginated block, so comments past Zendesk's first page are absent and the rest is cut at the response character limit.",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, include_comments } = params as {
          ticket_id: number;
          include_comments: boolean;
        };
        const token = await getToken();
        const { ticket } = await zendeskGet<{ ticket: ZendeskTicket }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
        );
        // Show Ticket exposes no SLA (#92); resolve it via a scoped Search.
        let text =
          formatTicket(ticket) + formatSlaBlock(await fetchTicketSla(subdomain, token, ticket));
        if (include_comments) {
          const { comments, users } = await zendeskGet<TicketCommentsResponse>(
            subdomain,
            token,
            `/tickets/${ticket_id}/comments`,
            { include: 'users', include_inline_images: 'true' },
          );
          const authors = await resolveCommentAuthors(subdomain, token, comments ?? [], users);
          text += `\n\n---\n# Comments\n\n${(comments ?? [])
            .map((comment) => formatComment(comment, authors))
            .join('\n\n')}`;
        }
        // This tool takes no page or filter, so the default truncation advice
        // would send the caller in circles (#265). Name the tool that does.
        const advice = include_comments
          ? `get_ticket appends the thread as one unpaginated block; read it page by page with list_ticket_comments (ticket_id: ${ticket_id}, sort_order: "desc") to get the newest comments first.`
          : 'get_ticket takes no pagination or filter parameters, so this response cannot be narrowed from the call.';
        return { content: [{ type: 'text', text: truncateIfNeeded(text, advice) }] };
      },
    },
    {
      name: 'get_ticket_history',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket History',
      description:
        'Read a ticket\'s change history — its audit trail — as a chronological, oldest-first timeline of who changed what and when. Each entry shows the actor (name and id) and the channel, then the field changes that update carried (status, priority, assignee, group, tags, custom fields) as before → after, with assignee/requester/group ids resolved to names. Comments appear as one-line presence markers (public comment vs internal note added), not their text — fetch the bodies with list_ticket_comments (or get_ticket(include_comments=true) for a short thread). Purely system-generated notification events (trigger emails, collaborator/CC notifications, pushes) are filtered out — note this filters notification delivery, not CC-list edits, which are shown as changes — and an update carrying only such events produces no entry, so the timeline stays a readable narrative rather than a raw log. Use it to answer "what happened on this ticket?", "why was it reassigned?" or "when did it go to pending?", reading oldest-first so the founding context is not missed. Read-only, and cursor-paginated oldest-first: pass the returned cursor to page a long-lived ticket toward its most recent changes.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket whose change history to read. Obtain it from search_tickets or list_tickets.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(
            'Audits (ticket updates) per page (1-100, default 100). Each audit is one update to the ticket and may expand to several change lines; audits carrying only system events are dropped, so a page can render fewer entries than this.',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'Pagination cursor from a previous response; omit for the first page. The timeline is ordered oldest-first, so paging forward moves toward the most recent changes.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, page_size, cursor } = params as {
          ticket_id: number;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        let response: ZendeskListResponse<ZendeskAudit>;
        try {
          response = await zendeskGet<ZendeskListResponse<ZendeskAudit>>(
            subdomain,
            token,
            `/tickets/${ticket_id}/audits`,
            buildCursorParams(page_size, cursor),
          );
        } catch (error) {
          // The Ticket Audits API requires the global `read` OAuth scope; a
          // narrower scope (e.g. tickets:read) returns 403 here even though it
          // works for the other ticket tools. Rewrite the generic error into
          // guidance the user can act on, mirroring the SLA/view handlers.
          if (error instanceof ZendeskApiError && error.status === 403) {
            throw new Error(
              "get_ticket_history reads the Ticket Audits API (GET /tickets/{id}/audits), which Zendesk gates behind the global 'read' OAuth scope. The current token lacks it (HTTP 403) -- a narrower scope such as tickets:read can read tickets and comments but not their audit history. Re-authenticate with the global read scope to use this tool.",
              { cause: error },
            );
          }
          throw error;
        }
        const audits = response.audits ?? [];
        const meta = extractPaginationMeta(response, audits.length);
        const { userIds, groupIds } = collectAuditIds(audits);
        const names = await resolveAuditNames(subdomain, token, userIds, groupIds);
        // formatAudit returns null for an all-noise update (e.g. a trigger that
        // only sent a notification), so this single filter both drops those and
        // yields the rendered blocks.
        const blocks = audits
          .map((audit) => formatAudit(audit, names))
          .filter((block): block is string => block !== null);
        if (blocks.length === 0) {
          const text = meta.has_more
            ? `No changes to show on this page of ticket #${ticket_id}'s history (system events only). More available (cursor: ${meta.after_cursor}).`
            : `No change history to show for ticket #${ticket_id}.`;
          return { content: [{ type: 'text', text }] };
        }
        // Count reflects rendered entries, not raw audits (all-noise updates drop
        // out); pagination is preserved from the response. Same as get_view_tickets.
        const list = formatList(blocks, (block) => block, { ...meta, count: blocks.length });
        return {
          content: [{ type: 'text', text: `# Change history for ticket #${ticket_id}\n\n${list}` }],
        };
      },
    },
    {
      name: 'list_ticket_comments',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Zendesk Ticket Comments',
      description:
        'Read a ticket\'s conversation — public replies and internal notes with their full bodies — one cursor-paginated page at a time, newest comment first. Each entry carries the comment id, the author resolved to a name, the timestamp, whether it is public or internal, and the ids of any attached files. Prefer this over get_ticket(include_comments=true) whenever a thread is long or you only need the latest exchange: get_ticket appends the thread as one unpaginated block and cuts it past the response character limit, which drops the most recent comments first. Keep sort_order "desc" (the default) to read the latest reply first and follow the returned cursor to walk further back in time, or pass "asc" to replay the conversation forward from the ticket\'s opening description. For who changed which field and when — without comment bodies — use get_ticket_history; to download the attached files themselves, pass the attachment ids shown here to get_ticket_attachments.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket whose conversation to read. Obtain it from search_tickets or list_tickets.',
          ),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe(
            'Chronological direction of the page. "desc" (the default) starts at the most recent comment and walks backward in time, which is what you want to see the latest reply; "asc" replays the conversation forward, starting from the ticket\'s opening description — that first comment therefore lands on the last page under "desc".',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_TICKET_COMMENT_PAGE_SIZE)
          .describe(
            'Comments per page (1-100, default 20). The default is deliberately small because comment bodies are long and a bigger page risks being cut short by the response character limit; follow the returned cursor rather than raising it.',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'Pagination cursor from a previous response; omit for the first page. Zendesk issues it for the ordering that response used, so after changing sort_order drop the cursor and start again from the first page.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, sort_order, page_size, cursor } = params as {
          ticket_id: number;
          sort_order: 'asc' | 'desc';
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        const response = await zendeskGet<TicketCommentsResponse>(
          subdomain,
          token,
          `/tickets/${ticket_id}/comments`,
          {
            ...buildCursorParams(page_size, cursor),
            // `sort_order` is offset-only on this endpoint; cursor pagination
            // takes `sort` instead. The tool exposes the friendlier name and
            // maps it here.
            sort: sort_order === 'desc' ? '-created_at' : 'created_at',
            include: 'users',
            include_inline_images: 'true',
          },
        );
        const comments = response.comments ?? [];
        const meta = commentPageMeta(response, comments.length);
        const offsetNote = offsetPageNote(response);
        if (comments.length === 0) {
          const text = meta.has_more
            ? `No comments on this page of ticket #${ticket_id}. More available (cursor: ${meta.after_cursor}).`
            : `No comments to show for ticket #${ticket_id}.`;
          return { content: [{ type: 'text', text: `${text}${offsetNote}` }] };
        }
        const authors = await resolveCommentAuthors(subdomain, token, comments, response.users);
        const body = comments.map((comment) => formatComment(comment, authors)).join('\n\n');
        // Assembled and truncated in one go: the title has to be inside the
        // character budget, or the response overshoots the limit and the notice
        // misreports its own size. The cursor is no way back to what the cut
        // dropped — it points past this whole page — so the advice names the
        // only recovery there is. At page_size 1 there is no smaller page to
        // ask for: the cut is inside one over-long comment, and recommending
        // "smaller than 1" would itself be advice the schema rejects (#265).
        const text = `${[
          `# Comments on ticket #${ticket_id} (${commentPageOrder(comments, sort_order)})`,
          formatPagination(meta),
          body,
        ].join('\n\n')}${offsetNote}`;
        return {
          content: [
            {
              type: 'text',
              text: truncateIfNeeded(
                text,
                page_size > 1
                  ? `The comments cut here are not reachable through the cursor, which points past this whole page: re-issue with a page_size smaller than ${page_size} to read them.`
                  : 'This single comment is longer than the response character limit, so no page small enough exists: read it in Zendesk directly.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_ticket_attachments',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket Attachments',
      description:
        'Retrieve ticket attachments. Images are embedded inline; other files are listed as text references.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket whose attachments to fetch. Obtain it from search_tickets or list_tickets.',
          ),
        attachment_ids: z
          .array(z.number().int())
          .optional()
          .describe(
            'Attachment IDs to fetch directly (e.g. extracted from a previous list_ticket_comments or get_ticket(include_comments=true) call). When provided, skips the comments fetch entirely. When omitted, all attachments of the ticket are returned.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, attachment_ids } = params as {
          ticket_id: number;
          attachment_ids?: number[];
        };
        const token = await getToken();

        const attachments =
          attachment_ids && attachment_ids.length > 0
            ? await fetchAttachmentsByIds(subdomain, token, attachment_ids)
            : (await fetchAllTicketComments(subdomain, token, ticket_id)).flatMap(
                (c) => c.attachments ?? [],
              );

        if (attachments.length === 0) {
          return {
            content: [{ type: 'text', text: `No attachments found on ticket #${ticket_id}.` }],
          };
        }
        const blocks = await collectAttachmentBlocks(subdomain, token, attachments);
        return {
          content: [
            {
              type: 'text',
              text: `# Attachments for ticket #${ticket_id} (${attachments.length} total)`,
            },
            ...blocks,
          ],
        };
      },
    },
    {
      name: 'search_tickets',
      namespace: 'tickets',
      readOnly: true,
      title: 'Search Zendesk Tickets',
      description:
        'Search tickets using Zendesk query syntax, returning each result with its live SLA state (per-metric stage and breach countdown) when an SLA policy applies. Examples: "status:open assignee:me", "priority:urgent ticket_type:incident". Returns total count, so queue triage like "breaching today" works without a per-ticket fetch.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Zendesk ticket search query — field filters like "status:open", "assignee:me", "priority:urgent ticket_type:incident", combined with free text. A "type:ticket" scope is added automatically, so filter the ticket kind with ticket_type: (e.g. ticket_type:incident), never type: (which the API rejects here).',
          ),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { query, per_page, page } = params as {
          query: string;
          per_page: number;
          page: number;
        };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(
          subdomain,
          token,
          '/search',
          {
            query: `type:ticket ${query}`,
            include: 'tickets(slas)',
            ...buildOffsetParams(per_page, page),
          },
        );
        // The `slas` sideload is nested on each result (no top-level array, no
        // ticket_id correlation) — read it straight off the ticket.
        const formatTicketWithSla = (ticket: ZendeskTicket): string =>
          formatTicket(ticket) + formatSlaBlock(ticket.slas);
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.results ?? [],
                formatTicketWithSla,
                extractSearchPaginationMeta(response, per_page, page),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'create_ticket',
      namespace: 'tickets',
      readOnly: false,
      title: 'Create Zendesk Ticket',
      description:
        'Create a new Zendesk support ticket with subject, description, and optional priority/type/assignee/tags. The description becomes the first public comment of the ticket, and the new ticket id is returned. After creation, use update_ticket to change status or assignee, add_public_comment or add_private_note to reply, and manage_tags to adjust tags. Look up valid assignee_id / group_id and custom field ids via search_users or your Zendesk admin settings. Discover custom field ids and their accepted option values with list_ticket_fields.',
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .describe(
            'Ticket subject — the short summary line shown in ticket lists and search results.',
          ),
        description: z
          .string()
          .min(1)
          .describe(
            "Ticket description — the body of the request. It becomes the ticket's first public comment (visible to the requester).",
          ),
        priority: z
          .enum(['urgent', 'high', 'normal', 'low'])
          .optional()
          .describe('Ticket priority. One of urgent, high, normal, low.'),
        type: z
          .enum(['problem', 'incident', 'question', 'task'])
          .optional()
          .describe('Ticket type. One of problem, incident, question, task.'),
        assignee_id: z
          .number()
          .int()
          .optional()
          .describe('User id of the agent to assign the ticket to.'),
        group_id: z.number().int().optional().describe('Id of the group to assign the ticket to.'),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Tags to set on the new ticket. Each tag is a single lowercase token (join multi-word tags with an underscore). Use manage_tags later to add or remove individual tags.',
          ),
        custom_fields: z
          .array(z.object({ id: z.number().int(), value: z.unknown() }))
          .optional()
          .describe(
            'Custom field values as { id, value } pairs (field ids come from your Zendesk admin settings). Call list_ticket_fields first to discover the numeric field ids and, for dropdown/multiselect fields, the exact option values Zendesk accepts.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { subject, description, ...rest } = params as Record<string, unknown>;
        const token = await getToken();
        const { ticket } = await zendeskPost<{ ticket: ZendeskTicket }>(
          subdomain,
          token,
          '/tickets',
          {
            ticket: { subject, comment: { body: description }, ...rest },
          },
        );
        return {
          content: [
            { type: 'text', text: `Ticket #${ticket.id} created.\n\n${formatTicket(ticket)}` },
          ],
        };
      },
    },
    {
      name: 'update_ticket',
      namespace: 'tickets',
      readOnly: false,
      title: 'Update Zendesk Ticket',
      description:
        'Update an existing ticket (status, priority, type, assignee, group, subject, tags, custom fields). Only the fields you pass are changed, and the updated ticket is returned. Setting tags here replaces the whole tag set — use manage_tags to add or remove individual tags without overwriting the rest. This tool does not post replies: use add_public_comment or add_private_note for that. Find the ticket id via search_tickets or list_tickets.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket to update. Obtain it from search_tickets or list_tickets.',
          ),
        status: z
          .enum(['new', 'open', 'pending', 'hold', 'solved', 'closed'])
          .optional()
          .describe('New ticket status. One of new, open, pending, hold, solved, closed.'),
        priority: z
          .enum(['urgent', 'high', 'normal', 'low'])
          .optional()
          .describe('Ticket priority. One of urgent, high, normal, low.'),
        type: z
          .enum(['problem', 'incident', 'question', 'task'])
          .optional()
          .describe('Ticket type. One of problem, incident, question, task.'),
        assignee_id: z
          .number()
          .int()
          .optional()
          .describe('User id of the agent to assign the ticket to.'),
        group_id: z.number().int().optional().describe('Id of the group to assign the ticket to.'),
        subject: z
          .string()
          .optional()
          .describe('New subject line for the ticket; replaces the current subject when provided.'),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Replaces the full tag set on the ticket. Use manage_tags for incremental add/remove.',
          ),
        custom_fields: z
          .array(z.object({ id: z.number().int(), value: z.unknown() }))
          .optional()
          .describe(
            'Custom field values as { id, value } pairs (field ids come from your Zendesk admin settings). Call list_ticket_fields first to discover the numeric field ids and, for dropdown/multiselect fields, the exact option values Zendesk accepts.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, ...updates } = params as { ticket_id: number } & Record<string, unknown>;
        const token = await getToken();
        const { ticket } = await zendeskPut<{ ticket: ZendeskTicket }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
          { ticket: updates },
        );
        return {
          content: [
            { type: 'text', text: `Ticket #${ticket.id} updated.\n\n${formatTicket(ticket)}` },
          ],
        };
      },
    },
    {
      name: 'add_private_note',
      namespace: 'tickets',
      readOnly: false,
      title: 'Add Private Note',
      description:
        'Add an internal note (not visible to requester) to a ticket, optionally with file attachments (uploaded via the Zendesk Uploads API and carried on the note). The note is appended to the ticket thread; use add_public_comment instead when the reply should be visible to the requester.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket to annotate. Obtain it from search_tickets or list_tickets.',
          ),
        body: z
          .string()
          .min(1)
          .describe(
            'Note text (internal, agent-only). Plain text or HTML; not shown to the requester.',
          ),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe('Files to attach to this note (base64-encoded content).'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, body, attachments } = params as {
          ticket_id: number;
          body: string;
          attachments?: AttachmentInput[];
        };
        const token = await getToken();
        const uploads = attachments?.length
          ? [await uploadAttachments(subdomain, token, attachments)]
          : undefined;
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, {
          ticket: { comment: { body, public: false, ...(uploads && { uploads }) } },
        });
        const suffix = formatAttachmentSuffix(attachments?.length);
        return {
          content: [{ type: 'text', text: `Private note added to ticket #${ticket_id}${suffix}.` }],
        };
      },
    },
    {
      name: 'add_public_comment',
      namespace: 'tickets',
      readOnly: false,
      title: 'Add Public Comment',
      description:
        'Add a public comment (visible to requester) to a ticket, optionally with file attachments (uploaded via the Zendesk Uploads API and carried on the comment). The comment is appended to the ticket thread and emails the requester; use add_private_note instead for an internal, agent-only note.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket to reply on. Obtain it from search_tickets or list_tickets.',
          ),
        body: z
          .string()
          .min(1)
          .describe(
            'Comment text sent to the requester. Plain text or HTML; visible in the ticket.',
          ),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe('Files to attach to this comment (base64-encoded content).'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, body, attachments } = params as {
          ticket_id: number;
          body: string;
          attachments?: AttachmentInput[];
        };
        const token = await getToken();
        const uploads = attachments?.length
          ? [await uploadAttachments(subdomain, token, attachments)]
          : undefined;
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, {
          ticket: { comment: { body, public: true, ...(uploads && { uploads }) } },
        });
        const suffix = formatAttachmentSuffix(attachments?.length);
        return {
          content: [
            { type: 'text', text: `Public comment added to ticket #${ticket_id}${suffix}.` },
          ],
        };
      },
    },
    {
      name: 'list_tickets',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Zendesk Tickets',
      description:
        "List tickets with cursor-based pagination, in Zendesk's default order (ascending ticket id), not by recency. Page size is controlled by page_size (not per_page, which is the offset-based parameter used by search_tickets); paginate by passing the returned cursor. To find tickets by recency or any other criterion, use search_tickets with a query.",
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Tickets per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(
          subdomain,
          token,
          '/tickets',
          buildCursorParams(page_size, cursor),
        );
        const tickets = response.tickets ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                tickets,
                formatTicket,
                extractPaginationMeta(response, tickets.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_linked_incidents',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Linked Incidents',
      description:
        "Get all incident tickets linked to a problem ticket. Returns the list of incidents that reference the given problem (Zendesk problem/incident relationship); useful to gauge a problem's blast radius before resolving it.",
      inputSchema: z.object({
        problem_id: z
          .number()
          .int()
          .describe(
            'Problem ticket ID — the numeric id of the ticket of type "problem" whose linked incidents to list. Obtain it from search_tickets or list_tickets.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { problem_id } = params as { problem_id: number };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(
          subdomain,
          token,
          `/tickets/${problem_id}/incidents`,
        );
        const incidents = response.tickets ?? [];
        const text =
          incidents.length > 0
            ? `# Incidents linked to problem #${problem_id}\n\n${incidents.map(formatTicket).join('\n\n')}`
            : `No incidents linked to problem #${problem_id}.`;
        return {
          content: [
            {
              type: 'text',
              text: truncateIfNeeded(
                text,
                'get_linked_incidents takes no pagination or filter parameters, so this response cannot be narrowed from the call.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'manage_tags',
      namespace: 'tickets',
      readOnly: false,
      title: 'Manage Ticket Tags',
      description:
        "Add or remove tags on a ticket. Performs an incremental read-modify-write: it fetches the ticket's current tags, adds those in `add` and deletes those in `remove`, then saves the merged set — tags you don't list are left untouched and duplicates are collapsed. Adding a tag already present, or removing one that is absent, is a no-op (idempotent). Returns the ticket's full tag set after the update. Use this for incremental tag edits; to overwrite the entire tag set at once, or to change tags alongside other fields, use update_ticket instead. Find the ticket id via search_tickets or list_tickets.",
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket whose tags to modify. Obtain it from search_tickets or list_tickets.',
          ),
        add: z
          .array(z.string())
          .optional()
          .describe(
            'Tags to add. Zendesk tags are single tokens: a value containing spaces is stored as separate tags rather than one tag, so join multi-word tags yourself with an underscore or dash (e.g. "urgent_request"). Adding a tag already on the ticket is a no-op. Omit to only remove.',
          ),
        remove: z
          .array(z.string())
          .optional()
          .describe(
            'Tags to remove. Removing a tag that is not present is a no-op; tags not listed here stay in place. Omit to only add.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, add, remove } = params as {
          ticket_id: number;
          add?: string[];
          remove?: string[];
        };
        const token = await getToken();
        const { ticket } = await zendeskGet<{ ticket: ZendeskTicket }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
        );
        const tags = new Set(ticket.tags);
        add?.forEach((t) => {
          tags.add(t);
        });
        remove?.forEach((t) => {
          tags.delete(t);
        });
        const { ticket: updated } = await zendeskPut<{ ticket: ZendeskTicket }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
          { ticket: { tags: [...tags] } },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Tags updated on ticket #${ticket_id}. Current: ${updated.tags.join(', ') || 'none'}`,
            },
          ],
        };
      },
    },
    {
      name: 'list_sla_policies',
      namespace: 'tickets',
      readOnly: true,
      title: 'List SLA Policies',
      description:
        'List the configured SLA policies with their filter conditions and per-priority reply/resolution targets. Use this to explain why a given target applies to a ticket and to reconstruct deadlines deterministically instead of hard-coding the policy matrix. Requires an admin token (or a custom role granted the SLA-management permission); a standard agent token gets 403 here, though it can still read live per-ticket SLA via get_ticket / search_tickets.',
      inputSchema: z.object({
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { per_page, page } = params as { per_page: number; page: number };
        const token = await getToken();
        let response: ZendeskListResponse<ZendeskSlaPolicy>;
        try {
          response = await zendeskGet<ZendeskListResponse<ZendeskSlaPolicy>>(
            subdomain,
            token,
            '/slas/policies',
            buildOffsetParams(per_page, page),
          );
        } catch (error) {
          // /slas/policies is the SLA *configuration* endpoint, which Zendesk
          // restricts to admins. A 403 here means the token lacks that role, so
          // replace the generic "Permission denied" with guidance the LLM can
          // act on -- including the agent-accessible alternative.
          if (error instanceof ZendeskApiError && error.status === 403) {
            throw new Error(
              'list_sla_policies reads SLA policy *configuration* (GET /slas/policies), which Zendesk restricts to admins (or a custom role granted the SLA-management permission). The current token lacks that permission (HTTP 403). This does not affect live SLA on tickets: per-metric SLA stage and breach countdown are available to any agent via get_ticket and search_tickets -- use those for triage and prioritization.',
              { cause: error },
            );
          }
          throw error;
        }
        const policies = response.sla_policies ?? [];
        // The SLA policies endpoint returns the full config list and, in
        // practice, omits the `count` wrapper, so the shared helper falls back to
        // the array length rather than reporting "Results: 0".
        const meta = extractOffsetPaginationMeta(response, policies.length, per_page, page);
        return {
          content: [{ type: 'text', text: formatList(policies, formatSlaPolicy, meta) }],
        };
      },
    },
    {
      name: 'list_ticket_fields',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Ticket Fields',
      description:
        'List the ticket field definitions configured on this Zendesk (both system fields and custom fields), returning each field\'s id, type, whether it is active/required, and — for dropdown and multiselect fields — the valid option values. Use this to discover the numeric field ids and accepted option tags that create_ticket and update_ticket expect in their custom_fields argument, so a natural-language intent ("set severity to High") maps to the right id and a value Zendesk will accept instead of a blind guess. Read-only reference lookup; cursor-paginated in Zendesk\'s default field order.',
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Ticket field definitions per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicketField>>(
          subdomain,
          token,
          '/ticket_fields',
          buildCursorParams(page_size, cursor),
        );
        const fields = response.ticket_fields ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                fields,
                formatTicketField,
                extractPaginationMeta(response, fields.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_views',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Zendesk Views',
      description:
        'List the agent\'s active Zendesk views — the saved ticket queues ("Unassigned tickets", "My open tickets", "Breaching today") the agent sees in the Zendesk UI — each with its current ticket count so you can tell at a glance where the workload sits. Views are per-agent scoped, so per-user auth returns exactly the queues this agent can see, with no shared key. Counts come from Zendesk\'s cache and can lag by up to about an hour (shown as "(count updating)" while a fresh value is still being computed); pass a view\'s title or id to get_view_tickets to read the tickets inside it.',
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Views per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskView>>(
          subdomain,
          token,
          '/views',
          { active: 'true', ...buildCursorParams(page_size, cursor) },
        );
        const views = response.views ?? [];
        const counts = await fetchViewCounts(
          subdomain,
          token,
          views.map((v) => v.id),
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                views,
                (view) => formatView(view, counts.get(view.id)),
                extractPaginationMeta(response, views.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_view_tickets',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Tickets In A View',
      description:
        'Read the tickets inside a Zendesk view, in the view\'s own configured sort order — the same order the agent sees in the Zendesk UI — which is the natural way to work a named queue like "Unassigned tickets" or "Breaching today". Accepts the view by title or by numeric id (discover both with list_views); a title is matched case-insensitively against the agent\'s active views, and on no match the available titles are returned so you can retry in one step. Tickets come back with the same fields as list_tickets and are cursor-paginated; there is no live SLA block here (use search_tickets when you need per-ticket SLA state), and sort_by/sort_order override the view\'s order when you want a different cut.',
      inputSchema: z.object({
        view: z
          .union([z.string().min(1), z.number().int().positive()])
          .describe(
            'The view to read: its exact title as shown in Zendesk (e.g. "Unassigned tickets") or its numeric id from list_views. A title is matched case-insensitively against your active views; on no match the tool returns the available titles instead of erroring, so you can retry with a correct one.',
          ),
        sort_by: z
          .string()
          .optional()
          .describe(
            'Optional column to sort by, overriding the view\'s own sort. Must be one of the view\'s columns (e.g. "status", "priority", "updated_at", or a custom field id); "subject" and "submitter" are not sortable. Omit to keep the view\'s configured order.',
          ),
        sort_order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe(
            'Sort direction applied to sort_by: "asc" (oldest/lowest first) or "desc" (newest/highest first). Only meaningful together with sort_by; omit to keep the view\'s configured direction.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Tickets per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { view, sort_by, sort_order, page_size, cursor } = params as {
          view: string | number;
          sort_by?: string;
          sort_order?: 'asc' | 'desc';
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        const resolved = await resolveViewId(subdomain, token, view);
        if ('available' in resolved) {
          const text =
            resolved.available.length > 0
              ? `No active view matches "${view}". Available views: ${resolved.available.join(', ')}.`
              : `No active view matches "${view}", and no active views were found for this agent.`;
          return { content: [{ type: 'text', text }] };
        }
        let rows: ZendeskViewExecuteRow[];
        let meta: PaginationMeta;
        try {
          ({ rows, meta } = await executeView(subdomain, token, resolved.id, {
            sort_by,
            sort_order,
            page_size,
            cursor,
          }));
        } catch (error) {
          // Views can be restricted to specific groups; a 403 means this agent
          // cannot see that view. Rewrite the generic "Permission denied" into
          // guidance the LLM can act on.
          if (error instanceof ZendeskApiError && error.status === 403) {
            throw new Error(
              `Access denied to view ${resolved.id} (HTTP 403). Zendesk views can be restricted to specific groups, and this agent is not allowed to read this one. Call list_views to see the queues available to this agent.`,
              { cause: error },
            );
          }
          throw error;
        }
        const ids = rows
          .map(extractRowTicketId)
          .filter((id): id is number => typeof id === 'number');
        const tickets = await hydrateViewTickets(subdomain, token, ids);
        // Count reflects the tickets actually rendered, not the raw execute rows:
        // a row whose id can't be extracted or that show_many can't resolve is
        // dropped, so rows.length would overstate the list. Pagination (has_more /
        // after_cursor) is preserved from the execute response.
        return {
          content: [
            {
              type: 'text',
              text: formatList(tickets, formatTicket, { ...meta, count: tickets.length }),
            },
          ],
        };
      },
    },
    {
      name: 'list_macros',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Zendesk Macros',
      description:
        'List the active macros available to the authenticated user. A macro bundles a canned reply and/or a set of field changes (status, priority, assignee, group, tags, custom fields) an agent applies to a ticket in one gesture; this returns each macro id, title, description, availability scope, and its ordered list of actions, offset-paginated. Results are scoped by per-user OAuth to what the current user can see, so no shared admin key is needed. Pass a macro id from here to preview_macro_diff to preview its effect on a specific ticket.',
      inputSchema: z.object({
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { per_page, page } = params as { per_page: number; page: number };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskMacro>>(
          subdomain,
          token,
          '/macros/active',
          buildOffsetParams(per_page, page),
        );
        const macros = response.macros ?? [];
        const meta = extractOffsetPaginationMeta(response, macros.length, per_page, page);
        return {
          content: [{ type: 'text', text: formatList(macros, formatMacro, meta) }],
        };
      },
    },
    {
      name: 'preview_macro_diff',
      namespace: 'tickets',
      // Marked write (readOnly: false) even though both reads mutate nothing: it
      // is the entry point of a mutation workflow whose commit step (update_ticket
      // / add_*_comment) is filtered out by --read-only, so exposing it there would
      // offer a preview the user cannot act on.
      readOnly: false,
      title: 'Preview a Macro Diff on a Ticket',
      description:
        "Preview the exact changes a macro would make to a specific ticket, as a before → after diff, WITHOUT saving anything. Orchestrates two reads — the ticket's current state and Zendesk's macro-apply preview (which returns the whole resulting ticket) — and returns only the fields the macro actually changes (status, priority, assignee, group, tags, custom fields) plus the canned reply with its public/internal flag; unchanged and identity fields are omitted. Nothing is committed: to apply it, follow up with update_ticket for the field changes and add_public_comment or add_private_note for the reply. This deliberate two-step keeps the mutation explicit and reviewable rather than hidden. Find macro ids via list_macros and the ticket id via search_tickets or list_tickets.",
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket to preview the macro against. Obtain it from search_tickets or list_tickets.',
          ),
        macro_id: z
          .number()
          .int()
          .describe(
            'Macro ID — the numeric id of the macro to preview. Obtain it from list_macros.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, macro_id } = params as { ticket_id: number; macro_id: number };
        const token = await getToken();
        // Two reads in parallel: the ticket as it is now, and the ticket as the
        // macro would leave it. Diffing them isolates the macro's actual effect.
        const [{ ticket: before }, { result }] = await Promise.all([
          zendeskGet<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticket_id}`),
          zendeskGet<{ result: ZendeskMacroApplyResult }>(
            subdomain,
            token,
            `/tickets/${ticket_id}/macros/${macro_id}/apply`,
          ),
        ]);
        return {
          content: [
            {
              type: 'text',
              text: truncateIfNeeded(
                formatMacroPreviewDiff(ticket_id, macro_id, before, result),
                'preview_macro_diff takes no pagination or filter parameters; read the macro on its own with list_macros to see every action it carries.',
              ),
            },
          ],
        };
      },
    },
  ];
};
