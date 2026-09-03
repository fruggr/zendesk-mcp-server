import { CHARACTER_LIMIT } from '../constants.js';
import type {
  PaginationMeta,
  ZendeskArticle,
  ZendeskArticleAttachment,
  ZendeskAudit,
  ZendeskAuditEvent,
  ZendeskCategory,
  ZendeskComment,
  ZendeskContentTag,
  ZendeskLabel,
  ZendeskMacro,
  ZendeskMacroAction,
  ZendeskOrganization,
  ZendeskPermissionGroup,
  ZendeskRequest,
  ZendeskRequestCommentAuthor,
  ZendeskSection,
  ZendeskSlaLiveMetric,
  ZendeskSlaPolicy,
  ZendeskSlaSideloadEntry,
  ZendeskTicket,
  ZendeskTicketField,
  ZendeskTranslation,
  ZendeskUser,
  ZendeskUserSegment,
  ZendeskView,
  ZendeskViewCount,
} from '../types.js';

export const truncateIfNeeded = (text: string): string => {
  if (text.length <= CHARACTER_LIMIT) return text;
  return `${text.slice(0, CHARACTER_LIMIT)}\n\n--- Response truncated (${text.length} chars, limit ${CHARACTER_LIMIT}). Use pagination or filters to reduce results. ---`;
};

const formatPagination = (meta: PaginationMeta): string => {
  const parts = [`Results: ${meta.count}`];
  if (meta.has_more) {
    parts.push(`More available (cursor: ${meta.after_cursor})`);
  }
  return parts.join(' | ');
};

export const formatTicket = (ticket: ZendeskTicket): string =>
  [
    `## Ticket #${ticket.id}: ${ticket.subject}`,
    `- **Status**: ${ticket.status} | **Priority**: ${ticket.priority ?? 'none'} | **Type**: ${ticket.type ?? 'none'}`,
    `- **Requester**: ${ticket.requester_id} | **Assignee**: ${ticket.assignee_id ?? 'unassigned'}`,
    `- **Tags**: ${ticket.tags.length > 0 ? ticket.tags.join(', ') : 'none'}`,
    `- **Created**: ${ticket.created_at} | **Updated**: ${ticket.updated_at}`,
    ticket.description ? `\n${ticket.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');

const formatConditionValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export const formatSlaPolicy = (policy: ZendeskSlaPolicy): string => {
  const conditions = [
    ...policy.filter.all.map((c) =>
      `all: ${c.field} ${c.operator} ${formatConditionValue(c.value)}`.trim(),
    ),
    ...policy.filter.any.map((c) =>
      `any: ${c.field} ${c.operator} ${formatConditionValue(c.value)}`.trim(),
    ),
  ];
  const targets = policy.policy_metrics.map(
    (m) =>
      `  - ${m.priority} / ${m.metric}: ${m.target} min${m.business_hours ? ' (business)' : ''}`,
  );
  return [
    `## SLA policy: ${policy.title} (${policy.id})`,
    policy.description ? `- **Description**: ${policy.description}` : '',
    `- **Position**: ${policy.position}`,
    conditions.length > 0 ? `- **Conditions**: ${conditions.join('; ')}` : '',
    targets.length > 0 ? '- **Targets**:' : '',
    ...targets,
  ]
    .filter(Boolean)
    .join('\n');
};

// Render a ticket field definition. Surfaces the id (what custom_fields writes
// need), the type, and — for dropdown/multiselect (custom_field_options) or
// system fields (system_field_options) — the exact value tags accepted, so the
// caller can map a natural-language intent to a valid write without guessing.
export const formatTicketField = (field: ZendeskTicketField): string => {
  const flags = [
    field.active ? 'active' : 'inactive',
    field.required ? 'required' : 'optional',
  ].join(', ');
  const options = field.custom_field_options ?? field.system_field_options ?? [];
  return [
    `## ${field.title} (id ${field.id})`,
    `- **Type**: ${field.type} | **${flags}**`,
    field.description ? `- **Description**: ${field.description}` : '',
    field.tag ? `- **Tag**: ${field.tag}` : '',
    options.length > 0 ? '- **Options** (name → value):' : '',
    ...options.map((o) => `  - ${o.name} → ${o.value}`),
  ]
    .filter(Boolean)
    .join('\n');
};

