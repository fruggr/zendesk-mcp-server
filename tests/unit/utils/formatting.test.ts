import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARACTER_LIMIT } from '../../../src/constants';
import type { ZendeskViewCount } from '../../../src/types';
import {
  formatArticle,
  formatArticleSummary,
  formatAudit,
  formatCategory,
  formatComment,
  formatFieldValue,
  formatList,
  formatMacro,
  formatNodeTranslationSummary,
  formatOrganization,
  formatPermissionGroup,
  formatSection,
  formatSlaBlock,
  formatSlaPolicy,
  formatTagDiff,
  formatTicket,
  formatTicketField,
  formatTranslation,
  formatTranslationSummary,
  formatUser,
  formatUserSegment,
  formatView,
  truncateIfNeeded,
} from '../../../src/utils/formatting';
import {
  MOCK_ARTICLE,
  MOCK_AUDIT_CHANGE,
  MOCK_AUDIT_CREATE,
  MOCK_AUDIT_NOISE,
  MOCK_CATEGORY,
  MOCK_COMMENT,
  MOCK_MACRO,
  MOCK_ORGANIZATION,
  MOCK_PERMISSION_GROUP,
  MOCK_SECTION,
  MOCK_SECTION_TRANSLATION,
  MOCK_SLA_POLICY,
  MOCK_TICKET,
  MOCK_TICKET_FIELD_CUSTOM,
  MOCK_TICKET_FIELD_SYSTEM,
  MOCK_TRANSLATION,
  MOCK_USER,
  MOCK_USER_SEGMENT,
  MOCK_VIEW,
} from '../../msw-handlers';

