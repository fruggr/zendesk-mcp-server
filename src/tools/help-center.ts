import * as z from 'zod/v4';
import {
  helpCenterDelete,
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
  REORDER_CONFIRM_THRESHOLD,
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
  arrangeDesiredOrder,
  computePositionWrites,
  hasPositionInversion,
  isPlacedAsRequested,
  type OrderedArticle,
  type ReorderTarget,
} from '../utils/article-order';
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
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { ToolContext, ToolDefinition } from './definitions';

// Byte-identical across the seven read/section/attachment tools that take an
// article id. Kept as one constant (like PER_PAGE_DESC/PAGE_DESC) so the "how to
// obtain it" guidance can't drift between copies. The two article-write tools
// use their own variant ("...to update" / "...whose translation to update").
const ARTICLE_ID_DESC =
  'Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.';

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

// Message returned when a reorder's position writes are (or would be) silently
// ignored because the section is sorted automatically rather than manually. There
// is no API field exposing the sort mode, so we name the section and the exact UI
// steps rather than fabricate an admin deep-link (none is stable across Guide
// versions). `applied` is set only after writes were attempted (post-verify path).
const autoSortNotice = (sectionId: number, applied?: number): string =>
  [
    applied === undefined
      ? `Section #${sectionId} looks like it is sorted automatically, so a manual reorder would have no visible effect.`
      : `Wrote ${applied} article position(s), but the display order of section #${sectionId} did not change — the section is sorted automatically, so positions are ignored.`,
    'To order its articles manually: in Guide, open the section, choose "Edit section", set "Order articles by" to Manual, then re-run this tool.',
  ].join(' ');