// Render an arbitrary Zendesk field value — a macro action value, a macro-apply
// field change — as a compact string: arrays as comma-joined tokens, scalars and
// objects via the shared `formatConditionValue` ladder (null/undefined → empty,
// object → JSON, else String). Shared by the macro formatters (here and in the
// preview-diff renderer) so list_macros and preview_macro_diff stringify values
// the same way instead of drifting apart.
export const formatFieldValue = (value: unknown): string =>
  // Recurse per element so an array of objects renders as JSON tokens rather than
  // the useless "[object Object]" a bare join produces; scalars/objects reuse the
  // existing condition-value stringifier (which encodes arrays as JSON, hence the
  // array case stays here rather than delegating).
  Array.isArray(value) ? value.map(formatFieldValue).join(', ') : formatConditionValue(value);

// One macro action rendered as `field → value`. Long values (a canned reply in
// `comment_value`) are previewed rather than dumped whole, keeping a macro list
// scannable; the full reply text is materialized by preview_macro_diff against a
// ticket, not here.
const MACRO_VALUE_PREVIEW = 120;
const formatMacroActionValue = (value: unknown): string => {
  const oneLine = formatFieldValue(value).replace(/\s+/g, ' ').trim();
  return oneLine.length > MACRO_VALUE_PREVIEW
    ? `${oneLine.slice(0, MACRO_VALUE_PREVIEW)}…`
    : oneLine;
};

const formatMacroAction = (action: ZendeskMacroAction): string =>
  `  - ${action.field} → ${formatMacroActionValue(action.value)}`;

// Render a macro definition for list_macros: its id (what preview_macro_diff needs),
// title, availability scope, and the ordered bundle of actions it applies so a
// caller can judge a macro's effect before previewing it against a ticket.
export const formatMacro = (macro: ZendeskMacro): string => {
  // A shared macro comes back with `restriction: null` — but the API also
  // renders an unrestricted macro as an empty object `{}`, so key off a real
  // `type` rather than mere truthiness to avoid mislabeling it "restricted".
  const scope = macro.restriction?.type ? 'restricted' : 'shared';
  const actions = macro.actions ?? [];
  return [
    `## ${macro.title} (id ${macro.id})`,
    `- **${macro.active ? 'active' : 'inactive'}** | **Scope**: ${scope}`,
    macro.description ? `- **Description**: ${macro.description}` : '',
    actions.length > 0 ? '- **Actions**:' : '- **Actions**: none',
    ...actions.map(formatMacroAction),
  ]
    .filter(Boolean)
    .join('\n');
};

const minutesUntil = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((t - Date.now()) / 60_000);
};

const formatSlaMetric = (m: ZendeskSlaLiveMetric): string => {
  const stage = m.stage ?? 'unknown';
  const due = m.breach_at ?? null;
  const parts = [`- **${m.metric}** — ${stage}`];
  if (due) {
    const remaining = minutesUntil(due);
    if (stage === 'paused' || stage === 'achieved' || stage === 'fulfilled' || remaining == null) {
      parts.push(`due ${due}`);
    } else if (remaining < 0) {
      parts.push(`due ${due} — breached (${Math.abs(remaining)} min overdue)`);
    } else {
      parts.push(`due ${due} — ${remaining} min remaining`);
    }
  }
  return parts.join('; ');
};

