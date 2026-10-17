import { expect, it } from 'vitest';
import { listExposedTools } from './list-exposed-tools';

// `namespace` is the default mode, so these proxies are what most agents see.

it('exposes the tickets proxy unchanged', async () => {
  expect(await listExposedTools('tickets', 'namespace')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Zendesk Tickets. Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.

    Operations: get_ticket, get_ticket_history, list_ticket_comments, get_ticket_attachments, search_tickets, create_ticket, update_ticket, add_private_note, add_public_comment, list_tickets, get_linked_incidents, manage_tags, list_sla_policies, get_ticket_metrics, list_ticket_fields, list_views, get_view_tickets, list_macros, preview_macro_diff, list_sla_alerts, search",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "properties": {
            "operation": {
              "description": "One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.
    - get_ticket(ticket_id*, include_comments): Retrieve a Zendesk ticket by ID, including its live SLA state (per-metric stage and breach countdown) when an SLA policy applies, plus its comments if requested.
    - get_ticket_history(ticket_id*, page_size, cursor): Read a ticket's change history — its audit trail — as a chronological, oldest-first timeline of who changed what and when.
    - list_ticket_comments(ticket_id*, sort_order, page_size, cursor): Read a ticket's conversation — public replies and internal notes with their full bodies — one cursor-paginated page at a time, newest comment first.
    - get_ticket_attachments(ticket_id*, attachment_ids): Retrieve ticket attachments.
    - search_tickets(query*, per_page, page): Search tickets using Zendesk query syntax, returning each result with its live SLA state (per-metric stage and breach countdown) when an SLA policy applies.
    - create_ticket(subject*, description*, priority, type, assignee_id, group_id, tags, custom_fields): Create a new Zendesk support ticket with subject, description, and optional priority/type/assignee/tags. (write)
    - update_ticket(ticket_id*, status, priority, type, assignee_id, group_id, subject, tags, custom_fields, followers, email_ccs): Update an existing ticket (status, priority, type, assignee, group, subject, tags, custom fields, followers, email CCs). (write)
    - add_private_note(ticket_id*, body*, attachments): Add an internal note (not visible to requester) to a ticket, optionally with file attachments (uploaded via the Zendesk Uploads API and carried on the note). (write)
    - add_public_comment(ticket_id*, body*, attachments): Add a public comment (visible to requester) to a ticket, optionally with file attachments (uploaded via the Zendesk Uploads API and carried on the comment). (write)
    - list_tickets(page_size, cursor): List tickets with cursor-based pagination, in Zendesk's default order (ascending ticket id), not by recency.
    - get_linked_incidents(problem_id*): Get all incident tickets linked to a problem ticket.
    - manage_tags(ticket_id*, add, remove): Add or remove tags on a ticket. (write)
    - list_sla_policies(per_page, page): List the configured SLA policies with their filter conditions and per-priority reply/resolution targets.
    - get_ticket_metrics(ticket_ids*): Read the elapsed-time metrics (reply, resolution, wait and on-hold times, reopens, replies) of up to 100 tickets in one call.
    - list_ticket_fields(page_size, cursor): List the ticket field definitions configured on this Zendesk (both system fields and custom fields), returning each field's id, type, whether it is active/required, and — for dropdown and multiselect fields — the valid option values.
    - list_views(page_size, cursor): List the agent's active Zendesk views — the saved ticket queues ("Unassigned tickets", "My open tickets", "Breaching today") the agent sees in the Zendesk UI — each with its current ticket count so you can tell at a glance where the workload sits.
    - get_view_tickets(view*, sort_by, sort_order, page_size, cursor): Read the tickets inside a Zendesk view, in the view's own configured sort order — the same order the agent sees in the Zendesk UI — which is the natural way to work a named queue like "Unassigned tickets" or "Breaching today".
    - list_macros(per_page, page): List the active macros available to the authenticated user.
    - preview_macro_diff(ticket_id*, macro_id*): Preview the exact changes a macro would make to a specific ticket, as a before → after diff, WITHOUT saving anything. (write)
    - list_sla_alerts(scope, view, query, within, include_breached, warning, critical): List the SLA metrics that are breached or about to breach across a set of tickets, most urgent first.
    - search(query*, per_page, page): Search across tickets, users, and organizations.",
              "type": "string",
            },
            "params": {
              "additionalProperties": {},
              "default": {},
              "description": "Parameters of the chosen operation, named exactly as its line in "operation" lists them (* = required). An unknown name is rejected.",
              "propertyNames": {
                "type": "string",
              },
              "type": "object",
            },
          },
          "required": [
            "operation",
          ],
          "type": "object",
        },
        "name": "zendesk_tickets",
        "title": "Zendesk Tickets",
      },
    ]
  `);
});

it('exposes the help_center proxy unchanged', async () => {
  expect(await listExposedTools('help_center', 'namespace')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Zendesk Help Center. Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.

    Operations: search_articles, get_article, list_categories, list_sections, list_articles, list_promoted_articles, list_article_translations, create_article_translation, update_article_translation, list_section_translations, list_category_translations, find_translation_gaps, set_section_translation, set_category_translation, list_permission_groups, create_article, update_article, reorder_article, archive_article, list_content_tags, create_content_tag, list_labels, list_user_segments, list_article_attachments, get_article_outline, get_article_section, update_article_section, compare_translations, create_article_attachment",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "properties": {
            "operation": {
              "description": "One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.
    - search_articles(query*, locale, per_page, page): Full-text search across Help Center articles (metadata only, no body).
    - get_article(article_id*, locale): Retrieve an article by ID with full body content.
    - list_categories(locale, page_size, cursor): List all Help Center categories.
    - list_sections(category_id, locale, page_size, cursor): List Help Center sections.
    - list_articles(section_id, locale, page_size, cursor, sort_by, sort_order, include_translations): List articles (metadata only, no body).
    - list_promoted_articles(): List the promoted ("featured") Help Center articles — the small, editorially-curated set surfaced at the top of their sections.
    - list_article_translations(article_id*): List all available translations for an article (metadata only, no body: locale, title, draft, updated_at).
    - create_article_translation(article_id*, locale*, title*, body*, draft): Create a translation for an existing article in a specific locale. (write)
    - update_article_translation(article_id*, locale*, title, body, draft): Update article content (title, body) in a specific locale. (write)
    - list_section_translations(section_id*): List the translations of a Help Center section: for each locale, the localized name, whether a description is set, and whether the translation is published or still a draft.
    - list_category_translations(category_id*): List the translations of a Help Center category: for each locale, the localized name, whether a description is set, and whether the translation is published or still a draft.
    - find_translation_gaps(locale*, category_id): Audit the Help Center tree for a target locale and report every category and section that has no translation, or one that is still an unpublished draft.
    - set_section_translation(section_id*, locale*, name, description, draft): Create or update the translation of a Help Center section in one locale, and return the resulting translation (locale, localized name, draft state). (write)
    - set_category_translation(category_id*, locale*, name, description, draft): Create or update the translation of a Help Center category in one locale, and return the resulting translation (locale, localized name, draft state). (write)
    - list_permission_groups(): List all Guide permission groups.
    - create_article(section_id*, title*, body*, permission_group_id*, user_segment_id, author_id, content_tag_ids, locale, draft, promoted, label_names): Create a new article in a section and return the created article with its id. (write)
    - update_article(article_id*, draft, promoted, label_names, content_tag_ids, user_segment_id, author_id, permission_group_id, section_id, position): Update article metadata only (draft, promoted, labels as label_names, content tags as content_tag_ids, visibility as permission_group_id / user_segment_id, section_id, sort position, etc.) and return the updated article. (write)
    - reorder_article(article_id*, target*, reference_article_id, normalize, confirm): Reorder an article within its current section by moving it relative to its siblings (top, bottom, or before/after another article), and return whether the new order was applied. (write)
    - archive_article(article_id*, confirm*): Archive (soft-delete) a Help Center article: it is removed from the Help Center but can be restored from the Guide admin UI. (write)
    - list_content_tags(name_prefix, sort_by, sort_order, page_size, cursor): List Guide content tags, which are end-user-visible labels that help readers find related articles.
    - create_content_tag(name*): Create a new content tag for Guide articles. (write)
    - list_labels(): List all article labels.
    - list_user_segments(): List all user segments.
    - list_article_attachments(article_id*): List all attachments for an article.
    - get_article_outline(article_id*, locale): Return a compact outline of an article (list of sections delimited by h1/h2/h3, with word counts) for the given locale (defaults to source_locale).
    - get_article_section(article_id*, locale*, section_index*, format): Retrieve the content of a single section of an article in a given locale.
    - update_article_section(article_id*, locale*, section_index*, content*, format): Replace the body of one article section, heading excluded (the heading is kept as is), in a given locale, leaving the rest of the article intact. (write)
    - compare_translations(article_id*, source_locale*, target_locale*): Compare two locales of the same article to decide whether the target translation needs work, reporting independent signals instead of one ambiguous verdict.
    - create_article_attachment(article_id*, file_name*, file_base64*, content_type): Upload a file to a Help Center article and return the created attachment (its id, file name, content type, size and content URL). (write)",
              "type": "string",
            },
            "params": {
              "additionalProperties": {},
              "default": {},
              "description": "Parameters of the chosen operation, named exactly as its line in "operation" lists them (* = required). An unknown name is rejected.",
              "propertyNames": {
                "type": "string",
              },
              "type": "object",
            },
          },
          "required": [
            "operation",
          ],
          "type": "object",
        },
        "name": "zendesk_help_center",
        "title": "Zendesk Help Center",
      },
    ]
  `);
});

