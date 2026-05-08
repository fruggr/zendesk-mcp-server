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
  MAX_EMBEDDED_IMAGE_COUNT,
  MAX_PAGE_SIZE,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../constants';
import type {
  ZendeskComment,
  ZendeskListResponse,
  ZendeskTicket,
  ZendeskTicketAttachment,
} from '../types';
import { formatComment, formatList, formatTicket, truncateIfNeeded } from '../utils/formatting';
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
  token: string,
  attachment: ZendeskTicketAttachment,
  reference: string,
): Promise<Array<ToolTextContent | ToolImageContent>> => {
  const { data, contentType } = await fetchZendeskBinary(token, attachment.content_url);
  return [
    { type: 'image', data: data.toString('base64'), mimeType: contentType },
    { type: 'text', text: reference },
  ];
};

const fetchAllTicketComments = async (
  subdomain: string,
  token: string,
  ticketId: number,
): Promise<ZendeskComment[]> => {
  const all: ZendeskComment[] = [];
  let cursor: string | undefined;
  for (;;) {
    const response = await zendeskGet<{
      comments: ZendeskComment[];
      meta?: { has_more: boolean; after_cursor: string };
    }>(subdomain, token, `/tickets/${ticketId}/comments`, buildCursorParams(MAX_PAGE_SIZE, cursor));
    all.push(...response.comments);
    if (!response.meta?.has_more || !response.meta?.after_cursor) return all;
    cursor = response.meta.after_cursor;
  }
};

const collectAttachmentBlocks = async (
  token: string,
  attachments: ZendeskTicketAttachment[],
): Promise<Array<ToolTextContent | ToolImageContent>> => {
  const blocks: Array<ToolTextContent | ToolImageContent> = [];
  let totalEmbeddedBytes = 0;
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
    } else if (totalEmbeddedBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      skipReason = 'skipped: total embedded budget (20 MB) reached';
    }

    if (skipReason) {
      blocks.push({ type: 'text', text: `${reference} — ${skipReason}` });
      continue;
    }

    try {
      blocks.push(...(await buildEmbeddedImageBlocks(token, attachment, reference)));
      totalEmbeddedBytes += attachment.size;
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

export const createTicketTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'get_ticket',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket',
      description:
        'Retrieve a Zendesk ticket by ID, including its comments if requested. Returns ticket details (subject, status, priority, assignee, tags, description) and optionally all comments/internal notes.',
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
        let text = formatTicket(ticket);
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
        "Retrieve all attachments from a ticket's comments. Call this whenever a ticket or comment mentions an attached file or screenshot. Images are returned as base64-encoded image content blocks the LLM can describe directly (useful for accessibility). Non-image attachments are listed as text references (file name, type, size, URL).",
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        comment_id: z.number().int().optional().describe('Restrict to attachments of this comment'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, comment_id } = params as {
          ticket_id: number;
          comment_id?: number;
        };
        const token = await getToken();
        const comments = await fetchAllTicketComments(subdomain, token, ticket_id);
        const scoped =
          comment_id !== undefined ? comments.filter((c) => c.id === comment_id) : comments;
        if (comment_id !== undefined && scoped.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Comment #${comment_id} not found on ticket #${ticket_id}.`,
              },
            ],
          };
        }
        const attachments = scoped.flatMap((c) => c.attachments ?? []);
        if (attachments.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No attachments found on ticket #${ticket_id}${comment_id ? ` (comment ${comment_id})` : ''}.`,
              },
            ],
          };
        }
        const blocks = await collectAttachmentBlocks(token, attachments);
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
        'Search tickets using Zendesk query syntax (e.g., "status:open assignee:me", "priority:urgent type:incident"). Returns total count.',
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
            ...buildOffsetParams(per_page, page),
          },
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.results ?? [],
                formatTicket,
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
        'Create a new Zendesk support ticket with subject, description, and optional priority/type/assignee/tags.',
      inputSchema: z.object({
        subject: z.string().min(1).describe('Ticket subject'),
        description: z.string().min(1).describe('Ticket description'),
        priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
        type: z.enum(['problem', 'incident', 'question', 'task']).optional(),
        assignee_id: z.number().int().optional(),
        group_id: z.number().int().optional(),
        tags: z.array(z.string()).optional(),
        custom_fields: z.array(z.object({ id: z.number().int(), value: z.unknown() })).optional(),
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
        'Update an existing ticket (status, priority, type, assignee, group, subject, tags, custom fields).',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        status: z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed']).optional(),
        priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
        type: z.enum(['problem', 'incident', 'question', 'task']).optional(),
        assignee_id: z.number().int().optional(),
        group_id: z.number().int().optional(),
        subject: z.string().optional(),
        tags: z.array(z.string()).optional(),
        custom_fields: z.array(z.object({ id: z.number().int(), value: z.unknown() })).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
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
      description: 'List tickets with cursor-based pagination, sorted by most recently updated.',
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        cursor: z.string().optional().describe('Pagination cursor'),
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
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.tickets ?? [],
                formatTicket,
                extractPaginationMeta(response),
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
        destructiveHint: false,
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
  ];
};
