import { CHARACTER_LIMIT } from '../constants.js';
import type {
  PaginationMeta,
  ZendeskArticle,
  ZendeskArticleAttachment,
  ZendeskCategory,
  ZendeskComment,
  ZendeskContentTag,
  ZendeskLabel,
  ZendeskOrganization,
  ZendeskPermissionGroup,
  ZendeskSection,
  ZendeskSlaLiveMetric,
  ZendeskSlaPolicy,
  ZendeskSlaSideloadEntry,
  ZendeskTicket,
  ZendeskTicketField,
  ZendeskTranslation,
  ZendeskUser,
  ZendeskUserSegment,
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

const formatConditionValue = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

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

export const formatTicketField = (field: ZendeskTicketField): string => {
  // A field carries either custom_field_options (custom dropdowns/taggers) or
  // system_field_options (system fields like priority); merge whichever applies.
  const options = [...(field.custom_field_options ?? []), ...(field.system_field_options ?? [])];
  return [
    `## Ticket field: ${field.title ?? '(untitled)'} (${field.id}) [${field.type}]`,
    `- **Active**: ${field.active ? 'yes' : 'no'} | **Required**: ${field.required ? 'yes' : 'no'}`,
    options.length > 0
      ? `- **Options**: ${options.map((o) => `${o.name} → ${o.value}`).join('; ')}`
      : '',
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

export const formatCategory = (category: ZendeskCategory): string =>
  `- **${category.name}** (${category.id}) — ${category.description || 'No description'}`;

export const formatSection = (section: ZendeskSection): string =>
  `- **${section.name}** (${section.id}) — Category: ${section.category_id} — ${section.description || 'No description'}`;

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
