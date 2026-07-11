import { describe, expect, it } from 'vitest';
import {
  formatArticle,
  formatArticleSummary,
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
