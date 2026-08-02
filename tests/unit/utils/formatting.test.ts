import { describe, expect, it } from 'vitest';
import { CHARACTER_LIMIT } from '../../../src/constants';
import {
  formatArticle,
  formatArticleSummary,
  formatAudit,
  formatCategory,
  formatComment,
  formatFieldValue,
  formatList,
  formatMacro,
  formatOrganization,
  formatSection,
  formatSlaBlock,
  formatSlaPolicy,
  formatTicket,
  formatTranslation,
  formatTranslationSummary,
  formatUser,
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
  MOCK_SECTION,
  MOCK_SLA_POLICY,
  MOCK_TICKET,
  MOCK_TRANSLATION,
  MOCK_USER,
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
});

describe('formatTicket', () => {
  it('includes ticket id and subject', () => {
    const result = formatTicket(MOCK_TICKET);
    expect(result).toContain('Ticket #1');
    expect(result).toContain('Test ticket');
  });

  it('includes status and priority', () => {
    const result = formatTicket(MOCK_TICKET);
    expect(result).toContain('open');
    expect(result).toContain('normal');
  });

  it('includes tags', () => {
    const result = formatTicket(MOCK_TICKET);
    expect(result).toContain('test, mock');
  });

  it('handles missing priority', () => {
    const result = formatTicket({ ...MOCK_TICKET, priority: null });
    expect(result).toContain('none');
  });
});

describe('formatSlaPolicy', () => {
  it('includes title, conditions and per-priority targets', () => {
    const result = formatSlaPolicy(MOCK_SLA_POLICY);
    expect(result).toContain('SLA contractuels fruggr - Bugs/Incidents');
    expect(result).toContain('(123)');
    expect(result).toContain('type is incident');
    expect(result).toContain('high / first_reply_time: 420 min');
    expect(result).toContain('high / total_resolution_time: 4200 min');
  });

  it('renders array-valued filter conditions (e.g. includes)', () => {
    const result = formatSlaPolicy(MOCK_SLA_POLICY);
    expect(result).toContain('custom_status_id includes ["1","2"]');
  });
});

describe('formatSlaBlock', () => {
  const entry = (metrics: unknown[]) => ({ policy_metrics: metrics }) as never;

  it('returns an empty string when no SLA applies', () => {
    expect(formatSlaBlock(undefined)).toBe('');
    expect(formatSlaBlock(entry([]))).toBe('');
  });

  it('shows minutes remaining for an active metric with a future breach', () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = formatSlaBlock(
      entry([{ metric: 'requester_wait_time', stage: 'active', breach_at: future }]),
    );
    expect(result).toContain('### SLA');
    expect(result).toContain('Next breach');
    expect(result).toContain('min remaining');
  });

  it('flags a breached metric as overdue instead of a negative countdown', () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const result = formatSlaBlock(
      entry([{ metric: 'first_reply_time', stage: 'active', breach_at: past }]),
    );
    expect(result).toContain('breached');
    expect(result).toContain('overdue');
    expect(result).not.toContain('min remaining');
  });

  it('omits the countdown for paused and achieved stages', () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = formatSlaBlock(
      entry([
        { metric: 'agent_work_time', stage: 'paused', breach_at: future },
        { metric: 'first_reply_time', stage: 'achieved', breach_at: future },
      ]),
    );
    expect(result).not.toContain('remaining');
  });

  it('tolerates an unparseable timestamp without crashing', () => {
    const result = formatSlaBlock(
      entry([{ metric: 'first_reply_time', stage: 'active', breach_at: 'not-a-date' }]),
    );
    expect(result).toContain('first_reply_time');
    expect(result).not.toContain('remaining');
  });
});

