import * as z from 'zod/v4';
import { zendeskGet } from '../client/zendesk-api';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import type { ZendeskListResponse, ZendeskOrganization, ZendeskUser } from '../types';
import { formatList, formatOrganization, formatUser } from '../utils/formatting';
import {
  buildCursorParams,
  buildOffsetParams,
  extractPaginationMeta,
  extractSearchPaginationMeta,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { ToolDefinition, ToolEnv } from './definitions';

export const createUserTools = (env: ToolEnv): ToolDefinition[] => {
  const { subdomain } = env;

  return [
    {
      name: 'get_current_user',
      namespace: 'users',
      readOnly: true,
      title: 'Get Current Zendesk User',
      description:
        'Get the currently authenticated Zendesk user. Useful to verify identity and permissions.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (_params, { caller }) => {
        const token = await caller.getToken();
        const { user } = await zendeskGet<{ user: ZendeskUser }>(subdomain, token, '/users/me');
        return { content: [{ type: 'text', text: formatUser(user) }] };
      },
    },
    {
      name: 'search_users',
      namespace: 'users',
      readOnly: true,
      title: 'Search Zendesk Users',
      description:
        "Search for users by name, email, or other criteria using Zendesk search query syntax, returning each match's id, name, email, role, active flag and organization id, with the total count. Use it to turn a person into the numeric user id other tools take, such as the followers of update_ticket; a name can match several users, so confirm the right one. With an id already in hand, call get_user for the full record, and for your own account get_current_user. Prefer it over `search` when you want users only: `search` mixes in tickets and organizations unless the query says type:user.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Zendesk user search query — free text matched against name and email, and/or field filters like "email:jane@acme.com", "role:agent", "organization_id:123". A "type:user" scope is added automatically.',
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
      handler: async (params, { caller }) => {
        const { query, per_page, page } = params as {
          query: string;
          per_page: number;
          page: number;
        };
        const token = await caller.getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskUser>>(
          subdomain,
          token,
          '/search',
          {
            query: `type:user ${query}`,
            ...buildOffsetParams(per_page, page),
          },
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.results ?? [],
                formatUser,
                extractSearchPaginationMeta(response, per_page, page),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_user',
      namespace: 'users',
      readOnly: true,
      title: 'Get Zendesk User',
      description:
        'Retrieve a single user by their numeric id. Returns the full user record (name, email, role, organization, tags). Use search_users when you only have a name or email, or get_current_user for the authenticated identity.',
      inputSchema: z.object({
        user_id: z
          .number()
          .int()
          .describe(
            'User ID — the numeric id of the Zendesk user to fetch. Obtain it from search_users, or from the requester/assignee fields of a ticket.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { user_id } = params as { user_id: number };
        const token = await caller.getToken();
        const { user } = await zendeskGet<{ user: ZendeskUser }>(
          subdomain,
          token,
          `/users/${user_id}`,
        );
        return { content: [{ type: 'text', text: formatUser(user) }] };
      },
    },
    {
      name: 'get_organization',
      namespace: 'users',
      readOnly: true,
      title: 'Get Zendesk Organization',
      description:
        'Retrieve a single organization by its numeric id. Returns full details (name, tags, domains, notes) — more than the name/id that search or list_organizations surface. Use list_organizations to browse or search for a name-based lookup.',
      inputSchema: z.object({
        organization_id: z
          .number()
          .int()
          .describe(
            'Organization ID — the numeric id of the Zendesk organization to fetch. Obtain it from list_organizations, search, or a user record.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { organization_id } = params as { organization_id: number };
        const token = await caller.getToken();
        const { organization } = await zendeskGet<{ organization: ZendeskOrganization }>(
          subdomain,
          token,
          `/organizations/${organization_id}`,
        );
        return { content: [{ type: 'text', text: formatOrganization(organization) }] };
      },
    },
    {
      name: 'list_organizations',
      namespace: 'users',
      readOnly: true,
      title: 'List Zendesk Organizations',
      description:
        'List all organizations with pagination. Returns the name and id of each organization plus basic fields; results are cursor-paginated. Use get_organization with an id for full details (tags, domains, notes), or search for query-based lookups by name. Organizations group end users and can be referenced when creating or filtering tickets.',
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Organizations per page (1-100, default 100).'),
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
      handler: async (params, { caller }) => {
        const { page_size, cursor } = params as { page_size: number; cursor?: string };
        const token = await caller.getToken();
        const response = await zendeskGet<ZendeskListResponse<ZendeskOrganization>>(
          subdomain,
          token,
          '/organizations',
          buildCursorParams(page_size, cursor),
        );
        const organizations = response.organizations ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                organizations,
                formatOrganization,
                extractPaginationMeta(response, organizations.length),
              ),
            },
          ],
        };
      },
    },
  ];
};
