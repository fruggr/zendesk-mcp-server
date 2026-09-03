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
//
// The `*_in_portal` trio describes the field as an END USER sees it on a
// request form, and is a different axis from `active`/`required`, which are the
// agent-side flags. A field can be `required: false` (an agent may solve a
// ticket without it) yet `required_in_portal: true` (a customer cannot submit
// without it) -- so the end-user tools read the portal flags and never the
// agent ones. Present on every object the endpoint returns, for both roles, but
// declared optional because `GET /ticket_fields` is also the agent-facing
// listing and nothing should start depending on them there.
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
  /** Whether the field is shown to end users on a request form. */
  visible_in_portal?: boolean;
  /** Whether an end user must fill it to submit. Independent of `required`. */
  required_in_portal?: boolean;
  /** Whether an end user may change it after submitting. */
  editable_in_portal?: boolean;
  /** The label shown to end users; may differ from the agent-side `title`. */
  title_in_portal?: string;
}

// GET /api/v2/ticket_forms — a request form: the named set of fields a customer
// picks between on the Help Center ("Bug", "Feature request", ...). Readable by
// end users, who receive only the forms marked `end_user_visible`; Zendesk does
// NOT filter out inactive ones, so `active` still has to be honoured.
//
// `ticket_field_ids` is a SUPERSET of what any one submitter sees:
// `end_user_conditions` can hide a field, or make it required, depending on
// another field's value. We surface those conditions as data rather than
// evaluating them (see the end-user tool descriptions).
//
// `display_name` is the customer-facing name and `name` the internal one; the
// `raw_*` variants may hold an unresolved dynamic-content placeholder
// (`{{dc.some_key}}`), so the resolved fields are the ones to render.
export interface ZendeskTicketForm {
  id: number;
  name: string;
  display_name: string;
  active: boolean;
  end_user_visible: boolean;
  default: boolean;
  position?: number;
  ticket_field_ids: number[];
  end_user_conditions?: ZendeskFormCondition[];
}