it('exposes the users proxy unchanged', async () => {
  expect(await listExposedTools('users', 'namespace')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Zendesk Users. Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.

    Operations: get_current_user, search_users, get_user, get_organization, list_organizations",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "properties": {
            "operation": {
              "description": "One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.
    - get_current_user(): Get the currently authenticated Zendesk user.
    - search_users(query*, per_page, page): Search for users by name, email, or other criteria using Zendesk search query syntax.
    - get_user(user_id*): Retrieve a single user by their numeric id.
    - get_organization(organization_id*): Retrieve a single organization by its numeric id.
    - list_organizations(page_size, cursor): List all organizations with pagination.",
              "type": "string",
            },
            "params": {
              "additionalProperties": {},
              "default": {},
              "description": "Parameters of the chosen operation, named exactly as its line in "operation" lists them (* = required). An unknown name is rejected.",
              "propertyNames": {
                "type": "string",
              },
              "type": "object",
            },
          },
          "required": [
            "operation",
          ],
          "type": "object",
        },
        "name": "zendesk_users",
        "title": "Zendesk Users",
      },
    ]
  `);
});

it('exposes the requests proxy unchanged', async () => {
  expect(await listExposedTools('requests', 'namespace')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Zendesk Requests. Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.

    Operations: list_request_forms, get_request_form, create_request, list_requests, get_request, add_request_comment, mark_request_solved",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "properties": {
            "operation": {
              "description": "One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.
    - list_request_forms(): List the kinds of request you can submit to this Zendesk — the forms a customer picks between on the Help Center, such as "Report a bug" or "Feature request".
    - get_request_form(form_id): Read what one request form actually asks for, so the user can be walked through it question by question.
    - create_request(subject*, body*, form_id, custom_fields, attachments): Submit a new support request as the signed-in user — the MCP equivalent of the Help Center's "Submit a request" form. (write)
    - list_requests(query, status, sort_by, sort_order, per_page, page): List the requests the signed-in user submitted, newest activity first by default.
    - get_request(request_id*, include_comments): Read one of the signed-in user's own requests, optionally with the whole conversation on it.
    - add_request_comment(request_id*, body*, attachments): Reply on one of the signed-in user's own requests, optionally attaching files. (write)
    - mark_request_solved(request_id*): Close one of the signed-in user's own requests, for when they consider it resolved. (write)",
              "type": "string",
            },
            "params": {
              "additionalProperties": {},
              "default": {},
              "description": "Parameters of the chosen operation, named exactly as its line in "operation" lists them (* = required). An unknown name is rejected.",
              "propertyNames": {
                "type": "string",
              },
              "type": "object",
            },
          },
          "required": [
            "operation",
          ],
          "type": "object",
        },
        "name": "zendesk_requests",
        "title": "Zendesk Requests",
      },
    ]
  `);
});
