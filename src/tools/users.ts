import * as z from 'zod/v4';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import type { ZendeskListResponse, ZendeskOrganization, ZendeskUser } from '../types';
import { zendeskGet } from '../client/zendesk-api';
import { buildCursorParams, buildOffsetParams, extractPaginationMeta, extractSearchPaginationMeta } from '../utils/pagination';
import { formatList, formatOrganization, formatUser } from '../utils/formatting';
import type { ToolContext, ToolDefinition } from './definitions';

export const createUserTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'get_current_user',
      namespace: 'users',
      readOnly: true,
      title: 'Get Current Zendesk User',
      description: 'Get the currently authenticated Zendesk user. Useful to verify identity and permissions.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async () => {
        const token = await getToken();
        const { user } = await zendeskGet<{ user: ZendeskUser }>(subdomain, token, '/users/me');
        return { content: [{ type: 'text', text: formatUser(user) }] };
      },
    },
    {
      name: 'search_users',
      namespace: 'users',
      readOnly: true,
      title: 'Search Zendesk Users',
      description: 'Search for users by name, email, or other criteria using Zendesk search query syntax. Returns total count.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query'),
        per_page: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { query, per_page, page } = params as { query: string; per_page: number; page: number };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskUser>>(subdomain, token, '/search', {
          query: `type:user ${query}`,
          ...buildOffsetParams(per_page, page),
        });
        return { content: [{ type: 'text', text: formatList(response.results ?? [], formatUser, extractSearchPaginationMeta(response, per_page, page)) }] };
      },
    },
    {
      name: 'get_user',
      namespace: 'users',
      readOnly: true,
      title: 'Get Zendesk User',
      description: 'Retrieve a user by ID.',
      inputSchema: z.object({ user_id: z.number().int().describe('User ID') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { user_id } = params as { user_id: number };
        const token = await getToken();
        const { user } = await zendeskGet<{ user: ZendeskUser }>(subdomain, token, `/users/${user_id}`);
        return { content: [{ type: 'text', text: formatUser(user) }] };
      },
    },
    {
      name: 'get_organization',
      namespace: 'users',
      readOnly: true,
      title: 'Get Zendesk Organization',
      description: 'Retrieve an organization by ID.',
      inputSchema: z.object({ organization_id: z.number().int().describe('Organization ID') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { organization_id } = params as { organization_id: number };
        const token = await getToken();
        const { organization } = await zendeskGet<{ organization: ZendeskOrganization }>(subdomain, token, `/organizations/${organization_id}`);
        return { content: [{ type: 'text', text: formatOrganization(organization) }] };
      },
    },
    {
      name: 'list_organizations',
      namespace: 'users',
      readOnly: true,
      title: 'List Zendesk Organizations',
      description: 'List all organizations with pagination.',
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskOrganization>>(subdomain, token, '/organizations', buildCursorParams(page_size, cursor));
        return { content: [{ type: 'text', text: formatList(response.organizations ?? [], formatOrganization, extractPaginationMeta(response)) }] };
      },
    },
  ];
};
