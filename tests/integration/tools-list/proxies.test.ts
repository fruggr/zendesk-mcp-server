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
    - get_ticket(ticket_id*, include_comments): Get a ticket as it stands now, with its live SLA state and who an update reaches.
    - get_ticket_history(ticket_id*, page_size, cursor): Read a ticket's audit trail: who changed which field and when, oldest first.
    - list_ticket_comments(ticket_id*, sort_order, page_size, cursor): Read a ticket's replies and internal notes in full, newest first, a page at a time.
    - get_ticket_attachments(ticket_id*, attachment_ids): Download a ticket's attached files to look at them.
    - search_tickets(query*, per_page, page): Search tickets with Zendesk query syntax, with the total count and live SLA state where a policy applies.
    - create_ticket(subject*, description*, priority, type, assignee_id, group_id, requester_id, organization_id, tags, custom_fields): Create a ticket from a subject and a description; the new ticket is returned with its id. (write)
    - update_ticket(ticket_id*, status, priority, type, assignee_id, group_id, requester_id, organization_id, subject, tags, custom_fields, followers, email_ccs): Change a ticket's fields, followers or email CCs and return the updated ticket. (write)
    - add_private_note(ticket_id*, body*, attachments): Add an internal note, hidden from the requester, to a ticket, optionally with files. (write)
    - add_public_comment(ticket_id*, body*, attachments): Post a public reply on a ticket, optionally with files. (write)
    - list_tickets(page_size, cursor): List tickets by ascending id, cursor-paginated, not by recency.
    - get_linked_incidents(problem_id*): List the incidents linked to a problem ticket, to gauge its impact before solving it.
    - manage_tags(ticket_id*, add, remove): Add or remove single tags on a ticket, keeping the others; returns the ticket's full tag set. (write)
    - list_sla_policies(per_page, page): List SLA policies with their conditions and per-priority targets.
    - get_ticket_metrics(ticket_ids*): Read elapsed-time metrics for up to 100 tickets: reply, resolution, wait and on-hold times.
    - list_ticket_fields(page_size, cursor): List ticket fields (system and custom) with id, type, active and required flags, and dropdown/multiselect options.
    - list_views(page_size, cursor): List your active views (saved ticket queues) with their ticket counts.
    - get_view_tickets(view*, sort_by, sort_order, page_size, cursor): Read a view's tickets in the view's own order, as the agent sees it in Zendesk.
    - list_macros(per_page, page): List the active macros you can use: id, title, description, scope and ordered actions.
    - preview_macro_diff(ticket_id*, macro_id*): Preview what a macro would change on a ticket, as a before → after diff, without saving. (write)
    - list_sla_alerts(scope, view, query, within, include_breached, warning, critical): List SLA metrics breached or about to breach on a set of tickets, most urgent first.
    - search(query*, per_page, page): Search tickets, users and organizations at once; returns the total count and a page of results.",
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
    - search_articles(query*, locale, per_page, page): Search Help Center articles by full text; returns metadata (no body) and the total count.
    - get_article(article_id*, locale): Get an article with its full HTML body, metadata, source_locale and translations.
    - list_categories(locale, page_size, cursor): List Help Center categories (top of category → section → article) with id, name and locale.
    - list_sections(category_id, locale, page_size, cursor): List Help Center sections (the level between category and article) with id, name, category_id and locale.
    - list_articles(section_id, locale, page_size, cursor, sort_by, sort_order, include_translations): List article metadata (no body), optionally by section or locale, sorted, or with translation locales.
    - list_promoted_articles(): List promoted ("featured") articles, shown at the top of their sections.
    - list_article_translations(article_id*): List an article's translations: locale, title, draft, updated_at (no body).
    - create_article_translation(article_id*, locale*, title*, body*, draft): Add an article translation in a locale that has none yet, and return it (locale, title, draft state). (write)
    - update_article_translation(article_id*, locale*, title, body, draft): Replace an article's title or full body in one locale, source or translation. (write)
    - list_section_translations(section_id*): List a section's translations: per locale, its name, whether a description is set, and draft or published.
    - list_category_translations(category_id*): List a category's translations: per locale, its name, whether a description is set, and draft or published.
    - find_translation_gaps(locale*, category_id): Report every category and section with no translation, or only a draft, in a locale.
    - set_section_translation(section_id*, locale*, name, description, draft): Create or update a section's translation in one locale and return it. (write)
    - set_category_translation(category_id*, locale*, name, description, draft): Create or update a category's translation in one locale and return it. (write)
    - list_permission_groups(): List Guide permission groups, which set who can edit and publish an article.
    - create_article(section_id*, title*, body*, permission_group_id*, user_segment_id, author_id, content_tag_ids, locale, draft, promoted, label_names): Create a new article in a section and return the created article with its id. (write)
    - update_article(article_id*, draft, promoted, label_names, content_tag_ids, user_segment_id, author_id, permission_group_id, section_id, position): Change article metadata and return the updated article. (write)
    - reorder_article(article_id*, target*, reference_article_id, normalize, confirm): Move an article within its section (top, bottom, or before/after another) and return whether the order took. (write)
    - archive_article(article_id*, confirm*): Archive an article and its translations, restorable in Guide; returns a confirmation. (write)
    - list_content_tags(name_prefix, sort_by, sort_order, page_size, cursor): List content tags, the labels readers see on articles.
    - create_content_tag(name*): Create a content tag, a label readers see on articles, and return it with its id. (write)
    - list_labels(): List article labels (id and name): hidden from readers, they tune search ranking.
    - list_user_segments(): List user segments, which set who can view an article.
    - list_article_attachments(article_id*): List an article's attachments, inline and block: id, file name, type, size, no bytes.
    - get_article_outline(article_id*, locale): Outline an article in one locale: its h1-h3 sections with word counts, and its translations with their outdated flag.
    - get_article_section(article_id*, locale*, section_index*, format): Read one section of an article in a locale; get its index from get_article_outline.
    - update_article_section(article_id*, locale*, section_index*, content*, format): Replace one section of an article in a locale, heading excluded, keeping the rest of the article. (write)
    - compare_translations(article_id*, source_locale*, target_locale*): Compare two locales of an article to see whether the target translation needs work, as separate signals.
    - create_article_attachment(article_id*, file_name*, file_base64*, content_type): Upload a file to an article and return the created attachment (id, name, type, size). (write)",
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
    - get_current_user(): Get the signed-in Zendesk user.
    - search_users(query*, per_page, page): Find users by name, email or Zendesk query.
    - get_user(user_id*): Get a user by id: name, email, role, role type, active state, organization id.
    - get_organization(organization_id*): Get an organization by id: name, details, domains, tags.
    - list_organizations(page_size, cursor): List organizations with name, id, details, domains and tags; they group end users and can scope tickets.",
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
    - list_request_forms(): List the request forms you can submit, such as "Report a bug" or "Feature request".
    - get_request_form(form_id): Read what one request form asks, to walk the user through it.
    - create_request(subject*, body*, form_id, custom_fields, attachments): Submit a support request as the signed-in user, like the Help Center's "Submit a request". (write)
    - list_requests(query, status, sort_by, sort_order, per_page, page): List your own requests, newest activity first by default, or search them by text.
    - get_request(request_id*, include_comments): Read one of your own requests, optionally with its conversation.
    - add_request_comment(request_id*, body*, attachments): Reply on one of your own requests, optionally with files; returns its status after. (write)
    - mark_request_solved(request_id*): Mark one of your own requests solved; returns the status read back from Zendesk. (write)",
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
