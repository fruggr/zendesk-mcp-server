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
        "description": "Full-text search across Help Center articles, returning metadata only (no body) and the total count. Use get_article for full content.",
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
        "description": "Retrieve an article by ID with its full HTML body, metadata, source_locale and available translations. Pass locale for a translated version. For large articles, prefer get_article_outline + get_article_section to save tokens.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
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
        "description": "List all Help Center categories, the top level of the Guide hierarchy (category → section → article). Each comes with its id, name and locale; cursor-paginated. Drill down with list_sections, then list_articles.",
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
              "description": "Categories per page.",
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
        "description": "List Help Center sections, the middle level of the Guide hierarchy (category → section → article). Each groups related articles and comes with its id, name, category_id and locale; cursor-paginated. Use a section id with list_articles.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Restrict to sections of this category (id from list_categories). Omit to list every section.",
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
              "description": "Sections per page.",
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
        "description": "List articles (metadata only, no body), optionally in one section or locale, sorted, or with each article's translation locales (include_translations). Use get_article for full content.",
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
              "description": "Include available translation locales per article (1 extra API call per article). Re-send it with each page cursor.",
              "type": "boolean",
            },
            "locale": {
              "description": "Restrict to a single locale, e.g. "en-us" or "fr". Omit for the default locale.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Articles per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "section_id": {
              "description": "Restrict the listing to one section (numeric id from list_sections). Omit to list articles across all sections.",
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
        "description": "List the promoted ("featured") Help Center articles, the small editorially-curated set surfaced at the top of their sections. Metadata only, default locale; use get_article for full content. COST: the API has no promoted filter, so each call runs a fresh, uncached scan of article pages (one request per page, up to ARTICLE_RESOURCES_SCAN_MAX_PAGES, default 20) filtered client-side; avoid repeating it. On a very large Help Center some may be omitted, which the output flags with the pages scanned. To promote or unpromote, use update_article with \`promoted\` (Help Center / Guide admin rights).",
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
        "description": "Create a translation of an existing article (made with create_article) in a new locale and return it (locale, title, draft state). Provide the full HTML body. The locale must have no translation yet: to modify one use update_article_translation; list_article_translations shows which locales exist.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "ID of the existing article to translate.",
              "type": "integer",
            },
            "body": {
              "description": "Translated body (HTML)",
              "minLength": 1,
              "type": "string",
            },
            "draft": {
              "default": false,
              "description": "Create the translation as a draft (not visible to end users); false publishes it.",
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
        "description": "Update article content (title, body) in a specific locale, the source locale or a translation. For edits on one or a few sections prefer update_article_section: this tool replaces the FULL body, re-sending the entire article on each write.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the article whose translation to update. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "body": {
              "description": "New full body (HTML) for this locale, replacing the entire body. Omit to leave the body unchanged.",
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
        "description": "List the translations of a Help Center section: for each locale, the localized name, whether a description is set, and whether it is published or a draft. Use it when a section looks wrong in a locale, which list_sections in that locale cannot settle: it omits a section with no translation, while a draft translation may still be listed there under its draft name, so only the draft flag here says whether it is published. Fix either case with set_section_translation; to sweep every category and section at once, use find_translation_gaps.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "section_id": {
              "description": "Section ID — the numeric id of the Help Center section. Obtain it from list_sections or the zendesk-hc://topology resource.",
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
        "description": "List the translations of a Help Center category: for each locale, the localized name, whether a description is set, and whether it is published or a draft. Use it when a category looks wrong in a locale, which list_categories in that locale cannot settle: it omits a category with no translation, while a draft translation may still be listed there under its draft name, so only the draft flag here says whether it is published. Fix either case with set_category_translation; to sweep every category and section at once, use find_translation_gaps.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Category ID — the numeric id of the Help Center category. Obtain it from list_categories or the zendesk-hc://topology resource.",
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
        "description": "Audit the Help Center tree for a target locale and report every category and section that has no translation, or only an unpublished draft. Use it before or after translating articles: an article published in a second locale is unreachable while its parent section only exists in the source locale. A listing in that locale cannot answer this — it omits an untranslated node without saying why, and a draft translation may still be listed under its draft name — so the audit reads each node's draft flag. Costs two listings and covers up to 100 categories and 100 sections; past that only the first page of each level is audited, and the report says so — pass category_id to narrow it. Fix what it reports with set_section_translation / set_category_translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Restrict the audit to this category and the sections it contains (id from list_categories). Omit to sweep the whole tree.",
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
        "description": "Create or update the translation of a Help Center section in one locale, and return it (locale, localized name, draft state). It creates the translation or updates the existing one, so no listing call is needed first; only the fields you pass are written, so publishing a draft is a single draft: false. Use it to make a section reachable in a locale where its articles are already translated — a gap find_translation_gaps reports and list_sections cannot explain.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "description": {
              "description": "Localized section description (the API's translation \`body\`). Omit to keep an existing one; an empty string clears it.",
              "type": "string",
            },
            "draft": {
              "description": "false publishes the translation, making the section visible to end users in this locale; true keeps (or puts) it back as a draft. Defaults to false when creating; omit on an existing translation to keep its state.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to write, e.g. "fr" or "de". Must be an active locale of the Help Center (zendesk-hc://topology lists them); list_section_translations shows which ones the section already has.",
              "type": "string",
            },
            "name": {
              "description": "Localized section name (the API's translation \`title\`). Required when the locale has no translation yet; omit on an existing one to keep its name, e.g. when only publishing a draft.",
              "minLength": 1,
              "type": "string",
            },
            "section_id": {
              "description": "Section ID — the numeric id of the section whose translation to write. Obtain it from list_sections, find_translation_gaps or the zendesk-hc://topology resource.",
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
        "description": "Create or update the translation of a Help Center category in one locale, and return it (locale, localized name, draft state). It creates the translation or updates the existing one, so no listing call is needed first; only the fields you pass are written, so publishing a draft is a single draft: false. Use it to make a category reachable in a locale where its sections or articles are already translated — a gap find_translation_gaps reports and list_categories cannot explain.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Category ID — the numeric id of the category whose translation to write. Obtain it from list_categories, find_translation_gaps or the zendesk-hc://topology resource.",
              "type": "integer",
            },
            "description": {
              "description": "Localized category description (the API's translation \`body\`). Omit to keep an existing one; an empty string clears it.",
              "type": "string",
            },
            "draft": {
              "description": "false publishes the translation, making the category visible to end users in this locale; true keeps (or puts) it back as a draft. Defaults to false when creating; omit on an existing translation to keep its state.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to write, e.g. "fr" or "de". Must be an active locale of the Help Center (zendesk-hc://topology lists them); list_category_translations shows which ones the category already has.",
              "type": "string",
            },
            "name": {
              "description": "Localized category name (the API's translation \`title\`). Required when the locale has no translation yet; omit on an existing one to keep its name, e.g. when only publishing a draft.",
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
        "description": "List all Guide permission groups, which control who can edit and publish an article, with each group's id, name and whether it is built-in. Use it to find the permission_group_id that create_article requires and update_article changes; to control who can view an article, use list_user_segments. Zendesk restricts it to Guide admins and Help Center managers: without that role the call fails, and you can reuse an existing article's permission_group_id from get_article.",
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
        "description": "Create a new article in a section and return the created article with its id. To add content in other locales afterwards, use create_article_translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "author_id": {
              "description": "Author user ID. Defaults to the authenticated user.",
              "type": "integer",
            },
            "body": {
              "description": "Article body as HTML, in the source locale.",
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
              "description": "When true, the article is created unpublished; set false to publish immediately.",
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
              "description": "Locale of the new article, e.g. "en-us" or "fr"; it becomes the article's source_locale. Defaults to the Help Center's default locale.",
              "type": "string",
            },
            "permission_group_id": {
              "description": "Permission group controlling who can edit (id from list_permission_groups; if that is forbidden to a non-Guide-admin token, reuse an existing article's from get_article).",
              "type": "integer",
            },
            "promoted": {
              "default": false,
              "description": "When true, marks the article as promoted (featured) in its section.",
              "type": "boolean",
            },
            "section_id": {
              "description": "Section that will contain the article (numeric id from list_sections).",
              "type": "integer",
            },
            "title": {
              "description": "Title of the new article, in its source locale.",
              "minLength": 1,
              "type": "string",
            },
            "user_segment_id": {
              "description": "User segment controlling who can see the article; defaults to everyone (id from list_user_segments; if that is forbidden to a non-Guide-admin token, reuse an existing article's from get_article).",
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
        "description": "Update article metadata only (publication, promotion, labels, content tags, visibility, section, position, author) and return the updated article; omitted fields keep their value. Title and body are content: edit them with update_article_translation, or one section with update_article_section. To put an article first or last in its section, prefer reorder_article: a plain position write is ambiguous while articles share position 0. To remove an article from the Help Center, use archive_article (a Guide admin can restore it); draft: true only unpublishes it.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the article to update. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "author_id": {
              "description": "User id of the article author (from search_users).",
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
              "description": "Permission group controlling who can edit (id from list_permission_groups; if that is forbidden to a non-Guide-admin token, reuse an existing article's from get_article).",
              "type": "integer",
            },
            "position": {
              "description": "Sort position within the section (manual ordering only; 0 = top, where new articles land). To move an article to the end, read the highest position P with list_articles(sort_by="position", sort_order="desc"), then set position = P + 1.",
              "minimum": 0,
              "type": "integer",
            },
            "promoted": {
              "description": "Set true to promote (feature) the article in its section, or false to unpromote it.",
              "type": "boolean",
            },
            "section_id": {
              "description": "Move the article to this section (numeric id from list_sections).",
              "type": "integer",
            },
            "user_segment_id": {
              "description": "User segment controlling who can see the article (id from list_user_segments; if that is forbidden to a non-Guide-admin token, reuse an existing article's from get_article).",
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
        "description": "Reorder an article within its current section (top, bottom, or before/after another article) and return whether the new order was applied. The reliable way to put an article first or last: it writes the fewest positions that make the order deterministic, where a plain position update is silently ambiguous because Zendesk leaves new articles tied at position 0. To move an article to another section, use update_article with section_id. Zendesk does not expose whether a section is sorted manually or automatically (by date or alphabetically); in an automatic one the writes are ignored, and the tool detects it afterwards and says to switch the section to manual ordering in Guide. A move may reposition several neighbouring articles, so a large one needs confirm.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the article to move within its section. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "confirm": {
              "default": false,
              "description": "Pass true to allow a move that rewrites more positions than REORDER_CONFIRM_THRESHOLD (default 20); without it such a call is refused with the count. No effect on smaller moves.",
              "type": "boolean",
            },
            "normalize": {
              "default": false,
              "description": "When true, also renumber the whole section to contiguous positions (0, 1, 2, …); false writes the fewest positions and leaves gaps. The confirm threshold applies either way.",
              "type": "boolean",
            },
            "reference_article_id": {
              "description": "For "before"/"after" only: the sibling to place the article next to (id from list_articles), in the same section and other than article_id.",
              "type": "integer",
            },
            "target": {
              "description": "Where to move the article: first ("top"), last ("bottom"), or "before"/"after" reference_article_id.",
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
        "description": "Archive (soft-delete) a Help Center article: it is removed from the Help Center but can be restored from the Guide admin UI. Returns a confirmation; the article and all its translations become invisible to end users. It is the only removal the API offers; permanent deletion is done in the Guide admin UI. To only hide an article while keeping it in the knowledge base, use update_article with draft: true (unpublish). Guarded by a required confirm flag.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "confirm": {
              "description": "Safety guard: must be true to archive the article; any other value refuses without calling Zendesk.",
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
        "description": "List Guide content tags, the end-user-visible labels that help readers find related articles. Cursor-paginated: follow the cursor for the full list. Look a tag up with name_prefix before create_content_tag, to reuse it rather than fragment the taxonomy. For internal search labels not shown to end users, use list_labels.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "name_prefix": {
              "description": "Return only content tags whose name starts with this prefix (not a substring or fuzzy match). Pass a full name to check whether that tag already exists.",
              "minLength": 1,
              "type": "string",
            },
            "page_size": {
              "default": 30,
              "description": "Content tags per page; the Guide endpoint caps a page at 30.",
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
        "description": "Create a new content tag for Guide articles — an end-user-visible label that helps readers discover related articles — and return it with its id. Check list_content_tags (name_prefix) first to avoid duplicates, then attach the id through content_tag_ids of create_article or update_article. For internal search-ranking labels not shown to end users, use article labels (list_labels).",
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
        "description": "List all article labels, with each label's id and name. Labels improve Help Center search ranking and are not visible to end users; attach them through label_names of create_article or update_article, reusing an existing label rather than coining a near-duplicate. For the end-user-visible content tags readers browse by, use list_content_tags.",
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
        "description": "List all Help Center user segments, which control who can view an article, with each segment's id, name, user type and whether it is built-in. Pass the id as user_segment_id to create_article or update_article; to control who can edit an article, use list_permission_groups. Zendesk restricts it to Guide admins and Help Center managers: without that role the call fails, and you can reuse an existing article's user_segment_id from get_article, or omit it on create_article to make the article visible to everyone.",
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
        "description": "List all attachments of a Help Center article as metadata (id, file name, content type, size), not the file bytes; inline and block attachments alike. For attachments on support tickets use get_ticket_attachments; upload new files with create_article_attachment.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "ID of the Help Center article whose attachments to list.",
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
        "description": "Return a compact outline of an article in one locale: its sections delimited by h1/h2/h3, with word counts, and its available translations with their outdated status. Use get_article_section to fetch a specific section.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
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
        "description": "Retrieve the content of a single section of an article in a given locale. Use get_article_outline first to discover section indexes. The "## [n] hN: ..." line at the top is a label, not part of the content.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "format": {
              "default": "html",
              "description": "Output format. "html" is round-trip safe. "markdown" is for human review only: it is lossy on some structures (<pre> with <br>, tables with multi-<p> cells, kept as raw HTML to limit the damage), so never send it back through update_article_section.",
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
        "description": "Replace the body of one article section, heading excluded (the heading is kept as is), in a given locale, leaving the rest of the article intact. The server fetches the current body, replaces the section, and PUTs the full rebuilt body via the Translations API. A leading heading in content that repeats the section heading is removed; any other h1-h3 creates new sections and shifts the later indexes (the response warns).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "content": {
              "description": "New content for the section (heading excluded: send neither the heading nor the "## [n] hN: ..." label line that get_article_section prints). HTML by default, Markdown if format="markdown".",
              "type": "string",
            },
            "format": {
              "default": "html",
              "description": "Input format. "html" is the safe path. "markdown" is converted to HTML server-side and may introduce artifacts: use it only when you control the input and it has no structures that round-trip poorly (code blocks with line breaks, tables with multi-paragraph cells).",
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
        "description": "Compare two locales of the same article to decide whether the target translation needs work, as independent signals rather than one verdict. (1) Freshness, the primary staleness signal, always available: if the source's updated_at is later than the target's, the target is "likely behind, review recommended" (with the day gap), otherwise "up to date". (2) Zendesk's "outdated" flag for the target (yes/no/unknown), secondary: only Guide's "mark out of date" workflow sets it, never an API edit, so "no" alone does not mean current. (3) A structure check (section count, heading-tag sequence) that warns when the per-index rows may be misaligned. (4) A per-section table matched by index: "ok" (in both), "missing" (source only) or "extra" (target only). (5) Per-section word counts, informational only: a length gap between languages is normal, not a divergence, an edit regression or staleness. Read-only; three Help Center GET calls (both translations, plus the translations list for the outdated flag).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
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
        "description": "Upload a file to a Help Center article and return the created attachment (id, file name, content type, size). Calling it again uploads another copy rather than replacing the previous one. For files on support tickets use get_ticket_attachments; to see an article's existing attachments, list_article_attachments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.",
              "type": "integer",
            },
            "content_type": {
              "default": "application/octet-stream",
              "description": "MIME type of the file, e.g. "image/png" or "application/pdf".",
              "type": "string",
            },
            "file_base64": {
              "description": "The file's raw bytes, base64-encoded; the server decodes them before upload. The length cap is about 7.45 MB of file; the HTTP transport also caps request bodies at 4 MB.",
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
