import { describe, expect, it } from 'vitest';
import {
  fetchScope,
  MAX_SCOPE_PAGES,
  readGroupIds,
  type SlaScope,
  scopeKey,
  scopeLabel,
  type ZendeskGetter,
} from '../../../src/utils/sla-scope';
import { MOCK_TICKET } from '../../msw-handlers';

interface Call {
  path: string;
  params: Record<string, string>;
}

// A getter answering from `respond`, recording every call.
const recorder = (respond: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const get = (<T>(path: string, params: Record<string, string>): Promise<T> => {
    calls.push({ path, params });
    return Promise.resolve(respond({ path, params }) as T);
  }) as ZendeskGetter;
  return { calls, get };
};

const tickets = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ ...MOCK_TICKET, id: from + i }));

const noUser = () => Promise.reject(new Error('no user lookup expected'));

describe('scopeKey and scopeLabel', () => {
  it.each<[SlaScope, string, string]>([
    [{ kind: 'scope', scope: 'mine' }, 'scope:mine', 'your assigned unsolved tickets'],
    [{ kind: 'scope', scope: 'my_groups' }, 'scope:my_groups', "your groups' unsolved tickets"],
    [{ kind: 'scope', scope: 'all' }, 'scope:all', 'all unsolved tickets'],
    [{ kind: 'view', viewId: 25 }, 'view:25', 'view 25'],
    [
      { kind: 'query', query: '  priority:urgent ' },
      'query:priority:urgent',
      'the tickets matching "priority:urgent"',
    ],
  ])('%j keys as %s and reads as %s', (scope, key, label) => {
    expect(scopeKey(scope)).toBe(key);
    expect(scopeLabel(scope)).toBe(label);
  });
});

