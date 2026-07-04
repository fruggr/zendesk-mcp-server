import * as z from 'zod/v4';
import { zendeskGet } from '../client/zendesk-api';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import type { ZendeskListResponse } from '../types';
import { truncateIfNeeded } from '../utils/formatting';
import {
  buildOffsetParams,
  extractSearchPaginationMeta,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { ToolContext, ToolDefinition } from './definitions';

const formatSearchResult = (result: Record<string, unknown>): string => {
  const lines: string[] = [`## [${result['result_type']}] #${result['id']}`];
  if (result['subject']) lines.push(`**Subject**: ${result['subject']}`);
  if (result['name']) lines.push(`**Name**: ${result['name']}`);
  if (result['title']) lines.push(`**Title**: ${result['title']}`);
  if (result['email']) lines.push(`**Email**: ${result['email']}`);
  if (result['status']) lines.push(`**Status**: ${result['status']}`);
  if (result['description']) {
    const desc = String(result['description']);
    lines.push(desc.length > 200 ? `${desc.slice(0, 200)}...` : desc);
  }
  return lines.join('\n');
};

export const createSearchTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'search',
      namespace: 'tickets',
      readOnly: true,
      title: 'Zendesk Unified Search',
      description:
        'Search across tickets, users, and organizations. Supports filters like "type:ticket status:open", "type:user role:agent". Returns total count and paginated results (100 per page). Organization results include name and ID only — use get_organization for full details (tags, domains, details).',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Zendesk search query. Supports type/status/role filters (e.g. "type:ticket status:open", "type:user role:agent") and free text; omit a type filter to search tickets, users and organizations at once.',
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
        const response = await zendeskGet<ZendeskListResponse<Record<string, unknown>>>(
          subdomain,
          token,
          '/search',
          {
            query,
            ...buildOffsetParams(per_page, page),
          },
        );
        const results = response.results ?? [];
        const meta = extractSearchPaginationMeta(response, per_page, page);
        const header = `Total: ${meta.count} | Page ${page} (${results.length} results)${meta.has_more ? ` | Next page: ${meta.after_cursor}` : ''}`;
        const body = results.map(formatSearchResult).join('\n\n');
        return {
          content: [
            { type: 'text', text: truncateIfNeeded([header, body].filter(Boolean).join('\n\n')) },
          ],
        };
      },
    },
  ];
};
