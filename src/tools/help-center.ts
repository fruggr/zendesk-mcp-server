import * as z from 'zod/v4';
import {
  helpCenterGet,
  helpCenterPost,
  helpCenterPut,
  helpCenterUpload,
  zendeskGet,
  zendeskPost,
} from '../client/zendesk-api';
import {
  DEFAULT_PAGE_SIZE,
  LARGE_ARTICLE_BODY_CHARS,
  LARGE_ARTICLE_SECTION_COUNT,
  MAX_PAGE_SIZE,
} from '../constants';
import type {
  ZendeskArticle,
  ZendeskArticleAttachment,
  ZendeskCategory,
  ZendeskContentTag,
  ZendeskLabel,
  ZendeskListResponse,
  ZendeskPermissionGroup,
  ZendeskSection,
  ZendeskTranslation,
  ZendeskUserSegment,
} from '../types';
import {
  htmlToMarkdown,
  markdownToHtml,
  parseSections,
  replaceSectionContent,
} from '../utils/article-sections';
import {
  formatArticle,
  formatArticleSummary,
  formatAttachment,
  formatCategory,
  formatContentTag,
  formatLabel,
  formatList,
  formatPermissionGroup,
  formatSection,
  formatTranslation,
  formatTranslationSummary,
  formatUserSegment,
  truncateIfNeeded,
} from '../utils/formatting';
import {
  buildCursorParams,
  buildOffsetParams,
  extractPaginationMeta,
  extractSearchPaginationMeta,
} from '../utils/pagination';
import type { ToolContext, ToolDefinition } from './definitions';

const largeArticleHint = (body: string, sectionCount: number): string | null => {
  if (body.length < LARGE_ARTICLE_BODY_CHARS && sectionCount < LARGE_ARTICLE_SECTION_COUNT) {
    return null;
  }
  return [
    `> ⚠ Large article (${body.length} chars, ${sectionCount} sections).`,
    '> For targeted edits, prefer get_article_outline + get_article_section +',
    '> update_article_section to avoid re-sending the full body on each write.',
    '',
  ].join('\n');
};

