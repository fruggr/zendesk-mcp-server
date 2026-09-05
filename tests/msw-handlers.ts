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
  // Agents see priority; customers do not. Keeps the end-user tools' portal
  // filter honest instead of every fixture field being visible.
  visible_in_portal: false,
  required_in_portal: false,
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
  // Portal-visible AND portal-required, with a customer-facing label that
  // differs from the agent title -- the case the end-user form spec must render.
  visible_in_portal: true,
  required_in_portal: true,
  editable_in_portal: true,
  title_in_portal: 'How severe is it?',
  custom_field_options: [
    { name: 'Sev-1', value: 'severity_1' },
    { name: 'Sev-2', value: 'severity_2' },
  ],
};

// The system subject and description fields. EVERY real Zendesk form carries
// these and marks them required in the portal, and their absence from the
// fixtures is what hid a blocking bug: treating them as custom fields made
// create_request demand "Subject (field id 1)" in `custom_fields`, which no
// caller can satisfy. They belong in the form fixture for that reason.
export const MOCK_TICKET_FIELD_SUBJECT = {
  id: 1,
  type: 'subject',
  title: 'Subject',
  description: null,
  active: true,
  required: true,
  visible_in_portal: true,
  required_in_portal: true,
  editable_in_portal: true,
};

export const MOCK_TICKET_FIELD_DESCRIPTION = {
  id: 2,
  type: 'description',
  title: 'Description',
  description: null,
  active: true,
  required: true,
  visible_in_portal: true,
  required_in_portal: true,
  editable_in_portal: true,
};

// A portal-visible but OPTIONAL field, so the required/optional split in the
// form spec is exercised rather than assumed.
export const MOCK_TICKET_FIELD_PORTAL_OPTIONAL = {
  id: 360000000002,
  type: 'text',
  title: 'Affected version',
  description: 'Which version were you using?',
  active: true,
  required: false,
  visible_in_portal: true,
  required_in_portal: false,
  editable_in_portal: true,
};

// GET /ticket_forms — the forms an end user picks between. `display_name` is
// deliberately different from `name` (customer-facing vs internal), which is
// what list_request_forms has to surface.
// The parent field of a conditional rule. Portal-visible and portal-OPTIONAL on
// purpose: a condition gates on an answer the submitter gives freely, and
// keeping it optional leaves MOCK_TICKET_FORM_FEATURE as the form with no
// required custom field.
export const MOCK_TICKET_FIELD_CONDITION_PARENT = {
  id: 360000000003,
  type: 'tagger',
  title: 'Blocking',
  description: 'Does this stop you working?',
  active: true,
  required: false,
  visible_in_portal: true,
  required_in_portal: false,
  editable_in_portal: true,
  title_in_portal: 'Is it blocking you?',
  custom_field_options: [
    { name: 'Yes', value: 'yes' },
    { name: 'No', value: 'no' },
  ],
};

export const MOCK_TICKET_FORM_BUG = {
  id: 900,
  name: 'Bug report (internal)',
  display_name: 'Report a bug',
  active: true,
  end_user_visible: true,
  default: true,
  position: 1,
  ticket_field_ids: [1, 2, 10, 360000000001, 360000000002],
  end_user_conditions: [],
};

// A second form carrying a conditional rule, so the condition rendering is
// covered: answering Severity = sev-1 makes the version field required.
export const MOCK_TICKET_FORM_FEATURE = {
  id: 901,
  name: 'Feature request',
  display_name: 'Feature request',
  active: true,
  end_user_visible: true,
  default: false,
  position: 2,
  // The condition's parent field is ON the form: a real Zendesk form cannot gate
  // on a field a submitter has no way to answer, and leaving it out made the
  // rendered rule name a field absent from the same output. It is deliberately
  // the OPTIONAL parent, so this form keeps being the one whose only
  // portal-required fields are the system ones.
  ticket_field_ids: [1, 2, 360000000003, 360000000002],
  end_user_conditions: [
    {
      parent_field_id: 360000000003,
      value: 'yes',
      child_fields: [{ id: 360000000002, is_required: true }],
    },
  ],
};

