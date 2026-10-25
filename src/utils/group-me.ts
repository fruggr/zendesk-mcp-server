import { zendeskGet } from '../client/zendesk-api';
import { readGroupIds, type ZendeskGetter } from './sla-scope';
import type { SlaService } from './sla-service';

// Zendesk takes `me` for user keywords only: `group:me` is read as a group
// named "me" and silently matches nothing (#389, measured in PR #387).
const GROUP_ME = /(^|\s)(-?)group:(?:me|"me")(?=\s|$)/gi;

const NOT_A_VALUE =
  'group:me is not a Zendesk search value: "me" works only for user keywords (assignee:, requester:, submitter:), and Zendesk would silently match nothing.';

/**
 * Reads `group:me` in a search query as the caller's group. With exactly one
 * group it becomes `group:<id>`, with a note to show; with none or several it
 * throws, naming the groups, since one offset-paginated search cannot cover
 * several groups. Without `group:me`, nothing is looked up.
 */
export const resolveGroupMe = async (
  query: string,
  get: ZendeskGetter,
  userId: () => Promise<number>,
): Promise<{ query: string; note?: string }> => {
  if (query.match(GROUP_ME) === null) return { query };
  const groupIds = await readGroupIds(get, await userId());
  const [only, ...others] = groupIds;
  if (only === undefined) {
    throw new Error(
      `${NOT_A_VALUE} You belong to no group, so there is no group queue to search: drop group:me, or name a group with group:<id>.`,
    );
  }
  if (others.length === 0) {
    return {
      query: query.replace(GROUP_ME, (_, lead, negation) => `${lead}${negation}group:${only}`),
      note: `Note: group:me was read as group:${only}, your only group.`,
    };
  }
  // Searching one group per call would invert an exclusion.
  const excluding = [...query.matchAll(GROUP_ME)].every(([, , negation]) => negation === '-');
  const advice = excluding
    ? `exclude a group with -group:<id> (e.g. -group:${only})`
    : `search one with group:<id> (e.g. group:${only}), one call per group`;
  throw new Error(`${NOT_A_VALUE} You belong to groups ${groupIds.join(', ')}: ${advice}.`);
};

/** `resolveGroupMe` for a tool call: the caller comes from the SLA service when wired, else `/users/me`. */
export const resolveCallerGroupMe = (
  query: string,
  subdomain: string,
  token: string,
  sla: SlaService | undefined,
): Promise<{ query: string; note?: string }> =>
  resolveGroupMe(
    query,
    (path, params) => zendeskGet(subdomain, token, path, params),
    sla?.userId ??
      (() =>
        zendeskGet<{ user: { id: number } }>(subdomain, token, '/users/me').then(
          ({ user }) => user.id,
        )),
  );