// Live SLA block appended after a formatted ticket. Renders only the state the
// Search `slas` sideload actually carries (per-metric stage + breach countdown)
// — targets and policy identity are not on the wire (see `list_sla_policies`).
// Returns '' when no policy applies, so it is safe to concatenate
// unconditionally (incl. in search rows).
export const formatSlaBlock = (entry: ZendeskSlaSideloadEntry | undefined): string => {
  if (!entry?.policy_metrics || entry.policy_metrics.length === 0) return '';
  const lines = ['### SLA'];
  const futureBreaches = entry.policy_metrics
    .map((m) => m.breach_at)
    .map((d) => (d ? Date.parse(d) : Number.NaN))
    .filter((t) => !Number.isNaN(t) && t > Date.now());
  if (futureBreaches.length > 0) {
    lines.push(`- **Next breach**: ${new Date(Math.min(...futureBreaches)).toISOString()}`);
  }
  for (const m of entry.policy_metrics) lines.push(formatSlaMetric(m));
  return `\n\n${lines.join('\n')}`;
};

export const formatComment = (comment: ZendeskComment): string => {
  const lines = [
    `### ${comment.public ? 'Public comment' : 'Internal note'} by ${comment.author_id}`,
    `*${comment.created_at}*`,
  ];
  if (comment.attachments?.length) {
    const summary = comment.attachments.map((a) => `#${a.id} (${a.content_type})`).join(', ');
    lines.push(`Attachments: ${summary}`);
  }
  lines.push('', comment.body);
  return lines.join('\n');
};

// A request as its requester sees it. Deliberately NOT formatTicket: that one
// dereferences `ticket.tags.length` unguarded and a Request carries no `tags`,
// so reusing it would throw; it also renders `assignee_id`, which end users are
// not shown, and omits `can_be_solved_by_me`, which is the field that decides
// whether the "mark solved" operation is even offered.
export const formatRequest = (request: ZendeskRequest): string =>
  [
    `## Request #${request.id}: ${request.subject}`,
    `- **Status**: ${request.status}${request.type ? ` | **Type**: ${request.type}` : ''}${
      request.priority ? ` | **Priority**: ${request.priority}` : ''
    }`,
    request.ticket_form_id ? `- **Form**: ${request.ticket_form_id}` : '',
    // Stated in both directions on purpose: "no" is the answer to "can I close
    // this?", and leaving it implicit invites a pointless attempt that Zendesk
    // would accept with a 200 and silently ignore.
    `- **Can you mark it solved**: ${request.can_be_solved_by_me ? 'yes' : 'no'}`,
    request.via?.channel ? `- **Submitted via**: ${request.via.channel}` : '',
    `- **Created**: ${request.created_at} | **Updated**: ${request.updated_at}`,
    request.description ? `\n${request.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');

// A comment on one's own request. formatComment is wrong here twice over: it
// labels a non-public comment "Internal note", which cannot reach this path at
// all (Zendesk filters agent notes out of /requests/{id}/comments), and it
// prints a bare `author_id` where the endpoint hands us a `users` sideload with
// a name and an `agent` flag -- which is exactly what tells an agent's reply
// from the customer's own comment.
export const formatRequestComment = (
  comment: ZendeskComment,
  authors: Map<number, ZendeskRequestCommentAuthor>,
): string => {
  const author = authors.get(comment.author_id);
  const who = author
    ? `${author.name}${author.agent ? ' (support agent)' : ''}`
    : `user ${comment.author_id}`;
  const lines = [`### Comment by ${who}`, `*${comment.created_at}*`];
  if (comment.attachments?.length) {
    const summary = comment.attachments
      .map((a) => `${a.file_name} (#${a.id}, ${a.content_type})`)
      .join(', ');
    lines.push(`Attachments: ${summary}`);
  }
  lines.push('', comment.body);
  return lines.join('\n');
};

