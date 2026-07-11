import * as z from 'zod/v4';
import {
  fetchZendeskBinary,
  ZendeskApiError,
  zendeskGet,
  zendeskPost,
  zendeskPut,
  zendeskUpload,
} from '../client/zendesk-api';
import {
  DEFAULT_PAGE_SIZE,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMENT_PAGES,
  MAX_EMBEDDED_IMAGE_COUNT,
  MAX_PAGE_SIZE,
} from '../constants';
import type {
  PaginationMeta,
  ZendeskComment,
  ZendeskListResponse,
  ZendeskSlaPolicy,
  ZendeskSlaSideloadEntry,
  ZendeskTicket,
  ZendeskTicketAttachment,
  ZendeskTicketField,
  ZendeskUpload,
  ZendeskView,
  ZendeskViewCount,
  ZendeskViewCountManyResponse,
  ZendeskViewExecuteResponse,
  ZendeskViewExecuteRow,
} from '../types';
import {
  formatComment,
  formatList,
  formatSlaBlock,
  formatSlaPolicy,
  formatTicket,
  formatTicketField,
  formatView,
  truncateIfNeeded,
} from '../utils/formatting';
import {
  buildCursorParams,
  buildOffsetParams,
  extractPaginationMeta,
  extractSearchPaginationMeta,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { ToolContext, ToolDefinition, ToolImageContent, ToolTextContent } from './definitions';

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
      const limitMb = +(MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(2);
      skipReason = `skipped: exceeds ${limitMb} MB per-image limit`;
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
const fetchTicketSla = async (
  subdomain: string,
  token: string,
  ticket: ZendeskTicket,
): Promise<ZendeskSlaSideloadEntry | undefined> => {
  const day = ticket.created_at.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
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

// Resolve a view reference (title or numeric id) to an id. A numeric reference is
// used as-is; a title is matched case-insensitively against the agent's active
// views. Returns the available titles on no match so the caller can self-correct.
const resolveViewId = async (
  subdomain: string,
  token: string,
  view: string | number,
): Promise<{ id: number } | { available: string[] }> => {
  if (typeof view === 'number') return { id: view };
  if (/^\d+$/.test(view.trim())) return { id: Number(view.trim()) };
  const response = await zendeskGet<ZendeskListResponse<ZendeskView>>(subdomain, token, '/views', {
    active: 'true',
    ...buildCursorParams(MAX_PAGE_SIZE),
  });
  const views = response.views ?? [];
  const target = view.trim().toLowerCase();
  const match = views.find((v) => v.title.trim().toLowerCase() === target);
  return match ? { id: match.id } : { available: views.map((v) => v.title) };
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

export const createTicketTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  const attachmentSchema = z.object({
    file_name: z.string().min(1).describe('File name, e.g. "app.log" or "screenshot.png".'),
    file_base64: z.string().min(1).base64().describe('File content encoded as base64.'),
    content_type: z
      .string()
      .min(1)
      .default('application/octet-stream')
      .describe('MIME type, e.g. "text/plain", "image/png", "application/pdf".'),
  });
  type AttachmentInput = z.infer<typeof attachmentSchema>;

  // Upload each file via the Zendesk Uploads API, aggregating them under a single
  // upload token (the token from the first upload is passed to the next), and
  // return that token for use in a comment's `uploads` array.
  const uploadAttachments = async (token: string, files: AttachmentInput[]): Promise<string> => {
    let uploadToken: string | undefined;
    for (const file of files) {
      const { upload } = await zendeskUpload<{ upload: ZendeskUpload }>(
        subdomain,
        token,
        file.file_name,
        Buffer.from(file.file_base64, 'base64'),
        file.content_type,
        uploadToken,
      );
      uploadToken = upload.token;
    }
    return uploadToken as string;
  };

  const formatAttachmentSuffix = (count?: number): string =>
    count ? ` with ${count} attachment(s)` : '';

  return [
    {
      name: 'get_ticket',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket',
      description:
        'Retrieve a Zendesk ticket by ID, including its live SLA state (per-metric stage and breach countdown) when an SLA policy applies, plus its comments if requested. Returns ticket details (subject, status, priority, assignee, tags, description) and optionally all comments/internal notes. The per-ticket Show endpoint exposes no SLA, so the SLA block is resolved via a scoped search and may be absent for a very high-volume requester or a just-updated ticket; SLA targets and policy conditions live in list_sla_policies.',
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
            'When true, appends the full public comment and internal note thread to the response. Defaults to false to keep the payload small; enable it when you need the conversation, not just the ticket fields.',
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
          const { comments } = await zendeskGet<{ comments: ZendeskComment[] }>(
            subdomain,
            token,
            `/tickets/${ticket_id}/comments`,
            { include_inline_images: 'true' },
          );
          text += `\n\n---\n# Comments\n\n${comments.map(formatComment).join('\n\n')}`;
        }
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
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
            'Attachment IDs to fetch directly (e.g. extracted from a previous get_ticket(include_comments=true) call). When provided, skips the comments fetch entirely. When omitted, all attachments of the ticket are returned.',
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

        let attachments: ZendeskTicketAttachment[];
        if (attachment_ids && attachment_ids.length > 0) {
          attachments = [];
          for (const id of attachment_ids) {
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
        } else {
          const comments = await fetchAllTicketComments(subdomain, token, ticket_id);
          attachments = comments.flatMap((c) => c.attachments ?? []);
        }

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
          ? [await uploadAttachments(token, attachments)]
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
          ? [await uploadAttachments(token, attachments)]
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
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
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
        // practice, omits the `count` wrapper, so fall back to the array length
        // rather than reporting "Results: 0".
        const meta =
          response.count != null
            ? extractSearchPaginationMeta(response, per_page, page)
            : { count: policies.length, has_more: false, after_cursor: null };
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
        const rows = views.map((view) => ({ view, count: counts.get(view.id) }));
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                rows,
                ({ view, count }) => formatView(view, count),
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
        return {
          content: [{ type: 'text', text: formatList(tickets, formatTicket, meta) }],
        };
      },
    },
  ];
};
