import { describe, it, expect } from 'vitest';
import {
  formatTicket,
  formatComment,
  formatUser,
  formatOrganization,
  formatArticle,
  formatArticleSummary,
  formatTranslation,
  formatTranslationSummary,
  formatCategory,
  formatSection,
  formatList,
  truncateIfNeeded,
} from '../../../src/utils/formatting';
import {
  MOCK_TICKET,
  MOCK_COMMENT,
  MOCK_USER,
  MOCK_ORGANIZATION,
  MOCK_ARTICLE,
  MOCK_TRANSLATION,
  MOCK_CATEGORY,
  MOCK_SECTION,
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

describe('formatList', () => {
  it('formats items with pagination meta', () => {
    const result = formatList(
      [MOCK_TICKET],
      formatTicket,
      { has_more: true, after_cursor: 'abc', count: 42 },
    );
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
