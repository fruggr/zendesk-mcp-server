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

// Live per-ticket SLA state, returned as a top-level `slas` sideload when a
// ticket is fetched with `?include=slas` (or `?include=tickets(slas)` in search).
// The exact field names of this sideload are not crisply documented, so the
// volatile fields are optional and the formatter reads them defensively
// (`stage ?? status`, `breach_at ?? due_at`, `business ?? business_hours`).
export interface ZendeskSlaLiveMetric {
  metric: string;
  stage?: string;
  status?: string;
  target?: number;
  business?: boolean;
  business_hours?: boolean;
  breach_at?: string | null;
  due_at?: string | null;
}

// Nested applied-policy object. Zendesk consistently exposes the applied policy
// as `policy: { id, title, description }` (e.g. the `sla` object on ticket
// metric events), so the sideload is read that way first, with flat
// `policy_id` / `title` kept as a fallback.
export interface ZendeskSlaPolicyRef {
  id?: number;
  title?: string;
  description?: string | null;
}

export interface ZendeskSlaSideloadEntry {
  ticket_id?: number;
  policy?: ZendeskSlaPolicyRef;
  policy_id?: number;
  title?: string;
  description?: string | null;
  policy_metrics: ZendeskSlaLiveMetric[];
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
  tickets?: T[];
  users?: T[];
  organizations?: T[];
  articles?: T[];
  categories?: T[];
  sections?: T[];
  comments?: T[];
  translations?: T[];
  permission_groups?: T[];
  sla_policies?: T[];
  meta?: {
    has_more: boolean;
    after_cursor: string;
  };
  count?: number;
  next_page?: string | null;
}
