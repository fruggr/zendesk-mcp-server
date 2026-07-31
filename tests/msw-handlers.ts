import { HttpResponse, http } from 'msw';

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

export const MOCK_VIEW = {
  id: 25,
  title: 'Unassigned tickets',
  active: true,
  description: 'Tickets with no assignee',
  position: 1,
};

// Shape mirrors the official SLA Policies API reference: condition values can be
// arrays (e.g. `includes`), policy_metrics carry target_in_seconds, and the
// record has a `url`. The resolution metric is `total_resolution_time`.
export const MOCK_SLA_POLICY = {
  id: 123,
  title: 'SLA contractuels fruggr - Bugs/Incidents',
  description: 'Contractual SLA for bugs and incidents',
  position: 1,
  filter: {
    all: [
      { field: 'type', operator: 'is', value: 'incident' },
      { field: 'custom_status_id', operator: 'includes', value: ['1', '2'] },
    ],
    any: [],
  },
  policy_metrics: [
    {
      priority: 'high',
      metric: 'first_reply_time',
      target: 420,
      target_in_seconds: 25200,
      business_hours: false,
    },
    {
      priority: 'high',
      metric: 'total_resolution_time',
      target: 4200,
      target_in_seconds: 252000,
      business_hours: false,
    },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  url: 'https://testsubdomain.zendesk.com/api/v2/slas/policies/123',
};

// Live per-ticket SLA, nested on each Search result (`include=tickets(slas)`).
// Mirrors the real shape (see #92): only live metrics — no ticket_id, no policy
// identity, no target. One achieved metric and one active metric whose breach is
// far in the future so "remaining" stays positive.
export const MOCK_SLA_SIDELOAD = {
  policy_metrics: [
    { metric: 'first_reply_time', stage: 'achieved', breach_at: '2026-01-01T07:00:00Z' },
    { metric: 'requester_wait_time', stage: 'active', breach_at: '2099-06-18T21:37:00Z', days: 12 },
  ],
};

// Two ticket field definitions: a system priority field (system_field_options)
// and a custom dropdown (custom_field_options), mirroring the Ticket Fields API
// so the tool's option rendering for both shapes is exercised.
export const MOCK_TICKET_FIELD_SYSTEM = {
  id: 10,
  type: 'priority',
  title: 'Priority',
  description: 'Ticket priority',
  active: true,
  required: false,
  system_field_options: [
    { name: 'Low', value: 'low' },
    { name: 'High', value: 'high' },
  ],
};

export const MOCK_TICKET_FIELD_CUSTOM = {
  id: 360000000001,
  type: 'tagger',
  title: 'Severity',
  description: 'Customer-facing severity',
  active: true,
  required: true,
  tag: null,
  custom_field_options: [
    { name: 'Sev-1', value: 'severity_1' },
    { name: 'Sev-2', value: 'severity_2' },
  ],
};

// A macro from GET /macros/active: a canned reply (`comment_value`) plus field
// changes, mirroring the real Macros API shape (actions are {field, value}).
export const MOCK_MACRO = {
  id: 700,
  title: 'Close and thank the customer',
  description: 'Solve the ticket and send a thank-you note',
  active: true,
  position: 9999,
  restriction: null,
  actions: [
    { field: 'status', value: 'solved' },
    { field: 'set_tags', value: ['resolved', 'macro_applied'] },
    { field: 'comment_value', value: 'Thanks for your business! We hope to see you again soon.' },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

// GET /tickets/{id}/macros/{macro_id}/apply — the WHOLE ticket as it would be
// after the macro runs (not just the changed fields — confirmed against the live
// tenant), plus the comment it would add, nested under `result.ticket`. Nothing
// is persisted. Modelled on MOCK_TICKET (the "before") with the macro's changes
// applied: status open→solved, two tags added, one custom field set. The
// identity fields (id/url/created_at/updated_at) match the before so the diff
// correctly drops them; preview_macro_diff surfaces only the real changes.
export const MOCK_MACRO_APPLY = {
  result: {
    ticket: {
      id: 1,
      url: 'https://testsubdomain.zendesk.com/api/v2/tickets/1.json',
      subject: 'Test ticket',
      description: 'A test ticket',
      type: 'incident',
      priority: 'normal',
      status: 'solved',
      assignee_id: 100,
      requester_id: 200,
      group_id: 300,
      organization_id: 400,
      tags: ['test', 'mock', 'resolved', 'macro_applied'],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      fields: [{ id: 360000000001, value: 'severity_2' }],
      comment: {
        body: 'Thanks for your business! We hope to see you again soon.',
        public: true,
      },
    },
  },
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
  permission_group_id: 12001,
  user_segment_id: 15001,
  draft: false,
  promoted: false,
  position: 0,
  label_names: ['guide'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

export const MOCK_PROMOTED_ARTICLE = {
  ...MOCK_ARTICLE,
  id: 5001,
  title: 'Featured guide',
  promoted: true,
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

// Per-locale translation bodies used by the compare_translations handler below.
// `de` is deliberately one section shorter than `en-us` so the structure-mismatch
// path has a fixture; any other locale gets the two-section French body.
const TRANSLATION_BODIES: Record<string, string> = {
  'en-us': '<h2>Intro</h2><p>Source intro</p><h2>Setup</h2><p>one two three four</p>',
  de: '<h2>Intro</h2><p>Deutsch intro</p>',
};
const FALLBACK_TRANSLATION_BODY = '<h2>Intro</h2><p>French intro</p><h2>Setup</h2><p>un deux</p>';

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

// A small referential covering the sort/filter cases exercised by the tests:
// `ai` and `mistral` are the tags whose absence #132 could not confirm, and the
// listing spans past `debug mode` (the alphabetical point the old cap stopped at).
export const MOCK_CONTENT_TAGS = [
  {
    id: 'ct_010',
    name: 'ai',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 'ct_011',
    name: 'debug mode',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 'ct_012',
    name: 'mistral',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
  MOCK_CONTENT_TAG,
];

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

export const MOCK_LOCALES = {
  locales: ['en-us', 'fr'],
  default_locale: 'en-us',
};

export const MOCK_ARTICLE_ATTACHMENT = {
  id: 20001,
  file_name: 'screenshot.png',
  content_url: 'https://testsubdomain.zendesk.com/hc/article_attachments/20001/screenshot.png',
  content_type: 'image/png',
  size: 12345,
  created_at: '2026-01-01T00:00:00Z',
};

export const MOCK_TICKET_ATTACHMENT_IMAGE = {
  id: 30001,
  file_name: 'screenshot.png',
  content_url: 'https://testsubdomain.zendesk.com/attachments/token/abc/?name=screenshot.png',
  content_type: 'image/png',
  size: 1024,
  inline: true,
};

export const MOCK_TICKET_ATTACHMENT_PDF = {
  id: 30002,
  file_name: 'report.pdf',
  content_url: 'https://testsubdomain.zendesk.com/attachments/token/def/?name=report.pdf',
  content_type: 'application/pdf',
  size: 4,
  inline: false,
};

export const MOCK_TICKET_ATTACHMENT_LARGE_IMAGE = {
  id: 30003,
  file_name: 'huge.png',
  content_url: 'https://testsubdomain.zendesk.com/attachments/token/ghi/?name=huge.png',
  content_type: 'image/png',
  size: 10 * 1024 * 1024,
  inline: false,
};

export const MOCK_COMMENT = {
  id: 3000,
  body: 'This is a comment',
  author_id: 9999,
  public: true,
  created_at: '2026-01-01T00:00:00Z',
  attachments: [
    MOCK_TICKET_ATTACHMENT_IMAGE,
    MOCK_TICKET_ATTACHMENT_PDF,
    MOCK_TICKET_ATTACHMENT_LARGE_IMAGE,
  ],
};

// Uploads API response (POST /uploads). The token is what gets carried on a
// comment via comment.uploads; subsequent files aggregate under it via ?token=.
// A group, minimal shape used to resolve a group_id change to a name.
export const MOCK_GROUP = { id: 300, name: 'Support' };

// Ticket audits (GET /tickets/:id/audits). Three updates that together exercise
// the timeline: a Create audit (founding facts + initial comment presence), a
// Change audit (status/assignee/group/tags before→after + an internal note + a
// system Notification that must be filtered), and an all-noise audit that must
// render no block at all.
export const MOCK_AUDIT_CREATE = {
  id: 9001,
  ticket_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  author_id: 200,
  via: { channel: 'web' },
  events: [
    { id: 1, type: 'Create', field_name: 'status', value: 'new' },
    { id: 2, type: 'Create', field_name: 'priority', value: 'normal' },
    { id: 3, type: 'Create', field_name: 'subject', value: 'Test ticket' },
    { id: 4, type: 'Comment', body: 'Initial request body', public: true, author_id: 200 },
    // Not in the Create whitelist — must be dropped from the founding block.
    { id: 5, type: 'Create', field_name: 'custom_status_id', value: '1' },
  ],
};

export const MOCK_AUDIT_CHANGE = {
  id: 9002,
  ticket_id: 1,
  created_at: '2026-01-02T00:00:00Z',
  author_id: 100,
  via: { channel: 'web' },
  events: [
    { id: 6, type: 'Change', field_name: 'status', value: 'open', previous_value: 'new' },
    { id: 7, type: 'Change', field_name: 'assignee_id', value: '100', previous_value: null },
    { id: 8, type: 'Change', field_name: 'group_id', value: '300', previous_value: null },
    {
      id: 9,
      type: 'Change',
      field_name: 'tags',
      value: ['test', 'mock', 'urgent'],
      previous_value: ['test', 'mock'],
    },
    { id: 10, type: 'Comment', body: 'internal note body', public: false, author_id: 100 },
    // System noise — must not surface on the timeline.
    { id: 11, type: 'Notification', body: 'email sent to requester' },
  ],
};

export const MOCK_AUDIT_NOISE = {
  id: 9003,
  ticket_id: 1,
  created_at: '2026-01-03T00:00:00Z',
  author_id: 999,
  via: { channel: 'rule' },
  events: [
    { id: 12, type: 'Notification', body: 'trigger fired' },
    { id: 13, type: 'Push', value: 'external' },
  ],
};

export const MOCK_UPLOAD = {
  token: 'mock-upload-token',
  expires_at: '2026-01-01T01:00:00Z',
  attachment: MOCK_TICKET_ATTACHMENT_PDF,
  attachments: [MOCK_TICKET_ATTACHMENT_PDF],
};

// OAuth token endpoint used by the browser PKCE flow. Opt-in per test via
// mswServer.use() so the OAuth roundtrip mock stays centralized here too.
// Opt-in via mswServer.use(): a ticket-audits page that reports more to come, so
// the cursor/"More available" footer of get_ticket_history can be asserted.
export const auditsMorePageHandler = http.get(`${BASE}/tickets/:id/audits`, () =>
  HttpResponse.json({
    audits: [MOCK_AUDIT_CHANGE],
    meta: { has_more: true, after_cursor: 'next-audit-cursor' },
  }),
);

export const oauthTokenHandler = http.post('https://testsubdomain.zendesk.com/oauth/tokens', () =>
  HttpResponse.json({ access_token: 'token-abc', token_type: 'bearer', scope: 'read write' }),
);

// Opt-in error handlers for tests that exercise failure paths. Kept here so all
// Zendesk mocking stays centralized; activate one per test via mswServer.use().
export const errorHandlers = {
  usersMeUnauthorized: http.get(
    `${BASE}/users/me`,
    () => new HttpResponse('unauthorized', { status: 401 }),
  ),
  localesUnauthorized: http.get(
    `${HC_BASE}/locales`,
    () => new HttpResponse('unauthorized', { status: 401 }),
  ),
  // Guide admin / Help Center manager gate: a content-editor token gets 403 on
  // the permission-groups and user-segments endpoints (issue #161).
  permissionGroupsForbidden: http.get(`${BASE}/guide/permission_groups`, () =>
    HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
  ),
  userSegmentsForbidden: http.get(`${HC_BASE}/user_segments`, () =>
    HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
  ),
  // A 401 (not 403) on the same admin endpoint must still hard-fail topology, so
  // the stale-token invalidation path keeps firing (guards against swallowing it).
  permissionGroupsUnauthorized: http.get(
    `${BASE}/guide/permission_groups`,
    () => new HttpResponse('unauthorized', { status: 401 }),
  ),
  // The promoted-article scan backing the article resources' list callback fails.
  // A 500 must be swallowed (empty list, logged) so it never breaks resources/list.
  articlesListError: http.get(
    `${HC_BASE}/articles`,
    () => new HttpResponse('boom', { status: 500 }),
  ),
  // A 401 on the same scan must still fire the stale-token invalidation path.
  articlesListUnauthorized: http.get(
    `${HC_BASE}/articles`,
    () => new HttpResponse('unauthorized', { status: 401 }),
  ),
};

// Opt-in override: an article listing that mixes a non-promoted and a promoted
// article on a single page, so the article resources' list callback (which filters
// `promoted` client-side) has exactly one entry to surface.
export const promotedArticlesHandler = http.get(`${HC_BASE}/articles`, () =>
  HttpResponse.json({
    articles: [MOCK_ARTICLE, MOCK_PROMOTED_ARTICLE],
    meta: { has_more: false, after_cursor: '' },
    count: 2,
  }),
);

// Opt-in override: a Help Center with more sections than a single page, used to
// exercise the topology resource's "summary mode" (tree omitted, count + hint).
export const manySectionsHandler = http.get(`${HC_BASE}/sections`, () =>
  HttpResponse.json({
    sections: [MOCK_SECTION],
    meta: { has_more: true, after_cursor: 'next-page-cursor' },
    count: 250,
  }),
);

// Opt-in override: a Help Center with more categories than a single page, used to
// exercise the topology resource's "summary mode" when categories themselves overflow.
export const manyCategoriesHandler = http.get(`${HC_BASE}/categories`, () =>
  HttpResponse.json({
    categories: [MOCK_CATEGORY],
    meta: { has_more: true, after_cursor: 'next-page-cursor' },
    count: 250,
  }),
);

// Opt-in override: a content-tag referential larger than one page, so the tool's
// cursor handling and the "More available" footer can be exercised (#132).
export const manyContentTagsHandler = http.get(`${BASE}/guide/content_tags`, () =>
  HttpResponse.json({
    records: [MOCK_CONTENT_TAG],
    meta: { has_more: true, after_cursor: 'next-page-cursor' },
  }),
);

export const handlers = [
  // Views (issue #121). Registered before `/tickets/:id` so `/tickets/show_many`
  // hits its own handler instead of being captured as an `:id`.
  http.get(`${BASE}/tickets/show_many`, ({ request }) => {
    const ids = (new URL(request.url).searchParams.get('ids') ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    return HttpResponse.json({ tickets: ids.map((id) => ({ ...MOCK_TICKET, id })) });
  }),
  http.get(`${BASE}/views/count_many`, ({ request }) => {
    const ids = (new URL(request.url).searchParams.get('ids') ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    return HttpResponse.json({
      view_counts: ids.map((id) => ({
        view_id: id,
        value: 298,
        pretty: '298',
        fresh: true,
        url: `${BASE}/views/${id}/count.json`,
      })),
    });
  }),
  http.get(`${BASE}/views/:id/execute`, ({ params }) =>
    HttpResponse.json({
      columns: [{ id: 'subject', title: 'Subject' }],
      rows: [{ ticket: { id: MOCK_TICKET.id } }],
      view: { id: Number(params['id']) },
      meta: { has_more: false, after_cursor: '' },
    }),
  ),
  http.get(`${BASE}/views`, () =>
    HttpResponse.json({ views: [MOCK_VIEW], meta: { has_more: false, after_cursor: '' } }),
  ),

  // Tickets
  http.get(`${BASE}/tickets/:id`, ({ params }) => {
    if (params['id'] === '404') return HttpResponse.json({}, { status: 404 });
    const id = Number(params['id']);
    // The Show Ticket endpoint does not expose SLA (Zendesk ignores
    // `include=slas` there, see #92), so no `slas` is ever returned here.
    return HttpResponse.json({ ticket: { ...MOCK_TICKET, id } });
  }),
  http.get(`${BASE}/tickets/:id/comments`, () => HttpResponse.json({ comments: [MOCK_COMMENT] })),
  http.get(`${BASE}/tickets/:id/audits`, ({ params }) => {
    if (params['id'] === '404') return HttpResponse.json({}, { status: 404 });
    return HttpResponse.json({
      audits: [MOCK_AUDIT_CREATE, MOCK_AUDIT_CHANGE, MOCK_AUDIT_NOISE],
      meta: { has_more: false, after_cursor: '' },
    });
  }),
  http.get(`${BASE}/attachments/:id`, ({ params }) => {
    const id = Number(params['id']);
    if (id === MOCK_TICKET_ATTACHMENT_IMAGE.id) {
      return HttpResponse.json({ attachment: MOCK_TICKET_ATTACHMENT_IMAGE });
    }
    if (id === MOCK_TICKET_ATTACHMENT_PDF.id) {
      return HttpResponse.json({ attachment: MOCK_TICKET_ATTACHMENT_PDF });
    }
    if (id === MOCK_TICKET_ATTACHMENT_LARGE_IMAGE.id) {
      return HttpResponse.json({ attachment: MOCK_TICKET_ATTACHMENT_LARGE_IMAGE });
    }
    return HttpResponse.json({}, { status: 404 });
  }),
  http.get('https://testsubdomain.zendesk.com/attachments/token/:token/', ({ request }) => {
    const token = new URL(request.url).pathname.split('/')[3];
    if (token === 'def') {
      return HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return HttpResponse.arrayBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, {
      headers: { 'content-type': 'image/png' },
    });
  }),
  http.get(`${BASE}/tickets/:id/incidents`, () => HttpResponse.json({ tickets: [MOCK_TICKET] })),
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
  http.post(`${BASE}/uploads`, () => HttpResponse.json({ upload: MOCK_UPLOAD })),

  // Macros — active macros for the current user, and the per-ticket apply
  // (preview) endpoint. The apply route sits under /tickets/:id/ but has extra
  // path segments, so it does not collide with the Show Ticket handler above.
  http.get(`${BASE}/macros/active`, () => HttpResponse.json({ macros: [MOCK_MACRO], count: 1 })),
  http.get(`${BASE}/tickets/:id/macros/:mid/apply`, () => HttpResponse.json(MOCK_MACRO_APPLY)),

  // SLA policies — the real endpoint returns the full config list with no
  // `count` wrapper, so omit it here to exercise the array-length fallback.
  http.get(`${BASE}/slas/policies`, () => HttpResponse.json({ sla_policies: [MOCK_SLA_POLICY] })),

  // Ticket field definitions (system + custom), cursor-paginated like /tickets.
  http.get(`${BASE}/ticket_fields`, () =>
    HttpResponse.json({
      ticket_fields: [MOCK_TICKET_FIELD_SYSTEM, MOCK_TICKET_FIELD_CUSTOM],
      meta: { has_more: false, after_cursor: '' },
    }),
  ),

  // Search
  http.get(`${BASE}/search`, ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    const withSla = (url.searchParams.get('include') ?? '').includes('slas');
    if (query.includes('type:ticket')) {
      // `slas` is nested on each result, not a top-level array (see #92).
      const ticket: Record<string, unknown> = { ...MOCK_TICKET, result_type: 'ticket' };
      if (withSla) ticket['slas'] = MOCK_SLA_SIDELOAD;
      return HttpResponse.json({ results: [ticket], count: 1 });
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

  // Users. show_many is registered before `/users/:id` so it hits its own
  // handler instead of matching `:id` = 'show_many'. Both show_many endpoints
  // echo a deterministic `<Entity> <id>` name so name resolution is assertable.
  http.get(`${BASE}/users/me`, () => HttpResponse.json({ user: MOCK_USER })),
  http.get(`${BASE}/users/show_many`, ({ request }) => {
    const ids = (new URL(request.url).searchParams.get('ids') ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    return HttpResponse.json({
      users: ids.map((id) => ({ ...MOCK_USER, id, name: `User ${id}` })),
    });
  }),
  http.get(`${BASE}/groups/show_many`, ({ request }) => {
    const ids = (new URL(request.url).searchParams.get('ids') ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    return HttpResponse.json({ groups: ids.map((id) => ({ id, name: `Group ${id}` })) });
  }),
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
    HttpResponse.json({
      article: { ...MOCK_ARTICLE, id: Number(params['id']), locale: params['locale'] as string },
    }),
  ),
  http.get(`${HC_BASE}/articles/:id/translations`, () =>
    HttpResponse.json({
      translations: [
        { ...MOCK_TRANSLATION, outdated: false },
        { ...MOCK_TRANSLATION, id: 7001, locale: 'en-us', outdated: true },
      ],
    }),
  ),
  http.get(`${HC_BASE}/articles/:id/translations/:locale`, ({ params }) => {
    const locale = params['locale'] as string;
    const body = TRANSLATION_BODIES[locale] ?? FALLBACK_TRANSLATION_BODY;
    return HttpResponse.json({
      translation: { ...MOCK_TRANSLATION, locale, body },
    });
  }),
  http.post(`${HC_BASE}/articles/:id/translations`, () =>
    HttpResponse.json({ translation: MOCK_TRANSLATION }),
  ),
  http.put(`${HC_BASE}/articles/:id/translations/:locale`, async ({ request, params }) => {
    const reqBody = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update = (reqBody['translation'] as Record<string, unknown> | undefined) ?? {};
    return HttpResponse.json({
      translation: {
        ...MOCK_TRANSLATION,
        locale: params['locale'] as string,
        ...update,
      },
    });
  }),
  http.get(`${HC_BASE}/articles`, () =>
    HttpResponse.json({
      articles: [MOCK_ARTICLE],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/:locale/articles`, () =>
    HttpResponse.json({
      articles: [MOCK_ARTICLE],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/sections/:sid/articles`, () =>
    HttpResponse.json({
      articles: [MOCK_ARTICLE],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/:locale/sections/:sid/articles`, () =>
    HttpResponse.json({
      articles: [MOCK_ARTICLE],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.post(`${HC_BASE}/sections/:sid/articles`, () =>
    HttpResponse.json({ article: MOCK_ARTICLE }),
  ),
  http.put(`${HC_BASE}/articles/:id`, async ({ request, params }) => {
    const reqBody = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update = (reqBody['article'] as Record<string, unknown> | undefined) ?? {};
    return HttpResponse.json({
      article: { ...MOCK_ARTICLE, id: Number(params['id']), ...update },
    });
  }),
  // Archive Article (soft-delete): Zendesk responds 204 No Content.
  http.delete(`${HC_BASE}/articles/:id`, () => new HttpResponse(null, { status: 204 })),

  // Guide - Permission Groups
  http.get(`${BASE}/guide/permission_groups`, () =>
    HttpResponse.json({ permission_groups: [MOCK_PERMISSION_GROUP], count: 1 }),
  ),

  // Guide - Content Tags. Honours filter[name_prefix], sort and cursor
  // pagination the way the real endpoint does so the tool's params are exercised.
  http.get(`${BASE}/guide/content_tags`, ({ request }) => {
    const url = new URL(request.url);
    // Faithful to the real endpoint (#162): /guide/content_tags caps page[size]
    // at 30 and 400s on anything larger, unlike the other Help Center list
    // endpoints that allow up to 100. Reproduce that so the tool's clamp is tested.
    const size = url.searchParams.get('page[size]');
    if (size !== null && Number(size) > 30) {
      return HttpResponse.json(
        {
          errors: [
            {
              title: `Value \`${size}\` for /page/size/0 is of type \`string\`; expected \`integer less than or equal to 30\``,
              code: 'TypeError',
              meta: null,
            },
          ],
        },
        { status: 400 },
      );
    }
    // Prefix match kept case-sensitive: the real endpoint's casing is
    // unverified, so the mock does not encode a case-insensitive assumption.
    const prefix = url.searchParams.get('filter[name_prefix]');
    const sort = url.searchParams.get('sort') ?? 'name';
    let records = [...MOCK_CONTENT_TAGS];
    if (prefix) {
      records = records.filter((t) => t.name.startsWith(prefix));
    }
    // The tool forwards `sort` to Zendesk untouched, so the mock only needs to
    // order enough for tests to assert wiring: name ascending, reversed by the
    // `-` prefix (covers the -name path). Other keys fall back to name order.
    records.sort((a, b) => a.name.localeCompare(b.name));
    if (sort.startsWith('-')) records.reverse();
    return HttpResponse.json({ records, meta: { has_more: false, after_cursor: '' } });
  }),
  http.post(`${BASE}/guide/content_tags`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const tag = body['content_tag'] as Record<string, unknown> | undefined;
    if (!tag?.['name']) {
      return HttpResponse.json(
        { errors: [{ title: 'Value `undefined` for /content_tag', code: 'TypeError' }] },
        { status: 400 },
      );
    }
    return HttpResponse.json({ content_tag: { ...MOCK_CONTENT_TAG, name: tag['name'] } });
  }),

  // Help Center - Locales
  http.get(`${HC_BASE}/locales`, () => HttpResponse.json(MOCK_LOCALES)),

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
    HttpResponse.json({
      categories: [MOCK_CATEGORY],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/:locale/categories`, () =>
    HttpResponse.json({
      categories: [MOCK_CATEGORY],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/sections`, () =>
    HttpResponse.json({
      sections: [MOCK_SECTION],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/:locale/sections`, () =>
    HttpResponse.json({
      sections: [MOCK_SECTION],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
  http.get(`${HC_BASE}/categories/:cid/sections`, () =>
    HttpResponse.json({
      sections: [MOCK_SECTION],
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),
];