describe('truncateIfNeeded', () => {
  it('returns short text unchanged', () => {
    expect(truncateIfNeeded('hello')).toBe('hello');
  });

  it('truncates text exceeding CHARACTER_LIMIT', () => {
    const long = 'x'.repeat(30_000);
    const result = truncateIfNeeded(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('truncated');
  });

  it('leaves text of exactly CHARACTER_LIMIT untouched', () => {
    // The bound is inclusive; `<` instead of `<=` would truncate a payload
    // that fits exactly.
    const exact = 'x'.repeat(CHARACTER_LIMIT);
    expect(truncateIfNeeded(exact)).toBe(exact);
  });

  it('keeps exactly CHARACTER_LIMIT characters and appends the notice verbatim', () => {
    const over = `${'x'.repeat(CHARACTER_LIMIT)}yz`;
    const result = truncateIfNeeded(over);

    expect(result.slice(0, CHARACTER_LIMIT)).toBe('x'.repeat(CHARACTER_LIMIT));
    // The notice states the real size and the limit — that is what tells the
    // caller how much to narrow the query by.
    expect(result.slice(CHARACTER_LIMIT)).toBe(
      `\n\n--- Response truncated (${CHARACTER_LIMIT + 2} chars, limit ${CHARACTER_LIMIT}). Use pagination or filters to reduce results. ---`,
    );
  });

  it('appends the caller-supplied advice in place of the default sentence', () => {
    // A tool with no pagination parameters must not be told to paginate (#265),
    // so the advice is per-call-site while the size/limit prefix stays shared.
    const over = `${'x'.repeat(CHARACTER_LIMIT)}yz`;
    const result = truncateIfNeeded(over, 'Read it with list_ticket_comments.');

    expect(result.slice(CHARACTER_LIMIT)).toBe(
      `\n\n--- Response truncated (${CHARACTER_LIMIT + 2} chars, limit ${CHARACTER_LIMIT}). Read it with list_ticket_comments. ---`,
    );
  });

  it('ignores the advice when the text fits', () => {
    expect(truncateIfNeeded('hello', 'Read it with list_ticket_comments.')).toBe('hello');
  });
});

describe('formatTicket', () => {
  it('renders every field of a fully populated ticket', () => {
    expect(formatTicket(MOCK_TICKET)).toMatchInlineSnapshot(`
      "## Ticket #1: Test ticket
      - **Status**: open | **Priority**: normal | **Type**: incident
      - **Requester**: 200 | **Assignee**: 100
      - **Tags**: test, mock
      - **Created**: 2026-01-01T00:00:00Z | **Updated**: 2026-01-02T00:00:00Z

      A test ticket"
    `);
  });

  it('falls back to none/unassigned and drops the body when the ticket is bare', () => {
    expect(
      formatTicket({
        ...MOCK_TICKET,
        priority: null,
        type: null,
        assignee_id: null,
        tags: [],
        description: '',
      }),
    ).toMatchInlineSnapshot(`
      "## Ticket #1: Test ticket
      - **Status**: open | **Priority**: none | **Type**: none
      - **Requester**: 200 | **Assignee**: unassigned
      - **Tags**: none
      - **Created**: 2026-01-01T00:00:00Z | **Updated**: 2026-01-02T00:00:00Z"
    `);
  });
});

describe('formatSlaPolicy', () => {
  it('renders all/any conditions, a null-valued condition and per-priority targets', () => {
    // A null condition value renders as empty, so the line would keep a trailing
    // space without the `.trim()`; `any` must be non-empty for its own map to
    // be observable at all.
    expect(
      formatSlaPolicy({
        ...MOCK_SLA_POLICY,
        filter: {
          all: [
            ...MOCK_SLA_POLICY.filter.all,
            { field: 'assignee_id', operator: 'is', value: null },
          ],
          any: [
            { field: 'priority', operator: 'is', value: 'urgent' },
            { field: 'group_id', operator: 'is', value: null },
          ],
        },
        policy_metrics: MOCK_SLA_POLICY.policy_metrics.map((m, i) =>
          i === 1 ? { ...m, business_hours: true } : m,
        ),
      }),
    ).toMatchInlineSnapshot(`
      "## SLA policy: SLA contractuels fruggr - Bugs/Incidents (123)
      - **Description**: Contractual SLA for bugs and incidents
      - **Position**: 1
      - **Conditions**: all: type is incident; all: custom_status_id includes ["1","2"]; all: assignee_id is; any: priority is urgent; any: group_id is
      - **Targets**:
        - high / first_reply_time: 420 min
        - high / total_resolution_time: 4200 min (business)"
    `);
  });

  it('drops the description, conditions and targets lines when the policy has none', () => {
    expect(
      formatSlaPolicy({
        ...MOCK_SLA_POLICY,
        description: '',
        filter: { all: [], any: [] },
        policy_metrics: [],
      }),
    ).toMatchInlineSnapshot(`
      "## SLA policy: SLA contractuels fruggr - Bugs/Incidents (123)
      - **Position**: 1"
    `);
  });
});

describe('formatSlaBlock', () => {
  // A real clock makes the countdown unassertable — "some number of minutes" is
  // the loosest possible claim about arithmetic. Pinning `now` lets every branch
  // of the countdown be stated exactly, boundary included.
  const NOW = new Date('2026-06-01T12:00:00Z');
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
  const entry = (metrics: unknown[]) => ({ policy_metrics: metrics }) as never;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty string when no SLA applies', () => {
    expect(formatSlaBlock(undefined)).toBe('');
    expect(formatSlaBlock(entry([]))).toBe('');
  });

  it('states the exact number of minutes remaining', () => {
    expect(
      formatSlaBlock(entry([{ metric: 'first_reply_time', stage: 'active', breach_at: at(90) }])),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **Next breach**: 2026-06-01T13:30:00.000Z
      - **first_reply_time** — active; due 2026-06-01T13:30:00.000Z — 90 min remaining"
    `);
  });

  it('reports the earliest future breach, not the latest', () => {
    expect(
      formatSlaBlock(
        entry([
          { metric: 'first_reply_time', stage: 'active', breach_at: at(240) },
          { metric: 'total_resolution_time', stage: 'active', breach_at: at(30) },
        ]),
      ),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **Next breach**: 2026-06-01T12:30:00.000Z
      - **first_reply_time** — active; due 2026-06-01T16:00:00.000Z — 240 min remaining
      - **total_resolution_time** — active; due 2026-06-01T12:30:00.000Z — 30 min remaining"
    `);
  });

  it('counts a deadline at the current instant as 0 min remaining, not as a next breach', () => {
    // The two boundaries meet here: `t > Date.now()` must not advertise a "next
    // breach" that is already due (hence no such line below), and `remaining < 0`
    // must not call 0 overdue.
    expect(
      formatSlaBlock(entry([{ metric: 'first_reply_time', stage: 'active', breach_at: at(0) }])),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **first_reply_time** — active; due 2026-06-01T12:00:00.000Z — 0 min remaining"
    `);
  });

  it('flags a breached metric as overdue instead of a negative countdown', () => {
    expect(
      formatSlaBlock(entry([{ metric: 'first_reply_time', stage: 'active', breach_at: at(-75) }])),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **first_reply_time** — active; due 2026-06-01T10:45:00.000Z — breached (75 min overdue)"
    `);
  });

  it('omits the next-breach line when every deadline is already past', () => {
    // A past deadline is not a *next* breach: it must be filtered out, not
    // reported as the soonest one.
    expect(
      formatSlaBlock(
        entry([
          { metric: 'first_reply_time', stage: 'active', breach_at: at(-120) },
          { metric: 'total_resolution_time', stage: 'active', breach_at: at(-10) },
        ]),
      ),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **first_reply_time** — active; due 2026-06-01T10:00:00.000Z — breached (120 min overdue)
      - **total_resolution_time** — active; due 2026-06-01T11:50:00.000Z — breached (10 min overdue)"
    `);
  });

  it('omits the countdown for paused, achieved and fulfilled stages', () => {
    // The `Next breach` line in this snapshot is today's output, not endorsed
    // behaviour: the header counts every future `breach_at` regardless of stage,
    // so it announces a breach for metrics this very test shows carry no live
    // countdown. Pinned here so the disagreement is visible rather than silent —
    // #260 owns the fix and the call on whether `paused` should feed the header.
    expect(
      formatSlaBlock(
        entry([
          { metric: 'agent_work_time', stage: 'paused', breach_at: at(60) },
          { metric: 'first_reply_time', stage: 'achieved', breach_at: at(60) },
          { metric: 'total_resolution_time', stage: 'fulfilled', breach_at: at(60) },
        ]),
      ),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **Next breach**: 2026-06-01T13:00:00.000Z
      - **agent_work_time** — paused; due 2026-06-01T13:00:00.000Z
      - **first_reply_time** — achieved; due 2026-06-01T13:00:00.000Z
      - **total_resolution_time** — fulfilled; due 2026-06-01T13:00:00.000Z"
    `);
  });

  it('tolerates an unparseable timestamp without crashing or counting down', () => {
    expect(
      formatSlaBlock(
        entry([{ metric: 'first_reply_time', stage: 'active', breach_at: 'not-a-date' }]),
      ),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **first_reply_time** — active; due not-a-date"
    `);
  });

  it('labels a metric with no stage as unknown, and omits the deadline when absent', () => {
    expect(
      formatSlaBlock(
        entry([
          { metric: 'first_reply_time', breach_at: null },
          { metric: 'agent_work_time', stage: undefined, breach_at: at(45) },
        ]),
      ),
    ).toMatchInlineSnapshot(`
      "

      ### SLA
      - **Next breach**: 2026-06-01T12:45:00.000Z
      - **first_reply_time** — unknown
      - **agent_work_time** — unknown; due 2026-06-01T12:45:00.000Z — 45 min remaining"
    `);
  });
});

describe('formatComment', () => {
  it('renders a public comment with its id, attachment ids and content types', () => {
    expect(formatComment(MOCK_COMMENT)).toMatchInlineSnapshot(`
      "### Public comment (id 3000) by 9999
      *2026-01-01T00:00:00Z*
      Attachments: #30001 (image/png), #30002 (application/pdf), #30003 (image/png)

      This is a comment"
    `);
  });

  it('renders an internal note with no attachment line', () => {
    expect(
      formatComment({ ...MOCK_COMMENT, public: false, attachments: [] }),
    ).toMatchInlineSnapshot(`
      "### Internal note (id 3000) by 9999
      *2026-01-01T00:00:00Z*

      This is a comment"
    `);
  });

  it('omits the Attachments line when the comment has none', () => {
    const result = formatComment({ ...MOCK_COMMENT, attachments: undefined });
    expect(result).not.toContain('Attachments:');
  });

  it('resolves the author to "Name (id)" when the map carries it', () => {
    const result = formatComment(MOCK_COMMENT, new Map([[9999, 'Agent Smith']]));
    expect(result).toContain('### Public comment (id 3000) by Agent Smith (9999)');
  });

  it('falls back to the bare id when the map lacks the author', () => {
    const result = formatComment(MOCK_COMMENT, new Map([[1234, 'Someone Else']]));
    expect(result).toContain('### Public comment (id 3000) by 9999');
  });

  it('labels the system actor rather than showing -1 alone', () => {
    // Zendesk attributes trigger/automation-driven comments to author_id -1,
    // which has no user record to resolve.
    const result = formatComment({ ...MOCK_COMMENT, author_id: -1 }, new Map());
    expect(result).toContain('### Public comment (id 3000) by System (-1)');
  });
});

describe('formatAudit', () => {
  const names = {
    users: new Map([
      [100, 'Agent Smith'],
      [200, 'Requester Jane'],
    ]),
    groups: new Map([[300, 'Support']]),
  };

  it('renders a Create audit as founding facts with actor, channel and comment presence', () => {
    const result = formatAudit(MOCK_AUDIT_CREATE, names) ?? '';
    expect(result).toContain('Requester Jane (200)');
    expect(result).toContain('via web');
    expect(result).toContain('**status**: new');
    expect(result).toContain('**priority**: normal');
    expect(result).toContain('Public comment added');
    // Comment bodies never leak into the timeline.
    expect(result).not.toContain('Initial request body');
    // Non-whitelisted Create fields are dropped from the founding block.
    expect(result).not.toContain('custom_status_id');
  });

  it('renders changes as before → after with resolved names and a tag diff', () => {
    const result = formatAudit(MOCK_AUDIT_CHANGE, names) ?? '';
    expect(result).toContain('Agent Smith (100)');
    expect(result).toContain('**status**: new → open');
    expect(result).toContain('**assignee**: (none) → Agent Smith (100)');
    expect(result).toContain('**group**: (none) → Support (300)');
    expect(result).toContain('**tags**: +urgent');
    expect(result).toContain('Internal note added');
    // System noise and comment bodies are filtered out.
    expect(result).not.toContain('email sent');
    expect(result).not.toContain('internal note body');
  });

  it('returns null for an audit carrying only system-noise events', () => {
    expect(formatAudit(MOCK_AUDIT_NOISE, names)).toBeNull();
  });

  it('labels the Zendesk system actor (author_id -1) instead of a bare id', () => {
    const audit = {
      id: 9200,
      ticket_id: 1,
      created_at: '2026-01-06T00:00:00Z',
      author_id: -1,
      via: { channel: 'rule' },
      events: [
        { id: 1, type: 'Change', field_name: 'status', value: 'solved', previous_value: 'open' },
      ],
    };
    const result = formatAudit(audit, names) ?? '';
    expect(result).toContain('System (-1)');
    expect(result).toContain('**status**: open → solved');
  });

  it('falls back to bare ids when names are unresolved', () => {
    const result = formatAudit(MOCK_AUDIT_CHANGE, { users: new Map(), groups: new Map() }) ?? '';
    expect(result).toContain('**assignee**: (none) → 100');
    expect(result).toContain('**group**: (none) → 300');
  });

  it('renders SLA-metric changes as minutes and summarises secondary events', () => {
    const audit = {
      id: 9100,
      ticket_id: 1,
      created_at: '2026-01-04T00:00:00Z',
      author_id: 100,
      via: { channel: 'api' },
      events: [
        {
          id: 1,
          type: 'Change',
          field_name: 'requester_wait_time',
          value: { minutes: 45, in_business_hours: false },
          previous_value: { minutes: 150, in_business_hours: false },
        },
        { id: 2, type: 'CommentPrivacyChange' },
        { id: 3, type: 'FollowersChange' },
        { id: 4, type: 'EmailCcChange' },
        { id: 5, type: 'SatisfactionRating' },
      ],
    };
    const result = formatAudit(audit, names) ?? '';
    expect(result).toContain('150 min → 45 min');
    expect(result).toContain('Comment visibility changed');
    expect(result).toContain('Followers changed');
    expect(result).toContain('Email CCs changed');
    expect(result).toContain('Satisfaction rating recorded');
  });

  it('omits a change whose value is unchanged after rendering', () => {
    const audit = {
      id: 9101,
      ticket_id: 1,
      created_at: '2026-01-05T00:00:00Z',
      author_id: 100,
      via: {},
      events: [
        { id: 1, type: 'Change', field_name: 'status', value: 'open', previous_value: 'open' },
      ],
    };
    // Only a no-op change → nothing meaningful to show → null.
    expect(formatAudit(audit, names)).toBeNull();
  });
});

describe('formatAudit — Create events', () => {
  const names = {
    users: new Map([
      [100, 'Agent Smith'],
      [200, 'Requester Jane'],
    ]),
    groups: new Map([[300, 'Support']]),
  };

  const create = (events: unknown[]) =>
    ({
      id: 9300,
      ticket_id: 1,
      created_at: '2026-02-01T00:00:00Z',
      author_id: 200,
      via: { channel: 'web' },
      events,
    }) as never;

  it('renders every whitelisted founding fact, and only those', () => {
    // One event per member of the Create whitelist, plus a non-member: emptying
    // any member of the set drops its line, and only this covers all of them.
    expect(
      formatAudit(
        create([
          { id: 1, type: 'Create', field_name: 'status', value: 'new' },
          { id: 2, type: 'Create', field_name: 'priority', value: 'urgent' },
          { id: 3, type: 'Create', field_name: 'type', value: 'incident' },
          { id: 4, type: 'Create', field_name: 'assignee_id', value: '100' },
          { id: 5, type: 'Create', field_name: 'group_id', value: '300' },
          { id: 6, type: 'Create', field_name: 'subject', value: 'Scanner is down' },
          { id: 7, type: 'Create', field_name: 'tags', value: ['urgent', 'scanner'] },
          { id: 8, type: 'Create', field_name: 'custom_status_id', value: '1' },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-01T00:00:00Z — Requester Jane (200) via web
      - **status**: new
      - **priority**: urgent
      - **type**: incident
      - **assignee**: Agent Smith (100)
      - **group**: Support (300)
      - **subject**: Scanner is down
      - **tags**: urgent, scanner"
    `);
  });

  it('drops the tags line when the Create carries no tag', () => {
    expect(
      formatAudit(
        create([
          { id: 1, type: 'Create', field_name: 'status', value: 'new' },
          { id: 2, type: 'Create', field_name: 'tags', value: [] },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-01T00:00:00Z — Requester Jane (200) via web
      - **status**: new"
    `);
  });

  it('drops a tags value that is not an array rather than stringifying it', () => {
    // `tags` takes a dedicated branch precisely so a malformed value is dropped
    // instead of rendered; falling through would print it as a scalar.
    expect(
      formatAudit(
        create([
          { id: 1, type: 'Create', field_name: 'status', value: 'new' },
          { id: 2, type: 'Create', field_name: 'tags', value: 'urgent,scanner' },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-01T00:00:00Z — Requester Jane (200) via web
      - **status**: new"
    `);
  });

  it('drops a whitelisted field whose value is empty', () => {
    expect(
      formatAudit(
        create([
          { id: 1, type: 'Create', field_name: 'status', value: 'new' },
          { id: 2, type: 'Create', field_name: 'subject', value: '' },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-01T00:00:00Z — Requester Jane (200) via web
      - **status**: new"
    `);
  });
});

describe('formatAudit — Change events', () => {
  const names = {
    users: new Map([
      [100, 'Agent Smith'],
      [200, 'Requester Jane'],
      [201, 'Requester Bob'],
    ]),
    groups: new Map([[300, 'Support']]),
  };

  const change = (events: unknown[], over: Record<string, unknown> = {}) =>
    ({
      id: 9400,
      ticket_id: 1,
      created_at: '2026-02-02T00:00:00Z',
      author_id: 100,
      via: { channel: 'api' },
      events,
      ...over,
    }) as never;

  it('resolves requester and submitter ids to names under their own labels', () => {
    // Both fields are in AUDIT_ENTITY_FIELDS *and* AUDIT_FIELD_LABELS: dropping
    // either mapping degrades the line to a bare id or a raw field name.
    expect(
      formatAudit(
        change([
          {
            id: 1,
            type: 'Change',
            field_name: 'requester_id',
            value: '201',
            previous_value: '200',
          },
          {
            id: 2,
            type: 'Change',
            field_name: 'submitter_id',
            value: '100',
            previous_value: '200',
          },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **requester**: Requester Jane (200) → Requester Bob (201)
      - **submitter**: Requester Jane (200) → Agent Smith (100)"
    `);
  });

  it('renders a cleared field as "(none)" on the after side', () => {
    expect(
      formatAudit(
        change([
          { id: 1, type: 'Change', field_name: 'subject', value: null, previous_value: 'Old' },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **subject**: Old → (none)"
    `);
  });

  it('renders an entity id with no previous value as "(none)", not as "null"', () => {
    // `renderAuditValue` short-circuits on null/undefined; without it the id
    // resolver would stringify the absent side.
    expect(
      formatAudit(
        change([
          { id: 1, type: 'Change', field_name: 'assignee_id', value: '100', previous_value: null },
          { id: 2, type: 'Change', field_name: 'group_id', value: '300' },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **assignee**: (none) → Agent Smith (100)
      - **group**: (none) → Support (300)"
    `);
  });

  it('drops a Change event carrying no field name', () => {
    expect(
      formatAudit(
        change([
          { id: 1, type: 'Change', value: 'whatever', previous_value: 'other' },
          { id: 2, type: 'Change', field_name: 'status', value: 'open', previous_value: 'new' },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **status**: new → open"
    `);
  });

  it('renders an SLA-metric object as its minutes, and a non-numeric one as data', () => {
    expect(
      formatAudit(
        change([
          {
            id: 1,
            type: 'Change',
            field_name: 'requester_wait_time',
            value: { minutes: 45, in_business_hours: false },
            previous_value: { minutes: 150, in_business_hours: false },
          },
          {
            id: 2,
            type: 'Change',
            field_name: 'agent_wait_time',
            value: { minutes: 'n/a' },
            previous_value: { minutes: 12 },
          },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **requester_wait_time**: 150 min → 45 min
      - **agent_wait_time**: 12 min → {"minutes":"n/a"}"
    `);
  });

  it('renders an emptied entity field as (none), whatever the name maps carry', () => {
    // `withName` resolves through `Number(value)`, and `Number('')` is 0. The
    // production caller never puts 0 in these maps, but `AuditNames` is a plain
    // `Map<number, string>` and cannot say so — the empty-value guard in
    // `renderAuditValue` is what keeps a cleared field from picking up whatever
    // name happens to sit at that key.
    expect(
      formatAudit(
        change([
          { id: 1, type: 'Change', field_name: 'assignee_id', value: '', previous_value: '100' },
        ]),
        { users: new Map([...names.users, [0, 'Not A Real User']]), groups: names.groups },
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **assignee**: Agent Smith (100) → (none)"
    `);
  });

  it('never reads an array as an SLA metric', () => {
    // The metric branch destructures `minutes` and reports it as a duration, so an
    // array that carries such a property must not reach it — `!Array.isArray` is
    // the guard, and an array is the one value that can hold both shapes.
    const arrayWithMinutes = Object.assign(['1', '2'], { minutes: 5 });
    expect(
      formatAudit(
        change([
          {
            id: 1,
            type: 'Change',
            field_name: 'custom_field_1',
            value: arrayWithMinutes,
            previous_value: null,
          },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - **custom_field_1**: (none) → 1, 2"
    `);
  });

  it('attributes a voice comment like a regular one', () => {
    expect(
      formatAudit(
        change([
          { id: 1, type: 'VoiceComment', body: 'call recording', public: true, author_id: 100 },
          { id: 2, type: 'VoiceComment', body: 'private call note', public: false, author_id: 100 },
        ]),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100) via api
      - Public comment added
      - Internal note added"
    `);
  });

  it('omits the channel from the heading when the audit carries no via', () => {
    expect(
      formatAudit(
        change(
          [{ id: 1, type: 'Change', field_name: 'status', value: 'open', previous_value: 'new' }],
          {
            via: undefined,
          },
        ),
        names,
      ),
    ).toMatchInlineSnapshot(`
      "### 2026-02-02T00:00:00Z — Agent Smith (100)
      - **status**: new → open"
    `);
  });
});

describe('formatUser', () => {
  it('renders name, email, role, role type, active flag and organization', () => {
    expect(formatUser({ ...MOCK_USER, role_type: 4 })).toMatchInlineSnapshot(`
      "## Test User (9999)
      - **Email**: test@example.com
      - **Role**: admin
      - **Role type**: 4
      - **Active**: true
      - **Organization**: 400"
    `);
  });

  it('drops the role type and organization lines when both are absent', () => {
    expect(
      formatUser({ ...MOCK_USER, role_type: null, organization_id: null, active: false }),
    ).toMatchInlineSnapshot(`
      "## Test User (9999)
      - **Email**: test@example.com
      - **Role**: admin
      - **Active**: false"
    `);
  });
});

describe('formatOrganization', () => {
  it('renders details, domains and tags', () => {
    expect(
      formatOrganization({
        ...MOCK_ORGANIZATION,
        domain_names: ['example.com', 'example.org'],
        tags: ['vip', 'eu'],
      }),
    ).toMatchInlineSnapshot(`
      "## Test Org (400)
      - **Details**: A test org
      - **Domains**: example.com, example.org
      - **Tags**: vip, eu"
    `);
  });

  it('drops details, domains and tags when the organization has none', () => {
    expect(
      formatOrganization({ ...MOCK_ORGANIZATION, details: '', domain_names: [], tags: [] }),
    ).toMatchInlineSnapshot(`"## Test Org (400)"`);
  });
});

describe('formatArticle', () => {
  it('renders the summary, a blank line, then the body', () => {
    expect(formatArticle(MOCK_ARTICLE)).toMatchInlineSnapshot(`
      "## How to test (5000)
      - **Locale**: en-us | **Source locale**: en-us
      - **Section**: 600 | **Draft**: false
      - **Permission group**: 12001 | **User segment**: 15001
      - **Position**: 0
      - **Labels**: guide
      - **Created**: 2026-01-01T00:00:00Z | **Updated**: 2026-01-02T00:00:00Z

      <p>Testing guide</p>"
    `);
  });
});

describe('formatArticleSummary', () => {
  it('renders locale, section, visibility ids, position and labels', () => {
    expect(
      formatArticleSummary({ ...MOCK_ARTICLE, label_names: ['guide', 'setup'] }),
    ).toMatchInlineSnapshot(`
      "## How to test (5000)
      - **Locale**: en-us | **Source locale**: en-us
      - **Section**: 600 | **Draft**: false
      - **Permission group**: 12001 | **User segment**: 15001
      - **Position**: 0
      - **Labels**: guide, setup
      - **Created**: 2026-01-01T00:00:00Z | **Updated**: 2026-01-02T00:00:00Z"
    `);
  });

  it('renders the promoted caveat and drops position, labels and the segment id', () => {
    expect(
      formatArticleSummary({
        ...MOCK_ARTICLE,
        promoted: true,
        position: undefined as unknown as number,
        label_names: [],
        user_segment_id: null,
      }),
    ).toMatchInlineSnapshot(`
      "## How to test (5000)
      - **Locale**: en-us | **Source locale**: en-us
      - **Section**: 600 | **Draft**: false
      - **Promoted**: featured in its section — changing this requires Help Center admin (Guide admin) rights; set via update_article \`promoted\`.
      - **Permission group**: 12001 | **User segment**: everyone (no segment)
      - **Created**: 2026-01-01T00:00:00Z | **Updated**: 2026-01-02T00:00:00Z"
    `);
  });

  it('does not include body', () => {
    const result = formatArticleSummary(MOCK_ARTICLE);
    expect(result).not.toContain('Testing guide');
  });
});

describe('formatTranslation', () => {
  it('renders the summary, a blank line, then the body', () => {
    expect(formatTranslation(MOCK_TRANSLATION)).toMatchInlineSnapshot(`
      "## Translation: fr (7000)
      - **Title**: Comment tester
      - **Draft**: false
      - **Updated**: 2026-01-02T00:00:00Z

      <p>Guide de test</p>"
    `);
  });
});

describe('formatTranslationSummary', () => {
  it('renders locale, id, title, draft and updated', () => {
    expect(formatTranslationSummary(MOCK_TRANSLATION)).toMatchInlineSnapshot(`
      "## Translation: fr (7000)
      - **Title**: Comment tester
      - **Draft**: false
      - **Updated**: 2026-01-02T00:00:00Z"
    `);
  });

  it('does not include body', () => {
    const result = formatTranslationSummary(MOCK_TRANSLATION);
    expect(result).not.toContain('Guide de test');
  });
});

describe('formatCategory', () => {
  it('renders name, id and description, and says so when there is none', () => {
    expect(formatCategory(MOCK_CATEGORY)).toMatchInlineSnapshot(
      `"- **General** (800) — General category"`,
    );
    expect(formatCategory({ ...MOCK_CATEGORY, description: '' })).toMatchInlineSnapshot(
      `"- **General** (800) — No description"`,
    );
  });
});

describe('formatSection', () => {
  it('renders name, id, category and description, and says so when there is none', () => {
    expect(formatSection(MOCK_SECTION)).toMatchInlineSnapshot(
      `"- **FAQ** (600) — Category: 800 — Frequently asked questions"`,
    );
    expect(formatSection({ ...MOCK_SECTION, description: '' })).toMatchInlineSnapshot(
      `"- **FAQ** (600) — Category: 800 — No description"`,
    );
  });
});

describe('formatFieldValue', () => {
  it('joins arrays, JSON-encodes objects, empties null/undefined, stringifies scalars', () => {
    expect(formatFieldValue(['a', 'b'])).toBe('a, b');
    expect(formatFieldValue({ x: 1 })).toBe('{"x":1}');
    expect(formatFieldValue(null)).toBe('');
    expect(formatFieldValue(undefined)).toBe('');
    expect(formatFieldValue(0)).toBe('0');
    expect(formatFieldValue('solved')).toBe('solved');
  });

  it('renders an array of objects as JSON tokens, not "[object Object]"', () => {
    expect(formatFieldValue([{ id: 1 }, { id: 2 }])).toBe('{"id":1}, {"id":2}');
  });
});

describe('formatMacro', () => {
  it('renders title, id, active flag, scope, description and the ordered actions', () => {
    expect(formatMacro(MOCK_MACRO)).toMatchInlineSnapshot(`
      "## Close and thank the customer (id 700)
      - **active** | **Scope**: shared
      - **Description**: Solve the ticket and send a thank-you note
      - **Actions**:
        - status → solved
        - set_tags → resolved, macro_applied
        - comment_value → Thanks for your business! We hope to see you again soon."
    `);
  });

  it('marks an inactive macro, drops the description and says the actions are none', () => {
    expect(
      formatMacro({ ...MOCK_MACRO, active: false, description: '', actions: [] }),
    ).toMatchInlineSnapshot(`
      "## Close and thank the customer (id 700)
      - **inactive** | **Scope**: shared
      - **Actions**: none"
    `);
  });

  it('marks a restricted macro and previews an over-long action value', () => {
    const result = formatMacro({
      ...MOCK_MACRO,
      restriction: { type: 'Group', id: 1 },
      actions: [{ field: 'comment_value', value: 'x'.repeat(500) }],
    });
    expect(result).toContain('Scope**: restricted');
    expect(result).toContain('…');
    expect(result).not.toContain('x'.repeat(500));
  });

  it('previews an over-long action value at exactly 120 characters plus an ellipsis', () => {
    const result = formatMacro({
      ...MOCK_MACRO,
      actions: [{ field: 'comment_value', value: 'x'.repeat(121) }],
    });
    expect(result).toContain(`comment_value → ${'x'.repeat(120)}…`);
  });

  it('leaves an action value of exactly 120 characters whole', () => {
    const value = 'x'.repeat(120);
    const result = formatMacro({
      ...MOCK_MACRO,
      actions: [{ field: 'comment_value', value }],
    });
    expect(result).toContain(`comment_value → ${value}`);
    expect(result).not.toContain('…');
  });

  it('collapses whitespace runs in an action value onto one line', () => {
    // A canned reply arrives with newlines and indentation; the macro list has
    // to stay scannable.
    const result = formatMacro({
      ...MOCK_MACRO,
      actions: [{ field: 'comment_value', value: '  Hello\n\n   there  ' }],
    });
    expect(result).toContain('comment_value → Hello there');
  });

  it('treats an empty-object restriction as shared, not restricted', () => {
    // The Zendesk list-macros response renders an unrestricted macro's
    // `restriction` as `{}`; a truthiness check would mislabel it "restricted".
    const result = formatMacro({ ...MOCK_MACRO, restriction: {} as never });
    expect(result).toContain('Scope**: shared');
  });

  it('does not crash when a macro has no actions array', () => {
    const result = formatMacro({ ...MOCK_MACRO, actions: undefined as never });
    expect(result).toContain('**Actions**: none');
  });
});

describe('formatList', () => {
  it('renders the pagination header, then the items separated by a blank line', () => {
    expect(
      formatList([MOCK_CATEGORY, { ...MOCK_CATEGORY, id: 801, name: 'Billing' }], formatCategory, {
        has_more: true,
        after_cursor: 'abc',
        count: 42,
      }),
    ).toMatchInlineSnapshot(`
      "Results: 42 | More available (cursor: abc)

      - **General** (800) — General category

      - **Billing** (801) — General category"
    `);
  });

  it('passes a caller-supplied advice through to the truncation notice', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      ...MOCK_CATEGORY,
      id: 800 + i,
      name: 'x'.repeat(100),
    }));
    const text = formatList(items, formatCategory, undefined, 'This tool takes no parameters.');
    expect(text.endsWith('). This tool takes no parameters. ---')).toBe(true);
  });

  it('keeps the default truncation advice when the caller supplies none', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      ...MOCK_CATEGORY,
      id: 800 + i,
      name: 'x'.repeat(100),
    }));
    const text = formatList(items, formatCategory);
    expect(text.endsWith('). Use pagination or filters to reduce results. ---')).toBe(true);
  });

  it('omits the header entirely when there is no pagination meta', () => {
    expect(formatList([MOCK_CATEGORY], formatCategory)).toMatchInlineSnapshot(
      `"- **General** (800) — General category"`,
    );
  });

  it('reports the result count without a cursor when there is no next page', () => {
    expect(
      formatList([MOCK_CATEGORY], formatCategory, {
        has_more: false,
        after_cursor: '',
        count: 1,
      }),
    ).toMatchInlineSnapshot(`
      "Results: 1

      - **General** (800) — General category"
    `);
  });
});

describe('formatTicketField', () => {
  it('renders a system field with its accepted value tags', () => {
    expect(
      formatTicketField({ ...MOCK_TICKET_FIELD_SYSTEM, tag: 'priority_tag' }),
    ).toMatchInlineSnapshot(`
      "## Priority (id 10)
      - **Type**: priority | **active, optional**
      - **Description**: Ticket priority
      - **Tag**: priority_tag
      - **Options** (name → value):
        - Low → low
        - High → high"
    `);
  });

  it('prefers custom_field_options over system_field_options and marks it required', () => {
    expect(
      formatTicketField({
        ...MOCK_TICKET_FIELD_CUSTOM,
        system_field_options: [{ name: 'Ignored', value: 'ignored' }],
      }),
    ).toMatchInlineSnapshot(`
      "## Severity (id 360000000001)
      - **Type**: tagger | **active, required**
      - **Description**: Customer-facing severity
      - **Options** (name → value):
        - Sev-1 → severity_1
        - Sev-2 → severity_2"
    `);
  });

  it('renders a bare inactive field with neither options array', () => {
    // Exercises the `?? []` fallback: no custom_field_options, no
    // system_field_options, and every optional line suppressed.
    expect(
      formatTicketField({
        id: 42,
        type: 'text',
        title: 'Free text',
        description: null,
        active: false,
        required: false,
      }),
    ).toMatchInlineSnapshot(`
      "## Free text (id 42)
      - **Type**: text | **inactive, optional**"
    `);
  });
});

describe('formatTagDiff', () => {
  it('renders an addition and a removal in the same diff', () => {
    // Both sides non-empty is what pins the `added.length + removed.length`
    // sum: a difference would read as unchanged when the counts match.
    expect(formatTagDiff(['keep', 'gone'], ['keep', 'new'])).toMatchInlineSnapshot(
      `"- **tags**: +new, -gone"`,
    );
  });

  it('renders additions only, and removals only', () => {
    expect(formatTagDiff(['keep'], ['keep', 'new'])).toMatchInlineSnapshot(`"- **tags**: +new"`);
    expect(formatTagDiff(['keep', 'gone'], ['keep'])).toMatchInlineSnapshot(`"- **tags**: -gone"`);
  });

  it('returns null when the set is unchanged', () => {
    expect(formatTagDiff(['keep', 'other'], ['other', 'keep'])).toBeNull();
  });

  it('treats a non-array side as empty rather than seeding it', () => {
    expect(formatTagDiff(undefined, ['new'])).toMatchInlineSnapshot(`"- **tags**: +new"`);
    expect(formatTagDiff(['gone'], null)).toMatchInlineSnapshot(`"- **tags**: -gone"`);
    expect(formatTagDiff(undefined, undefined)).toBeNull();
  });

  it('stringifies non-string tags', () => {
    expect(formatTagDiff([1], [1, 2])).toMatchInlineSnapshot(`"- **tags**: +2"`);
  });
});

describe('formatView', () => {
  const count = (over: Partial<ZendeskViewCount>): ZendeskViewCount => ({
    view_id: MOCK_VIEW.id,
    value: 298,
    pretty: '298',
    fresh: true,
    ...over,
  });

  it('renders a view with a fresh count and a description', () => {
    expect(formatView(MOCK_VIEW, count({}))).toMatchInlineSnapshot(
      `"- **Unassigned tickets** (id 25) — 298 ticket(s) — Tickets with no assignee"`,
    );
  });

  it('marks a non-fresh count as updating', () => {
    expect(
      formatView(MOCK_VIEW, count({ value: null, pretty: '...', fresh: false })),
    ).toMatchInlineSnapshot(
      `"- **Unassigned tickets** (id 25) — ... ticket(s) (count updating) — Tickets with no assignee"`,
    );
  });

  it('omits the count and the description when neither is available', () => {
    expect(formatView({ ...MOCK_VIEW, description: null })).toMatchInlineSnapshot(
      `"- **Unassigned tickets** (id 25)"`,
    );
  });
});

describe('formatPermissionGroup', () => {
  it('flags a built-in group and leaves a custom one unmarked', () => {
    expect(
      formatPermissionGroup({ ...MOCK_PERMISSION_GROUP, built_in: true }),
    ).toMatchInlineSnapshot(`"- **Editors** (12001) — Built-in"`);
    expect(formatPermissionGroup(MOCK_PERMISSION_GROUP)).toMatchInlineSnapshot(
      `"- **Editors** (12001)"`,
    );
  });
});

describe('formatUserSegment', () => {
  it('flags a built-in segment and leaves a custom one unmarked', () => {
    expect(formatUserSegment(MOCK_USER_SEGMENT)).toMatchInlineSnapshot(
      `"- **Signed-in users** (15001) — signed_in_users — Built-in"`,
    );
    expect(
      formatUserSegment({ ...MOCK_USER_SEGMENT, built_in: false, user_type: 'staff' }),
    ).toMatchInlineSnapshot(`"- **Signed-in users** (15001) — staff"`);
  });
});

describe('formatNodeTranslationSummary', () => {
  it('reports a set description as present rather than inlining it', () => {
    expect(formatNodeTranslationSummary(MOCK_SECTION_TRANSLATION)).toMatchInlineSnapshot(`
      "## Translation: en-us (7100)
      - **Name**: FAQ
      - **Description**: set
      - **Draft**: false
      - **Updated**: 2026-01-02T00:00:00Z"
    `);
  });

  it('reports an empty description as empty', () => {
    expect(
      formatNodeTranslationSummary({ ...MOCK_SECTION_TRANSLATION, body: '' }),
    ).toMatchInlineSnapshot(`
      "## Translation: en-us (7100)
      - **Name**: FAQ
      - **Description**: empty
      - **Draft**: false
      - **Updated**: 2026-01-02T00:00:00Z"
    `);
  });
});