// Tags rendered as added/removed tokens (`+new`, `-gone`) rather than a full
// before/after list — that is what tag changes actually express. Returns null
// when the set is unchanged. Shared by the macro preview diff and the audit
// history timeline.
export const formatTagDiff = (before: unknown, after: unknown): string | null => {
  const b = new Set(Array.isArray(before) ? before.map(String) : []);
  const a = new Set(Array.isArray(after) ? after.map(String) : []);
  const added = [...a].filter((t) => !b.has(t)).map((t) => `+${t}`);
  const removed = [...b].filter((t) => !a.has(t)).map((t) => `-${t}`);
  return added.length + removed.length === 0
    ? null
    : `- **tags**: ${[...added, ...removed].join(', ')}`;
};

// Audit Change/Create fields whose value is an entity id, and which entity kind
// it resolves to. The single source of truth for both id collection (what to
// look up) and rendering (which name map to use), so the two never drift.
export const AUDIT_ENTITY_FIELDS: Record<string, 'user' | 'group'> = {
  assignee_id: 'user',
  requester_id: 'user',
  submitter_id: 'user',
  group_id: 'group',
};

// On a Create audit, render only these founding facts instead of every column
// Zendesk sets at creation (which would bury the timeline). Post-creation Changes
// are never filtered this way — every field change is shown.
const AUDIT_CREATE_FIELDS = new Set([
  'status',
  'priority',
  'type',
  'assignee_id',
  'group_id',
  'subject',
  'tags',
]);

const AUDIT_FIELD_LABELS: Record<string, string> = {
  assignee_id: 'assignee',
  requester_id: 'requester',
  submitter_id: 'submitter',
  group_id: 'group',
};

// id -> display name maps resolved by the caller (batched user/group look-ups).
export interface AuditNames {
  users: Map<number, string>;
  groups: Map<number, string>;
}

const withName = (id: unknown, names: Map<number, string>): string => {
  const n = Number(id);
  // Zendesk attributes automation/trigger-driven updates to the system actor
  // (author_id -1), which has no user record to resolve — label it plainly.
  if (n === -1) return 'System (-1)';
  const name = names.get(n);
  return name ? `${name} (${id})` : String(id);
};

// A Change/Create field value rendered for the timeline: user/group ids resolved
// to "Name (id)", SLA-metric objects reduced to their minutes, everything else via
// formatFieldValue. Returns '' for an empty/absent side.
const renderAuditValue = (field: string, value: unknown, names: AuditNames): string => {
  // The empty-value guard is the contract, not an optimisation: without it an
  // entity field would resolve `''` through `withName`, where `Number('')` is 0 —
  // rendering a name whenever the caller's map happens to carry that key. The
  // production caller filters 0 out (`addPositiveId` in `tools/tickets.ts`), but
  // `AuditNames` does not, so the guard has to hold here. Asserted in
  // "renders an emptied entity field as (none), whatever the name maps carry".
  if (value === null || value === undefined || value === '') return '';
  const entity = AUDIT_ENTITY_FIELDS[field];
  if (entity === 'user') return withName(value, names.users);
  if (entity === 'group') return withName(value, names.groups);
  // `!Array.isArray` is likewise load-bearing rather than defensive padding: an
  // array reaching the SLA-metric branch would be destructured for `minutes` and
  // reported as a duration. Asserted in "never reads an array as an SLA metric".
  if (typeof value === 'object' && !Array.isArray(value) && 'minutes' in value) {
    const { minutes } = value as { minutes?: unknown };
    if (typeof minutes === 'number') return `${minutes} min`;
  }
  return formatFieldValue(value);
};

// A Create event's founding fact: only whitelisted fields, rendered single-sided
// (there is no "before"). Returns null for a non-whitelisted or empty field.
const renderCreateEvent = (event: ZendeskAuditEvent, names: AuditNames): string | null => {
  const field = event.field_name;
  if (!field || !AUDIT_CREATE_FIELDS.has(field)) return null;
  if (field === 'tags') {
    const tags = Array.isArray(event.value) ? event.value.map(String) : [];
    return tags.length > 0 ? `- **tags**: ${tags.join(', ')}` : null;
  }
  const value = renderAuditValue(field, event.value, names);
  return value === '' ? null : `- **${AUDIT_FIELD_LABELS[field] ?? field}**: ${value}`;
};

