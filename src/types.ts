export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  priority: string | null;
  type: string | null;
  assignee_id: number | null;
  requester_id: number;
  group_id: number | null;
  organization_id: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  custom_fields: Array<{ id: number; value: unknown }>;
  // Live SLA state, present only on Search results fetched with
  // `include=tickets(slas)` (nested per result). Absent on the Show Ticket
  // endpoint — Zendesk silently ignores `include=slas` there (see #92).
  slas?: ZendeskSlaSideloadEntry;
}

// GET /api/v2/slas/policies.json — a configured SLA policy with its filter
// conditions and per-priority reply/resolution targets.
export interface ZendeskSlaCondition {
  field: string;
  operator: string;
  value: unknown;
}

export interface ZendeskSlaPolicyMetric {
  priority: string;
  metric: string;
  target: number;
  target_in_seconds?: number;
  business_hours: boolean;
}

export interface ZendeskSlaPolicy {
  id: number;
  title: string;
  description: string | null;
  position: number;
  filter: { all: ZendeskSlaCondition[]; any: ZendeskSlaCondition[] };
  policy_metrics: ZendeskSlaPolicyMetric[];
  created_at: string;
  updated_at: string;
  url?: string;
}

// Live per-ticket SLA state, nested on each ticket result of a Search fetched
// with `include=tickets(slas)` (verified against the live API, see #92). It
// carries only the live metrics: no `ticket_id` (correlation is by nesting),
// no policy identity and no target (those live in `/slas/policies`, surfaced
// by `list_sla_policies`).
export interface ZendeskSlaLiveMetric {
  metric: string;
  stage?: string; // active | paused | achieved | fulfilled | breached | ...
  breach_at?: string | null;
  days?: number; // whole days to breach, when Zendesk includes it
}

export interface ZendeskSlaSideloadEntry {
  policy_metrics: ZendeskSlaLiveMetric[];
}

// A selectable value on a ticket field. `value` is the tag written back via
// create_ticket / update_ticket custom_fields; `name` is the human label shown
// in the Zendesk UI. Shared by dropdown/multiselect custom fields
// (`custom_field_options`) and system fields (`system_field_options`).
export interface ZendeskFieldOption {
  name: string;
  value: string;
}

// A ticket field definition (system or custom) from the Ticket Fields API. The
// `id` is what create_ticket / update_ticket custom_fields expect; `type`
// determines whether `custom_field_options` (dropdown/multiselect) or
// `system_field_options` (system fields like priority) carry the valid values.
export interface ZendeskTicketField {
  id: number;
  type: string;
  title: string;
  description: string | null;
  active: boolean;
  required: boolean;
  tag?: string | null;
  custom_field_options?: ZendeskFieldOption[];
  system_field_options?: ZendeskFieldOption[];
}

// GET /api/v2/views — a Zendesk view: a saved, per-agent ticket queue
// ("Unassigned tickets", "Breaching today"). We surface title/id/description for
// list_views; `execution`/`conditions`/`restriction` are read by the API but not
// rendered (the usage is the queue, not its filter definition).
export interface ZendeskView {
  id: number;
  title: string;
  active: boolean;
  description: string | null;
  position?: number;
}

// GET /api/v2/views/count_many — a view's cached ticket count. Zendesk caches
// these heavily (up to ~an hour for large views): while it recomputes, `fresh`
// is false and `value` may be null. `pretty` is the display form ("298", "~700",
// or "..." when not yet computed), so prefer it for rendering.
export interface ZendeskViewCount {
  view_id: number;
  value: number | null;
  pretty: string;
  fresh: boolean;
  url?: string;
}

export interface ZendeskViewCountManyResponse {
  view_counts?: ZendeskViewCount[];
}

// GET /api/v2/views/{id}/execute — a view executed with its own column set and
// configured sort order. Each row carries the view's column values inlined plus a
// *partial* ticket object; we use the rows only for the view-ordered ticket ids,
// then hydrate full tickets via /tickets/show_many (the partial ticket and the
// view-dependent columns are not a reliable full ticket, see #121).
export interface ZendeskViewExecuteRow {
  ticket?: { id?: number };
  [key: string]: unknown;
}

export interface ZendeskViewExecuteResponse {
  columns?: Array<{ id: string | number; title: string }>;
  rows?: ZendeskViewExecuteRow[];
  view?: { id: number };
  meta?: {
    has_more: boolean;
    after_cursor: string;
  };
  count?: number;
  next_page?: string | null;
}

export interface ZendeskTicketAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type: string;
  size: number;
  inline?: boolean;
}

export interface ZendeskComment {
  id: number;
  body: string;
  author_id: number;
  public: boolean;
  created_at: string;
  attachments?: ZendeskTicketAttachment[];
}

export interface ZendeskUpload {
  token: string;
  expires_at: string;
  attachment: ZendeskTicketAttachment;
  attachments: ZendeskTicketAttachment[];
}

export interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: string;
  role_type: number | null;
  organization_id: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ZendeskOrganization {
  id: number;
  name: string;
  details: string | null;
  notes: string | null;
  domain_names: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ZendeskArticle {
  id: number;
  title: string;
  body: string;
  locale: string;
  source_locale: string;
  author_id: number;
  section_id: number;
  permission_group_id: number;
  draft: boolean;
  promoted: boolean;
  position: number;
  label_names: string[];
  created_at: string;
  updated_at: string;
}

export interface ZendeskPermissionGroup {
  id: number;
  name: string;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface ZendeskContentTag {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ZendeskLabel {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ZendeskUserSegment {
  id: number;
  name: string;
  user_type: string;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface ZendeskArticleAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type: string;
  size: number;
  created_at: string;
}

export interface ZendeskTranslation {
  id: number;
  locale: string;
  title: string;
  body: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  source_id: number;
  source_type: string;
}

export interface ZendeskCategory {
  id: number;
  name: string;
  description: string;
  locale: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ZendeskSection {
  id: number;
  name: string;
  description: string;
  locale: string;
  category_id: number;
  position: number;
  created_at: string;
  updated_at: string;
}

// GET /api/v2/help_center/locales — the Help Center's active languages and the
// one served by default.
export interface ZendeskLocalesResponse {
  locales: string[];
  default_locale: string;
}

export interface PaginationMeta {
  has_more: boolean;
  after_cursor: string | null;
  count: number;
}

export interface ZendeskListResponse<T> {
  results?: T[];
  records?: T[];
  tickets?: T[];
  views?: T[];
  users?: T[];
  organizations?: T[];
  articles?: T[];
  categories?: T[];
  sections?: T[];
  comments?: T[];
  translations?: T[];
  permission_groups?: T[];
  sla_policies?: T[];
  ticket_fields?: T[];
  meta?: {
    has_more: boolean;
    after_cursor: string;
  };
  count?: number;
  next_page?: string | null;
}