// GET/POST/PUT /api/v2/requests — a ticket as its requester sees it. No `tags`,
// no `assignee_id`, and `can_be_solved_by_me` true (an agent is assigned), which
// is the state in which mark_request_solved is allowed to act.
export const MOCK_REQUEST = {
  id: 5001,
  subject: 'The export button does nothing',
  description: 'Clicking export spins forever and no file arrives.',
  status: 'open',
  priority: 'normal',
  type: 'incident',
  requester_id: 456,
  organization_id: null,
  ticket_form_id: 900,
  can_be_solved_by_me: true,
  due_at: null,
  custom_fields: [{ id: 360000000001, value: 'severity_2' }],
  via: { channel: 'web' },
  created_at: '2026-01-05T09:00:00Z',
  updated_at: '2026-01-06T11:30:00Z',
};

// Unassigned, so `can_be_solved_by_me` is false. Zendesk would answer 200 to
// `solved: true` here and change nothing, which is exactly what the tool must
// refuse to report as success.
export const MOCK_REQUEST_UNSOLVABLE = {
  ...MOCK_REQUEST,
  id: 5002,
  subject: 'Feature idea: bulk export',
  status: 'new',
  can_be_solved_by_me: false,
};

// GET /requests/{id}/comments — note the `users` sideload Zendesk returns by
// default, whose `agent` flag is what tells a support reply from the customer's
// own comment. Five keys only: no email, nothing agent-private.
export const MOCK_REQUEST_COMMENTS = {
  comments: [
    {
      id: 9001,
      body: 'Clicking export spins forever and no file arrives.',
      author_id: 456,
      public: true,
      created_at: '2026-01-05T09:00:00Z',
    },
    {
      id: 9002,
      body: 'Thanks for the report — which browser are you on?',
      author_id: 789,
      public: true,
      created_at: '2026-01-06T11:30:00Z',
      attachments: [
        {
          id: 4242,
          file_name: 'diagnostic.txt',
          content_url: 'https://testsubdomain.zendesk.com/attachments/4242/diagnostic.txt',
          content_type: 'text/plain',
          size: 128,
        },
      ],
    },
  ],
  users: [
    { id: 456, name: 'Dana Customer', agent: false },
    { id: 789, name: 'Sam Support', agent: true },
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

// Translations of a section / a category. Same endpoint family as the article
// ones, but `title` carries the localized *name* and `body` the localized
// *description*.
export const MOCK_SECTION_TRANSLATION = {
  id: 7100,
  locale: 'en-us',
  title: 'FAQ',
  body: 'Frequently asked questions',
  draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  source_id: 600,
  source_type: 'Section',
};

export const MOCK_CATEGORY_TRANSLATION = {
  ...MOCK_SECTION_TRANSLATION,
  id: 7200,
  title: 'General',
  body: 'General category',
  source_id: 800,
  source_type: 'Category',
};

// Keyed by node id so one listing can exercise all three states the gap scan
// distinguishes: a published target translation, a draft one, and none at all.
// 600 / 800 are the ids the section and category list fixtures return.
const SECTION_TRANSLATIONS: Record<string, Record<string, unknown>[]> = {
  '600': [
    MOCK_SECTION_TRANSLATION,
    { ...MOCK_SECTION_TRANSLATION, id: 7101, locale: 'fr', title: 'FAQ (fr)', draft: true },
  ],
  '601': [{ ...MOCK_SECTION_TRANSLATION, id: 7102, source_id: 601, title: 'Billing' }],
  '602': [
    { ...MOCK_SECTION_TRANSLATION, id: 7103, source_id: 602, title: 'Pricing' },
    {
      ...MOCK_SECTION_TRANSLATION,
      id: 7104,
      source_id: 602,
      locale: 'fr',
      title: 'Tarifs',
      draft: false,
    },
  ],
};

const CATEGORY_TRANSLATIONS: Record<string, Record<string, unknown>[]> = {
  '800': [
    MOCK_CATEGORY_TRANSLATION,
    { ...MOCK_CATEGORY_TRANSLATION, id: 7201, locale: 'fr', title: 'Général', draft: false },
  ],
  '801': [{ ...MOCK_CATEGORY_TRANSLATION, id: 7202, source_id: 801, title: 'Legal' }],
};

/**
 * Apply the `translations` sideload the way a live tenant does (measured in #226):
 * every locale of the node, `draft` included, embedded **in the node itself** rather
 * than in a top-level array keyed by `source_id`. An `include` Zendesk doesn't know
 * is ignored silently — no error, no key — so the key stays absent unless asked for,
 * which is what lets a test exercise a listing that answers without the sideload.
 */
export const withTranslationsSideload = <T extends { id: number }>(
  request: Request,
  kind: 'sections' | 'categories',
  nodes: T[],
): (T | (T & { translations: Record<string, unknown>[] }))[] => {
  const include = new URL(request.url).searchParams.get('include') ?? '';
  if (!include.split(',').includes('translations')) return nodes;
  const table = kind === 'sections' ? SECTION_TRANSLATIONS : CATEGORY_TRANSLATIONS;
  return nodes.map((node) => ({ ...node, translations: table[String(node.id)] ?? [] }));
};

const readTranslationPayload = async (request: Request): Promise<Record<string, unknown>> => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return (body['translation'] as Record<string, unknown> | undefined) ?? {};
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

// A second, later comment by a different author: lets list_ticket_comments
// assert both the rendered order (newest first by default) and the resolution
// of more than one author id.
export const MOCK_COMMENT_NOTE = {
  id: 3001,
  body: 'Internal analysis',
  author_id: 9998,
  public: false,
  created_at: '2026-01-02T00:00:00Z',
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

// Opt-in via mswServer.use(): a comments page that reports more to come, so the
// cursor/"More available" footer of list_ticket_comments can be asserted.
export const commentsMorePageHandler = http.get(`${BASE}/tickets/:id/comments`, () =>
  HttpResponse.json({
    comments: [MOCK_COMMENT_NOTE],
    meta: { has_more: true, after_cursor: 'next-comment-cursor' },
  }),
);

// Opt-in via mswServer.use(): the same page carrying the `include=users`
// side-load, so the "no extra show_many call" path can be asserted. The names
// differ from the `User <id>` the show_many mock echoes, which is what makes the
// two paths distinguishable in an assertion.
export const commentsWithUsersSideloadHandler = http.get(`${BASE}/tickets/:id/comments`, () =>
  HttpResponse.json({
    comments: [MOCK_COMMENT_NOTE, MOCK_COMMENT],
    users: [
      { ...MOCK_USER, id: 9999, name: 'Sideloaded Agent' },
      { ...MOCK_USER, id: 9998, name: 'Sideloaded Author' },
    ],
    meta: { has_more: false, after_cursor: '' },
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
  // Single-page by default: fetchAllTicketComments (get_ticket_attachments)
  // walks this endpoint in a loop, so `has_more: true` here would change how
  // many pages those tests fetch. Cursor paging is opted into per test via
  // commentsMorePageHandler. No `users` side-load either, so the default path
  // exercises the batched show_many fallback.
  http.get(`${BASE}/tickets/:id/comments`, ({ request }) => {
    const sort = new URL(request.url).searchParams.get('sort');
    const comments =
      sort === '-created_at'
        ? [MOCK_COMMENT_NOTE, MOCK_COMMENT]
        : [MOCK_COMMENT, MOCK_COMMENT_NOTE];
    return HttpResponse.json({ comments, meta: { has_more: false, after_cursor: '' } });
  }),
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

  // --- End-user Requests surface (namespace: requests) ---
  // Order matters: the literal `/requests/search` must be registered before
  // `/requests/:id`, or MSW captures "search" as the id.
  http.get(`${BASE}/ticket_forms`, () =>
    HttpResponse.json({
      ticket_forms: [MOCK_TICKET_FORM_BUG, MOCK_TICKET_FORM_FEATURE],
      count: 2,
      next_page: null,
    }),
  ),
  http.get(`${BASE}/requests/search`, ({ request }) => {
    const query = new URL(request.url).searchParams.get('query') ?? '';
    // Echo the caller's query back through the filter so a search that matches
    // nothing is distinguishable from one that matches.
    const requests = query.includes('nothing') ? [] : [MOCK_REQUEST];
    return HttpResponse.json({ requests, count: requests.length, next_page: null });
  }),
  http.get(`${BASE}/requests/:id/comments`, () => HttpResponse.json(MOCK_REQUEST_COMMENTS)),
  http.get(`${BASE}/requests/:id`, ({ params }) => {
    const id = Number(params['id']);
    if (id === MOCK_REQUEST_UNSOLVABLE.id) {
      return HttpResponse.json({ request: MOCK_REQUEST_UNSOLVABLE });
    }
    if (id === 5003) {
      return HttpResponse.json({ request: { ...MOCK_REQUEST, id: 5003, status: 'solved' } });
    }
    return HttpResponse.json({ request: { ...MOCK_REQUEST, id } });
  }),
  http.get(`${BASE}/requests`, ({ request }) => {
    const status = new URL(request.url).searchParams.get('status');
    const requests = status === 'closed' ? [] : [MOCK_REQUEST];
    return HttpResponse.json({ requests, count: requests.length, next_page: null });
  }),
  http.post(`${BASE}/requests`, async ({ request }) => {
    const body = (await request.json()) as { request: Record<string, unknown> };
    return HttpResponse.json({ request: { ...MOCK_REQUEST, id: 5010, ...body.request } });
  }),
  http.put(`${BASE}/requests/:id`, async ({ request, params }) => {
    const body = (await request.json()) as {
      request: { solved?: boolean; comment?: { body: string } };
    };
    // Mirror the two real transitions: `solved: true` solves it, and a comment
    // on a solved request reopens it.
    const status = body.request.solved ? 'solved' : 'open';
    return HttpResponse.json({
      request: { ...MOCK_REQUEST, id: Number(params['id']), status },
    });
  }),

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
      ticket_fields: [
        MOCK_TICKET_FIELD_SUBJECT,
        MOCK_TICKET_FIELD_DESCRIPTION,
        MOCK_TICKET_FIELD_SYSTEM,
        MOCK_TICKET_FIELD_CUSTOM,
        MOCK_TICKET_FIELD_PORTAL_OPTIONAL,
        MOCK_TICKET_FIELD_CONDITION_PARENT,
      ],
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
  http.get(`${HC_BASE}/categories`, ({ request }) =>
    HttpResponse.json({
      categories: withTranslationsSideload(request, 'categories', [MOCK_CATEGORY]),
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
  http.get(`${HC_BASE}/categories/:id`, ({ params, request }) =>
    HttpResponse.json({
      category: withTranslationsSideload(request, 'categories', [
        { ...MOCK_CATEGORY, id: Number(params['id']) },
      ])[0],
    }),
  ),
  http.get(`${HC_BASE}/sections`, ({ request }) =>
    HttpResponse.json({
      sections: withTranslationsSideload(request, 'sections', [MOCK_SECTION]),
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
  http.get(`${HC_BASE}/categories/:cid/sections`, ({ request }) =>
    HttpResponse.json({
      sections: withTranslationsSideload(request, 'sections', [MOCK_SECTION]),
      meta: { has_more: false, after_cursor: '' },
      count: 1,
    }),
  ),

  // Help Center - Section & Category translations. The write handlers echo the
  // submitted `translation` object back over the fixture, so a test can assert
  // which fields the tool actually sent (and, by omission, which it left alone).
  http.get(`${HC_BASE}/sections/:id/translations`, ({ params }) =>
    HttpResponse.json({ translations: SECTION_TRANSLATIONS[String(params['id'])] ?? [] }),
  ),
  http.post(`${HC_BASE}/sections/:id/translations`, async ({ request, params }) => {
    const submitted = await readTranslationPayload(request);
    return HttpResponse.json({
      translation: {
        ...MOCK_SECTION_TRANSLATION,
        id: 7150,
        source_id: Number(params['id']),
        ...submitted,
      },
    });
  }),
  http.put(`${HC_BASE}/sections/:id/translations/:locale`, async ({ request, params }) => {
    const submitted = await readTranslationPayload(request);
    return HttpResponse.json({
      translation: {
        ...MOCK_SECTION_TRANSLATION,
        source_id: Number(params['id']),
        locale: params['locale'] as string,
        ...submitted,
      },
    });
  }),
  http.get(`${HC_BASE}/categories/:id/translations`, ({ params }) =>
    HttpResponse.json({ translations: CATEGORY_TRANSLATIONS[String(params['id'])] ?? [] }),
  ),
  http.post(`${HC_BASE}/categories/:id/translations`, async ({ request, params }) => {
    const submitted = await readTranslationPayload(request);
    return HttpResponse.json({
      translation: {
        ...MOCK_CATEGORY_TRANSLATION,
        id: 7250,
        source_id: Number(params['id']),
        ...submitted,
      },
    });
  }),
  http.put(`${HC_BASE}/categories/:id/translations/:locale`, async ({ request, params }) => {
    const submitted = await readTranslationPayload(request);
    return HttpResponse.json({
      translation: {
        ...MOCK_CATEGORY_TRANSLATION,
        source_id: Number(params['id']),
        locale: params['locale'] as string,
        ...submitted,
      },
    });
  }),
];