describe('fetchScope', () => {
  it('reads "mine" with one SLA-sideloaded search of the assigned unsolved tickets', async () => {
    const { calls, get } = recorder(() => ({ results: tickets(1, 2), count: 2, next_page: null }));
    const snapshot = await fetchScope({ kind: 'scope', scope: 'mine' }, get, noUser);
    expect(calls).toEqual([
      {
        path: '/search',
        params: {
          query: 'type:ticket assignee:me status<solved',
          include: 'tickets(slas)',
          per_page: '100',
          page: '1',
        },
      },
    ]);
    expect(snapshot.tickets.map((t) => t.id)).toEqual([1, 2]);
    expect(snapshot.unread).toBe(0);
  });

  it('reads "all" as every unsolved ticket, and a query as given, trimmed', async () => {
    const { calls, get } = recorder(() => ({ results: [], count: 0 }));
    await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser);
    await fetchScope({ kind: 'query', query: ' priority:urgent ' }, get, noUser);
    expect(calls.map((c) => c.params['query'])).toEqual([
      'type:ticket status<solved',
      'type:ticket priority:urgent',
    ]);
  });

  it('follows next_page up to the page cap and counts what it left unread', async () => {
    const { calls, get } = recorder(({ params }) => ({
      results: tickets(Number(params['page']) * 1000, 100),
      count: 750,
      next_page: 'more',
    }));
    const snapshot = await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser);
    expect(calls.map((c) => c.params['page'])).toEqual(['1', '2', '3', '4', '5']);
    expect(MAX_SCOPE_PAGES).toBe(5);
    expect(snapshot.tickets).toHaveLength(500);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.unread).toBe(250);
  });

  it('stops on the last page without counting anything unread', async () => {
    const { calls, get } = recorder(({ params }) => ({
      results: tickets(Number(params['page']) * 1000, 100),
      count: 150,
      next_page: params['page'] === '1' ? 'more' : null,
    }));
    const snapshot = await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser);
    expect(calls).toHaveLength(2);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.unread).toBe(0);
  });

  it('stops on an empty page even when Zendesk announces another', async () => {
    const { calls, get } = recorder(() => ({ results: [], count: 0, next_page: 'more' }));
    await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser);
    expect(calls).toHaveLength(1);
  });

  it('says it was truncated, without a number, when the cap is hit without a count', async () => {
    const { get } = recorder(({ params }) => ({
      results: tickets(Number(params['page']) * 1000, 100),
      next_page: 'more',
    }));
    const snapshot = await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser);
    expect([snapshot.truncated, snapshot.unread]).toEqual([true, 0]);
  });

  it('keeps the last count Zendesk gave when a later page omits it', async () => {
    const { get } = recorder(({ params }) => ({
      results: tickets(Number(params['page']) * 1000, 100),
      ...(params['page'] === '1' ? { count: 900 } : {}),
      next_page: 'more',
    }));
    expect((await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser)).unread).toBe(400);
  });

  it('reads a view through its tickets endpoint with the slas sideload', async () => {
    const { calls, get } = recorder(() => ({ tickets: tickets(7, 1), count: 1, next_page: null }));
    const snapshot = await fetchScope({ kind: 'view', viewId: 25 }, get, noUser);
    expect(calls).toEqual([
      {
        path: '/views/25/tickets',
        params: { include: 'slas', per_page: '100', page: '1' },
      },
    ]);
    expect(snapshot.tickets.map((t) => t.id)).toEqual([7]);
  });

  it('reads a page missing its list as empty', async () => {
    const { get } = recorder(() => ({ count: 0 }));
    expect((await fetchScope({ kind: 'view', viewId: 25 }, get, noUser)).tickets).toEqual([]);
    expect((await fetchScope({ kind: 'scope', scope: 'all' }, get, noUser)).tickets).toEqual([]);
  });

  it('reads "my_groups" as one search per group of the caller, merged', async () => {
    const { calls, get } = recorder(({ path, params }) => {
      if (path === '/users/42/group_memberships') {
        return {
          group_memberships: [{ group_id: 10 }, { group_id: 20 }],
          meta: { has_more: false },
        };
      }
      const group = params['query']?.includes('group:10') ? 10 : 20;
      return { results: group === 10 ? tickets(1, 2) : tickets(2, 2), count: 2 };
    });
    const snapshot = await fetchScope({ kind: 'scope', scope: 'my_groups' }, get, () =>
      Promise.resolve(42),
    );
    expect(calls.map((c) => c.params['query'] ?? c.path)).toEqual([
      '/users/42/group_memberships',
      'type:ticket group:10 status<solved',
      'type:ticket group:20 status<solved',
    ]);
    expect(snapshot.tickets.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('reads "my_groups" of a caller in no group as empty, with no search', async () => {
    const { calls, get } = recorder(() => ({ group_memberships: [] }));
    const snapshot = await fetchScope({ kind: 'scope', scope: 'my_groups' }, get, () =>
      Promise.resolve(42),
    );
    expect(calls).toHaveLength(1);
    expect(snapshot).toEqual({ tickets: [], truncated: false, unread: 0 });
  });
});

describe('readGroupIds', () => {
  it('walks every page of memberships and keeps each group once', async () => {
    const { calls, get } = recorder(({ params }) =>
      params['page[after]']
        ? { group_memberships: [{ group_id: 2 }, { group_id: 3 }], meta: { has_more: false } }
        : {
            group_memberships: [{ group_id: 1 }, { group_id: 2 }],
            meta: { has_more: true, after_cursor: 'NEXT' },
          },
    );
    expect(await readGroupIds(get, 7)).toEqual([1, 2, 3]);
    expect(calls).toEqual([
      { path: '/users/7/group_memberships', params: { 'page[size]': '100' } },
      {
        path: '/users/7/group_memberships',
        params: { 'page[size]': '100', 'page[after]': 'NEXT' },
      },
    ]);
  });

  it('stops when has_more comes without a cursor', async () => {
    const { calls, get } = recorder(() => ({
      group_memberships: [{ group_id: 1 }],
      meta: { has_more: true, after_cursor: null },
    }));
    expect(await readGroupIds(get, 7)).toEqual([1]);
    expect(calls).toHaveLength(1);
  });
});