export const createHelpCenterTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'search_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'Search Help Center Articles',
      description:
        'Full-text search across Help Center articles (metadata only, no body). Use get_article for full content. Supports locale filtering. Returns total count.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query'),
        locale: z.string().optional().describe('Filter by locale (e.g., "en-us", "fr")'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Results per page'),
        page: z.number().int().min(1).default(1).describe('Page number'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { query, locale, per_page, page } = params as {
          query: string;
          locale?: string;
          per_page: number;
          page: number;
        };
        const token = await getToken();
        const p: Record<string, string> = { query, ...buildOffsetParams(per_page, page) };
        if (locale) p['locale'] = locale;
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
          subdomain,
          token,
          '/articles/search',
          p,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.results ?? [],
                formatArticleSummary,
                extractSearchPaginationMeta(response, per_page, page),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_article',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Help Center Article',
      description:
        'Retrieve an article by ID with full body content. For large articles, prefer get_article_outline + get_article_section to save tokens. Optionally specify locale for a translated version. Returns body (HTML), metadata, source_locale, and list of available translations.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        locale: z.string().optional().describe('Locale for translated version'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale } = params as { article_id: number; locale?: string };
        const token = await getToken();
        const path = locale ? `/${locale}/articles/${article_id}` : `/articles/${article_id}`;
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          subdomain,
          token,
          path,
        );
        const { translations } = await helpCenterGet<{ translations: ZendeskTranslation[] }>(
          subdomain,
          token,
          `/articles/${article_id}/translations`,
        );
        const hint = largeArticleHint(article.body, parseSections(article.body).length);
        const text =
          (hint ?? '') +
          formatArticle(article) +
          `\n\n**Available translations**: ${translations.map((t) => t.locale).join(', ')}`;
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { locale, page_size, cursor } = params as {
          locale?: string;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        const path = locale ? `/${locale}/categories` : '/categories';
        const response = await helpCenterGet<ZendeskListResponse<ZendeskCategory>>(
          subdomain,
          token,
          path,
          buildCursorParams(page_size, cursor),
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.categories ?? [],
                formatCategory,
                extractPaginationMeta(response),
              ),
            },
          ],
        };
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { category_id, locale, page_size, cursor } = params as {
          category_id?: number;
          locale?: string;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        const path =
          category_id && locale
            ? `/${locale}/categories/${category_id}/sections`
            : category_id
              ? `/categories/${category_id}/sections`
              : locale
                ? `/${locale}/sections`
                : '/sections';
        const response = await helpCenterGet<ZendeskListResponse<ZendeskSection>>(
          subdomain,
          token,
          path,
          buildCursorParams(page_size, cursor),
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.sections ?? [],
                formatSection,
                extractPaginationMeta(response),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Articles',
      description:
        'List articles (metadata only, no body). Use get_article for full content. Optionally filter by section ID and locale. Supports sort_by ("title", "created_at", "updated_at") and include_translations: true to show available translation locales per article. Note: include_translations must be re-sent on each paginated request.',
      inputSchema: z.object({
        section_id: z.number().int().optional(),
        locale: z.string().optional(),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        cursor: z.string().optional(),
        sort_by: z
          .enum(['created_at', 'updated_at', 'position', 'title'])
          .default('position')
          .describe('Sort field'),
        sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
        include_translations: z
          .boolean()
          .default(false)
          .describe(
            'Include available translation locales per article (causes 1 extra API call per article)',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { section_id, locale, page_size, cursor, sort_by, sort_order, include_translations } =
          params as {
            section_id?: number;
            locale?: string;
            page_size: number;
            cursor?: string;
            sort_by: string;
            sort_order: string;
            include_translations: boolean;
          };
        const token = await getToken();
        const path =
          section_id && locale
            ? `/${locale}/sections/${section_id}/articles`
            : section_id
              ? `/sections/${section_id}/articles`
              : locale
                ? `/${locale}/articles`
                : '/articles';
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
          subdomain,
          token,
          path,
          { ...buildCursorParams(page_size, cursor), sort_by, sort_order },
        );
        const articles = response.articles ?? [];
        if (!include_translations) {
          return {
            content: [
              {
                type: 'text',
                text: formatList(articles, formatArticleSummary, extractPaginationMeta(response)),
              },
            ],
          };
        }
        const formatted = await Promise.all(
          articles.map(async (article) => {
            const { translations } = await helpCenterGet<{ translations: ZendeskTranslation[] }>(
              subdomain,
              token,
              `/articles/${article.id}/translations`,
            );
            const locales = translations.map((t) => t.locale).join(', ');
            return `${formatArticleSummary(article)}\n- **Translations**: ${locales}`;
          }),
        );
        const meta = extractPaginationMeta(response);
        const header = meta.count
          ? `Results: ${meta.count}${meta.has_more ? ` | More available (cursor: ${meta.after_cursor})` : ''}`
          : '';
        const text = [header, ...formatted].filter(Boolean).join('\n\n');
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'list_article_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Translations',
      description:
        'List all available translations for an article (metadata only, no body: locale, title, draft, updated_at). Use get_article with locale for full translated content.',
      inputSchema: z.object({ article_id: z.number().int().describe('Article ID') }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id } = params as { article_id: number };
        const token = await getToken();
        const { translations } = await helpCenterGet<{ translations: ZendeskTranslation[] }>(
          subdomain,
          token,
          `/articles/${article_id}/translations`,
        );
        return {
          content: [{ type: 'text', text: formatList(translations, formatTranslationSummary) }],
        };
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, title, body, draft } = params as {
          article_id: number;
          locale: string;
          title: string;
          body: string;
          draft: boolean;
        };
        const token = await getToken();
        const { translation } = await helpCenterPost<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations`,
          { translation: { locale, title, body, draft } },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Translation created for article #${article_id} in "${locale}".\n\n${formatTranslation(translation)}`,
            },
          ],
        };
      },
    },
    {
      name: 'update_article_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Article Translation',
      description:
        "Update article content (title, body) in a specific locale. For targeted edits on one or a few sections, prefer update_article_section — this tool replaces the FULL body and re-sends the entire article on each write. Use the article's source_locale (from get_article) for the default language, or another locale for translations.",
      inputSchema: z.object({
        article_id: z.number().int(),
        locale: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, ...updates } = params as {
          article_id: number;
          locale: string;
        } & Record<string, unknown>;
        const token = await getToken();
        const { translation } = await helpCenterPut<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          { translation: updates },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Translation updated for article #${article_id} in "${locale}".\n\n${formatTranslation(translation)}`,
            },
          ],
        };
      },
    },
    {
      name: 'list_permission_groups',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Permission Groups',
      description:
        'List all Guide permission groups. Use this to find the permission_group_id required when creating articles.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const response = await zendeskGet<{
          permission_groups: ZendeskPermissionGroup[];
          count: number;
        }>(subdomain, token, '/guide/permission_groups');
        return {
          content: [
            {
              type: 'text',
              text: formatList(response.permission_groups ?? [], formatPermissionGroup),
            },
          ],
        };
      },
    },
    {
      name: 'create_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Help Center Article',
      description:
        "Create a new article in a section. The locale becomes the article's source_locale. Requires a permission_group_id (use list_permission_groups to find available IDs). To add content in other locales afterwards, use create_article_translation.",
      inputSchema: z.object({
        section_id: z.number().int(),
        title: z.string().min(1),
        body: z.string().min(1).describe('Article body (HTML)'),
        permission_group_id: z
          .number()
          .int()
          .describe('Permission group ID (use list_permission_groups to find it)'),
        user_segment_id: z
          .number()
          .int()
          .optional()
          .describe(
            'User segment ID for visibility (use list_user_segments to find it). Defaults to everyone.',
          ),
        author_id: z
          .number()
          .int()
          .optional()
          .describe('Author user ID. Defaults to the authenticated user.'),
        content_tag_ids: z
          .array(z.string())
          .optional()
          .describe('Content tag IDs (use list_content_tags to find them)'),
        locale: z.string().optional(),
        draft: z.boolean().default(true),
        promoted: z.boolean().default(false),
        label_names: z
          .array(z.string())
          .optional()
          .describe('Label names for search ranking (use list_labels to see existing labels)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { section_id, ...articleData } = params as { section_id: number } & Record<
          string,
          unknown
        >;
        const token = await getToken();
        const { article } = await helpCenterPost<{ article: ZendeskArticle }>(
          subdomain,
          token,
          `/sections/${section_id}/articles`,
          { article: articleData },
        );
        return {
          content: [
            { type: 'text', text: `Article #${article.id} created.\n\n${formatArticle(article)}` },
          ],
        };
      },
    },
    {
      name: 'update_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Help Center Article',
      description:
        'Update article metadata only (draft, promoted, labels, tags, visibility, section, sort position, etc.). Does NOT update content (title, body) — use update_article_translation for that.',
      inputSchema: z.object({
        article_id: z.number().int(),
        draft: z.boolean().optional(),
        promoted: z.boolean().optional(),
        label_names: z.array(z.string()).optional().describe('Label names for search ranking'),
        content_tag_ids: z.array(z.string()).optional().describe('Content tag IDs'),
        user_segment_id: z.number().int().optional().describe('User segment ID for visibility'),
        author_id: z.number().int().optional().describe('Author user ID'),
        permission_group_id: z.number().int().optional().describe('Permission group ID'),
        section_id: z.number().int().optional(),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Sort position within the section (manual ordering only; 0 = first/top). New articles default to position 0. To move an article to the END of its section, set this to one more than the highest current position: read the highest position P from list_articles with sort_by="position", sort_order="desc", then set position = P + 1.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, ...updates } = params as { article_id: number } & Record<
          string,
          unknown
        >;
        const token = await getToken();
        const { article } = await helpCenterPut<{ article: ZendeskArticle }>(
          subdomain,
          token,
          `/articles/${article_id}`,
          { article: updates },
        );
        return {
          content: [
            { type: 'text', text: `Article #${article.id} updated.\n\n${formatArticle(article)}` },
          ],
        };
      },
    },
    {
      name: 'list_content_tags',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Content Tags',
      description:
        'List all Guide content tags. Content tags are visible to end users and help them find related articles.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const response = await zendeskGet<{ records: ZendeskContentTag[]; count: number }>(
          subdomain,
          token,
          '/guide/content_tags',
        );
        return {
          content: [{ type: 'text', text: formatList(response.records ?? [], formatContentTag) }],
        };
      },
    },
    {
      name: 'create_content_tag',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Content Tag',
      description: 'Create a new content tag for Guide articles.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Content tag name'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { name } = params as { name: string };
        const token = await getToken();
        const { content_tag } = await zendeskPost<{ content_tag: ZendeskContentTag }>(
          subdomain,
          token,
          '/guide/content_tags',
          { content_tag: { name } },
        );
        return {
          content: [
            { type: 'text', text: `Content tag created.\n\n${formatContentTag(content_tag)}` },
          ],
        };
      },
    },
    {
      name: 'list_labels',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Labels',
      description:
        'List all article labels. Labels improve Help Center search ranking and are not visible to end users.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const response = await helpCenterGet<{ labels: ZendeskLabel[]; count: number }>(
          subdomain,
          token,
          '/articles/labels',
        );
        return {
          content: [{ type: 'text', text: formatList(response.labels ?? [], formatLabel) }],
        };
      },
    },
    {
      name: 'list_user_segments',
      namespace: 'help_center',
      readOnly: true,
      title: 'List User Segments',
      description:
        'List all user segments. User segments control article visibility (who can view). Use the ID when creating or updating articles.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const response = await helpCenterGet<{
          user_segments: ZendeskUserSegment[];
          count: number;
        }>(subdomain, token, '/user_segments');
        return {
          content: [
            { type: 'text', text: formatList(response.user_segments ?? [], formatUserSegment) },
          ],
        };
      },
    },
    {
      name: 'list_article_attachments',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Attachments',
      description: 'List all attachments for an article.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id } = params as { article_id: number };
        const token = await getToken();
        const response = await helpCenterGet<{
          article_attachments: ZendeskArticleAttachment[];
          count: number;
        }>(subdomain, token, `/articles/${article_id}/attachments`);
        return {
          content: [
            {
              type: 'text',
              text: formatList(response.article_attachments ?? [], formatAttachment),
            },
          ],
        };
      },
    },
    {
      name: 'get_article_outline',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Article Outline',
      description:
        'Return a compact outline of an article (list of sections delimited by h1/h2/h3, with word counts) for the given locale (defaults to source_locale). Includes available translations with their outdated status. Use get_article_section to fetch a specific section.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        locale: z
          .string()
          .optional()
          .describe('Locale of the body to outline (defaults to article source_locale)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale } = params as { article_id: number; locale?: string };
        const token = await getToken();
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          subdomain,
          token,
          `/articles/${article_id}`,
        );
        const effectiveLocale = locale ?? article.source_locale;
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${effectiveLocale}`,
        );
        const { translations } = await helpCenterGet<{
          translations: Array<ZendeskTranslation & { outdated?: boolean }>;
        }>(subdomain, token, `/articles/${article_id}/translations`);
        const sections = parseSections(translation.body);

        const outlineLines = sections.length
          ? sections
              .map(
                (s) =>
                  `- [${s.index}] ${s.headingTag ? `${s.headingTag}: ` : ''}${s.heading} (${s.wordCount} words)`,
              )
              .join('\n')
          : '_(no sections detected)_';
        const translationsList = translations
          .map((t) => `- ${t.locale}${t.outdated ? ' (outdated)' : ''}`)
          .join('\n');

        const text = [
          `# Outline — Article #${article_id} (${effectiveLocale})`,
          `**Title**: ${translation.title}`,
          '',
          '## Sections',
          outlineLines,
          '',
          '## Available translations',
          translationsList,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'get_article_section',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Article Section',
      description:
        'Retrieve the content of a single section of an article in a given locale. Use get_article_outline first to discover section indexes. Default format="html" for round-trip safety. Pass format="markdown" only for human review — the Markdown representation is lossy on some structures (<pre> with <br>, tables with multi-<p> cells are kept as raw HTML to limit the damage, but do not round-trip markdown content back through update_article_section).',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        locale: z.string().describe('Locale of the body (e.g., "en-us", "fr")'),
        section_index: z
          .number()
          .int()
          .min(0)
          .describe('0-based index of the section (see get_article_outline)'),
        format: z
          .enum(['html', 'markdown'])
          .default('html')
          .describe(
            'Output format. "html" (default) is round-trip safe. "markdown" is lossy on some HTML structures — use only for human review, not before update_article_section.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, section_index, format } = params as {
          article_id: number;
          locale: string;
          section_index: number;
          format: 'html' | 'markdown';
        };
        const token = await getToken();
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
        );
        const sections = parseSections(translation.body);
        const section = sections[section_index];
        if (!section) {
          throw new Error(
            `Section index ${section_index} not found. Article has ${sections.length} section(s) (0-${Math.max(0, sections.length - 1)}).`,
          );
        }
        const content = format === 'markdown' ? htmlToMarkdown(section.html) : section.html;
        const headerLine = section.headingTag
          ? `## [${section.index}] ${section.headingTag}: ${section.heading}`
          : `## [${section.index}] ${section.heading}`;
        const text = [
          headerLine,
          `_Locale: ${locale} | Words: ${section.wordCount} | Format: ${format}_`,
          '',
          content,
        ].join('\n');
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'update_article_section',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Article Section',
      description:
        'Replace the content of a single section of an article in a given locale, keeping the rest of the body intact. The server fetches the current body, replaces the targeted section, and PUTs the full reconstructed body via the Translations API. Default format="html" for fidelity. Use format="markdown" only when you control the input and know it does not rely on structures that round-trip poorly (code blocks with line breaks, tables with multi-paragraph cells). The section heading is preserved and is NOT part of the replaced content.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        locale: z.string().describe('Locale of the translation to update'),
        section_index: z
          .number()
          .int()
          .min(0)
          .describe('0-based index of the section to replace (see get_article_outline)'),
        content: z
          .string()
          .describe(
            'New content for the section (heading excluded). HTML by default, Markdown if format="markdown".',
          ),
        format: z
          .enum(['html', 'markdown'])
          .default('html')
          .describe(
            'Input format. "html" (default) is the safe path. "markdown" is converted to HTML server-side but may introduce artifacts on complex content.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, section_index, content, format } = params as {
          article_id: number;
          locale: string;
          section_index: number;
          content: string;
          format: 'html' | 'markdown';
        };
        const token = await getToken();
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
        );
        const newSectionHtml = format === 'markdown' ? markdownToHtml(content) : content;
        const newBody = replaceSectionContent(translation.body, section_index, newSectionHtml);
        const { translation: updated } = await helpCenterPut<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          { translation: { body: newBody } },
        );
        const updatedSections = parseSections(updated.body);
        const updatedSection = updatedSections[section_index];
        const newWordCount = updatedSection?.wordCount ?? 0;
        const headingLabel = updatedSection?.heading ?? '(intro)';
        const text = [
          `Section [${section_index}] "${headingLabel}" updated for article #${article_id} (${locale}).`,
          `New word count: ${newWordCount}.`,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'compare_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'Compare Article Translations',
      description:
        'Compare section structure between two locales of the same article, matched by index. Returns a compact table (one row per section) with status: "ok" (both present, source/target word count ratio within 25%), "different" (word count ratio diverges by more than 25% — size signal only, NOT a semantic divergence: two locales may legitimately differ in verbosity) or "missing" (section absent in target). Useful to spot structurally stale or missing sections; do not interpret "different" as an edit regression on its own.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        source_locale: z.string().describe('Source (reference) locale'),
        target_locale: z.string().describe('Target locale to compare against source'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, source_locale, target_locale } = params as {
          article_id: number;
          source_locale: string;
          target_locale: string;
        };
        const token = await getToken();
        const [sourceRes, targetRes] = await Promise.all([
          helpCenterGet<{ translation: ZendeskTranslation }>(
            subdomain,
            token,
            `/articles/${article_id}/translations/${source_locale}`,
          ),
          helpCenterGet<{ translation: ZendeskTranslation }>(
            subdomain,
            token,
            `/articles/${article_id}/translations/${target_locale}`,
          ),
        ]);
        const sourceSections = parseSections(sourceRes.translation.body);
        const targetSections = parseSections(targetRes.translation.body);
        const maxLen = Math.max(sourceSections.length, targetSections.length);

        const rows: string[] = [];
        rows.push(`| Idx | Heading | Status | Source words | Target words |`);
        rows.push(`| --- | --- | --- | --- | --- |`);
        for (let i = 0; i < maxLen; i += 1) {
          const src = sourceSections[i];
          const tgt = targetSections[i];
          const heading = src?.heading ?? tgt?.heading ?? '';
          const sourceWords = src?.wordCount ?? 0;
          const targetWords = tgt?.wordCount ?? 0;
          let status: 'ok' | 'missing' | 'different';
          if (!tgt) status = 'missing';
          else if (!src) status = 'different';
          else {
            const denom = Math.max(sourceWords, 1);
            const diffRatio = Math.abs(sourceWords - targetWords) / denom;
            status = diffRatio > 0.25 ? 'different' : 'ok';
          }
          rows.push(`| ${i} | ${heading} | ${status} | ${sourceWords} | ${targetWords} |`);
        }

        const text = [
          `# Translation diff — Article #${article_id} (${source_locale} → ${target_locale})`,
          '',
          ...rows,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'create_article_attachment',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Article Attachment',
      description:
        'Upload an attachment to an article. Provide file content as base64-encoded string.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article ID'),
        file_name: z.string().min(1).describe('File name (e.g., "screenshot.png")'),
        file_base64: z.string().min(1).describe('File content encoded as base64'),
        content_type: z
          .string()
          .default('application/octet-stream')
          .describe('MIME type (e.g., "image/png", "application/pdf")'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, file_name, file_base64, content_type } = params as {
          article_id: number;
          file_name: string;
          file_base64: string;
          content_type: string;
        };
        const token = await getToken();
        const buffer = Buffer.from(file_base64, 'base64');
        const blob = new Blob([buffer], { type: content_type });
        const formData = new FormData();
        formData.append('file', blob, file_name);
        const { article_attachment } = await helpCenterUpload<{
          article_attachment: ZendeskArticleAttachment;
        }>(subdomain, token, `/articles/${article_id}/attachments`, formData);
        return {
          content: [
            {
              type: 'text',
              text: `Attachment created for article #${article_id}.\n\n${formatAttachment(article_attachment)}`,
            },
          ],
        };
      },
    },
  ];
};
