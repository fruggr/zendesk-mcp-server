import * as z from 'zod/v4';
import { zendeskGet } from '../client/zendesk-api';
import { DEFAULT_TICKET_LIST_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import type { PaginationMeta, ZendeskListResponse } from '../types';
import { descriptionExcerpt, formatFittingList } from '../utils/formatting';
import { resolveCallerGroupMe } from '../utils/group-me';
import {
  buildOffsetParams,
  extractSearchPaginationMeta,
  offsetResume,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { ToolDefinition, ToolEnv } from './definitions';

const formatSearchResult = (result: Record<string, unknown>): string => {
  const lines: string[] = [`## [${result['result_type']}] #${result['id']}`];
  if (result['subject']) lines.push(`**Subject**: ${result['subject']}`);
  if (result['name']) lines.push(`**Name**: ${result['name']}`);
  if (result['title']) lines.push(`**Title**: ${result['title']}`);
  if (result['email']) lines.push(`**Email**: ${result['email']}`);
  if (result['status']) lines.push(`**Status**: ${result['status']}`);
  if (result['description']) lines.push(descriptionExcerpt(String(result['description'])));
  return lines.join('\n');
};

export const createSearchTools = (env: ToolEnv): ToolDefinition[] => {
  const { subdomain } = env;

  return [
    {
      name: 'search',
      namespace: 'tickets',
      readOnly: true,
      title: 'Zendesk Unified Search',
      description:
        'Search tickets, users and organizations at once; returns the total count and a page of results. Ticket descriptions are cut to 200 characters (full text: get_ticket); organizations show only name and id (more: get_organization).',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Filters like "type:ticket status:open" or "type:user role:agent", plus free text; no type filter searches all three. "me" works only with assignee:, requester:, submitter:; group:me works if you are in exactly one group (else the error names them), otherwise use group:<id>.',
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
        const resolved = await resolveCallerGroupMe(query, subdomain, token, caller.sla);
        const response = await zendeskGet<ZendeskListResponse<Record<string, unknown>>>(
          subdomain,
          token,
          '/search',
          {
            query: resolved.query,
            ...buildOffsetParams(per_page, page),
          },
        );
        const results = response.results ?? [];
        const meta = extractSearchPaginationMeta(response, per_page, page);
        const header = (m: PaginationMeta): string =>
          [
            resolved.note,
            `Total: ${m.count} | Page ${page} (${results.length} results)${m.has_more ? ` | Next page: ${m.next_page}` : ''}`,
          ]
            .filter(Boolean)
            .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: formatFittingList(
                results,
                formatSearchResult,
                meta,
                offsetResume(page, per_page),
                header,
              ),
            },
          ],
        };
      },
    },
  ];
};
