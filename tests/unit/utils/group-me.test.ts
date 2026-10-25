import { describe, expect, it } from 'vitest';
import { resolveGroupMe } from '../../../src/utils/group-me';
import type { ZendeskGetter } from '../../../src/utils/sla-scope';

// A getter answering the caller's memberships with `groups`, recording every path.
const memberships = (groups: number[]) => {
  const paths: string[] = [];
  const get = (<T>(path: string): Promise<T> => {
    paths.push(path);
    return Promise.resolve({
      group_memberships: groups.map((group_id) => ({ group_id })),
      meta: { has_more: false },
    } as T);
  }) as ZendeskGetter;
  return { get, paths };
};

const caller = () => Promise.resolve(42);
const noUser = () => Promise.reject(new Error('no user lookup expected'));

describe('resolveGroupMe', () => {
  it.each([
    'status:open',
    'assignee:me status<solved',
    'group:meteo',
    'group:8576146860573',
    'group me',
    'subgroup:me',
  ])('leaves %j untouched, with no lookup', async (query) => {
    const { get, paths } = memberships([10]);
    await expect(resolveGroupMe(query, get, noUser)).resolves.toEqual({ query });
    expect(paths).toEqual([]);
  });

  it.each([
    ['status<solved group:me', 'status<solved group:10'],
    ['GROUP:ME status:open', 'group:10 status:open'],
    ['status:open -group:me', 'status:open -group:10'],
    ['group:"me"', 'group:10'],
    ['group:me priority:urgent group:me', 'group:10 priority:urgent group:10'],
  ])('reads %j as the only group of the caller', async (query, expected) => {
    const { get, paths } = memberships([10]);
    await expect(resolveGroupMe(query, get, caller)).resolves.toEqual({
      query: expected,
      note: 'Note: group:me was read as group:10, your only group.',
    });
    expect(paths).toEqual(['/users/42/group_memberships']);
  });

  it('names every group of a caller in several, so the agent retries per group', async () => {
    const { get } = memberships([10, 20]);
    await expect(
      resolveGroupMe('status<solved group:me', get, caller),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: group:me is not a Zendesk search value: "me" works only for user keywords (assignee:, requester:, submitter:), and Zendesk would silently match nothing. You belong to groups 10, 20: search one with group:<id> (e.g. group:10), one call per group.]`,
    );
  });

  it('advises excluding one group when every group:me is negated', async () => {
    const { get } = memberships([10, 20]);
    await expect(
      resolveGroupMe('-group:me', get, caller),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: group:me is not a Zendesk search value: "me" works only for user keywords (assignee:, requester:, submitter:), and Zendesk would silently match nothing. You belong to groups 10, 20: exclude a group with -group:<id> (e.g. -group:10).]`,
    );
  });

  it('keeps the per-group advice when group:me is both included and excluded', async () => {
    const { get } = memberships([10, 20]);
    await expect(resolveGroupMe('group:me -group:me', get, caller)).rejects.toThrow(
      'search one with group:<id> (e.g. group:10), one call per group.',
    );
  });

  it('says a caller in no group has no group queue', async () => {
    const { get } = memberships([]);
    await expect(
      resolveGroupMe('group:me', get, caller),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: group:me is not a Zendesk search value: "me" works only for user keywords (assignee:, requester:, submitter:), and Zendesk would silently match nothing. You belong to no group, so there is no group queue to search: drop group:me, or name a group with group:<id>.]`,
    );
  });
});
