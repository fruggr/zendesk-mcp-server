import * as z from 'zod/v4';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import type {
  ZendeskArticle,
  ZendeskCategory,
  ZendeskListResponse,
  ZendeskPermissionGroup,
  ZendeskSection,
  ZendeskTranslation,
} from '../types';
import { helpCenterGet, helpCenterPost, helpCenterPut, zendeskGet } from '../client/zendesk-api';
import { buildCursorParams, buildOffsetParams, extractPaginationMeta, extractSearchPaginationMeta } from '../utils/pagination';
import { formatArticle, formatArticleSummary, formatCategory, formatList, formatPermissionGroup, formatSection, formatTranslation, formatTranslationSummary, truncateIfNeeded } from '../utils/formatting';
import type { ToolContext, ToolDefinition } from './definitions';

export const createHelpCenterTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'search_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'Search Help Center Articles',
      description: 'Full-text search across Help Center articles (metadata only, no body). Use get_article for full content. Supports locale filtering. Returns total count.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query'),
        locale: z.string().optional().describe('Filter by locale (e.g., "en-us", "fr")'),
        per_page: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { query, locale, per_page, page } = params as { query: string; locale?: string; per_page: number; page: number };
        const token = await getToken();
        const p: Record<string, string> = { query, ...buildOffsetParams(per_page, page) };
        if (locale) p['locale'] = locale;
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(subdomain, token, '/articles/search', p);
        return { content: [{ type: 'text', text: formatList(response.results ?? [], formatArticleSummary, extractSearchPaginationMeta(response, per_page, page)) }] };
      },
    },
    {
      name: 'get_article',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Help Center Article',
      description: 'Retrieve an article by ID with full body content. Optionally specify locale for a translated version. Returns body (HTML), metadata, source_locale, and list of available translations.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        locale: z.string().optional().describe('Locale for translated version'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { article_id, locale } = params as { article_id: number; locale?: string };
        const token = await getToken();
        const path = locale ? `/${locale}/articles/${article_id}` : `/articles/${article_id}`;
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(subdomain, token, path);
        const { translations } = await helpCenterGet<{ translations: ZendeskTranslation[] }>(subdomain, token, `/articles/${article_id}/translations`);
        const text = formatArticle(article) + `\n\n**Available translations**: ${translations.map((t) => t.locale).join(', ')}`;
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'list_categories',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Categories',
      description: 'List all Help Center categories. Optionally filter by locale.',
      inputSchema: z.object({
        locale: z.string().optional(),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { locale, page_size, cursor } = params as { locale?: string; page_size: number; cursor?: string };
        const token = await getToken();
        const path = locale ? `/${locale}/categories` : '/categories';
        const response = await helpCenterGet<ZendeskListResponse<ZendeskCategory>>(subdomain, token, path, buildCursorParams(page_size, cursor));
        return { content: [{ type: 'text', text: formatList(response.categories ?? [], formatCategory, extractPaginationMeta(response)) }] };
      },
    },
    {
      name: 'list_sections',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Sections',
      description: 'List sections, optionally filtered by category ID and locale.',
      inputSchema: z.object({
        category_id: z.number().int().optional(),
        locale: z.string().optional(),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { category_id, locale, page_size, cursor } = params as { category_id?: number; locale?: string; page_size: number; cursor?: string };
        const token = await getToken();
        const path = category_id && locale ? `/${locale}/categories/${category_id}/sections`
          : category_id ? `/categories/${category_id}/sections`
          : locale ? `/${locale}/sections` : '/sections';
        const response = await helpCenterGet<ZendeskListResponse<ZendeskSection>>(subdomain, token, path, buildCursorParams(page_size, cursor));
        return { content: [{ type: 'text', text: formatList(response.sections ?? [], formatSection, extractPaginationMeta(response)) }] };
      },
    },
    {
      name: 'list_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Articles',
      description: 'List articles (metadata only, no body). Use get_article for full content. Optionally filter by section ID and locale. Supports sort_by ("title", "created_at", "updated_at") and include_translations: true to show available translation locales per article. Note: include_translations must be re-sent on each paginated request.',
      inputSchema: z.object({
        section_id: z.number().int().optional(),
        locale: z.string().optional(),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        cursor: z.string().optional(),
        sort_by: z.enum(['created_at', 'updated_at', 'position', 'title']).default('position').describe('Sort field'),
        sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
        include_translations: z.boolean().default(false).describe('Include available translation locales per article (causes 1 extra API call per article)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { section_id, locale, page_size, cursor, sort_by, sort_order, include_translations } = params as {
          section_id?: number; locale?: string; page_size: number; cursor?: string;
          sort_by: string; sort_order: string; include_translations: boolean;
        };
        const token = await getToken();
        const path = section_id && locale ? `/${locale}/sections/${section_id}/articles`
          : section_id ? `/sections/${section_id}/articles`
          : locale ? `/${locale}/articles` : '/articles';
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(subdomain, token, path, { ...buildCursorParams(page_size, cursor), sort_by, sort_order });
        const articles = response.articles ?? [];
        if (!include_translations) {
          return { content: [{ type: 'text', text: formatList(articles, formatArticleSummary, extractPaginationMeta(response)) }] };
        }
        const formatted = await Promise.all(articles.map(async (article) => {
          const { translations } = await helpCenterGet<{ translations: ZendeskTranslation[] }>(subdomain, token, `/articles/${article.id}/translations`);
          const locales = translations.map((t) => t.locale).join(', ');
          return `${formatArticleSummary(article)}\n- **Translations**: ${locales}`;
        }));
        const meta = extractPaginationMeta(response);
        const header = meta.count ? `Results: ${meta.count}${meta.has_more ? ` | More available (cursor: ${meta.after_cursor})` : ''}` : '';
        const text = [header, ...formatted].filter(Boolean).join('\n\n');
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'list_article_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Translations',
      description: 'List all available translations for an article (metadata only, no body: locale, title, draft, updated_at). Use get_article with locale for full translated content.',
      inputSchema: z.object({ article_id: z.number().int().describe('Article ID') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { article_id } = params as { article_id: number };
        const token = await getToken();
        const { translations } = await helpCenterGet<{ translations: ZendeskTranslation[] }>(subdomain, token, `/articles/${article_id}/translations`);
        return { content: [{ type: 'text', text: formatList(translations, formatTranslationSummary) }] };
      },
    },
    {
      name: 'create_article_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Article Translation',
      description: 'Create a translation for an existing article in a specific locale.',
      inputSchema: z.object({
        article_id: z.number().int(),
        locale: z.string().describe('Target locale (e.g., "fr", "de")'),
        title: z.string().min(1),
        body: z.string().min(1).describe('Translated body (HTML)'),
        draft: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (params) => {
        const { article_id, locale, title, body, draft } = params as { article_id: number; locale: string; title: string; body: string; draft: boolean };
        const token = await getToken();
        const { translation } = await helpCenterPost<{ translation: ZendeskTranslation }>(subdomain, token, `/articles/${article_id}/translations`, { translation: { locale, title, body, draft } });
        return { content: [{ type: 'text', text: `Translation created for article #${article_id} in "${locale}".\n\n${formatTranslation(translation)}` }] };
      },
    },
    {
      name: 'update_article_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Article Translation',
      description: 'Update an existing translation of an article.',
      inputSchema: z.object({
        article_id: z.number().int(),
        locale: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { article_id, locale, ...updates } = params as { article_id: number; locale: string } & Record<string, unknown>;
        const token = await getToken();
        const { translation } = await helpCenterPut<{ translation: ZendeskTranslation }>(subdomain, token, `/articles/${article_id}/translations/${locale}`, { translation: updates });
        return { content: [{ type: 'text', text: `Translation updated for article #${article_id} in "${locale}".\n\n${formatTranslation(translation)}` }] };
      },
    },
    {
      name: 'list_permission_groups',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Permission Groups',
      description: 'List all Guide permission groups. Use this to find the permission_group_id required when creating articles.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async () => {
        const token = await getToken();
        const response = await zendeskGet<{ permission_groups: ZendeskPermissionGroup[]; count: number }>(subdomain, token, '/guide/permission_groups');
        return { content: [{ type: 'text', text: formatList(response.permission_groups ?? [], formatPermissionGroup) }] };
      },
    },
    {
      name: 'create_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Help Center Article',
      description: 'Create a new article in a section. Requires a permission_group_id (use list_permission_groups to find available IDs).',
      inputSchema: z.object({
        section_id: z.number().int(),
        title: z.string().min(1),
        body: z.string().min(1).describe('Article body (HTML)'),
        permission_group_id: z.number().int().describe('Permission group ID (use list_permission_groups to find it)'),
        locale: z.string().optional(),
        draft: z.boolean().default(true),
        promoted: z.boolean().default(false),
        label_names: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (params) => {
        const { section_id, ...articleData } = params as { section_id: number } & Record<string, unknown>;
        const token = await getToken();
        const { article } = await helpCenterPost<{ article: ZendeskArticle }>(subdomain, token, `/sections/${section_id}/articles`, { article: articleData });
        return { content: [{ type: 'text', text: `Article #${article.id} created.\n\n${formatArticle(article)}` }] };
      },
    },
    {
      name: 'update_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Help Center Article',
      description: 'Update an existing article metadata or content.',
      inputSchema: z.object({
        article_id: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
        promoted: z.boolean().optional(),
        label_names: z.array(z.string()).optional(),
        section_id: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (params) => {
        const { article_id, ...updates } = params as { article_id: number } & Record<string, unknown>;
        const token = await getToken();
        const { article } = await helpCenterPut<{ article: ZendeskArticle }>(subdomain, token, `/articles/${article_id}`, { article: updates });
        return { content: [{ type: 'text', text: `Article #${article.id} updated.\n\n${formatArticle(article)}` }] };
      },
    },
  ];
};