// One condition set inside a form's `end_user_conditions`: when
// `parent_field_id` holds `value`, the listed `child_fields` become visible,
// each with its own `is_required` override. Rendered verbatim for the model to
// reason about rather than evaluated -- whether the Requests API enforces these
// server-side is unverified (no form on the probed instance carried any).
export interface ZendeskFormCondition {
  parent_field_id: number;
  value: unknown;
  child_fields?: Array<{ id: number; is_required?: boolean; required_on_statuses?: unknown }>;
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

// A single action a macro performs: `field` is the target (e.g. "status",
// "priority", "set_tags", or "comment_value" for the canned reply) and `value`
// the value to set — a string, an array (multi-value fields), or a number,
// depending on the field.
export interface ZendeskMacroAction {
  field: string;
  value: unknown;
}

// A macro definition from GET /macros/active — the active macros available to
// the authenticated user. `actions` is the ordered bundle of field changes and
// the optional canned reply the macro applies; `restriction` scopes who may use
// it (null = shared with everyone in the account).
export interface ZendeskMacro {
  id: number;
  title: string;
  description: string | null;
  active: boolean;
  actions: ZendeskMacroAction[];
  position?: number;
  restriction?: { type: string; id?: number; ids?: number[] } | null;
  created_at: string;
  updated_at: string;
}

// The canned reply carried by a macro-apply result. `public` distinguishes a
// public comment (emails the requester) from an internal note.
export interface ZendeskMacroApplyComment {
  body?: string;
  public?: boolean;
}

// A single custom-field change in a macro-apply result.
export interface ZendeskMacroApplyField {
  id: number;
  value: unknown;
}

// GET /tickets/{id}/macros/{macro_id}/apply returns the WHOLE ticket as it would
// be after the macro runs (not just the changed fields — confirmed against the
// live tenant), plus the comment it would add. Nothing is persisted; the caller
// commits via update_ticket / add_public_comment / add_private_note.
// preview_macro_diff isolates the macro's actual effect by diffing this against
// the ticket's current state. Standard fields (status, priority, assignee_id,
// group_id, tags, subject, type, …) appear as top-level keys; custom fields
// arrive under `fields` (or `custom_fields`).
export interface ZendeskMacroApplyTicket {
  comment?: ZendeskMacroApplyComment;
  // The apply endpoint renders one changed custom field as a bare object and
  // several as an array, so both shapes are accepted (the handler normalizes).
  fields?: ZendeskMacroApplyField[] | ZendeskMacroApplyField;
  custom_fields?: ZendeskMacroApplyField[] | ZendeskMacroApplyField;
  [key: string]: unknown;
}

export interface ZendeskMacroApplyResult {
  ticket: ZendeskMacroApplyTicket;
  // Some API versions surface the comment as a sibling of `ticket` rather than
  // nested inside it; the handler reads both locations.
  comment?: ZendeskMacroApplyComment;
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

// GET/POST/PUT /api/v2/requests — a ticket as its REQUESTER sees it. Not a
// trimmed ZendeskTicket: there is no `tags`, `assignee_id` is only present when
// the form exposes it to end users, and `can_be_solved_by_me` exists nowhere
// else. Hence a dedicated interface and a dedicated formatter.
//
// `can_be_solved_by_me` is read-only and tracks ASSIGNMENT, not status: false
// while the ticket is unassigned, true once an agent owns it and the type is
// not `problem`. Writing `solved: true` when it is false returns 200 and
// changes nothing, so it has to be checked before offering the operation.
export interface ZendeskRequest {
  id: number;
  subject: string;
  description: string;
  status: string;
  priority?: string | null;
  type?: string | null;
  requester_id: number;
  organization_id?: number | null;
  ticket_form_id?: number | null;
  can_be_solved_by_me?: boolean;
  due_at?: string | null;
  custom_fields?: Array<{ id: number; value: unknown }>;
  via?: { channel?: string };
  created_at: string;
  updated_at: string;
}

// The `users` sideload that `GET /requests/{id}/comments` returns by default.
// Five keys only -- no email, no role -- so it is safe to render to the
// requester, and `agent` is what tells an agent's reply from the customer's own
// comment without guessing from ids.
export interface ZendeskRequestCommentAuthor {
  id: number;
  name: string;
  agent: boolean;
}

// GET /api/v2/tickets/{id}/audits — the immutable, chronological record of every
// update to a ticket. Each audit is one update; its `events` list the individual
// changes/comments that update carried. `Change`/`Create` events expose
// `field_name`/`value`/`previous_value` (the before→after of a field); comment
// events carry `public` (and a body we deliberately do not render — see
// get_ticket_history). Values are strings, except `tags` (array) and SLA-metric
// fields (object). Many event types are system noise and are filtered out.
export interface ZendeskAuditEvent {
  id: number;
  type: string;
  field_name?: string;
  value?: unknown;
  previous_value?: unknown;
  public?: boolean;
  author_id?: number;
  body?: string;
}

export interface ZendeskAudit {
  id: number;
  ticket_id: number;
  created_at: string;
  author_id: number;
  via?: { channel?: string };
  events: ZendeskAuditEvent[];
}

// Minimal Group shape — only what get_ticket_history needs to resolve a
// group_id change to a readable name (GET /api/v2/groups/show_many).
export interface ZendeskGroup {
  id: number;
  name: string;
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
  /** Visibility segment; null/absent means the article is visible to everyone. */
  user_segment_id?: number | null;
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
  /**
   * Set by Zendesk when the source translation was edited after this one — the
   * authoritative "this translation is stale" signal. Only returned on the
   * translations *list* endpoint (`GET /articles/{id}/translations`), not on a
   * single-translation GET, so it is optional here.
   */
  outdated?: boolean;
}

export interface ZendeskCategory {
  id: number;
  name: string;
  description: string;
  locale: string;
  position: number;
  created_at: string;
  updated_at: string;
  /** @see {@link ZendeskSection.translations} */
  translations?: ZendeskTranslation[];
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
  /**
   * The `include=translations` sideload: every locale of this node, each with its
   * `draft` flag, embedded in the node rather than in a top-level array keyed by
   * `source_id` (measured on a live tenant, #226). Optional because an `include`
   * Zendesk does not honour is dropped silently, so a caller must tell an empty
   * array (no translation at all) from an absent one (nothing was sideloaded).
   */
  translations?: ZendeskTranslation[];
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
  audits?: T[];
  translations?: T[];
  permission_groups?: T[];
  sla_policies?: T[];
  ticket_fields?: T[];
  ticket_forms?: T[];
  requests?: T[];
  macros?: T[];
  meta?: {
    has_more: boolean;
    after_cursor: string;
  };
  count?: number;
  next_page?: string | null;
}