// A post-creation Change: any field, rendered as before → after. Returns null
// when the value did not actually change after rendering.
const renderChangeEvent = (event: ZendeskAuditEvent, names: AuditNames): string | null => {
  const field = event.field_name;
  if (!field) return null;
  if (field === 'tags') return formatTagDiff(event.previous_value, event.value);
  const after = renderAuditValue(field, event.value, names);
  const before = renderAuditValue(field, event.previous_value, names);
  if (before === after) return null;
  return `- **${AUDIT_FIELD_LABELS[field] ?? field}**: ${before || '(none)'} → ${after || '(none)'}`;
};

const renderAuditEvent = (event: ZendeskAuditEvent, names: AuditNames): string | null => {
  switch (event.type) {
    case 'Create':
      return renderCreateEvent(event, names);
    case 'Change':
      return renderChangeEvent(event, names);
    case 'Comment':
    case 'VoiceComment':
      // Presence only — the body lives on get_ticket(include_comments), so the
      // timeline attributes the reply without duplicating (or bloating with) it.
      return `- ${event.public === false ? 'Internal note' : 'Public comment'} added`;
    case 'CommentPrivacyChange':
      return '- Comment visibility changed';
    case 'FollowersChange':
      return '- Followers changed';
    case 'EmailCcChange':
      return '- Email CCs changed';
    case 'SatisfactionRating':
      return '- Satisfaction rating recorded';
    default:
      return null;
  }
};

// One audit rendered as a timeline block: a heading (when — who — channel) plus a
// line per meaningful change. Returns null when the audit carries only filtered
// system-noise events, so an all-noise update (e.g. a trigger that just sent a
// notification) produces no block rather than an empty one.
export const formatAudit = (audit: ZendeskAudit, names: AuditNames): string | null => {
  const lines = audit.events
    .map((e) => renderAuditEvent(e, names))
    .filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  const channel = audit.via?.channel ? ` via ${audit.via.channel}` : '';
  const heading = `### ${audit.created_at} — ${withName(audit.author_id, names.users)}${channel}`;
  return [heading, ...lines].join('\n');
};

export const formatUser = (user: ZendeskUser): string =>
  [
    `## ${user.name} (${user.id})`,
    `- **Email**: ${user.email}`,
    `- **Role**: ${user.role}`,
    user.role_type != null ? `- **Role type**: ${user.role_type}` : '',
    `- **Active**: ${user.active}`,
    user.organization_id ? `- **Organization**: ${user.organization_id}` : '',
  ]
    .filter(Boolean)
    .join('\n');

export const formatOrganization = (org: ZendeskOrganization): string =>
  [
    `## ${org.name} (${org.id})`,
    org.details ? `- **Details**: ${org.details}` : '',
    org.domain_names.length > 0 ? `- **Domains**: ${org.domain_names.join(', ')}` : '',
    org.tags.length > 0 ? `- **Tags**: ${org.tags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

export const formatArticleSummary = (article: ZendeskArticle): string =>
  [
    `## ${article.title} (${article.id})`,
    `- **Locale**: ${article.locale} | **Source locale**: ${article.source_locale}`,
    `- **Section**: ${article.section_id} | **Draft**: ${article.draft}`,
    // Surface promoted status only when the article IS promoted, with the caveat
    // that changing it is admin-gated — so an editor doesn't try (and fail) to
    // toggle it. Non-promoted articles omit the line entirely (via filter(Boolean)).
    article.promoted
      ? '- **Promoted**: featured in its section — changing this requires Help Center admin (Guide admin) rights; set via update_article `promoted`.'
      : '',
    // Surface the visibility/edit IDs so an editor without Guide-admin rights can
    // reuse them (list_permission_groups / list_user_segments are admin-gated, #161).
    `- **Permission group**: ${article.permission_group_id} | **User segment**: ${
      article.user_segment_id ?? 'everyone (no segment)'
    }`,
    typeof article.position === 'number' ? `- **Position**: ${article.position}` : '',
    article.label_names.length > 0 ? `- **Labels**: ${article.label_names.join(', ')}` : '',
    `- **Created**: ${article.created_at} | **Updated**: ${article.updated_at}`,
  ]
    .filter(Boolean)
    .join('\n');

