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
        "description": "Search Help Center articles by full text; returns metadata (no body) and the total count. Full content: get_article.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "locale": {
              "description": "Only articles in this locale (e.g. "en-us", "fr").",
              "type": "string",
            },
            "page": {
              "default": 1,
              "description": "1-based page number; keep per_page fixed while paging.",
              "minimum": 1,
              "type": "integer",
            },
            "per_page": {
              "default": 100,
              "description": "Results per page; the header gives the total and whether more pages remain.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "query": {
              "description": "Plain keywords matched against titles and bodies.",
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
        "description": "Get an article with its full HTML body, metadata, source_locale and translations. For a large article, get_article_outline then get_article_section costs fewer tokens.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "locale": {
              "description": "Locale of the translation to return; omit for the source.",
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
        "description": "List Help Center categories (top of category → section → article) with id, name and locale. Drill down with list_sections, then list_articles.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "locale": {
              "description": "Locale of the names (e.g. "en-us", "fr"); defaults to the Help Center default.",
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
        "description": "List Help Center sections (the level between category and article) with id, name, category_id and locale. Use a section id with list_articles.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Only sections of this category (id from list_categories).",
              "type": "integer",
            },
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "locale": {
              "description": "Locale of the names (e.g. "en-us", "fr"); defaults to the Help Center default.",
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
        "description": "List article metadata (no body), optionally by section or locale, sorted, or with translation locales. Full content: get_article.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "include_translations": {
              "default": false,
              "description": "Add each article's translation locales (one extra call per article); re-send it with each cursor.",
              "type": "boolean",
            },
            "locale": {
              "description": "Only this locale, e.g. "en-us" or "fr"; defaults to the default locale.",
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
              "description": "Only articles of this section (id from list_sections).",
              "type": "integer",
            },
            "sort_by": {
              "default": "position",
              "description": "Sort field; "position" is the manual order set in Guide.",
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
        "description": "List promoted ("featured") articles, shown at the top of their sections: metadata only, default locale (full content: get_article). Each call scans article pages afresh (one request each, up to 20 by default), so avoid repeating it. On a very large Help Center some may be missed, which the output flags. To promote or unpromote: update_article with \`promoted\` (Guide admin rights).",
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
        "description": "List an article's translations: locale, title, draft, updated_at (no body). Full translated content: get_article with locale.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
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
        "description": "Add an article translation in a locale that has none yet, and return it (locale, title, draft state). To change an existing one use update_article_translation; list_article_translations shows which exist.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "body": {
              "description": "Full translated body, in HTML.",
              "minLength": 1,
              "type": "string",
            },
            "draft": {
              "default": false,
              "description": "true keeps it a draft, hidden from end users; false publishes it.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale of the new translation (e.g. "fr", "de").",
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
        "description": "Replace an article's title or full body in one locale, source or translation. To edit one or a few sections, prefer update_article_section: this re-sends the whole body.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "body": {
              "description": "New full body in HTML, replacing the whole body.",
              "type": "string",
            },
            "draft": {
              "description": "true keeps this translation a draft; false publishes it.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to update, e.g. "fr"; the source_locale (from get_article) edits the original.",
              "type": "string",
            },
            "title": {
              "description": "New title for this locale.",
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
        "description": "List a section's translations: per locale, its name, whether a description is set, and draft or published. Use it when a section looks wrong in a locale: list_sections omits an untranslated section, and a draft may still be listed there under its name, so only this draft flag says if it is published. Fix with set_section_translation; for the whole tree, find_translation_gaps.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "section_id": {
              "description": "Section id, from list_sections or zendesk-hc://topology.",
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
        "description": "List a category's translations: per locale, its name, whether a description is set, and draft or published. Use it when a category looks wrong in a locale: list_categories omits an untranslated category, and a draft may still be listed there under its name, so only this draft flag says if it is published. Fix with set_category_translation; for the whole tree, find_translation_gaps.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Category id, from list_categories or zendesk-hc://topology.",
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
        "description": "Report every category and section with no translation, or only a draft, in a locale. Run it around article translation: an article published in a locale is unreachable while its section exists only in the source locale. A listing in that locale cannot show this (a draft may still be listed under its name), so the audit reads each draft flag. Two listings, up to 100 categories and 100 sections; past that only the first page of each level is audited and the report says so (narrow with category_id). Fix with set_section_translation / set_category_translation.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Only this category and its sections (id from list_categories).",
              "type": "integer",
            },
            "locale": {
              "description": "Locale to audit, e.g. "fr", usually a non-default active one (zendesk-hc://topology); an inactive locale is reported as a warning.",
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
        "description": "Create or update a section's translation in one locale and return it (locale, name, draft state); no listing needed first. Only fields you pass are written, so publishing a draft is just draft: false. Use it for the gaps find_translation_gaps reports.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "description": {
              "description": "Localized description; an empty string clears it.",
              "type": "string",
            },
            "draft": {
              "description": "false publishes it to end users in this locale, true makes it a draft. A new translation defaults to false; omit to keep an existing state.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to write, e.g. "fr"; must be active (zendesk-hc://topology). Existing ones: list_section_translations.",
              "type": "string",
            },
            "name": {
              "description": "Localized name; required for a new translation, omit to keep an existing one.",
              "minLength": 1,
              "type": "string",
            },
            "section_id": {
              "description": "Section id, from list_sections, find_translation_gaps or zendesk-hc://topology.",
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
        "description": "Create or update a category's translation in one locale and return it (locale, name, draft state); no listing needed first. Only fields you pass are written, so publishing a draft is just draft: false. Use it for the gaps find_translation_gaps reports.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "category_id": {
              "description": "Category id, from list_categories, find_translation_gaps or zendesk-hc://topology.",
              "type": "integer",
            },
            "description": {
              "description": "Localized description; an empty string clears it.",
              "type": "string",
            },
            "draft": {
              "description": "false publishes it to end users in this locale, true makes it a draft. A new translation defaults to false; omit to keep an existing state.",
              "type": "boolean",
            },
            "locale": {
              "description": "Locale to write, e.g. "fr"; must be active (zendesk-hc://topology). Existing ones: list_category_translations.",
              "type": "string",
            },
            "name": {
              "description": "Localized name; required for a new translation, omit to keep an existing one.",
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
        "description": "List Guide permission groups (who can edit and publish an article) with id, name and built-in flag, for create_article and update_article. Who can view: list_user_segments. Guide admins and Help Center managers only; otherwise reuse an article's permission_group_id from get_article.",
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
              "description": "Author user id; defaults to you.",
              "type": "integer",
            },
            "body": {
              "description": "Article body in HTML, in the source locale.",
              "minLength": 1,
              "type": "string",
            },
            "content_tag_ids": {
              "description": "Content tag ids, from list_content_tags.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "draft": {
              "default": true,
              "description": "true creates it unpublished; false publishes it now.",
              "type": "boolean",
            },
            "label_names": {
              "description": "Search-ranking labels (existing ones: list_labels).",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "locale": {
              "description": "Source locale of the article, e.g. "en-us"; defaults to the Help Center default.",
              "type": "string",
            },
            "permission_group_id": {
              "description": "Who can edit (id from list_permission_groups, or an existing article's from get_article).",
              "type": "integer",
            },
            "promoted": {
              "default": false,
              "description": "true features it at the top of its section.",
              "type": "boolean",
            },
            "section_id": {
              "description": "Section to create it in (id from list_sections).",
              "type": "integer",
            },
            "title": {
              "description": "Article title, in its source locale.",
              "minLength": 1,
              "type": "string",
            },
            "user_segment_id": {
              "description": "Who can see it, everyone by default (id from list_user_segments, or an existing article's from get_article).",
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
        "description": "Change article metadata (publication, promotion, labels, tags, visibility, section, position, author) and return the updated article; omitted fields are kept. Title and body: update_article_translation, or update_article_section for one section. First or last in a section: reorder_article, since articles often share position 0. To remove an article use archive_article; draft: true only unpublishes it.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "author_id": {
              "description": "Author user id, from search_users.",
              "type": "integer",
            },
            "content_tag_ids": {
              "description": "Content tag ids, from list_content_tags.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "draft": {
              "description": "true unpublishes (back to draft), false publishes.",
              "type": "boolean",
            },
            "label_names": {
              "description": "Search-ranking labels (existing ones: list_labels).",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "permission_group_id": {
              "description": "Who can edit (id from list_permission_groups, or an existing article's from get_article).",
              "type": "integer",
            },
            "position": {
              "description": "Position in a manually sorted section (0 = top, where new articles land). For the end, read the highest P with list_articles(sort_by="position", sort_order="desc") and set P + 1.",
              "minimum": 0,
              "type": "integer",
            },
            "promoted": {
              "description": "true features it in its section, false stops.",
              "type": "boolean",
            },
            "section_id": {
              "description": "Section to move it to (id from list_sections).",
              "type": "integer",
            },
            "user_segment_id": {
              "description": "Who can see it (id from list_user_segments, or an existing article's from get_article).",
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
        "description": "Move an article within its section (top, bottom, or before/after another) and return whether the order took. It writes the fewest positions that make the order certain, unlike a plain position write while articles tie at 0. Another section: update_article with section_id. In a section sorted automatically the writes are ignored, and the reply says to switch it to manual ordering in Guide. A move can shift neighbours, so a large one needs confirm.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "confirm": {
              "default": false,
              "description": "Pass true to allow a move that rewrites more positions than REORDER_CONFIRM_THRESHOLD (default 20); without it such a call is refused with the count. No effect on smaller moves.",
              "type": "boolean",
            },
            "normalize": {
              "default": false,
              "description": "true also renumbers the section 0, 1, 2, …; false leaves gaps. The confirm threshold applies either way.",
              "type": "boolean",
            },
            "reference_article_id": {
              "description": "For "before"/"after": the other article of the same section to place it next to.",
              "type": "integer",
            },
            "target": {
              "description": ""top", "bottom", or "before"/"after" reference_article_id.",
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
        "description": "Archive an article: it and its translations leave the Help Center, restorable in Guide (permanent deletion is Guide-only); returns a confirmation. To only unpublish, use update_article with draft: true. Requires confirm: true.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "confirm": {
              "description": "Must be true; anything else refuses without calling Zendesk.",
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
        "description": "List content tags, the labels readers see on articles. Check name_prefix before create_content_tag to reuse a tag. Hidden search labels: list_labels.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "name_prefix": {
              "description": "Only tags whose name starts with this (no fuzzy match); a full name checks if it exists.",
              "minLength": 1,
              "type": "string",
            },
            "page_size": {
              "default": 30,
              "description": "Content tags per page.",
              "maximum": 30,
              "minimum": 1,
              "type": "integer",
            },
            "sort_by": {
              "default": "name",
              "description": "Sort field; "name" is alphabetical.",
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
        "description": "Create a content tag, a label readers see on articles, and return it with its id. Check list_content_tags (name_prefix) first, then attach it via content_tag_ids of create_article or update_article. Hidden search labels: list_labels.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "name": {
              "description": "Name shown to readers (e.g. "billing", "getting-started").",
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
        "description": "List article labels (id and name): hidden from readers, they tune search ranking. Attach them via label_names of create_article or update_article, reusing existing ones. Labels readers see: list_content_tags.",
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
        "description": "List user segments (who can view an article) with id, name, user type and built-in flag, for user_segment_id in create_article or update_article. Who can edit: list_permission_groups. Guide admins and Help Center managers only; otherwise reuse an article's user_segment_id from get_article, or omit it on create_article for everyone.",
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
        "description": "List an article's attachments, inline and block: id, file name, type, size, no bytes. Ticket files: get_ticket_attachments; uploads: create_article_attachment.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
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
        "description": "Outline an article in one locale: its h1-h3 sections with word counts, and its translations with their outdated flag. Then read one section with get_article_section.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "locale": {
              "description": "Locale to outline; defaults to the source_locale.",
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
        "description": "Read one section of an article in a locale; get its index from get_article_outline. The leading "## [n] hN: ..." line is a label, not content.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "format": {
              "default": "html",
              "description": ""html" round-trips safely; "markdown" is for reading only (lossy on <pre> with <br> and tables with multi-<p> cells), never to send back to update_article_section.",
              "enum": [
                "html",
                "markdown",
              ],
              "type": "string",
            },
            "locale": {
              "description": "Locale to read (e.g. "en-us", "fr").",
              "type": "string",
            },
            "section_index": {
              "description": "0-based section index, from get_article_outline.",
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
        "description": "Replace one section of an article in a locale, heading excluded, keeping the rest of the article. A leading heading repeating the section heading is dropped; any other h1-h3 creates sections and shifts later indexes (the reply warns).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "content": {
              "description": "New section content, heading excluded (and without the "## [n] hN: ..." label line). HTML, or Markdown with format="markdown".",
              "type": "string",
            },
            "format": {
              "default": "html",
              "description": ""html" is safe; "markdown" is converted and can leave artifacts, so avoid it for code blocks with line breaks or tables with multi-paragraph cells.",
              "enum": [
                "html",
                "markdown",
              ],
              "type": "string",
            },
            "locale": {
              "description": "Locale of the translation to edit.",
              "type": "string",
            },
            "section_index": {
              "description": "0-based index from get_article_outline; 0 is the heading-less intro when text precedes the first heading.",
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
        "description": "Compare two locales of an article to see whether the target translation needs work, as separate signals. Freshness (main signal): a source updated after the target is "likely behind" with the day gap. Zendesk's "outdated" flag: set only by Guide's "mark out of date", so "no" proves nothing. A structure check warns when sections may be misaligned; a per-section table marks each "ok", "missing" or "extra". Word counts are informational: languages differ in length. Three GET calls.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "source_locale": {
              "description": "Reference locale, e.g. "en-us", usually the source_locale.",
              "type": "string",
            },
            "target_locale": {
              "description": "Locale of the translation to check.",
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
        "description": "Upload a file to an article and return the created attachment (id, name, type, size); a second call adds another copy. Existing ones: list_article_attachments; ticket files: get_ticket_attachments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "article_id": {
              "description": "Article id, from list_articles or search_articles.",
              "type": "integer",
            },
            "content_type": {
              "default": "application/octet-stream",
              "description": "MIME type, e.g. "image/png".",
              "type": "string",
            },
            "file_base64": {
              "description": "The file's raw bytes, base64-encoded; the server decodes them before upload. The length cap is about 7.45 MB of file; the HTTP transport also caps request bodies at 4 MB.",
              "maxLength": 10420224,
              "minLength": 1,
              "type": "string",
            },
            "file_name": {
              "description": "File name with extension (e.g. "screenshot.png"), used for download.",
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
