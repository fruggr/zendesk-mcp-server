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
      description: 'Get the signed-in Zendesk user. Use it to check who you act as and your role.',
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
        'Find users by name, email or Zendesk query, with id, name, email, role, active flag and organization id, plus the total. Use it to get the user id other tools take; a name can match several users, so confirm. By id: get_user; yourself: get_current_user. Prefer it to `search`, which mixes in tickets and organizations.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Name or email text and/or filters like "role:agent" or "organization_id:123"; type:user is added.',
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
        'Get a user by id: name, email, role, role type, active state, organization id. By name or email: search_users; yourself: get_current_user.',
      inputSchema: z.object({
        user_id: z
          .number()
          .int()
          .describe("User id, from search_users or a ticket's requester or assignee."),
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
        'Get an organization by id: name, details, domains, tags. Browse: list_organizations; by name: search.',
      inputSchema: z.object({
        organization_id: z
          .number()
          .int()
          .describe('Organization id, from list_organizations, search or a user.'),
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
        'List organizations with name, id, details, domains and tags; they group end users and can scope tickets. By id: get_organization; by name: search.',
      inputSchema: z.object({
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Organizations per page.'),
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
