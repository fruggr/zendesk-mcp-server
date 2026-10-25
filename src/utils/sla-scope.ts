import type { ZendeskTicket } from '../types';
import { mergeSnapshots, type ScopeSnapshot, toAlertTicket } from './sla-alerts';

/** The tickets an SLA alert check reads: a named scope, a view, or any search query. */
export type SlaScope =
  | { kind: 'scope'; scope: 'mine' | 'my_groups' | 'all' }
  | { kind: 'view'; viewId: number }
  | { kind: 'query'; query: string };

export type NamedScope = 'mine' | 'my_groups' | 'all';

const SCOPE_QUERIES: Record<Exclude<NamedScope, 'my_groups'>, string> = {
  mine: 'assignee:me status<solved',
  all: 'status<solved',
};

// `group:me` matches nothing, silently (PR #387 spike 2; see utils/group-me.ts), so a group scope is
// one `group:<id>` search per group, merged.
const groupQuery = (groupId: number): string => `group:${groupId} status<solved`;

/** The cache key of a scope: same tickets, same key, whoever asks. */
export const scopeKey = (scope: SlaScope): string => {
  if (scope.kind === 'scope') return `scope:${scope.scope}`;
  if (scope.kind === 'view') return `view:${scope.viewId}`;
  return `query:${scope.query.trim()}`;
};

export const scopeLabel = (scope: SlaScope): string => {
  if (scope.kind === 'view') return `view ${scope.viewId}`;
  if (scope.kind === 'query') return `the tickets matching "${scope.query.trim()}"`;
  return {
    mine: 'your assigned unsolved tickets',
    my_groups: "your groups' unsolved tickets",
    all: 'all unsolved tickets',
  }[scope.scope];
};

export type ZendeskGetter = <T>(path: string, params: Record<string, string>) => Promise<T>;

/** Bounds every scope fetch: at most this many pages of 100 tickets per search or view. */
export const MAX_SCOPE_PAGES = 5;
/** Bounds a `my_groups` check: at most this many group searches; the rest count as unread. */
export const MAX_SCOPE_GROUPS = 10;
const PAGE_SIZE = 100;

interface OffsetPage {
  count?: number;
  next_page?: string | null;
}

// Walks an offset-paginated listing until it runs out or the page cap is hit;
// whatever the cap leaves behind is counted as unread.
const readPages = async (
  fetchPage: (page: number) => Promise<OffsetPage & { tickets: ZendeskTicket[] }>,
): Promise<ScopeSnapshot> => {
  const tickets: ZendeskTicket[] = [];
  let total: number | undefined;
  let more = true;
  for (let page = 1; more && page <= MAX_SCOPE_PAGES; page += 1) {
    const response = await fetchPage(page);
    tickets.push(...response.tickets);
    total = response.count ?? total;
    more = response.next_page != null && response.tickets.length > 0;
  }
  return {
    tickets: tickets.map(toAlertTicket),
    truncated: more,
    unread: more ? Math.max((total ?? 0) - tickets.length, 0) : 0,
  };
};

const pageParams = (page: number): Record<string, string> => ({
  per_page: String(PAGE_SIZE),
  page: String(page),
});

const readSearch = (get: ZendeskGetter, query: string): Promise<ScopeSnapshot> =>
  readPages(async (page) => {
    const response = await get<OffsetPage & { results?: ZendeskTicket[] }>('/search', {
      query: `type:ticket ${query}`,
      include: 'tickets(slas)',
      ...pageParams(page),
    });
    return { ...response, tickets: response.results ?? [] };
  });

const readView = (get: ZendeskGetter, viewId: number): Promise<ScopeSnapshot> =>
  readPages(async (page) => {
    const response = await get<OffsetPage & { tickets?: ZendeskTicket[] }>(
      `/views/${viewId}/tickets`,
      { include: 'slas', ...pageParams(page) },
    );
    return { ...response, tickets: response.tickets ?? [] };
  });

interface MembershipsPage {
  group_memberships?: Array<{ group_id: number }>;
  meta?: { has_more?: boolean; after_cursor?: string | null };
}

/** The ids of the groups `userId` belongs to, every page read. */
export const readGroupIds = async (get: ZendeskGetter, userId: number): Promise<number[]> => {
  const ids: number[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { 'page[size]': String(PAGE_SIZE) };
    if (cursor) params['page[after]'] = cursor;
    const response = await get<MembershipsPage>(`/users/${userId}/group_memberships`, params);
    ids.push(...(response.group_memberships ?? []).map((m) => m.group_id));
    cursor = response.meta?.has_more ? (response.meta.after_cursor ?? undefined) : undefined;
  } while (cursor);
  return [...new Set(ids)];
};

/**
 * Reads the tickets of a scope with their live SLA, bounded by
 * `MAX_SCOPE_PAGES` per search or view and `MAX_SCOPE_GROUPS` group searches. Every call goes through `get`, so
 * through the client's retry policy.
 */
export const fetchScope = async (
  scope: SlaScope,
  get: ZendeskGetter,
  userId: () => Promise<number>,
): Promise<ScopeSnapshot> => {
  if (scope.kind === 'view') return readView(get, scope.viewId);
  if (scope.kind === 'query') return readSearch(get, scope.query.trim());
  if (scope.scope !== 'my_groups') return readSearch(get, SCOPE_QUERIES[scope.scope]);
  // One group at a time: an agent in many groups must not burst the rate limit.
  const groupIds = await readGroupIds(get, await userId());
  const snapshots: ScopeSnapshot[] = [];
  for (const id of groupIds.slice(0, MAX_SCOPE_GROUPS)) {
    snapshots.push(await readSearch(get, groupQuery(id)));
  }
  // Groups past the cap: their tickets are unread, how many is unknown.
  if (groupIds.length > MAX_SCOPE_GROUPS)
    snapshots.push({ tickets: [], truncated: true, unread: 0 });
  return mergeSnapshots(snapshots);
};
