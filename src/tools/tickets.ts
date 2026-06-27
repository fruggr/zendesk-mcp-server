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
  MAX_ATTACHMENT_BYTES,
  MAX_COMMENT_PAGES,
  MAX_EMBEDDED_IMAGE_COUNT,
  MAX_PAGE_SIZE,
} from '../constants';
import type {
  ZendeskComment,
  ZendeskListResponse,
  ZendeskSlaPolicy,
  ZendeskSlaSideloadEntry,
  ZendeskTicket,
  ZendeskTicketAttachment,
} from '../types';
import {
  formatComment,
  formatList,
  formatSlaBlock,
  formatSlaPolicy,
  formatTicket,
  truncateIfNeeded,
} from '../utils/formatting';
import {
  buildCursorParams,
  buildOffsetParams,
  extractPaginationMeta,
  extractSearchPaginationMeta,
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
    }>(subdomain, token, `/tickets/${ticketId}/comments`, buildCursorParams(MAX_PAGE_SIZE, cursor));
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
      skipReason = 'skipped: exceeds 5 MB per-image limit';
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

export const createTicketTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'get_ticket',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket',
      description:
        'Retrieve a Zendesk ticket by ID, including its live SLA state (per-metric stage and breach countdown) when an SLA policy applies, plus its comments if requested. Returns ticket details (subject, status, priority, assignee, tags, description) and optionally all comments/internal notes. The per-ticket Show endpoint exposes no SLA, so the SLA block is resolved via a scoped search and may be absent for a very high-volume requester or a just-updated ticket; SLA targets and policy conditions live in list_sla_policies.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        include_comments: z.boolean().default(false).describe('Include ticket comments'),
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
        ticket_id: z.number().int().describe('Ticket ID'),
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
        'Search tickets using Zendesk query syntax, returning each result with its live SLA state (per-metric stage and breach countdown) when an SLA policy applies. Examples: "status:open assignee:me", "priority:urgent type:incident". Returns total count, so queue triage like "breaching today" works without a per-ticket fetch.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Zendesk search query string'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
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
        'Create a new Zendesk support ticket with subject, description, and optional priority/type/assignee/tags. The description becomes the first public comment of the ticket, and the new ticket id is returned. After creation, use update_ticket to change status or assignee, add_public_comment or add_private_note to reply, and manage_tags to adjust tags. Look up valid assignee_id / group_id and custom field ids via search_users or your Zendesk admin settings.',
      inputSchema: z.object({
        subject: z.string().min(1).describe('Ticket subject'),
        description: z.string().min(1).describe('Ticket description'),
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
        tags: z.array(z.string()).optional().describe('Tags to set on the ticket.'),
        custom_fields: z
          .array(z.object({ id: z.number().int(), value: z.unknown() }))
          .optional()
          .describe(
            'Custom field values as { id, value } pairs (field ids come from your Zendesk admin settings).',
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
        ticket_id: z.number().int().describe('Ticket ID'),
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
        subject: z.string().optional().describe('New ticket subject line.'),
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
            'Custom field values as { id, value } pairs (field ids come from your Zendesk admin settings).',
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
      description: 'Add an internal note (not visible to requester) to a ticket.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        body: z.string().min(1).describe('Note content'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, body } = params as { ticket_id: number; body: string };
        const token = await getToken();
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, {
          ticket: { comment: { body, public: false } },
        });
        return { content: [{ type: 'text', text: `Private note added to ticket #${ticket_id}.` }] };
      },
    },
    {
      name: 'add_public_comment',
      namespace: 'tickets',
      readOnly: false,
      title: 'Add Public Comment',
      description: 'Add a public comment (visible to requester) to a ticket.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        body: z.string().min(1).describe('Comment content'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, body } = params as { ticket_id: number; body: string };
        const token = await getToken();
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, {
          ticket: { comment: { body, public: true } },
        });
        return {
          content: [{ type: 'text', text: `Public comment added to ticket #${ticket_id}.` }],
        };
      },
    },
    {
      name: 'list_tickets',
      namespace: 'tickets',
      readOnly: true,
      title: 'List Zendesk Tickets',
      description:
        'List tickets with cursor-based pagination, sorted by most recently updated. Page size is controlled by page_size (not per_page, which is the offset-based parameter used by search_tickets); paginate by passing the returned cursor.',
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
      description: 'Get all incident tickets linked to a problem ticket.',
      inputSchema: z.object({
        problem_id: z.number().int().describe('Problem ticket ID'),
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
      description: 'Add or remove tags on a ticket.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        add: z.array(z.string()).optional().describe('Tags to add'),
        remove: z.array(z.string()).optional().describe('Tags to remove'),
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
          .describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
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
  ];
};