describe('formatComment', () => {
  it('formats public comment', () => {
    const result = formatComment(MOCK_COMMENT);
    expect(result).toContain('Public comment');
    expect(result).toContain('This is a comment');
  });

  it('formats private note', () => {
    const result = formatComment({ ...MOCK_COMMENT, public: false });
    expect(result).toContain('Internal note');
  });

  it('lists attachment ids and content types when the comment has attachments', () => {
    const result = formatComment(MOCK_COMMENT);
    expect(result).toContain('Attachments:');
    expect(result).toContain('#30001 (image/png)');
    expect(result).toContain('#30002 (application/pdf)');
    expect(result).toContain('#30003 (image/png)');
  });

  it('omits the Attachments line when the comment has none', () => {
    const result = formatComment({ ...MOCK_COMMENT, attachments: undefined });
    expect(result).not.toContain('Attachments:');
  });

  it('omits the Attachments line when the attachments array is empty', () => {
    const result = formatComment({ ...MOCK_COMMENT, attachments: [] });
    expect(result).not.toContain('Attachments:');
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

describe('formatUser', () => {
  it('includes name, email, role', () => {
    const result = formatUser(MOCK_USER);
    expect(result).toContain('Test User');
    expect(result).toContain('test@example.com');
    expect(result).toContain('admin');
  });

  it('includes organization when present', () => {
    const result = formatUser(MOCK_USER);
    expect(result).toContain('Organization');
  });

  it('omits organization when null', () => {
    const result = formatUser({ ...MOCK_USER, organization_id: null });
    expect(result).not.toContain('Organization');
  });

  it('displays role_type when present', () => {
    const result = formatUser({ ...MOCK_USER, role_type: 1 });
    expect(result).toContain('**Role type**: 1');
  });

  it('omits role_type when null', () => {
    const result = formatUser({ ...MOCK_USER, role_type: null });
    expect(result).not.toContain('Role type');
  });
});

describe('formatOrganization', () => {
  it('includes name and domains', () => {
    const result = formatOrganization(MOCK_ORGANIZATION);
    expect(result).toContain('Test Org');
    expect(result).toContain('example.com');
  });
});

describe('formatArticle', () => {
  it('includes title, locale, body', () => {
    const result = formatArticle(MOCK_ARTICLE);
    expect(result).toContain('How to test');
    expect(result).toContain('en-us');
    expect(result).toContain('Testing guide');
  });
});

describe('formatArticleSummary', () => {
  it('includes metadata', () => {
    const result = formatArticleSummary(MOCK_ARTICLE);
    expect(result).toContain('How to test');
    expect(result).toContain('5000');
    expect(result).toContain('en-us');
    expect(result).toContain('600');
    expect(result).toContain('Draft');
    expect(result).toContain('Created');
    expect(result).toContain('Updated');
  });

  it('does not include body', () => {
    const result = formatArticleSummary(MOCK_ARTICLE);
    expect(result).not.toContain('Testing guide');
  });

  it('includes labels when present', () => {
    const result = formatArticleSummary(MOCK_ARTICLE);
    expect(result).toContain('guide');
  });

  it('surfaces the permission group and user segment so their IDs can be reused', () => {
    const result = formatArticleSummary(MOCK_ARTICLE);
    expect(result).toContain('12001');
    expect(result).toContain('15001');
  });

  it('marks visibility as everyone when the article has no user segment', () => {
    const result = formatArticleSummary({
      ...MOCK_ARTICLE,
      user_segment_id: null,
    });
    expect(result).toContain('12001');
    expect(result).toMatch(/everyone/i);
  });

  it('omits labels when empty', () => {
    const result = formatArticleSummary({ ...MOCK_ARTICLE, label_names: [] });
    expect(result).not.toContain('Labels');
  });

  it('includes the sort position', () => {
    const result = formatArticleSummary({ ...MOCK_ARTICLE, position: 7 });
    expect(result).toContain('**Position**: 7');
  });

  it('omits position when not a number', () => {
    const result = formatArticleSummary({
      ...MOCK_ARTICLE,
      position: undefined as unknown as number,
    });
    expect(result).not.toContain('Position');
  });

  it('surfaces promoted status with the admin-only caveat only when promoted', () => {
    // MOCK_ARTICLE is not promoted → no line at all.
    expect(formatArticleSummary(MOCK_ARTICLE)).not.toContain('Promoted');

    const promoted = formatArticleSummary({ ...MOCK_ARTICLE, promoted: true });
    expect(promoted).toContain('**Promoted**');
    expect(promoted).toMatch(/Help Center admin|Guide admin/);
  });
});

describe('formatTranslation', () => {
  it('includes locale and title', () => {
    const result = formatTranslation(MOCK_TRANSLATION);
    expect(result).toContain('fr');
    expect(result).toContain('Comment tester');
  });
});

describe('formatTranslationSummary', () => {
  it('includes metadata', () => {
    const result = formatTranslationSummary(MOCK_TRANSLATION);
    expect(result).toContain('fr');
    expect(result).toContain('7000');
    expect(result).toContain('Comment tester');
    expect(result).toContain('Draft');
    expect(result).toContain('Updated');
  });

  it('does not include body', () => {
    const result = formatTranslationSummary(MOCK_TRANSLATION);
    expect(result).not.toContain('Guide de test');
  });
});

describe('formatCategory', () => {
  it('includes name and id', () => {
    const result = formatCategory(MOCK_CATEGORY);
    expect(result).toContain('General');
    expect(result).toContain('800');
  });
});

describe('formatSection', () => {
  it('includes name, id, category_id', () => {
    const result = formatSection(MOCK_SECTION);
    expect(result).toContain('FAQ');
    expect(result).toContain('600');
    expect(result).toContain('800');
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
  it('includes id, title, scope and the ordered actions', () => {
    const result = formatMacro(MOCK_MACRO);
    expect(result).toContain('Close and thank the customer (id 700)');
    expect(result).toContain('Scope**: shared');
    expect(result).toContain('status → solved');
    expect(result).toContain('set_tags → resolved, macro_applied');
    expect(result).toContain('comment_value → Thanks for your business!');
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
  it('formats items with pagination meta', () => {
    const result = formatList([MOCK_TICKET], formatTicket, {
      has_more: true,
      after_cursor: 'abc',
      count: 42,
    });
    expect(result).toContain('Results: 42');
    expect(result).toContain('More available');
    expect(result).toContain('Test ticket');
  });

  it('works without pagination meta', () => {
    const result = formatList([MOCK_USER], formatUser);
    expect(result).toContain('Test User');
    expect(result).not.toContain('Results:');
  });
});
