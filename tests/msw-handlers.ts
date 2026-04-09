import { http, HttpResponse } from 'msw';

const BASE = 'https://testsubdomain.zendesk.com/api/v2';
const HC_BASE = 'https://testsubdomain.zendesk.com/api/v2/help_center';

export const MOCK_TICKET = {
  id: 1,
  subject: 'Test ticket',
  description: 'A test ticket',
  status: 'open',
  priority: 'normal',
  type: 'incident',
  assignee_id: 100,
  requester_id: 200,
  group_id: 300,
  organization_id: 400,
  tags: ['test', 'mock'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  custom_fields: [],
};

export const MOCK_USER = {
  id: 9999,
  name: 'Test User',
  email: 'test@example.com',
  role: 'admin',
  role_type: null,
  organization_id: 400,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_ORGANIZATION = {
  id: 400,
  name: 'Test Org',
  details: 'A test org',
  notes: null,
  domain_names: ['example.com'],
  tags: ['vip'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_ARTICLE = {
  id: 5000,
  title: 'How to test',
  body: '<p>Testing guide</p>',
  locale: 'en-us',
  source_locale: 'en-us',
  author_id: 9999,
  section_id: 600,
  draft: false,
  promoted: false,
  position: 0,
  label_names: ['guide'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_TRANSLATION = {
  id: 7000,
  locale: 'fr',
  title: 'Comment tester',
  body: '<p>Guide de test</p>',
  draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  source_id: 5000,
  source_type: 'Article',
};

export const MOCK_CATEGORY = {
  id: 800,
  name: 'General',
  description: 'General category',
  locale: 'en-us',
  position: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_SECTION = {
  id: 600,
  name: 'FAQ',
  description: 'Frequently asked questions',
  locale: 'en-us',
  category_id: 800,
  position: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_PERMISSION_GROUP = {
  id: 12001,
  name: 'Editors',
  built_in: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_CONTENT_TAG = {
  id: 'ct_001',
  name: 'scanner',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_LABEL = {
  id: 9001,
  name: 'getting-started',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_USER_SEGMENT = {
  id: 15001,
  name: 'Signed-in users',
  user_type: 'signed_in_users',
  built_in: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_ARTICLE_ATTACHMENT = {
  id: 20001,
  file_name: 'screenshot.png',
  content_url: 'https://testsubdomain.zendesk.com/hc/article_attachments/20001/screenshot.png',
  content_type: 'image/png',
  size: 12345,
  created_at: '2026-01-01T00:00:00Z',
};

export const MOCK_COMMENT = {
  id: 3000,
  body: 'This is a comment',
  author_id: 9999,
  public: true,
  created_at: '2026-01-01T00:00:00Z',
};

export const handlers = [
  // Tickets
  http.get(`${BASE}/tickets/:id`, ({ params }) => {
    if (params['id'] === '404') return HttpResponse.json({}, { status: 404 });
    return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: Number(params['id']) } });
  }),
  http.get(`${BASE}/tickets/:id/comments`, () =>
    HttpResponse.json({ comments: [MOCK_COMMENT] }),
  ),
  http.get(`${BASE}/tickets/:id/incidents`, () =>
    HttpResponse.json({ tickets: [MOCK_TICKET] }),
  ),
  http.get(`${BASE}/tickets`, () =>
    HttpResponse.json({
      tickets: [MOCK_TICKET],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.post(`${BASE}/tickets`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const ticket = body['ticket'] as Record<string, unknown>;
    return HttpResponse.json({
      ticket: { ...MOCK_TICKET, id: 42, subject: (ticket['subject'] as string) ?? 'New' },
    });
  }),
  http.put(`${BASE}/tickets/:id`, ({ params }) =>
    HttpResponse.json({ ticket: { ...MOCK_TICKET, id: Number(params['id']), status: 'solved' } }),
  ),

  // Search
  http.get(`${BASE}/search`, ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    if (query.includes('type:ticket')) {
      return HttpResponse.json({ results: [{ ...MOCK_TICKET, result_type: 'ticket' }], count: 1 });
    }
    if (query.includes('type:user')) {
      return HttpResponse.json({ results: [{ ...MOCK_USER, result_type: 'user' }], count: 1 });
    }
    return HttpResponse.json({
      results: [
        { ...MOCK_TICKET, result_type: 'ticket' },
        { ...MOCK_USER, result_type: 'user' },
      ],
      count: 2,
    });
  }),

  // Users
  http.get(`${BASE}/users/me`, () => HttpResponse.json({ user: MOCK_USER })),
  http.get(`${BASE}/users/:id`, ({ params }) =>
    HttpResponse.json({ user: { ...MOCK_USER, id: Number(params['id']) } }),
  ),

  // Organizations
  http.get(`${BASE}/organizations/:id`, ({ params }) =>
    HttpResponse.json({ organization: { ...MOCK_ORGANIZATION, id: Number(params['id']) } }),
  ),
  http.get(`${BASE}/organizations`, () =>
    HttpResponse.json({
      organizations: [MOCK_ORGANIZATION],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),

  // Help Center - Articles
  http.get(`${HC_BASE}/articles/search`, () =>
    HttpResponse.json({ results: [MOCK_ARTICLE], count: 1 }),
  ),
  http.get(`${HC_BASE}/articles/labels`, () =>
    HttpResponse.json({ labels: [MOCK_LABEL], count: 1 }),
  ),
  http.get(`${HC_BASE}/articles/:id`, ({ params }) =>
    HttpResponse.json({ article: { ...MOCK_ARTICLE, id: Number(params['id']) } }),
  ),
  http.get(`${HC_BASE}/:locale/articles/:id`, ({ params }) =>
    HttpResponse.json({ article: { ...MOCK_ARTICLE, id: Number(params['id']), locale: params['locale'] as string } }),
  ),
  http.get(`${HC_BASE}/articles/:id/translations`, () =>
    HttpResponse.json({ translations: [MOCK_TRANSLATION, { ...MOCK_TRANSLATION, id: 7001, locale: 'en-us' }] }),
  ),
  http.post(`${HC_BASE}/articles/:id/translations`, () =>
    HttpResponse.json({ translation: MOCK_TRANSLATION }),
  ),
  http.put(`${HC_BASE}/articles/:id/translations/:locale`, () =>
    HttpResponse.json({ translation: MOCK_TRANSLATION }),
  ),
  http.get(`${HC_BASE}/articles`, () =>
    HttpResponse.json({ articles: [MOCK_ARTICLE], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.get(`${HC_BASE}/:locale/articles`, () =>
    HttpResponse.json({ articles: [MOCK_ARTICLE], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.get(`${HC_BASE}/sections/:sid/articles`, () =>
    HttpResponse.json({ articles: [MOCK_ARTICLE], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.post(`${HC_BASE}/sections/:sid/articles`, () =>
    HttpResponse.json({ article: MOCK_ARTICLE }),
  ),
  http.put(`${HC_BASE}/articles/:id`, () =>
    HttpResponse.json({ article: MOCK_ARTICLE }),
  ),

  // Guide - Permission Groups
  http.get(`${BASE}/guide/permission_groups`, () =>
    HttpResponse.json({ permission_groups: [MOCK_PERMISSION_GROUP], count: 1 }),
  ),

  // Guide - Content Tags
  http.get(`${BASE}/guide/content_tags`, () =>
    HttpResponse.json({ records: [MOCK_CONTENT_TAG], count: 1 }),
  ),
  http.post(`${BASE}/guide/content_tags`, () =>
    HttpResponse.json({ record: MOCK_CONTENT_TAG }),
  ),

  // Help Center - User Segments
  http.get(`${HC_BASE}/user_segments`, () =>
    HttpResponse.json({ user_segments: [MOCK_USER_SEGMENT], count: 1 }),
  ),

  // Help Center - Article Attachments
  http.get(`${HC_BASE}/articles/:id/attachments`, () =>
    HttpResponse.json({ article_attachments: [MOCK_ARTICLE_ATTACHMENT], count: 1 }),
  ),
  http.post(`${HC_BASE}/articles/:id/attachments`, () =>
    HttpResponse.json({ article_attachment: MOCK_ARTICLE_ATTACHMENT }),
  ),

  // Help Center - Categories & Sections
  http.get(`${HC_BASE}/categories`, () =>
    HttpResponse.json({ categories: [MOCK_CATEGORY], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.get(`${HC_BASE}/:locale/categories`, () =>
    HttpResponse.json({ categories: [MOCK_CATEGORY], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.get(`${HC_BASE}/sections`, () =>
    HttpResponse.json({ sections: [MOCK_SECTION], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.get(`${HC_BASE}/:locale/sections`, () =>
    HttpResponse.json({ sections: [MOCK_SECTION], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
  http.get(`${HC_BASE}/categories/:cid/sections`, () =>
    HttpResponse.json({ sections: [MOCK_SECTION], meta: { has_more: false, after_cursor: '' }, count: 1 }),
  ),
];
