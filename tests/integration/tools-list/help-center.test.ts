import { expect, it } from 'vitest';
import { listExposedTools } from './list-exposed-tools';

it('exposes the help_center tool surface unchanged', async () => {
  expect(await listExposedTools('help_center')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Full-text search across Help Center articles (metadata only, no body). Use get_article for full content. Supports locale filtering. Returns total count.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "locale": {
              "description": "Filter by locale (e.g., "en-us", "fr")",
              "type": "string",
            },
            "page": {
              "default": 1,
              "description": "1-based page number for offset pagination. Increment it while keeping \`per_page\` fixed to fetch subsequent pages; page 1 is the first page.",
              "maximum": 9007199254740991,
              "minimum": 1,
              "type": "integer",
            },
            "per_page": {
              "default": 100,
              "description": "Number of results per page for offset pagination (1-100). Pair with \`page\` to walk large result sets; the response header reports the total count and whether more pages remain.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "query": {
              "description": "Full-text query matched against article titles and body. Plain keywords; combine with the locale filter to scope to one language.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "query",
          ],
          "type": "object",
        },
        "name": "search_articles",
        "title": "Search Help Center Articles",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Retrieve an article by ID with full body content. For large articles, prefer get_article_outline + get_article_section to save tokens. Optionally specify locale for a translated version. Returns body (HTML), metadata, source_locale, and list of available translations.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "locale": {
              "description": "Locale for translated version",
              "type": "string",
            },
          },
          "required": [
            "article_id",
          ],
          "type": "object",
        },
        "name": "get_article",
        "title": "Get Help Center Article",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all Help Center categories. Categories are the top level of the Guide hierarchy (category → section → article); each entry includes its id, name and locale. Results are cursor-paginated. Pair a returned category id with list_sections to drill down, then list_articles to reach articles. Pass a locale to read category names in that translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "locale": {
              "description": "Locale for category names (e.g., "en-us", "fr"). Defaults to the Help Center default locale.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Categories per page (1-100, default 100).",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "list_categories",
        "title": "List Help Center Categories",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List Help Center sections. Sections are the middle level of the Guide hierarchy (category → section → article) and group related articles; each entry includes its id, name, category_id and locale. Results are cursor-paginated. Pass category_id to list only one category's sections (ids come from list_categories), then use a section id with list_articles. Pass a locale to read section names in that translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Restrict to sections of this category (id from list_categories). Omit to list every section.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "locale": {
              "description": "Locale for section names (e.g., "en-us", "fr"). Defaults to the Help Center default locale.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Sections per page (1-100, default 100).",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "list_sections",
        "title": "List Help Center Sections",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List articles (metadata only, no body). Use get_article for full content. Optionally filter by section ID and locale. Supports sort_by ("title", "created_at", "updated_at") and include_translations: true to show available translation locales per article. Note: include_translations must be re-sent on each paginated request.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "include_translations": {
              "default": false,
              "description": "Include available translation locales per article (causes 1 extra API call per article)",
              "type": "boolean",
            },
            "locale": {
              "description": "Restrict to a single locale, e.g. "en-us" or "fr". Omit for the default locale.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Articles per page (1-100, default 100).",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "section_id": {
              "description": "Restrict the listing to one section (numeric id from list_sections). Omit to list articles across all sections.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "sort_by": {
              "default": "position",
              "description": "Field to sort by; "position" (the default) is the manual order set in Guide.",
              "enum": [
                "created_at",
                "updated_at",
                "position",
                "title",
              ],
              "type": "string",
            },
            "sort_order": {
              "default": "asc",
              "description": "Sort direction: ascending or descending.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
          },
          "type": "object",
        },
        "name": "list_articles",
        "title": "List Help Center Articles",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the promoted ("featured") Help Center articles — the small, editorially-curated set surfaced at the top of their sections. Returns metadata only (no body); use get_article for full content. COST: the Help Center API has no server-side promoted filter, so this scans article pages (one Zendesk API request per page, up to ARTICLE_RESOURCES_SCAN_MAX_PAGES, default 20) and filters client-side — potentially costly on a large Help Center. Each call performs a fresh, uncached scan, so avoid calling it repeatedly. On a very large Help Center some promoted articles may be omitted, and both the omission and the number of pages scanned are flagged in the output. Lists the default locale. To promote or unpromote an article, use update_article with \`promoted\` (requires Help Center admin / Guide admin rights).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {},
          "type": "object",
        },
        "name": "list_promoted_articles",
        "title": "List Promoted Help Center Articles",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all available translations for an article (metadata only, no body: locale, title, draft, updated_at). Use get_article with locale for full translated content.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "article_id",
          ],
          "type": "object",
        },
        "name": "list_article_translations",
        "title": "List Article Translations",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Create a translation for an existing article in a specific locale. The article must already exist (create it with create_article); this adds a new localized version and returns the created translation (locale, title, draft state). The target locale must not already have a translation — use update_article_translation to modify an existing one, and list_article_translations to see which locales exist. Provide the full HTML body.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "ID of the existing article to translate.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "body": {
              "description": "Translated body (HTML)",
              "minLength": 1,
              "type": "string",
            },
            "draft": {
              "default": false,
              "description": "Create the translation as a draft (not visible to end users). Defaults to false (published).",
              "type": "boolean",
            },
            "locale": {
              "description": "Target locale (e.g., "fr", "de")",
              "type": "string",
            },
            "title": {
              "description": "Translated article title.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "article_id",
            "locale",
            "title",
            "body",
          ],
          "type": "object",
        },
        "name": "create_article_translation",
        "title": "Create Article Translation",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Update article content (title, body) in a specific locale. For targeted edits on one or a few sections, prefer update_article_section — this tool replaces the FULL body and re-sends the entire article on each write. Use the article's source_locale (from get_article) for the default language, or another locale for translations.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the article whose translation to update. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "body": {
              "description": "New full body (HTML) for this locale. Replaces the entire body — for a single-section edit prefer update_article_section. Omit to leave the body unchanged.",
              "type": "string",
            },
            "draft": {
              "description": "When true, keeps this translation as a draft; when false, publishes it.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale of the translation to update, e.g. "en-us" or "fr". Use the source_locale (from get_article) to edit the default language.",
              "type": "string",
            },
            "title": {
              "description": "New title for this locale. Omit to leave the current title unchanged.",
              "type": "string",
            },
          },
          "required": [
            "article_id",
            "locale",
          ],
          "type": "object",
        },
        "name": "update_article_translation",
        "title": "Update Article Translation",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the translations of a Help Center section: for each locale, the localized name, whether a description is set, and whether the translation is published or still a draft. Reach for this when a section looks wrong in a locale, because list_sections with that locale cannot settle it: a section with no translation is omitted from it, while a section whose translation is an unpublished draft may still be listed there under the draft name — so appearing in that listing does not mean published, and the draft flag here is what decides. Fix either case with set_section_translation; to sweep every category and section at once, use find_translation_gaps.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "section_id": {
              "description": "Section ID — the numeric id of the Help Center section. Obtain it from list_sections or the zendesk-hc://topology resource.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "section_id",
          ],
          "type": "object",
        },
        "name": "list_section_translations",
        "title": "List Section Translations",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the translations of a Help Center category: for each locale, the localized name, whether a description is set, and whether the translation is published or still a draft. Reach for this when a category looks wrong in a locale, because list_categories with that locale cannot settle it: a category with no translation is omitted from it, while a category whose translation is an unpublished draft may still be listed there under the draft name — so appearing in that listing does not mean published, and the draft flag here is what decides. Fix either case with set_category_translation; to sweep every category and section at once, use find_translation_gaps.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Category ID — the numeric id of the Help Center category. Obtain it from list_categories or the zendesk-hc://topology resource.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "category_id",
          ],
          "type": "object",
        },
        "name": "list_category_translations",
        "title": "List Category Translations",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Audit the Help Center tree for a target locale and report every category and section that has no translation, or one that is still an unpublished draft. Use it before or after translating articles: an article published in a second locale is unreachable while its parent section only exists in the source locale. Listing sections in that locale cannot answer this — a node with no translation is simply absent, without saying why, and a node whose translation is an unpublished draft may still be listed under its draft name — so this audit reads the draft flag on each node instead of trusting that listing. Costs two listings and covers up to 100 categories and 100 sections; past that only the first page of each level is audited, and the report says so — pass category_id to narrow it. Fix what it reports with set_section_translation / set_category_translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Restrict the audit to this category and the sections it contains (id from list_categories). Omit to sweep the whole tree, which costs two listings and covers up to 100 categories and 100 sections.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "locale": {
              "description": "Locale to audit, e.g. "fr" or "de" — usually a non-default active locale of the Help Center (zendesk-hc://topology lists them). A locale that is not active is reported as a warning, since every node would then look untranslated.",
              "type": "string",
            },
          },
          "required": [
            "locale",
          ],
          "type": "object",
        },
        "name": "find_translation_gaps",
        "title": "Find Help Center Translation Gaps",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Create or update the translation of a Help Center section in one locale, and return the resulting translation (locale, localized name, draft state). Creates the translation when the locale has none and updates it otherwise, so no listing call is needed first; only the fields you pass are written, which makes "publish this draft" a single draft: false. Use it to make a section reachable in a locale where its articles are already translated — a gap find_translation_gaps reports and list_sections cannot explain.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "description": {
              "description": "Localized section description for this locale (sent as the API's translation \`body\`). Omit to leave an existing description untouched; pass an empty string to clear it.",
              "type": "string",
            },
            "draft": {
              "description": "Publication state: false publishes the translation, making the section visible to end users in this locale; true keeps (or puts) it back as a draft. Defaults to false when creating; omit on an existing translation to leave its state unchanged.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to write, e.g. "fr" or "de". Must be an active locale of the Help Center (zendesk-hc://topology lists them); list_section_translations shows which ones the section already has.",
              "type": "string",
            },
            "name": {
              "description": "Localized section name for this locale (sent as the API's translation \`title\`). Required when the locale has no translation yet; omit on an existing one to leave its name untouched, for instance when only publishing a draft.",
              "minLength": 1,
              "type": "string",
            },
            "section_id": {
              "description": "Section ID — the numeric id of the section whose translation to write. Obtain it from list_sections, find_translation_gaps or the zendesk-hc://topology resource.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "section_id",
            "locale",
          ],
          "type": "object",
        },
        "name": "set_section_translation",
        "title": "Create or Update a Section Translation",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Create or update the translation of a Help Center category in one locale, and return the resulting translation (locale, localized name, draft state). Creates the translation when the locale has none and updates it otherwise, so no listing call is needed first; only the fields you pass are written, which makes "publish this draft" a single draft: false. Use it to make a category reachable in a locale where its sections or articles are already translated — a gap find_translation_gaps reports and list_categories cannot explain.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Category ID — the numeric id of the category whose translation to write. Obtain it from list_categories, find_translation_gaps or the zendesk-hc://topology resource.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "description": {
              "description": "Localized category description for this locale (sent as the API's translation \`body\`). Omit to leave an existing description untouched; pass an empty string to clear it.",
              "type": "string",
            },
            "draft": {
              "description": "Publication state: false publishes the translation, making the category visible to end users in this locale; true keeps (or puts) it back as a draft. Defaults to false when creating; omit on an existing translation to leave its state unchanged.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to write, e.g. "fr" or "de". Must be an active locale of the Help Center (zendesk-hc://topology lists them); list_category_translations shows which ones the category already has.",
              "type": "string",
            },
            "name": {
              "description": "Localized category name for this locale (sent as the API's translation \`title\`). Required when the locale has no translation yet; omit on an existing one to leave its name untouched, for instance when only publishing a draft.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "category_id",
            "locale",
          ],
          "type": "object",
        },
        "name": "set_category_translation",
        "title": "Create or Update a Category Translation",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all Guide permission groups. Use this to find the permission_group_id required when creating articles.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {},
          "type": "object",
        },
        "name": "list_permission_groups",
        "title": "List Permission Groups",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Create a new article in a section and return the created article with its id. The locale becomes the article's source_locale. Requires a permission_group_id (use list_permission_groups to find available IDs). To add content in other locales afterwards, use create_article_translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "author_id": {
              "description": "Author user ID. Defaults to the authenticated user.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "body": {
              "description": "Article body as HTML (this becomes the source-locale content).",
              "minLength": 1,
              "type": "string",
            },
            "content_tag_ids": {
              "description": "Content tag IDs (use list_content_tags to find them)",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "draft": {
              "default": true,
              "description": "When true (default), the article is created unpublished; set false to publish immediately.",
              "type": "boolean",
            },
            "label_names": {
              "description": "Label names for search ranking (use list_labels to see existing labels)",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "locale": {
              "description": "Source locale for the article, e.g. "en-us" or "fr". Defaults to the Help Center's default locale; becomes the article's source_locale.",
              "type": "string",
            },
            "permission_group_id": {
              "description": "Permission group ID (use list_permission_groups to find it; if that is forbidden because the token is not a Guide admin, reuse the permission_group_id of an existing article from get_article).",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "promoted": {
              "default": false,
              "description": "When true, marks the article as promoted (featured) in its section. Defaults to false.",
              "type": "boolean",
            },
            "section_id": {
              "description": "Section that will contain the article (numeric id from list_sections).",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "title": {
              "description": "Title of the new article, in its source locale.",
              "minLength": 1,
              "type": "string",
            },
            "user_segment_id": {
              "description": "User segment ID for visibility (use list_user_segments to find it; if that is forbidden because the token is not a Guide admin, reuse the user_segment_id of an existing article from get_article). Defaults to everyone.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "section_id",
            "title",
            "body",
            "permission_group_id",
          ],
          "type": "object",
        },
        "name": "create_article",
        "title": "Create Help Center Article",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Update article metadata only (draft, promoted, labels as label_names, content tags as content_tag_ids, visibility as permission_group_id / user_segment_id, section_id, sort position, etc.) and return the updated article. Does NOT update content (title, body) — use update_article_translation for that.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the article to update. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "author_id": {
              "description": "User id of the article author (from search_users).",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "content_tag_ids": {
              "description": "Content tag ids to attach (use list_content_tags to find them).",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "draft": {
              "description": "Set true to unpublish the article (revert to draft) or false to publish it.",
              "type": "boolean",
            },
            "label_names": {
              "description": "Label names for search ranking (use list_labels to see existing labels).",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "permission_group_id": {
              "description": "Guide permission group controlling who can edit (id from list_permission_groups; if that is forbidden because the token is not a Guide admin, reuse the permission_group_id of an existing article from get_article).",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "position": {
              "description": "Sort position within the section (manual ordering only; 0 = first/top). New articles default to position 0. To move an article to the END of its section, set this to one more than the highest current position: read the highest position P from list_articles with sort_by="position", sort_order="desc", then set position = P + 1.",
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer",
            },
            "promoted": {
              "description": "Set true to promote (feature) the article in its section, or false to unpromote it.",
              "type": "boolean",
            },
            "section_id": {
              "description": "Move the article to this section (numeric id from list_sections).",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "user_segment_id": {
              "description": "User segment that controls who can see the article (id from list_user_segments; if that is forbidden because the token is not a Guide admin, reuse the user_segment_id of an existing article from get_article).",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "article_id",
          ],
          "type": "object",
        },
        "name": "update_article",
        "title": "Update Help Center Article",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Reorder an article within its current section by moving it relative to its siblings (top, bottom, or before/after another article), and return whether the new order was applied. This is the reliable way to satisfy "put this article first/last" requests: it writes the minimal set of article positions needed to make the order deterministic, because Zendesk leaves newly created articles tied at position 0 where a plain position update is silently ambiguous. It does NOT move the article to a different section — use update_article with section_id for that. Zendesk exposes no way to read whether a section is manually or automatically sorted, so when the section is sorted automatically (by date or alphabetically) the position writes are ignored; this tool detects that after the fact and returns guidance to switch the section to manual ordering in Guide. A move may reposition several neighbouring articles; when that count exceeds a configurable safety threshold the call is refused unless confirm is set to true.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the article to move within its section. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "confirm": {
              "default": false,
              "description": "Safety guard for large reorders. When the move would rewrite more article positions than the configured threshold (REORDER_CONFIRM_THRESHOLD, default 20), the tool refuses and reports the count until you pass true here. Has no effect on small reorders.",
              "type": "boolean",
            },
            "normalize": {
              "default": false,
              "description": "When true, also renumber every article in the section to contiguous positions (0, 1, 2, …) so the stored positions stay tidy. Defaults to false, which writes the fewest positions possible and lets gaps remain. Either way the confirmation threshold still applies.",
              "type": "boolean",
            },
            "reference_article_id": {
              "description": "The sibling article to position next to when target is "before" or "after" (numeric id from list_articles). Must belong to the same section and differ from article_id; leave it unset for "top" or "bottom".",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "target": {
              "description": "Where to move the article relative to its section siblings: "top" (becomes first), "bottom" (becomes last), or "before"/"after" a specific reference article. "before" and "after" require reference_article_id.",
              "enum": [
                "top",
                "bottom",
                "before",
                "after",
              ],
              "type": "string",
            },
          },
          "required": [
            "article_id",
            "target",
          ],
          "type": "object",
        },
        "name": "reorder_article",
        "title": "Reorder Help Center Article",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Archive (soft-delete) a Help Center article: it is removed from the Help Center but can be restored from the Guide admin UI. Returns a confirmation message; the article and all its translations become invisible to end users. This is the only removal the Zendesk API offers — permanent deletion is not available via the API (do it from the Guide admin UI). To only hide an article temporarily while keeping it in the knowledge base, use update_article with draft: true (unpublish) instead. Guarded by a required confirm flag.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "confirm": {
              "description": "Explicit safety guard: must be set to true to archive the article. Any other value refuses the operation without calling Zendesk.",
              "type": "boolean",
            },
          },
          "required": [
            "article_id",
            "confirm",
          ],
          "type": "object",
        },
        "name": "archive_article",
        "title": "Archive Help Center Article",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List Guide content tags, which are end-user-visible labels that help readers find related articles. Results are cursor-paginated (follow the returned cursor to enumerate the full list) and sorted by name by default. Pass name_prefix to look a tag up by the start of its name — do this before create_content_tag to reuse an existing tag rather than fragment the taxonomy. For internal, non-end-user search labels, see list_labels instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "name_prefix": {
              "description": "Return only content tags whose name starts with this prefix (prefix match — not a substring or fuzzy search). Use the full name to check whether a specific tag already exists before creating it.",
              "minLength": 1,
              "type": "string",
            },
            "page_size": {
              "default": 30,
              "description": "Content tags per page (1-30, default 30). The Guide content-tags endpoint caps each page at 30; follow the returned cursor to enumerate the full list.",
              "maximum": 30,
              "minimum": 1,
              "type": "integer",
            },
            "sort_by": {
              "default": "name",
              "description": "Field to sort by; "name" (the default) lists tags alphabetically.",
              "enum": [
                "name",
                "id",
              ],
              "type": "string",
            },
            "sort_order": {
              "default": "asc",
              "description": "Sort direction: ascending or descending.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
          },
          "type": "object",
        },
        "name": "list_content_tags",
        "title": "List Content Tags",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Create a new content tag for Guide articles. Content tags are end-user visible labels that help readers discover related articles; this returns the created tag with its id. Check list_content_tags first (filter by name_prefix) to avoid duplicates, then attach the new id via the content_tag_ids parameter of create_article or update_article. For internal search-ranking labels that are not shown to end users, use article labels (list_labels) instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "name": {
              "description": "Content tag name as shown to end users (e.g., "billing", "getting-started").",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "create_content_tag",
        "title": "Create Content Tag",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all article labels. Labels improve Help Center search ranking and are not visible to end users. Attach them to an article through the label_names parameter of create_article or update_article.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {},
          "type": "object",
        },
        "name": "list_labels",
        "title": "List Article Labels",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all user segments. User segments control article visibility (who can view). Use the ID when creating or updating articles.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {},
          "type": "object",
        },
        "name": "list_user_segments",
        "title": "List User Segments",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all attachments for an article. Returns attachment metadata only (id, file name, content type, size, URL), not the file bytes; both inline and block attachments are included. This is for Help Center articles — for attachments on support tickets use get_ticket_attachments instead. Upload new files with create_article_attachment.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "ID of the Help Center article whose attachments to list.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "article_id",
          ],
          "type": "object",
        },
        "name": "list_article_attachments",
        "title": "List Article Attachments",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Return a compact outline of an article (list of sections delimited by h1/h2/h3, with word counts) for the given locale (defaults to source_locale). Includes available translations with their outdated status. Use get_article_section to fetch a specific section.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "locale": {
              "description": "Locale of the body to outline (defaults to article source_locale)",
              "type": "string",
            },
          },
          "required": [
            "article_id",
          ],
          "type": "object",
        },
        "name": "get_article_outline",
        "title": "Get Article Outline",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Retrieve the content of a single section of an article in a given locale. Use get_article_outline first to discover section indexes. Default format="html" for round-trip safety. Pass format="markdown" only for human review — the Markdown representation is lossy on some structures (<pre> with <br>, tables with multi-<p> cells are kept as raw HTML to limit the damage, but do not round-trip markdown content back through update_article_section). The "## [n] hN: ..." line at the top is a label, not part of the content.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "format": {
              "default": "html",
              "description": "Output format. "html" (default) is round-trip safe. "markdown" is lossy on some HTML structures — use only for human review, not before update_article_section.",
              "enum": [
                "html",
                "markdown",
              ],
              "type": "string",
            },
            "locale": {
              "description": "Locale of the body (e.g., "en-us", "fr")",
              "type": "string",
            },
            "section_index": {
              "description": "0-based index of the section (see get_article_outline)",
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer",
            },
          },
          "required": [
            "article_id",
            "locale",
            "section_index",
          ],
          "type": "object",
        },
        "name": "get_article_section",
        "title": "Get Article Section",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Replace the body of one article section, heading excluded (the heading is kept as is), in a given locale, leaving the rest of the article intact. The server fetches the current body, replaces the targeted section, and PUTs the full reconstructed body via the Translations API. A leading heading in content that repeats the section heading is removed; any other h1-h3 in content creates new sections and shifts the later indexes (the response warns). section_index 0 is the heading-less intro, which exists only when the body has text before its first heading. Default format="html" for fidelity. Use format="markdown" only when you control the input and know it does not rely on structures that round-trip poorly (code blocks with line breaks, tables with multi-paragraph cells).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "content": {
              "description": "New content for the section (heading excluded: send neither the heading nor the "## [n] hN: ..." label line that get_article_section prints). HTML by default, Markdown if format="markdown".",
              "type": "string",
            },
            "format": {
              "default": "html",
              "description": "Input format. "html" (default) is the safe path. "markdown" is converted to HTML server-side but may introduce artifacts on complex content.",
              "enum": [
                "html",
                "markdown",
              ],
              "type": "string",
            },
            "locale": {
              "description": "Locale of the translation to update",
              "type": "string",
            },
            "section_index": {
              "description": "0-based index of the section to replace (see get_article_outline). 0 is the heading-less intro when the body has text before its first heading, otherwise the first heading.",
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer",
            },
          },
          "required": [
            "article_id",
            "locale",
            "section_index",
            "content",
          ],
          "type": "object",
        },
        "name": "update_article_section",
        "title": "Update Article Section",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Compare two locales of the same article to decide whether the target translation needs work, reporting independent signals instead of one ambiguous verdict. (1) Header — a "Freshness" verdict for the target, derived from the two translations' updated_at timestamps: if the source was edited after the target it is "likely behind, review recommended" (with the day gap), otherwise "up to date". This is the primary staleness signal and is always available. (2) Zendesk's own per-translation "outdated" flag for the target ("yes"/"no"/"unknown"), shown as a secondary overlay: it is only set through Guide's native "mark out of date" workflow and NOT by API edits, so a "no" does not by itself mean current — prefer Freshness. (3) A global structure check (section count and heading-tag sequence); on mismatch the header warns the per-index rows may be misaligned. (4) A per-section table matched by index, status "ok" (present in both), "missing" (present in source, absent in target) or "extra" (present in target, absent in source). (5) Per-section source/target word counts, INFORMATIONAL ONLY: a length difference between languages is normal and is deliberately NOT flagged as a divergence — do not read a word-count gap as an edit regression or staleness. Read-only; performs three Help Center GET calls (both translations plus the translations list for the outdated flag).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "source_locale": {
              "description": "Reference locale to diff against, e.g. "en-us". Usually the article source_locale (from get_article).",
              "type": "string",
            },
            "target_locale": {
              "description": "Target locale to compare against source",
              "type": "string",
            },
          },
          "required": [
            "article_id",
            "source_locale",
            "target_locale",
          ],
          "type": "object",
        },
        "name": "compare_translations",
        "title": "Compare Article Translations",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Upload a file to a Help Center article and return the created attachment (its id, file name, content type, size and content URL). Not idempotent: calling it again uploads another copy rather than replacing the previous one. This is for article assets — for files on support tickets use get_ticket_attachments, and to see an article's existing attachments use list_article_attachments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "content_type": {
              "default": "application/octet-stream",
              "description": "MIME type of the file, e.g. "image/png" or "application/pdf". Defaults to application/octet-stream when omitted.",
              "type": "string",
            },
            "file_base64": {
              "description": "The file's raw bytes as a base64-encoded string; the server decodes them before upload. At most 10420224 characters (about 7.45 MB of file); the HTTP transport additionally caps request bodies at 4 MB.",
              "maxLength": 10420224,
              "minLength": 1,
              "type": "string",
            },
            "file_name": {
              "description": "Name to store the file under, including its extension (e.g. "screenshot.png"); used as the download name.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "article_id",
            "file_name",
            "file_base64",
          ],
          "type": "object",
        },
        "name": "create_article_attachment",
        "title": "Create Article Attachment",
      },
    ]
  `);
});
