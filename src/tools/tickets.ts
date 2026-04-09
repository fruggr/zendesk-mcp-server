import * as z from 'zod/v4';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import type { ZendeskComment, ZendeskListResponse, ZendeskTicket } from '../types';
import { zendeskGet, zendeskPost, zendeskPut } from '../client/zendesk-api';
import { buildCursorParams, buildOffsetParams, extractPaginationMeta, extractSearchPaginationMeta } from '../utils/pagination';
import { formatComment, formatList, formatTicket, truncateIfNeeded } from '../utils/formatting';
import type { ToolContext, ToolDefinition } from './definitions';

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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { ticket_id, include_comments } = params as { ticket_id: number; include_comments: boolean };
        const token = await getToken();
        const { ticket } = await zendeskGet<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticket_id}`);
        let text = formatTicket(ticket);
        if (include_comments) {
          const { comments } = await zendeskGet<{ comments: ZendeskComment[] }>(subdomain, token, `/tickets/${ticket_id}/comments`);
          text += '\n\n---\n# Comments\n\n' + comments.map(formatComment).join('\n\n');
        }
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'search_tickets',
      namespace: 'tickets',
      readOnly: true,
      title: 'Search Zendesk Tickets',
      description: 'Search tickets using Zendesk query syntax (e.g., "status:open assignee:me", "priority:urgent type:incident"). Returns total count.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Zendesk search query string'),
        per_page: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { query, per_page, page } = params as { query: string; per_page: number; page: number };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(subdomain, token, '/search', {
          query: `type:ticket ${query}`,
          ...buildOffsetParams(per_page, page),
        });
        return { content: [{ type: 'text', text: formatList(response.results ?? [], formatTicket, extractSearchPaginationMeta(response, per_page, page)) }] };
      },
    },
    {
      name: 'create_ticket',
      namespace: 'tickets',
      readOnly: false,
      title: 'Create Zendesk Ticket',
      description: 'Create a new Zendesk support ticket with subject, description, and optional priority/type/assignee/tags.',
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (params) => {
        const { subject, description, ...rest } = params as Record<string, unknown>;
        const token = await getToken();
        const { ticket } = await zendeskPost<{ ticket: ZendeskTicket }>(subdomain, token, '/tickets', {
          ticket: { subject, comment: { body: description }, ...rest },
        });
        return { content: [{ type: 'text', text: `Ticket #${ticket.id} created.\n\n${formatTicket(ticket)}` }] };
      },
    },
    {
      name: 'update_ticket',
      namespace: 'tickets',
      readOnly: false,
      title: 'Update Zendesk Ticket',
      description: 'Update an existing ticket (status, priority, type, assignee, group, subject, tags, custom fields).',
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { ticket_id, ...updates } = params as { ticket_id: number } & Record<string, unknown>;
        const token = await getToken();
        const { ticket } = await zendeskPut<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticket_id}`, { ticket: updates });
        return { content: [{ type: 'text', text: `Ticket #${ticket.id} updated.\n\n${formatTicket(ticket)}` }] };
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (params) => {
        const { ticket_id, body } = params as { ticket_id: number; body: string };
        const token = await getToken();
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, { ticket: { comment: { body, public: false } } });
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (params) => {
        const { ticket_id, body } = params as { ticket_id: number; body: string };
        const token = await getToken();
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, { ticket: { comment: { body, public: true } } });
        return { content: [{ type: 'text', text: `Public comment added to ticket #${ticket_id}.` }] };
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(subdomain, token, '/tickets', buildCursorParams(page_size, cursor));
        return { content: [{ type: 'text', text: formatList(response.tickets ?? [], formatTicket, extractPaginationMeta(response)) }] };
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { problem_id } = params as { problem_id: number };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskTicket>>(subdomain, token, `/tickets/${problem_id}/incidents`);
        const incidents = response.tickets ?? [];
        const text = incidents.length > 0
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { ticket_id, add, remove } = params as { ticket_id: number; add?: string[]; remove?: string[] };
        const token = await getToken();
        const { ticket } = await zendeskGet<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticket_id}`);
        const tags = new Set(ticket.tags);
        add?.forEach((t) => tags.add(t));
        remove?.forEach((t) => tags.delete(t));
        const { ticket: updated } = await zendeskPut<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticket_id}`, { ticket: { tags: [...tags] } });
        return { content: [{ type: 'text', text: `Tags updated on ticket #${ticket_id}. Current: ${updated.tags.join(', ') || 'none'}` }] };
      },
    },
  ];
};
