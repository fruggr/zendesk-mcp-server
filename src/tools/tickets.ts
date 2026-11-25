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
  DEFAULT_TICKET_LIST_PAGE_SIZE,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMENT_PAGES,
  MAX_EMBEDDED_IMAGE_COUNT,
  MAX_PAGE_SIZE,
  MAX_RESPONSE_BYTES,
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
  ZendeskTicketMetric,
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
  DESCRIPTION_EXCERPT_CHARS,
  formatAudit,
  formatComment,
  formatFieldValue,
  formatFittingList,
  formatList,
  formatMacro,
  formatNextBreachBlock,
  formatPagination,
  formatSlaBlock,
  formatSlaPolicy,
  formatSubscribersBlock,
  formatTagDiff,
  formatTicket,
  formatTicketField,
  formatTicketSummary,
  formatView,
  nextBreachByTicket,
  truncateIfNeeded,
} from '../utils/formatting';
import { resolveCallerGroupMe } from '../utils/group-me';
import {
  buildCursorParams,
  buildOffsetParams,
  extractOffsetPaginationMeta,
  extractPaginationMeta,
  extractSearchPaginationMeta,
  offsetResume,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { SlaService } from '../utils/sla-service';
import { formatUrgencyLine, ticketUrgency } from '../utils/sla-urgency';
import { formatTicketMetrics } from '../utils/ticket-metrics';
import {
  type AttachmentInput,
  attachmentsParam,
  formatAttachmentSuffix,
  uploadAttachments,
} from './attachments';
import type { ToolDefinition, ToolEnv, ToolImageContent, ToolTextContent } from './definitions';

// Zendesk renders Markdown in comment.body only for an agent author (Ticket
// Comments API, "Bodies"); these tools post as the calling agent. HTML there is
// shown as literal text (#418 validation), despite the docs saying "stripped".
const AGENT_COMMENT_FORMAT =
  'Markdown, not HTML (tags show as literal text); put code, identifiers with _ or *, and <placeholders> in backticks.';

// The per-image cap in MB, for the skip message. Derived once: both operands
// are module constants.
const MAX_ATTACHMENT_MB = Number.parseFloat((MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(2));

// The response budget in MB, for the skip and truncation messages.
const MAX_RESPONSE_MB = Number.parseFloat((MAX_RESPONSE_BYTES / (1024 * 1024)).toFixed(2));

// Bytes a block adds to the response once serialized. A JSON array weighs the sum
// of its elements plus one separator each, so accumulating this is exact rather
// than approximate. An image is measured without its payload and the base64
// length added back: identical, without a multi-megabyte throwaway copy.
const blockCost = (block: ToolTextContent | ToolImageContent): number =>
  block.type === 'image'
    ? Buffer.byteLength(JSON.stringify({ ...block, data: '' }), 'utf8') + block.data.length + 1
    : Buffer.byteLength(JSON.stringify(block), 'utf8') + 1;

// What embedding this image would weigh, reference block included, known before
// downloading it. Base64 turns every 3 bytes into 4 characters, so the size
// Zendesk reports is enough, and an image that cannot fit is never fetched.
const embeddedCost = (attachment: ZendeskTicketAttachment, reference: string): number =>
  blockCost({ type: 'image', data: '', mimeType: attachment.content_type }) +
  4 * Math.ceil(attachment.size / 3) +
  blockCost({ type: 'text', text: reference });

// One wording for the budget, shared by the skip reason and the fallback
// reference so the two cannot describe the same cause differently.
const BUDGET_REACHED = `skipped: response budget of ${MAX_RESPONSE_MB} MB reached`;

// An attachment listed rather than embedded, with the reason appended when there
// is one. Every non-embedded attachment goes through here, so a client always
// learns what it got instead of the file, never finding a silent hole.
const referenceBlock = (reference: string, skipReason: string | null): ToolTextContent => ({
  type: 'text',
  text: skipReason ? `${reference} — ${skipReason}` : reference,
});

// The block that reports what the budget cut off. Its own weight is reserved up
// front, so the notice is never what overflows.
const truncationNotice = (omitted: number): ToolTextContent => ({
  type: 'text',
  text: `${omitted} further attachments omitted: response budget of ${MAX_RESPONSE_MB} MB reached`,
});

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

// Zendesk lists attachments only on comments, hence the walk. `truncated`: the
// page cap cut it short, which the caller must say. `complete`: every comment was
// read or `done` had enough; an offset-paged answer leaves it false.
const fetchAllTicketComments = async (
  subdomain: string,
  token: string,
  ticketId: number,
  { done, newestFirst }: { done?: (page: ZendeskComment[]) => boolean; newestFirst?: boolean } = {},
): Promise<{ comments: ZendeskComment[]; truncated: boolean; complete: boolean }> => {
  const all: ZendeskComment[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  let complete = false;
  while (pages < MAX_COMMENT_PAGES) {
    const response = await zendeskGet<{
      comments: ZendeskComment[];
      meta?: { has_more: boolean; after_cursor: string };
      next_page?: string | null;
    }>(subdomain, token, `/tickets/${ticketId}/comments`, {
      ...buildCursorParams(MAX_PAGE_SIZE, cursor),
      include_inline_images: 'true',
      ...(newestFirst && { sort: '-created_at' }),
    });
    all.push(...response.comments);
    pages += 1;
    if (done?.(response.comments)) {
      complete = true;
      break;
    }
    if (!response.meta?.has_more || !response.meta?.after_cursor) {
      complete = !response.meta?.has_more && response.next_page == null;
      break;
    }
    cursor = response.meta.after_cursor;
    truncated = pages === MAX_COMMENT_PAGES;
  }
  return { comments: all, truncated, complete };
};

const COMMENT_CAP_NOTICE = `Comment scan stopped at its page cap (${MAX_COMMENT_PAGES} pages, COMMENT_MAX_PAGES): attachments on any later comments are not listed. Pass attachment_ids taken from list_ticket_comments to fetch them.`;

// Narrowed rather than passed whole: `users?: T[]` on
// ZendeskListResponse<ZendeskComment> clashes with the side-load. `next_page` is
// dropped on purpose — forwarding it raises `has_more` with a null cursor, an
// offer this cursor-only tool cannot honour. offsetPageNote says so in words.
const commentPageMeta = (response: TicketCommentsResponse, itemCount: number): PaginationMeta =>
  extractPaginationMeta<ZendeskComment>(
    {
      ...(response.meta && { meta: response.meta }),
      ...(response.count !== undefined && { count: response.count }),
    },
    itemCount,
  );

// Defensive: Zendesk documents cursor pagination here. Were it ever to answer
// offset-style, `next_page` would report more comments with no cursor to reach
// them, and no parameter this tool accepts gets there. The note says the
// continuation is out of reach rather than give advice that cannot work (#265).
const offsetPageNote = (response: TicketCommentsResponse): string =>
  response.meta?.after_cursor == null && response.next_page != null
    ? '\n\n> ⚠ Zendesk paginated this response by offset rather than by cursor, so more comments exist beyond this page and no cursor leads to them. This tool pages by cursor only, and no parameter it accepts reaches the rest: read the remaining comments in Zendesk directly.'
    : '';

// Read off the data rather than off what was asked for: a header describing the
// wrong end is worse than none, and the truncation cut always lands on the
// trailing end (#265). Equal timestamps say nothing about order, so those fall
// back to what was requested.
const commentPageOrder = (
  comments: ZendeskComment[],
  sortOrder: 'asc' | 'desc',
): 'newest first' | 'oldest first' => {
  const first = comments[0]?.created_at ?? '';
  const last = comments.at(-1)?.created_at ?? '';
  const newestFirst = first === last ? sortOrder === 'desc' : first > last;
  return newestFirst ? 'newest first' : 'oldest first';
};

const MAX_ATTACHMENT_IDS = 25;

interface AttachmentSelection {
  attachments: ZendeskTicketAttachment[];
  /** Absent from a complete walk of the ticket's comments. */
  notOnTicket: number[];
  /** Past the comment page cap: fetched directly, ticket not checked. */
  unchecked: number[];
  /** Past the page cap and unknown to Zendesk (404). */
  unknown: number[];
}

const attachmentsById = (comments: ZendeskComment[]): Map<number, ZendeskTicketAttachment> =>
  new Map(comments.flatMap((c) => (c.attachments ?? []).map((a) => [a.id, a] as const)));

// Zendesk's attachment object names no ticket, so the ticket's own comments are
// the only proof an id belongs to it: read them, stopping once every id is seen.
// Newest first, as list_ticket_comments lists them: that is where the ids an
// agent holds usually come from, so the walk tends to stop on its first page.
const selectTicketAttachments = async (
  subdomain: string,
  token: string,
  ticketId: number,
  requested: number[],
): Promise<AttachmentSelection> => {
  const ids = [...new Set(requested)];
  const pending = new Set(ids);
  const walk = await fetchAllTicketComments(subdomain, token, ticketId, {
    newestFirst: true,
    done: (page) => {
      for (const id of attachmentsById(page).keys()) pending.delete(id);
      return pending.size === 0;
    },
  });
  const seen = attachmentsById(walk.comments);
  const found = ids.flatMap((id) => seen.get(id) ?? []);
  const missing = ids.filter((id) => !seen.has(id));
  if (walk.complete) {
    return { attachments: found, notOnTicket: missing, unchecked: [], unknown: [] };
  }
  const fetched = await fetchAttachmentsByIds(subdomain, token, missing);
  const fetchedIds = new Set(fetched.map((a) => a.id));
  const resolved = new Map([...found, ...fetched].map((a) => [a.id, a] as const));
  return {
    // In the order asked for, verified or not.
    attachments: ids.flatMap((id) => resolved.get(id) ?? []),
    notOnTicket: [],
    unchecked: [...fetchedIds],
    unknown: missing.filter((id) => !fetchedIds.has(id)),
  };
};

const selectionNotice = (selection: AttachmentSelection, ticketId: number): string[] => [
  ...(selection.notOnTicket.length
    ? [
        `Not attachments of ticket #${ticketId} (absent from all its comments), so not listed: ${selection.notOnTicket.join(', ')}.`,
      ]
    : []),
  ...(selection.unchecked.length
    ? [
        `Not in the comments of ticket #${ticketId} that could be read (at most ${MAX_COMMENT_PAGES} pages), so listed without checking they belong to it: ${selection.unchecked.join(', ')}.`,
      ]
    : []),
  ...(selection.unknown.length
    ? [`Unknown to Zendesk, so not listed: ${selection.unknown.join(', ')}.`]
    : []),
];

// Measured on a live tenant (#423 spike): images pasted into an HTML email body
// come back with `inline: true`, re-sent under a new name in every quoted reply,
// and signature icons weigh well under this. Real files are never inline.
const SMALL_INLINE_IMAGE_BYTES = 4 * 1024;

// Only consulted for images (collectAttachmentBlocks).
const isSmallInlineImage = (attachment: ZendeskTicketAttachment): boolean =>
  attachment.inline === true && attachment.size < SMALL_INLINE_IMAGE_BYTES;

// For a whole-ticket listing: real attachments first, so inline images never
// push them past the embedded-image cap or the response budget; then inline
// images, each content kept once. A quoted reply renames the copies it carries,
// so type and size identify them, not the file name.
const arrangeTicketAttachments = (
  attachments: ZendeskTicketAttachment[],
): { attachments: ZendeskTicketAttachment[]; repeatedInline: number[] } => {
  const seen = new Set<string>();
  const inline: ZendeskTicketAttachment[] = [];
  const repeatedInline: number[] = [];
  for (const a of attachments.filter((attachment) => attachment.inline)) {
    const key = `${a.content_type}:${a.size}`;
    if (seen.has(key)) repeatedInline.push(a.id);
    else inline.push(a);
    seen.add(key);
  }
  const real = attachments.filter((a) => !a.inline);
  return { attachments: [...real, ...inline], repeatedInline };
};

const smallInlineReason = (attachment: ZendeskTicketAttachment): string | null =>
  isSmallInlineImage(attachment)
    ? `not embedded: inline image under ${SMALL_INLINE_IMAGE_BYTES / 1024} KB, as signature icons are`
    : null;

const listTicketAttachments = async (subdomain: string, token: string, ticketId: number) => {
  const walk = await fetchAllTicketComments(subdomain, token, ticketId);
  const arranged = arrangeTicketAttachments(walk.comments.flatMap((c) => c.attachments ?? []));
  return {
    attachments: arranged.attachments,
    notices: [
      ...(walk.truncated ? [COMMENT_CAP_NOTICE] : []),
      // Ids named so a wrong match (two contents of equal size) stays reachable.
      ...(arranged.repeatedInline.length
        ? [
            `${arranged.repeatedInline.length} repeated inline attachment(s) skipped (ids ${arranged.repeatedInline.join(', ')}): same type and size as one already listed, as when a reply quotes an earlier email.`,
          ]
        : []),
    ],
    uncheckedCount: 0,
    // A whole-ticket listing keeps its embed slots for content, not signature icons.
    referenceOnly: smallInlineReason,
  };
};

const embedAsAsked = (): null => null;

// An explicit selection is embedded as asked: no reference-only rule.
const pickTicketAttachments = async (
  subdomain: string,
  token: string,
  ticketId: number,
  ids: number[],
) => {
  const selection = await selectTicketAttachments(subdomain, token, ticketId, ids);
  return {
    attachments: selection.attachments,
    notices: selectionNotice(selection, ticketId),
    uncheckedCount: selection.unchecked.length,
    referenceOnly: embedAsAsked,
  };
};

const noAttachmentsText = (ticketId: number, notices: string[], ids?: number[]): string => {
  if (ids) {
    return [
      'None of the requested attachment_ids was listed.',
      ...notices,
      `Omit attachment_ids to collect the attachments of ticket #${ticketId}'s comments.`,
    ].join(' ');
  }
  return notices.includes(COMMENT_CAP_NOTICE)
    ? `No attachments found on the first ${MAX_COMMENT_PAGES} pages of comments of ticket #${ticketId}. ${COMMENT_CAP_NOTICE}`
    : `No attachments found on ticket #${ticketId}.`;
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

// Why an image is not embedded, or null when it is. Ordered from the narrowest
// reason to the widest so the message names the actual cause: its own size, then
// how many are already in, then what is left of the response budget.
const imageSkipReason = (
  attachment: ZendeskTicketAttachment,
  embeddedCount: number,
  reference: string,
  fits: (cost: number) => boolean,
): string | null => {
  if (attachment.size > MAX_ATTACHMENT_BYTES)
    return `skipped: exceeds ${MAX_ATTACHMENT_MB} MB per-image limit`;
  if (embeddedCount >= MAX_EMBEDDED_IMAGE_COUNT)
    return `skipped: max ${MAX_EMBEDDED_IMAGE_COUNT} embedded images reached`;
  // Last, and only reached when the cheaper reasons did not fire, so the cost
  // estimate is never computed for an image already rejected.
  if (!fits(embeddedCost(attachment, reference))) return BUDGET_REACHED;
  return null;
};

// What to emit when what was produced does not fit. An image degrades to a
// reference when that reference fits; null means nothing more fits at all, so the
// listing has to stop.
const overflowFallback = (
  produced: Array<ToolTextContent | ToolImageContent>,
  reference: string,
  fits: (cost: number) => boolean,
): ToolTextContent | null => {
  if (!produced.some((block) => block.type === 'image')) return null;
  const fallback = referenceBlock(reference, BUDGET_REACHED);
  return fits(blockCost(fallback)) ? fallback : null;
};

// Embed the image, or fall back to a reference that says why the download failed.
// A failed download is one attachment lost, never the whole listing.
const embedOrExplain = async (
  subdomain: string,
  token: string,
  attachment: ZendeskTicketAttachment,
  reference: string,
): Promise<Array<ToolTextContent | ToolImageContent>> => {
  try {
    return await buildEmbeddedImageBlocks(subdomain, token, attachment, reference);
  } catch (error) {
    const reason =
      error instanceof ZendeskApiError
        ? `download failed: ${error.status} ${error.statusText}`
        : 'download failed';
    return [{ type: 'text', text: `${reference} — ${reason}` }];
  }
};

const collectAttachmentBlocks = async (
  subdomain: string,
  token: string,
  attachments: ZendeskTicketAttachment[],
  // What the caller already spends on the same response (its header, and the
  // array wrapper). Counted here or the budget bounds only part of the message.
  consumedBytes = 0,
  // Images listed as a reference whatever room is left, with the reason given.
  referenceOnly: (attachment: ZendeskTicketAttachment) => string | null = () => null,
): Promise<Array<ToolTextContent | ToolImageContent>> => {
  const blocks: Array<ToolTextContent | ToolImageContent> = [];
  let embeddedCount = 0;
  // Running weight of the response once serialized, so it never grows past what
  // the transport accepts (#205).
  let responseBytes = consumedBytes;
  // Worst case for the notice is every attachment omitted, hence the widest count.
  const noticeReserve = blockCost(truncationNotice(attachments.length));
  const fits = (cost: number): boolean =>
    responseBytes + cost + noticeReserve <= MAX_RESPONSE_BYTES;

  for (const [index, attachment] of attachments.entries()) {
    const reference = formatReference(attachment);
    const isImage = attachment.content_type.startsWith('image/');
    const skipReason = isImage
      ? (referenceOnly(attachment) ?? imageSkipReason(attachment, embeddedCount, reference, fits))
      : null;

    const produced: Array<ToolTextContent | ToolImageContent> =
      isImage && !skipReason
        ? await embedOrExplain(subdomain, token, attachment, reference)
        : [referenceBlock(reference, skipReason)];

    const cost = produced.reduce((total, block) => total + blockCost(block), 0);
    if (!fits(cost)) {
      // The estimate can undershoot: it reads `attachment.size` and the declared
      // content type, while the built block carries what the download actually
      // returned (`fetchZendeskBinary` prefers the response's Content-Type). One
      // image not fitting is not the same as nothing fitting.
      const fallback = overflowFallback(produced, reference, fits);
      if (fallback) {
        blocks.push(fallback);
        responseBytes += blockCost(fallback);
        continue;
      }
      // Even a reference has stopped fitting: stop walking and say how many were
      // dropped, since silence here would read as a shorter ticket.
      blocks.push(truncationNotice(attachments.length - index));
      break;
    }

    blocks.push(...produced);
    responseBytes += cost;
    if (produced.some((block) => block.type === 'image')) embeddedCount += 1;
  }

  return blocks;
};

// Zendesk silently ignores the `slas` sideload on Show Ticket and Show Many
// (#92), and Search is the only endpoint returning live SLA — hence the scoped
// search: same requester, +/-1 day around creation (the window absorbs
// account-timezone skew). Best-effort, returning undefined over mis-attribution.
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

// A Zendesk cursor resumes after the whole page fetched, past the tickets left
// out, and cannot skip: re-reading just the shown part yields the cursor between
// them. `pageSizeFor` maps shown tickets to the page_size covering them, which a
// view's dropped rows make larger.
const cursorResume =
  (pageSizeFor: (shown: number) => number = (shown) => shown) =>
  (shown: number, onPage: number): string =>
    `To read the ${onPage - shown} not shown, call again with page_size: ${pageSizeFor(shown)} and the cursor this page was read with (none for the first page): it returns these ${shown} again, with a cursor that resumes right after them.`;

const EXCERPT_NOTE = `Descriptions are cut to ${DESCRIPTION_EXCERPT_CHARS} characters (full text: get_ticket).`;

// A string reference is always a title, even an all-digits one, matched
// case-insensitively. The active-views list is paginated to completion so a title
// on a later page still resolves; on no match the available titles come back, for
// the caller to self-correct.
export const resolveViewId = async (
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

// Audit change values arrive as unknown — string or number depending on the
// field — and 0 / null / "" all mean "unset". Only real positive ids are worth
// the batched name lookup.
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

interface SubscriberEdit {
  add?: number[];
  remove?: number[];
}
interface SubscriberAction {
  user_id: number;
  action: 'put' | 'delete';
}
type SubscriberParam = 'followers' | 'email_ccs';
type SubscriberActions = Partial<Record<SubscriberParam, SubscriberAction[]>>;

// The ticket field carrying what Zendesk actually applied, per write parameter.
const SUBSCRIBER_PARAMS = [
  { param: 'followers', field: 'follower_ids' },
  { param: 'email_ccs', field: 'email_cc_ids' },
] as const satisfies ReadonlyArray<{ param: SubscriberParam; field: keyof ZendeskTicket }>;

// Zendesk takes these as action objects; the tool exposes `{ add, remove }` like
// manage_tags. An id in both loses the add. `undefined` when nothing maps, so the
// key never reaches the payload.
const toSubscriberActions = (edit: SubscriberEdit | undefined): SubscriberAction[] | undefined => {
  if (!edit) return undefined;
  const removed = new Set(edit.remove);
  const actions: SubscriberAction[] = [
    ...[...new Set(edit.add)]
      .filter((id) => !removed.has(id))
      .map((id) => ({ user_id: id, action: 'put' }) as const),
    ...[...removed].map((id) => ({ user_id: id, action: 'delete' }) as const),
  ];
  return actions.length > 0 ? actions : undefined;
};

// The entries the response does not positively account for: an `add` whose id is
// absent, a `remove` whose id is still there, and everything when Zendesk sent no
// list at all.
const unappliedActions = (
  actions: SubscriberAction[],
  ids: number[] | undefined,
): SubscriberAction[] => {
  const present = Array.isArray(ids) ? new Set(ids) : undefined;
  return actions.filter(({ user_id, action }) => {
    if (action === 'put') return !present?.has(user_id);
    return present === undefined || present.has(user_id);
  });
};

// Zendesk never errors on a subscriber write: an unknown id is ignored, and both
// lists are ignored wholesale when the account's "CCs and followers" setting is
// off. The two are indistinguishable in the response, so this detects without
// diagnosing and names both causes.
const formatSubscriberOutcome = (
  sent: SubscriberActions,
  after: Pick<ZendeskTicket, 'follower_ids' | 'email_cc_ids'>,
): string => {
  const unconfirmed = SUBSCRIBER_PARAMS.flatMap(({ param, field }) =>
    unappliedActions(sent[param] ?? [], after[field]).map(
      ({ user_id, action }) => `${param} ${action === 'put' ? 'add' : 'remove'} ${user_id}`,
    ),
  );
  if (unconfirmed.length === 0) return '';
  return `\n\nUnconfirmed: ${unconfirmed.join(', ')}. Zendesk applies followers and email CCs silently: an id it does not know is ignored, and both are ignored entirely when the account's "CCs and followers" setting is off. Check that each id exists with get_user, and the account setting with a Zendesk admin.`;
};

// Zendesk can answer 200 and leave the requester or organization as it was (a
// role without the permission, an organization the requester is not a member
// of), so a requested value is checked against the returned ticket (#417).
const PARTY_FIELDS = ['requester_id', 'organization_id'] as const;

const formatPartyOutcome = (
  requested: Partial<Record<(typeof PARTY_FIELDS)[number], unknown>>,
  after: Pick<ZendeskTicket, (typeof PARTY_FIELDS)[number]>,
): string => {
  const unapplied = PARTY_FIELDS.filter(
    (field) => requested[field] !== undefined && requested[field] !== after[field],
  ).map(
    (field) => `${field} ${requested[field]} requested, Zendesk kept ${after[field] ?? 'none'}`,
  );
  if (unapplied.length === 0) return '';
  return `\n\nNot applied: ${unapplied.join('; ')}. Zendesk can leave the requester or the organization unchanged without an error: check that your role may edit them, and that the requester is a member of the organization.`;
};

// A requester change can carry the organization along with it (#417): Zendesk
// files a ticket under one of its requester's organizations. The agent did not
// ask for that move, so it is named from the audit the update returns, which
// is the stored audit, one `Change` event per changed field (#444 spike).
const formatOrganizationMove = (audit: ZendeskAudit | undefined): string => {
  if (!audit) {
    return '\n\nCould not confirm whether the organization moved with the requester: check that the organization shown above is the one you expect.';
  }
  const move = audit.events?.find((e) => e.type === 'Change' && e.field_name === 'organization_id');
  if (!move) return '';
  const id = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : String(v));
  return `\n\nOrganization changed with the requester: organization_id ${id(move.previous_value)} -> ${id(move.value)}. Pass organization_id to keep the ticket under another organization the new requester belongs to.`;
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

// Resolve every user a ticket response names, in one batch: comment authors,
// followers, email CCs. The `include=users` side-load seeds the map; the ids it
// left out cost one batched show_many. The system actor (-1) has no user record,
// so it is never looked up.
const resolveUserDisplayNames = async (
  subdomain: string,
  token: string,
  ids: number[],
  sideloaded: ZendeskUser[] = [],
): Promise<Map<number, string>> => {
  const names = new Map(sideloaded.map((user) => [user.id, user.name]));
  const missing = [...new Set(ids)].filter((id) => id > 0 && !names.has(id));
  if (missing.length === 0) return names;
  for (const [id, name] of await resolveUserNames(subdomain, token, missing)) {
    names.set(id, name);
  }
  return names;
};

// Followers and email CCs a response has to name. Both keys are absent on an
// account without the "CCs and followers" setting, hence the guards; the
// de-duplication and positive-id filter live in the resolver.
const collectSubscriberIds = (ticket: ZendeskTicket): number[] => [
  ...(ticket.follower_ids ?? []),
  ...(ticket.email_cc_ids ?? []),
];

// Keys the generic field diff must not emit:
//   - `comment`/`fields`/`custom_fields` have their own render paths.
//   - `updated_at`/`generated_timestamp`/`encoded_id` are server-recomputed, so a
//     no-op preview bumps them and they'd read as changes.
//   - `id`/`url`/`created_at` already drop out; listed as belt-and-braces, since
//     over-suppression is the safe direction before a real write.
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

// Null when the two sides render identically. That also drops a field the apply
// response returns as `null` where the current ticket omits the key: both render
// "(empty)", so it is a no-op, not a change.
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

// The apply endpoint returns the WHOLE resulting ticket, not just the macro's
// changes, so diffing it against the ticket's current state is what isolates the
// macro's effect. It mutates nothing, hence the closing pointer at the write
// tools that persist the change — the deliberate two-step from #120.
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

export const createTicketTools = (env: ToolEnv): ToolDefinition[] => {
  const { subdomain } = env;

  // The pushed `**Urgency**` line for one SLA block, '' when push is off. The
  // thresholds are the caller's, read once per call; the line is decoration, so
  // a failed read (/users/me, the store) falls back to the server's rather than
  // failing the ticket read.
  const urgencyRenderer = async (
    sla: SlaService | undefined,
  ): Promise<(entry: ZendeskSlaSideloadEntry | undefined) => string> => {
    if (!sla?.push) return () => '';
    const thresholds = await sla.thresholds().catch(() => sla.adminThresholds);
    // Read at render time, as formatSlaBlock does: a clock taken before the
    // Zendesk request would let the two lines disagree.
    return (entry) => formatUrgencyLine(ticketUrgency(entry, thresholds, Date.now()));
  };

  // One side of a subscriber edit: only the cap and the prose differ between
  // followers and email CCs, and the published `maxItems` is what tells an agent
  // about Zendesk's 48-CC ceiling before it calls.
  const subscriberIdList = (description: string, max?: number) => {
    const ids = z.array(z.number().int().positive());
    return (max === undefined ? ids : ids.max(max)).optional().describe(description);
  };

  const customFieldEntry = z
    .object({
      id: z
        .number()
        .int()
        .describe('Numeric id of the ticket field to set, as listed by list_ticket_fields.'),
      value: z
        .unknown()
        .describe(
          "Value typed after the field: the option tag (a string) for a dropdown, an array of option tags for a multiselect, true or false for a checkbox, text or a number for a text or numeric field. For any other type (a date, a lookup), follow the type list_ticket_fields reports; it also lists each dropdown's accepted tags.",
        ),
    })
    .strict();

  return [
    {
      name: 'get_ticket',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket',
      description:
        'Get a ticket as it stands now, with its live SLA state and who an update reaches. Followers (notified of updates, internal notes included) and email CCs (public correspondence only) are listed by name; the requester is neither, and both lists are empty when "CCs and followers" is off. The SLA block (per-metric stage and countdown) comes from a search, so it can be missing for a very high-volume requester or a just-updated ticket; with SLA push on it adds an Urgency line (BREACHED, CRITICAL or WARNING) against your thresholds. Policies: list_sla_policies. Change history: get_ticket_history. Long thread: list_ticket_comments.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        include_comments: z
          .boolean()
          .default(false)
          .describe(
            "Append the comments and internal notes as one block: only Zendesk's first page, cut at the response limit. On a long thread use list_ticket_comments.",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, include_comments } = params as {
          ticket_id: number;
          include_comments: boolean;
        };
        const token = await caller.getToken();
        const { ticket } = await zendeskGet<{ ticket: ZendeskTicket }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
        );
        // Show Ticket exposes no SLA (#92); resolve it via a scoped Search. That
        // search needs only the ticket and the thread needs only its id, so the
        // two go out together instead of one after the other.
        const [sla, thread, urgency] = await Promise.all([
          fetchTicketSla(subdomain, token, ticket),
          include_comments
            ? zendeskGet<TicketCommentsResponse>(
                subdomain,
                token,
                `/tickets/${ticket_id}/comments`,
                { include: 'users', include_inline_images: 'true' },
              )
            : undefined,
          urgencyRenderer(caller.sla),
        ]);
        const comments = thread?.comments ?? [];
        // Subscribers and comment authors resolve in the same batch, so the whole
        // response costs one show_many, and none at all when there is no name to
        // look up.
        const names = await resolveUserDisplayNames(
          subdomain,
          token,
          [...collectSubscriberIds(ticket), ...comments.map((comment) => comment.author_id)],
          thread?.users,
        );
        const commentsBlock = thread
          ? `\n\n---\n# Comments\n\n${comments
              .map((comment) => formatComment(comment, names))
              .join('\n\n')}`
          : '';
        const text =
          formatTicket(ticket) +
          formatSlaBlock(sla, urgency(sla)) +
          formatSubscribersBlock(ticket, names) +
          commentsBlock;
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
        'Read a ticket\'s audit trail: who changed which field and when, oldest first. Each entry gives the actor (name and id), the channel and each field change as before → after, user and group ids resolved to names. Comments show only as public or internal markers (bodies: list_ticket_comments). Notification events (trigger emails, CC notifications, pushes) are dropped; CC-list edits still show. Use it for "why was it reassigned?" or "when did it go to pending?".',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(
            'Audits (ticket updates) per page; one can give several lines, and audits with only system events are dropped, so a page can show fewer.',
          ),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; it moves toward the latest changes.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, page_size, cursor } = params as {
          ticket_id: number;
          page_size: number;
          cursor?: string;
        };
        const token = await caller.getToken();
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
        "Read a ticket's replies and internal notes in full, newest first, a page at a time. Each entry has the comment id, author, time, public or internal, and attachment ids (download: get_ticket_attachments). Prefer it to get_ticket(include_comments=true) on a long thread, whose cut drops the newest comments. Field changes: get_ticket_history.",
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe(
            '"desc" walks back from the latest reply; "asc" reads forward from the opening description.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_TICKET_COMMENT_PAGE_SIZE)
          .describe(
            'Comments per page; bodies are long, so follow the cursor rather than raise it past the response limit.',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'Cursor from the previous response; it keeps that sort_order, so drop it when changing sort_order.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, sort_order, page_size, cursor } = params as {
          ticket_id: number;
          sort_order: 'asc' | 'desc';
          page_size: number;
          cursor?: string;
        };
        const token = await caller.getToken();
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
        const authors = await resolveUserDisplayNames(
          subdomain,
          token,
          comments.map((comment) => comment.author_id),
          response.users,
        );
        const body = comments.map((comment) => formatComment(comment, authors)).join('\n\n');
        // The title has to sit inside the character budget, or the response
        // overshoots and the notice misreports its own size. The cursor points past
        // this page, so it is no way back to what the cut dropped; at page_size 1
        // there is no smaller page to ask for either (#265).
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
        "Download a ticket's attached files to look at them. Images come inline, other files as references (name, id, type, size, download URL). To only see which files a comment has, use list_ticket_comments. Without attachment_ids it scans up to 10 pages of 100 comments (and says if it stopped): comment files first, then images pasted into email bodies once each, those under 4 KB (signature icons) as references only. An oversized image or one past the embed cap comes back as a reference saying why; past the response budget, the rest are counted as omitted.",

      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        attachment_ids: z
          .array(z.number().int().positive())
          .min(
            1,
            "attachment_ids cannot be empty: omit it to collect the attachments of the ticket's comments",
          )
          .max(
            MAX_ATTACHMENT_IDS,
            `attachment_ids takes at most ${MAX_ATTACHMENT_IDS} ids: split a longer selection over several calls`,
          )
          .optional()
          .describe(
            'Fetch only these files (ids from list_ticket_comments), even past the page cap; comments are read until all are found. After a full scan an id not on the ticket is named, not fetched; if the scan ends early (page cap, or a page without cursor), a missing id is fetched directly and flagged unchecked.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, attachment_ids } = params as {
          ticket_id: number;
          attachment_ids?: number[];
        };
        const token = await caller.getToken();

        const { attachments, notices, uncheckedCount, referenceOnly } = attachment_ids
          ? await pickTicketAttachments(subdomain, token, ticket_id, attachment_ids)
          : await listTicketAttachments(subdomain, token, ticket_id);

        if (attachments.length === 0) {
          return {
            content: [
              { type: 'text', text: noAttachmentsText(ticket_id, notices, attachment_ids) },
            ],
          };
        }
        const header: ToolTextContent = {
          type: 'text',
          text: `# Attachments for ticket #${ticket_id} (${attachments.length} total${uncheckedCount ? `, ${uncheckedCount} not checked against the ticket` : ''})`,
        };
        // Right after the header, so the response budget can never drop it.
        const notice: ToolTextContent[] = notices.length
          ? [{ type: 'text', text: notices.join(' ') }]
          : [];
        // `+ 1` is the array's opening bracket; blockCost accounts for a trailing
        // separator per element but nothing for the wrapper itself.
        const blocks = await collectAttachmentBlocks(
          subdomain,
          token,
          attachments,
          [header, ...notice].reduce((total, block) => total + blockCost(block), 1),
          referenceOnly,
        );
        return { content: [header, ...notice, ...blocks] };
      },
    },
    {
      name: 'search_tickets',
      namespace: 'tickets',
      readOnly: true,
      title: 'Search Zendesk Tickets',
      description: `Search tickets with Zendesk query syntax, with the total count and live SLA state where a policy applies. With SLA push on, each SLA block adds an Urgency line (BREACHED, CRITICAL or WARNING) against your thresholds. ${EXCERPT_NOTE}`,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Field filters like "status:open assignee:me" or "priority:urgent ticket_type:incident", plus free text. type:ticket is added for you: filter the kind with ticket_type:, never type:. "me" works only with assignee:, requester:, submitter:; group:me works if you are in exactly one group (else the error names them), otherwise use group:<id>.',
          ),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_TICKET_LIST_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { query, per_page, page } = params as {
          query: string;
          per_page: number;
          page: number;
        };
        const token = await caller.getToken();
        const search = async () => {
          const resolved = await resolveCallerGroupMe(query, subdomain, token, caller.sla);
          const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(
            subdomain,
            token,
            '/search',
            {
              query: `type:ticket ${resolved.query}`,
              include: 'tickets(slas)',
              ...buildOffsetParams(per_page, page),
            },
          );
          return { resolved, response };
        };
        const [{ resolved, response }, urgency] = await Promise.all([
          search(),
          urgencyRenderer(caller.sla),
        ]);
        // The `slas` sideload is nested on each result (no top-level array, no
        // ticket_id correlation) — read it straight off the ticket.
        const formatTicketWithSla = (ticket: ZendeskTicket): string =>
          formatTicketSummary(ticket) + formatSlaBlock(ticket.slas, urgency(ticket.slas));
        return {
          content: [
            {
              type: 'text',
              text: formatFittingList(
                response.results ?? [],
                formatTicketWithSla,
                extractSearchPaginationMeta(response, per_page, page),
                offsetResume(page, per_page),
                (meta) => [resolved.note, formatPagination(meta)].filter(Boolean).join('\n'),
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
        'Create a ticket from a subject and a description; the new ticket is returned with its id. A requester or organization Zendesk did not keep is reported as not applied. Afterwards: update_ticket for status or assignee, add_public_comment or add_private_note to reply, manage_tags for tags.',
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .describe('Summary line shown in ticket lists and search results.'),
        description: z
          .string()
          .min(1)
          .describe(
            `The ticket's first public comment, seen by the requester. ${AGENT_COMMENT_FORMAT}`,
          ),
        priority: z
          .enum(['urgent', 'high', 'normal', 'low'])
          .optional()
          .describe('Priority level of the ticket.'),
        type: z
          .enum(['problem', 'incident', 'question', 'task'])
          .optional()
          .describe('Kind of ticket, as Zendesk classifies it.'),
        assignee_id: z
          .number()
          .int()
          .optional()
          .describe('User id of the agent to assign the ticket to, from search_users.'),
        group_id: z.number().int().optional().describe('Id of the group to assign the ticket to.'),
        requester_id: z
          .number()
          .int()
          .optional()
          .describe(
            'User the ticket is on behalf of (end user or agent), from search_users; defaults to you.',
          ),
        organization_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Organization of the ticket; it must be one of the requester's, or Zendesk rejects or ignores it. Omit for the requester's default.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe('Single lowercase tokens; join words with an underscore.'),
        custom_fields: z
          .array(customFieldEntry)
          .optional()
          .describe(
            '{ id, value } pairs; field ids and accepted dropdown/multiselect values come from list_ticket_fields.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { subject, description, ...rest } = params as Record<string, unknown>;
        const token = await caller.getToken();
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
            {
              type: 'text',
              text: `Ticket #${ticket.id} created.\n\n${formatTicket(ticket)}${formatPartyOutcome(rest, ticket)}`,
            },
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
        "Change a ticket's fields, followers or email CCs and return the updated ticket. Only what you pass changes. Tags here replace the whole set (single tags: manage_tags). Zendesk can skip a change silently, so the response says when a requester or organization was not applied, a follower or CC change is unconfirmed, or the organization moved with a new requester. It posts no reply: use add_public_comment or add_private_note.",
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        status: z
          .enum(['new', 'open', 'pending', 'hold', 'solved', 'closed'])
          .optional()
          .describe('New status of the ticket.'),
        priority: z
          .enum(['urgent', 'high', 'normal', 'low'])
          .optional()
          .describe('Priority level of the ticket.'),
        type: z
          .enum(['problem', 'incident', 'question', 'task'])
          .optional()
          .describe('Kind of ticket, as Zendesk classifies it.'),
        assignee_id: z
          .number()
          .int()
          .optional()
          .describe('User id of the agent to assign the ticket to, from search_users.'),
        group_id: z.number().int().optional().describe('Id of the group to assign the ticket to.'),
        requester_id: z
          .number()
          .int()
          .optional()
          .describe(
            'New requester (end user or agent), from search_users. Zendesk may move the ticket to one of their organizations; pass organization_id to choose.',
          ),
        organization_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Organization to move the ticket to; it must be one of the requester's, or Zendesk rejects or ignores it.",
          ),
        subject: z.string().optional().describe('Replacement subject line.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('The full new tag set; tags left out are removed.'),
        custom_fields: z
          .array(customFieldEntry)
          .optional()
          .describe(
            '{ id, value } pairs; field ids and accepted dropdown/multiselect values come from list_ticket_fields.',
          ),
        followers: z
          .object({
            add: subscriberIdList('User ids to start following the ticket. Omit to only remove.'),
            remove: subscriberIdList('User ids to stop following the ticket. Omit to only add.'),
          })
          .strict()
          .optional()
          .describe(
            'Agents to add or remove, as user ids: { add: [123], remove: [456] }; followers are notified of updates, internal notes included. Resolve each person with search_users and confirm the match: removing a wrong id succeeds silently. A change already in place is a no-op; an id in both lists is removed.',
          ),
        email_ccs: z
          .object({
            add: subscriberIdList('User ids to CC on the ticket. Omit to only remove.', 48),
            remove: subscriberIdList('User ids to drop from the CC list. Omit to only add.'),
          })
          .strict()
          .optional()
          .describe(
            'Users to add or remove, as user ids: { add: [123], remove: [456] }; CCs get the public correspondence, subject to your triggers. Resolve each person with search_users and confirm the match. Zendesk caps a ticket at 48 CCs, existing ones included: going over comes back unconfirmed, not as an error. An id in both lists is removed.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        // `followers` and `email_ccs` are pulled out of the spread on purpose:
        // every other key goes to Zendesk verbatim, so leaving the add/remove
        // wrapper in would send a shape Zendesk quietly ignores.
        const { ticket_id, followers, email_ccs, ...updates } = params as {
          ticket_id: number;
          followers?: SubscriberEdit;
          email_ccs?: SubscriberEdit;
        } & Record<string, unknown>;
        const token = await caller.getToken();
        const sent: SubscriberActions = {};
        const followerActions = toSubscriberActions(followers);
        const ccActions = toSubscriberActions(email_ccs);
        if (followerActions) sent.followers = followerActions;
        if (ccActions) sent.email_ccs = ccActions;
        const { ticket, audit } = await zendeskPut<{ ticket: ZendeskTicket; audit?: ZendeskAudit }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
          { ticket: { ...updates, ...sent } },
        );
        let text = `Ticket #${ticket.id} updated.\n\n${formatTicket(ticket)}`;
        // Only a call that touched subscribers pays the look-up and reports the
        // block; a plain status change keeps the output it always had.
        if (followerActions || ccActions) {
          const names = await resolveUserDisplayNames(
            subdomain,
            token,
            collectSubscriberIds(ticket),
          );
          text += formatSubscribersBlock(ticket, names) + formatSubscriberOutcome(sent, ticket);
        }
        text += formatPartyOutcome(updates, ticket);
        // An explicit organization_id is checked by formatPartyOutcome instead.
        if (updates['requester_id'] !== undefined && updates['organization_id'] === undefined) {
          text += formatOrganizationMove(audit);
        }
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'add_private_note',
      namespace: 'tickets',
      readOnly: false,
      title: 'Add Private Note',
      description:
        'Add an internal note, hidden from the requester, to a ticket, optionally with files. It is appended to the thread; for a reply the requester sees, use add_public_comment.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        body: z.string().min(1).describe(`Note text, for agents only. ${AGENT_COMMENT_FORMAT}`),
        attachments: attachmentsParam('Files to attach to the note.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, body, attachments } = params as {
          ticket_id: number;
          body: string;
          attachments?: AttachmentInput[];
        };
        const token = await caller.getToken();
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
        'Post a public reply on a ticket, optionally with files. It is appended to the thread and emails the requester; for an agent-only note, use add_private_note.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        body: z
          .string()
          .min(1)
          .describe(`Reply text, sent to the requester. ${AGENT_COMMENT_FORMAT}`),
        attachments: attachmentsParam('Files to attach to the reply.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, body, attachments } = params as {
          ticket_id: number;
          body: string;
          attachments?: AttachmentInput[];
        };
        const token = await caller.getToken();
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
      description: `List tickets by ascending id, cursor-paginated, not by recency. To filter or sort, use search_tickets. ${EXCERPT_NOTE}`,
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_TICKET_LIST_PAGE_SIZE)
          .describe('Tickets per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await caller.getToken();
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
              text: formatFittingList(
                tickets,
                formatTicketSummary,
                extractPaginationMeta(response, tickets.length),
                cursorResume(),
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
      description: `List the incidents linked to a problem ticket, to gauge its impact before solving it. ${EXCERPT_NOTE}`,
      inputSchema: z.object({
        problem_id: z
          .number()
          .int()
          .describe('Id of a ticket of type "problem", from search_tickets or list_tickets.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { problem_id } = params as { problem_id: number };
        const token = await caller.getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(
          subdomain,
          token,
          `/tickets/${problem_id}/incidents`,
        );
        const incidents = response.tickets ?? [];
        const text =
          incidents.length > 0
            ? `# Incidents linked to problem #${problem_id}\n\n${incidents.map(formatTicketSummary).join('\n\n')}`
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
        "Add or remove single tags on a ticket, keeping the others; returns the ticket's full tag set. Adding a present tag or removing an absent one is a no-op (idempotent). To replace the whole set, or change tags with other fields, use update_ticket.",
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        add: z
          .array(z.string())
          .optional()
          .describe(
            'Tags to add; a value with spaces becomes several tags, so join words with _ or - (e.g. "urgent_request").',
          ),
        remove: z.array(z.string()).optional().describe('Tags to take off the ticket.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, add, remove } = params as {
          ticket_id: number;
          add?: string[];
          remove?: string[];
        };
        const token = await caller.getToken();
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
        'List SLA policies with their conditions and per-priority targets. Use it to explain which reply or resolution target applies to a ticket. Needs an admin or a role with the SLA-management permission; other agents get 403 but still see live SLA via get_ticket / search_tickets.',
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
      handler: async (params, { caller }) => {
        const { per_page, page } = params as { per_page: number; page: number };
        const token = await caller.getToken();
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
      name: 'get_ticket_metrics',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Ticket Metrics',
      description:
        'Read elapsed-time metrics for up to 100 tickets: reply, resolution, wait and on-hold times. Times come in calendar and business minutes, with reopen, reply and station counts and key timestamps; they exist without any SLA policy and say how long things took, not time left (countdown: get_ticket, search_tickets, list_sla_alerts). A running duration reads "not reached yet"; a ticket you cannot see is reported, not fatal.',
      inputSchema: z.object({
        ticket_ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_PAGE_SIZE)
          .describe(
            'Ticket ids, from search_tickets, list_tickets or get_view_tickets; duplicates are read once, order is kept.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const ids = [...new Set((params as { ticket_ids: number[] }).ticket_ids)];
        const token = await caller.getToken();
        const response = await zendeskGet<{
          tickets?: ZendeskTicket[];
          metric_sets?: ZendeskTicketMetric[];
        }>(subdomain, token, '/tickets/show_many', {
          ids: ids.join(','),
          include: 'metric_sets',
        });
        const tickets = new Map((response.tickets ?? []).map((t) => [t.id, t]));
        const metrics = new Map((response.metric_sets ?? []).map((m) => [m.ticket_id, m]));
        const text = ids
          .map((id) => formatTicketMetrics(id, tickets.get(id), metrics.get(id)))
          .join('\n\n');
        return {
          content: [
            {
              type: 'text',
              text: truncateIfNeeded(text, 'Pass fewer ticket_ids per call.'),
            },
          ],
        };
      },
    },
    {
      name: 'list_ticket_fields',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Ticket Fields',
      description:
        'List ticket fields (system and custom) with id, type, active and required flags, and dropdown/multiselect options. Use it to turn "set severity to High" into the field id and option tag custom_fields expects in create_ticket and update_ticket.',
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Field definitions per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await caller.getToken();
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
        'List your active views (saved ticket queues) with their ticket counts. Counts are cached and can lag up to about an hour ("(count updating)" while refreshed). To read a view\'s tickets, pass its title or id to get_view_tickets.',
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Views per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await caller.getToken();
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
      description: `Read a view's tickets in the view's own order, as the agent sees it in Zendesk. Same fields as list_tickets, cursor-paginated; each SLA-covered ticket shows its next breach (every metric: get_ticket or search_tickets). ${EXCERPT_NOTE}`,
      inputSchema: z.object({
        view: z
          .union([z.string().min(1), z.number().int().positive()])
          .describe(
            'View title (case-insensitive) or id, from list_views; on no match the available titles come back so you can retry.',
          ),
        sort_by: z
          .string()
          .optional()
          .describe(
            'One of the view\'s columns to sort by instead (e.g. "status", "priority", "updated_at", a custom field id), except "subject" and "submitter".',
          ),
        sort_order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Direction for sort_by only: "asc" (oldest/lowest first) or "desc".'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_TICKET_LIST_PAGE_SIZE)
          .describe('Tickets per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { view, sort_by, sort_order, page_size, cursor } = params as {
          view: string | number;
          sort_by?: string;
          sort_order?: 'asc' | 'desc';
          page_size: number;
          cursor?: string;
        };
        const token = await caller.getToken();
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
        const rowIds = rows.map(extractRowTicketId);
        const ids = rowIds.filter((id): id is number => typeof id === 'number');
        const tickets = await hydrateViewTickets(subdomain, token, ids);
        const nextBreach = nextBreachByTicket(rows);
        // Count reflects the tickets actually rendered, not the raw execute rows:
        // a row whose id can't be extracted or that show_many can't resolve is
        // dropped, so rows.length would overstate the list. Pagination (has_more /
        // after_cursor) is preserved from the execute response.
        return {
          content: [
            {
              type: 'text',
              text: formatFittingList(
                tickets,
                (ticket) =>
                  formatTicketSummary(ticket) + formatNextBreachBlock(nextBreach.get(ticket.id)),
                { ...meta, count: tickets.length },
                // page_size counts execute rows, dropped ones included.
                cursorResume((shown) => rowIds.indexOf(tickets[shown - 1]?.id) + 1),
              ),
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
        'List the active macros you can use: id, title, description, scope and ordered actions. A macro applies a canned reply and/or field changes to a ticket in one step; preview its effect with preview_macro_diff.',
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
      handler: async (params, { caller }) => {
        const { per_page, page } = params as { per_page: number; page: number };
        const token = await caller.getToken();
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
        'Preview what a macro would change on a ticket, as a before → after diff, without saving. Returns only the changed fields and the canned reply with its public/internal flag. To apply it, call update_ticket for the fields and add_public_comment or add_private_note for the reply.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket id, from search_tickets or list_tickets.'),
        macro_id: z.number().int().describe('Macro id, from list_macros.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { ticket_id, macro_id } = params as { ticket_id: number; macro_id: number };
        const token = await caller.getToken();
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