export const formatArticle = (article: ZendeskArticle): string =>
  [formatArticleSummary(article), '', article.body].join('\n');

export const formatTranslationSummary = (translation: ZendeskTranslation): string =>
  [
    `## Translation: ${translation.locale} (${translation.id})`,
    `- **Title**: ${translation.title}`,
    `- **Draft**: ${translation.draft}`,
    `- **Updated**: ${translation.updated_at}`,
  ].join('\n');

export const formatTranslation = (translation: ZendeskTranslation): string =>
  [formatTranslationSummary(translation), '', translation.body].join('\n');

// Translations of a section or a category, which reuse the article translation
// object with different meanings: `title` is the localized *name* and `body` the
// localized *description*. Rendered with the vocabulary list_sections /
// list_categories already use, so the caller never has to map the two. The
// description is reported as present/absent rather than inlined — it is metadata
// here, not content, and Zendesk leaves it empty when unset.
export const formatNodeTranslationSummary = (translation: ZendeskTranslation): string =>
  [
    `## Translation: ${translation.locale} (${translation.id})`,
    `- **Name**: ${translation.title}`,
    `- **Description**: ${translation.body ? 'set' : 'empty'}`,
    `- **Draft**: ${translation.draft}`,
    `- **Updated**: ${translation.updated_at}`,
  ].join('\n');

export const formatCategory = (category: ZendeskCategory): string =>
  `- **${category.name}** (${category.id}) — ${category.description || 'No description'}`;

export const formatSection = (section: ZendeskSection): string =>
  `- **${section.name}** (${section.id}) — Category: ${section.category_id} — ${section.description || 'No description'}`;

// Compact one-line view entry for list_views: title, id, and — when a count was
// resolved — the queue size. Counts are cached by Zendesk; a non-fresh one is
// marked "(count updating)" so the caller does not treat a stale/estimated value
// (or "...") as exact. Rendered via `count.pretty`, which already carries the
// exact/approximate/"not yet computed" form.
export const formatView = (view: ZendeskView, count?: ZendeskViewCount): string => {
  const countText = count
    ? ` — ${count.pretty} ticket(s)${count.fresh ? '' : ' (count updating)'}`
    : '';
  const description = view.description ? ` — ${view.description}` : '';
  return `- **${view.title}** (id ${view.id})${countText}${description}`;
};

export const formatPermissionGroup = (group: ZendeskPermissionGroup): string =>
  `- **${group.name}** (${group.id})${group.built_in ? ' — Built-in' : ''}`;

export const formatContentTag = (tag: ZendeskContentTag): string => `- **${tag.name}** (${tag.id})`;

export const formatLabel = (label: ZendeskLabel): string => `- **${label.name}** (${label.id})`;

export const formatUserSegment = (segment: ZendeskUserSegment): string =>
  `- **${segment.name}** (${segment.id}) — ${segment.user_type}${segment.built_in ? ' — Built-in' : ''}`;

export const formatAttachment = (attachment: ZendeskArticleAttachment): string =>
  `- **${attachment.file_name}** (${attachment.id}) — ${attachment.content_type} — ${attachment.size} bytes`;

export const formatList = <T>(
  items: T[],
  formatter: (item: T) => string,
  meta?: PaginationMeta,
): string => {
  const header = meta ? formatPagination(meta) : '';
  const body = items.map(formatter).join('\n\n');
  const text = [header, body].filter(Boolean).join('\n\n');
  return truncateIfNeeded(text);
};