export const createHelpCenterTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  // Fetch a section's articles in their EFFECTIVE display order (no sort_by), the
  // order an end user sees. Fully paginated so reorder decisions and verification
  // see every article, not just the first page. Used by reorder_article.
  const fetchSectionOrder = async (sectionId: number, token: string): Promise<OrderedArticle[]> => {
    const order: OrderedArticle[] = [];
    let cursor: string | undefined;
    do {
      const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
        subdomain,
        token,
        `/sections/${sectionId}/articles`,
        buildCursorParams(MAX_PAGE_SIZE, cursor),
      );
      const articles = response.articles ?? [];
      for (const article of articles) {
        order.push({ id: article.id, position: article.position });
      }
      const meta = extractPaginationMeta(response, articles.length);
      cursor = meta.has_more && meta.after_cursor ? meta.after_cursor : undefined;
    } while (cursor);
    return order;
  };

  return [
    {
      name: 'search_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'Search Help Center Articles',
      description:
        'Full-text search across Help Center articles (metadata only, no body). Use get_article for full content. Supports locale filtering. Returns total count.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Full-text query matched against article titles and body. Plain keywords; combine with the locale filter to scope to one language.',
          ),
        locale: z.string().optional().describe('Filter by locale (e.g., "en-us", "fr")'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
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
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
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
      description:
        'List all Help Center categories. Categories are the top level of the Guide hierarchy (category → section → article); each entry includes its id, name and locale. Results are cursor-paginated. Pair a returned category id with list_sections to drill down, then list_articles to reach articles. Pass a locale to read category names in that translation.',
      inputSchema: z.object({
        locale: z
          .string()
          .optional()
          .describe(
            'Locale for category names (e.g., "en-us", "fr"). Defaults to the Help Center default locale.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Categories per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
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
        const categories = response.categories ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                categories,
                formatCategory,
                extractPaginationMeta(response, categories.length),
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
      description:
        "List Help Center sections. Sections are the middle level of the Guide hierarchy (category → section → article) and group related articles; each entry includes its id, name, category_id and locale. Results are cursor-paginated. Pass category_id to list only one category's sections (ids come from list_categories), then use a section id with list_articles. Pass a locale to read section names in that translation.",
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Restrict to sections of this category (id from list_categories). Omit to list every section.',
          ),
        locale: z
          .string()
          .optional()
          .describe(
            'Locale for section names (e.g., "en-us", "fr"). Defaults to the Help Center default locale.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Sections per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
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
        const sections = response.sections ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                sections,
                formatSection,
                extractPaginationMeta(response, sections.length),
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
        section_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Restrict the listing to one section (numeric id from list_sections). Omit to list articles across all sections.',
          ),
        locale: z
          .string()
          .optional()
          .describe(
            'Restrict to a single locale, e.g. "en-us" or "fr". Omit for the default locale.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Articles per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
        sort_by: z
          .enum(['created_at', 'updated_at', 'position', 'title'])
          .default('position')
          .describe('Field to sort by; "position" (the default) is the manual order set in Guide.'),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('asc')
          .describe('Sort direction: ascending or descending.'),
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
                text: formatList(
                  articles,
                  formatArticleSummary,
                  extractPaginationMeta(response, articles.length),
                ),
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
        const meta = extractPaginationMeta(response, articles.length);
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
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
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
      description:
        'Create a translation for an existing article in a specific locale. The article must already exist (create it with create_article); this adds a new localized version and returns the created translation (locale, title, draft state). The target locale must not already have a translation — use update_article_translation to modify an existing one, and list_article_translations to see which locales exist. Provide the full HTML body.',
      inputSchema: z.object({
        article_id: z.number().int().describe('ID of the existing article to translate.'),
        locale: z.string().describe('Target locale (e.g., "fr", "de")'),
        title: z.string().min(1).describe('Translated article title.'),
        body: z.string().min(1).describe('Translated body (HTML)'),
        draft: z
          .boolean()
          .default(false)
          .describe(
            'Create the translation as a draft (not visible to end users). Defaults to false (published).',
          ),
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
        article_id: z
          .number()
          .int()
          .describe(
            'Article ID — the numeric id of the article whose translation to update. Obtain it from list_articles or search_articles.',
          ),
        locale: z
          .string()
          .describe(
            'Locale of the translation to update, e.g. "en-us" or "fr". Use the source_locale (from get_article) to edit the default language.',
          ),
        title: z
          .string()
          .optional()
          .describe('New title for this locale. Omit to leave the current title unchanged.'),
        body: z
          .string()
          .optional()
          .describe(
            'New full body (HTML) for this locale. Replaces the entire body — for a single-section edit prefer update_article_section. Omit to leave the body unchanged.',
          ),
        draft: z
          .boolean()
          .optional()
          .describe('When true, keeps this translation as a draft; when false, publishes it.'),
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
        "Create a new article in a section and return the created article with its id. The locale becomes the article's source_locale. Requires a permission_group_id (use list_permission_groups to find available IDs). To add content in other locales afterwards, use create_article_translation.",
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .describe('Section that will contain the article (numeric id from list_sections).'),
        title: z.string().min(1).describe('Title of the new article, in its source locale.'),
        body: z
          .string()
          .min(1)
          .describe('Article body as HTML (this becomes the source-locale content).'),
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
        locale: z
          .string()
          .optional()
          .describe(
            'Source locale for the article, e.g. "en-us" or "fr". Defaults to the Help Center\'s default locale; becomes the article\'s source_locale.',
          ),
        draft: z
          .boolean()
          .default(true)
          .describe(
            'When true (default), the article is created unpublished; set false to publish immediately.',
          ),
        promoted: z
          .boolean()
          .default(false)
          .describe(
            'When true, marks the article as promoted (featured) in its section. Defaults to false.',
          ),
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
        'Update article metadata only (draft, promoted, labels, tags, visibility, section, sort position, etc.) and return the updated article. Does NOT update content (title, body) — use update_article_translation for that.',
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe(
            'Article ID — the numeric id of the article to update. Obtain it from list_articles or search_articles.',
          ),
        draft: z
          .boolean()
          .optional()
          .describe('Set true to unpublish the article (revert to draft) or false to publish it.'),
        promoted: z
          .boolean()
          .optional()
          .describe(
            'Set true to promote (feature) the article in its section, or false to unpromote it.',
          ),
        label_names: z
          .array(z.string())
          .optional()
          .describe('Label names for search ranking (use list_labels to see existing labels).'),
        content_tag_ids: z
          .array(z.string())
          .optional()
          .describe('Content tag ids to attach (use list_content_tags to find them).'),
        user_segment_id: z
          .number()
          .int()
          .optional()
          .describe(
            'User segment that controls who can see the article (id from list_user_segments).',
          ),
        author_id: z
          .number()
          .int()
          .optional()
          .describe('User id of the article author (from search_users).'),
        permission_group_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Guide permission group controlling who can edit (id from list_permission_groups).',
          ),
        section_id: z
          .number()
          .int()
          .optional()
          .describe('Move the article to this section (numeric id from list_sections).'),
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
      name: 'reorder_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Reorder Help Center Article',
      description:
        'Reorder an article within its current section by moving it relative to its siblings (top, bottom, or before/after another article), and return whether the new order was applied. This is the reliable way to satisfy "put this article first/last" requests: it writes the minimal set of article positions needed to make the order deterministic, because Zendesk leaves newly created articles tied at position 0 where a plain position update is silently ambiguous. It does NOT move the article to a different section — use update_article with section_id for that. Zendesk exposes no way to read whether a section is manually or automatically sorted, so when the section is sorted automatically (by date or alphabetically) the position writes are ignored; this tool detects that after the fact and returns guidance to switch the section to manual ordering in Guide. A move may reposition several neighbouring articles; when that count exceeds a configurable safety threshold the call is refused unless confirm is set to true.',
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe(
            'Article ID — the numeric id of the article to move within its section. Obtain it from list_articles or search_articles.',
          ),
        target: z
          .enum(['top', 'bottom', 'before', 'after'])
          .describe(
            'Where to move the article relative to its section siblings: "top" (becomes first), "bottom" (becomes last), or "before"/"after" a specific reference article. "before" and "after" require reference_article_id.',
          ),
        reference_article_id: z
          .number()
          .int()
          .optional()
          .describe(
            'The sibling article to position next to when target is "before" or "after" (numeric id from list_articles). Must belong to the same section and differ from article_id; leave it unset for "top" or "bottom".',
          ),
        normalize: z
          .boolean()
          .default(false)
          .describe(
            'When true, also renumber every article in the section to contiguous positions (0, 1, 2, …) so the stored positions stay tidy. Defaults to false, which writes the fewest positions possible and lets gaps remain. Either way the confirmation threshold still applies.',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            'Safety guard for large reorders. When the move would rewrite more article positions than the configured threshold (ZENDESK_REORDER_CONFIRM_THRESHOLD, default 20), the tool refuses and reports the count until you pass true here. Has no effect on small reorders.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const {
          article_id,
          target,
          reference_article_id,
          normalize = false,
          confirm = false,
        } = params as {
          article_id: number;
          target: ReorderTarget;
          reference_article_id?: number;
          normalize?: boolean;
          confirm?: boolean;
        };

        // Cross-field validation (the schema is a plain object; enforce the
        // target/reference relationship here, like archive_article's confirm guard).
        const needsReference = target === 'before' || target === 'after';
        if (needsReference && reference_article_id === undefined) {
          throw new Error(
            `target "${target}" requires reference_article_id (the article to move ${target}).`,
          );
        }
        if (!needsReference && reference_article_id !== undefined) {
          throw new Error(
            `reference_article_id must be omitted when target is "${target}" (it only applies to "before"/"after").`,
          );
        }
        if (reference_article_id !== undefined && reference_article_id === article_id) {
          throw new Error('reference_article_id must differ from article_id.');
        }

        const token = await getToken();

        // Resolve the article's section (also validates the article exists).
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          subdomain,
          token,
          `/articles/${article_id}`,
        );
        const sectionId = article.section_id;

        const effective = await fetchSectionOrder(sectionId, token);

        // For before/after, the reference must be in the same section. Disambiguate
        // not-found vs wrong-section so the caller gets an actionable message.
        if (needsReference && !effective.some((a) => a.id === reference_article_id)) {
          let detail = 'was not found';
          try {
            const { article: ref } = await helpCenterGet<{ article: ZendeskArticle }>(
              subdomain,
              token,
              `/articles/${reference_article_id}`,
            );
            detail = `is in section #${ref.section_id}, not section #${sectionId}`;
          } catch {
            // 404 or similar → keep the "was not found" wording.
          }
          throw new Error(
            `Reference article #${reference_article_id} ${detail}. It must be in the same section (#${sectionId}) as article #${article_id}.`,
          );
        }

        const targetLabel = needsReference ? `${target} article #${reference_article_id}` : target;

        const desired = arrangeDesiredOrder(effective, article_id, target, reference_article_id);
        const writes = computePositionWrites(desired, article_id, normalize);

        if (writes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Article #${article_id} is already positioned ${targetLabel} in section #${sectionId}. No changes made.`,
              },
            ],
          };
        }

        // If the section provably ignores position (its effective order is not
        // sorted by position) and the reorder would be large, refuse up front
        // rather than fire many writes that will be silently ignored.
        const autoSorted = hasPositionInversion(effective);
        if (autoSorted && writes.length > REORDER_CONFIRM_THRESHOLD) {
          return { content: [{ type: 'text', text: autoSortNotice(sectionId) }] };
        }

        // Blast-radius guard.
        if (writes.length > REORDER_CONFIRM_THRESHOLD && confirm !== true) {
          return {
            content: [
              {
                type: 'text',
                text: `Reordering article #${article_id} to ${targetLabel} would reposition ${writes.length} articles in section #${sectionId}, above the safety threshold of ${REORDER_CONFIRM_THRESHOLD}. Re-run with confirm: true to proceed.`,
              },
            ],
          };
        }

        // Apply the writes. Positions are absolute, so a re-run after a failure
        // recomputes against the current state and resumes — it never double-applies.
        let applied = 0;
        for (const write of writes) {
          try {
            await helpCenterPut(subdomain, token, `/articles/${write.id}`, {
              article: { position: write.position },
            });
            applied += 1;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Reorder of article #${article_id} failed after ${applied}/${writes.length} position write(s) (on article #${write.id}): ${reason} Positions are written absolutely, so re-running the identical call is safe and resumes where it stopped.`,
              { cause: error },
            );
          }
        }

        // Verify the move took effect (the definitive auto-sort check).
        const after = await fetchSectionOrder(sectionId, token);
        if (!isPlacedAsRequested(after, article_id, target, reference_article_id)) {
          return { content: [{ type: 'text', text: autoSortNotice(sectionId, applied) }] };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Article #${article_id} moved to ${targetLabel} in section #${sectionId} (${applied} article${applied === 1 ? '' : 's'} repositioned).`,
            },
          ],
        };
      },
    },
    {
      name: 'archive_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Archive Help Center Article',
      description:
        'Archive (soft-delete) a Help Center article: it is removed from the Help Center but can be restored from the Guide admin UI. Returns a confirmation message; the article and all its translations become invisible to end users. This is the only removal the Zendesk API offers — permanent deletion is not available via the API (do it from the Guide admin UI). To only hide an article temporarily while keeping it in the knowledge base, use update_article with draft: true (unpublish) instead. Guarded by a required confirm flag.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        confirm: z
          .boolean()
          .describe(
            'Explicit safety guard: must be set to true to archive the article. Any other value refuses the operation without calling Zendesk.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, confirm } = params as { article_id: number; confirm: boolean };
        if (confirm !== true) {
          throw new Error(
            'Archiving is guarded: pass confirm: true to archive (soft-delete) this article. No changes were made.',
          );
        }
        const token = await getToken();
        await helpCenterDelete(subdomain, token, `/articles/${article_id}`);
        return {
          content: [
            {
              type: 'text',
              text: `Article #${article_id} archived (soft-deleted). It is removed from the Help Center; restore it from the Guide admin UI if needed.`,
            },
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
        'List Guide content tags, which are end-user-visible labels that help readers find related articles. Results are cursor-paginated (follow the returned cursor to enumerate the full list) and sorted by name by default. Pass name_prefix to look a tag up by the start of its name — do this before create_content_tag to reuse an existing tag rather than fragment the taxonomy. For internal, non-end-user search labels, see list_labels instead.',
      inputSchema: z.object({
        name_prefix: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Return only content tags whose name starts with this prefix (prefix match — not a substring or fuzzy search). Use the full name to check whether a specific tag already exists before creating it.',
          ),
        sort_by: z
          .enum(['name', 'id'])
          .default('name')
          .describe('Field to sort by; "name" (the default) lists tags alphabetically.'),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('asc')
          .describe('Sort direction: ascending or descending.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Content tags per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { name_prefix, sort_by, sort_order, page_size, cursor } = params as {
          name_prefix?: string;
          sort_by: string;
          sort_order: string;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        // /guide/content_tags takes a single `sort` param, `-` prefix for
        // descending; the tool surface keeps the sort_by/sort_order convention
        // shared with the sibling list tools and translates to the wire format.
        const sort = `${sort_order === 'desc' ? '-' : ''}${sort_by}`;
        const p: Record<string, string> = { ...buildCursorParams(page_size, cursor), sort };
        if (name_prefix) p['filter[name_prefix]'] = name_prefix;
        const response = await zendeskGet<ZendeskListResponse<ZendeskContentTag>>(
          subdomain,
          token,
          '/guide/content_tags',
          p,
        );
        const records = response.records ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                records,
                formatContentTag,
                extractPaginationMeta(response, records.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'create_content_tag',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Content Tag',
      description:
        'Create a new content tag for Guide articles. Content tags are end-user visible labels that help readers discover related articles; this returns the created tag with its id. Check list_content_tags first (filter by name_prefix) to avoid duplicates, then attach the new id via the content_tag_ids parameter of create_article or update_article. For internal search-ranking labels that are not shown to end users, use article labels (list_labels) instead.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe('Content tag name as shown to end users (e.g., "billing", "getting-started").'),
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
      description:
        'List all attachments for an article. Returns attachment metadata only (id, file name, content type, size, URL), not the file bytes; both inline and block attachments are included. This is for Help Center articles — for attachments on support tickets use get_ticket_attachments instead. Upload new files with create_article_attachment.',
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe('ID of the Help Center article whose attachments to list.'),
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
        const attachments = response.article_attachments ?? [];
        if (attachments.length === 0) {
          return {
            content: [{ type: 'text', text: `No attachments found on article #${article_id}.` }],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: formatList(attachments, formatAttachment),
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
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
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
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
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
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
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
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        source_locale: z
          .string()
          .describe(
            'Reference locale to diff against, e.g. "en-us". Usually the article source_locale (from get_article).',
          ),
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
        "Upload a file to a Help Center article and return the created attachment (its id, file name, content type, size and content URL). Not idempotent: calling it again uploads another copy rather than replacing the previous one. This is for article assets — for files on support tickets use get_ticket_attachments, and to see an article's existing attachments use list_article_attachments.",
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        file_name: z
          .string()
          .min(1)
          .describe(
            'Name to store the file under, including its extension (e.g. "screenshot.png"); used as the download name.',
          ),
        file_base64: z
          .string()
          .min(1)
          .describe(
            "The file's raw bytes as a base64-encoded string; the server decodes them before upload.",
          ),
        content_type: z
          .string()
          .default('application/octet-stream')
          .describe(
            'MIME type of the file, e.g. "image/png" or "application/pdf". Defaults to application/octet-stream when omitted.',
          ),
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
