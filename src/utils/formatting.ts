import { CHARACTER_LIMIT } from '../constants.js';
import type {
  PaginationMeta,
  ZendeskArticle,
  ZendeskCategory,
  ZendeskComment,
  ZendeskOrganization,
  ZendeskSection,
  ZendeskTicket,
  ZendeskTranslation,
  ZendeskUser,
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

export const formatComment = (comment: ZendeskComment): string =>
  [
    `### ${comment.public ? 'Public comment' : 'Internal note'} by ${comment.author_id}`,
    `*${comment.created_at}*`,
    '',
    comment.body,
  ].join('\n');

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
