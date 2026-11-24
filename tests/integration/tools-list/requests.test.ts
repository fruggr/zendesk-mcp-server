import { expect, it } from 'vitest';
import { listExposedTools } from './list-exposed-tools';

it('exposes the requests tool surface unchanged', async () => {
  expect(await listExposedTools('requests')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the kinds of request you can submit to this Zendesk: the Help Center forms a customer picks between, such as "Report a bug" or "Feature request". Returns each active, end-user-visible form's customer-facing name, numeric id, and which is the account default; a single-form account returns just that one. Call it first when opening a request so the user picks the right kind, then get_request_form for what that form asks. End-user view: agents picking a form for someone else want list_ticket_fields and create_ticket instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {},
          "type": "object",
        },
        "name": "list_request_forms",
        "title": "List Request Forms",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Read what one request form asks for, to walk the user through it question by question. Returns the form's fields in portal order (joined from the field definitions, since the form carries only ids), each with its customer-facing label, whether it is required and, for a dropdown, the exact values Zendesk accepts, plus conditional rules ("if Type is Bug, Version becomes required"), left unresolved because they depend on answers not yet given. Use it after list_request_forms and before create_request.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "form_id": {
              "description": "Form id whose questions to read, as returned by list_request_forms. Omit to describe the account default form.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "get_request_form",
        "title": "Get Request Form",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Submit a new support request as the signed-in user, like the Help Center's "Submit a request" form. Returns the created request with its number, to follow with list_requests and get_request. Call get_request_form first for the fields to gather. Refused before sending: an unknown form id, a field id the form does not carry, a missing required field, or a dropdown answer the form does not offer, because Zendesk would answer 201 after silently substituting the default form, accepting an empty subject or dropping the answer. An end user cannot set priority or type (Zendesk drops them); triage is left to the agents. An agent opening a ticket on someone else's behalf wants create_ticket instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to the request, such as a screenshot or a log.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "content_type": {
                    "default": "application/octet-stream",
                    "description": "MIME type, e.g. "text/plain", "image/png", "application/pdf".",
                    "minLength": 1,
                    "type": "string",
                  },
                  "file_base64": {
                    "contentEncoding": "base64",
                    "description": "File content as base64, about 7.45 MB of file at most; the attachments of one call share that limit, and the HTTP transport caps request bodies at 4 MB.",
                    "format": "base64",
                    "maxLength": 10420224,
                    "minLength": 1,
                    "pattern": "^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$",
                    "type": "string",
                  },
                  "file_name": {
                    "description": "File name, e.g. "app.log" or "screenshot.png".",
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "file_name",
                  "file_base64",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "body": {
              "description": "The request itself: what happened, what was expected, any steps to reproduce. Becomes the ticket's first public comment. Sent as plain text: an end user sees Markdown and HTML as literal text, so write it without formatting markup.",
              "minLength": 1,
              "type": "string",
            },
            "custom_fields": {
              "description": "Answers to the form's own questions, as { id, value } pairs; take both the ids and the accepted values from get_request_form.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "description": "Numeric id of a question on the chosen form, from get_request_form.",
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
                    "type": "integer",
                  },
                  "value": {
                    "description": "The answer, typed after the question: the option tag (a string, never a number) for a dropdown, an array of option tags for a multiselect, true or false for a checkbox, text otherwise.",
                  },
                },
                "required": [
                  "id",
                  "value",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "form_id": {
              "description": "Form id from list_request_forms, deciding which questions apply. Omit for the account default form.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "subject": {
              "description": "One-line summary, shown as the ticket title to the support agents who pick it up.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "subject",
            "body",
          ],
          "type": "object",
        },
        "name": "create_request",
        "title": "Submit a Request",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the requests the signed-in user submitted, or search them by free text. Returns each with its number, subject, status and whether the user can mark it solved. Zendesk scopes it to the caller, so it never returns anyone else's tickets: an agent sees only requests they raised, not their queue (for that, list_tickets, search_tickets or get_view_tickets). Read one with its full conversation via get_request.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
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
              "description": "Free text matched against the caller's own requests, through the search endpoint instead of the plain listing; omit to list everything.",
              "minLength": 1,
              "type": "string",
            },
            "sort_by": {
              "default": "updated_at",
              "description": "updated_at surfaces recent activity, created_at the newest submissions.",
              "enum": [
                "created_at",
                "updated_at",
              ],
              "type": "string",
            },
            "sort_order": {
              "default": "desc",
              "description": "desc puts the most recent first, what a user following their tickets wants.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "status": {
              "description": "Restrict to these states, e.g. ["open","pending"] for anything still being worked. Checked here because Zendesk silently returns every request for a status it does not recognise.",
              "items": {
                "enum": [
                  "new",
                  "open",
                  "pending",
                  "hold",
                  "solved",
                  "closed",
                ],
                "type": "string",
              },
              "minItems": 1,
              "type": "array",
            },
          },
          "type": "object",
        },
        "name": "list_requests",
        "title": "List My Requests",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Read one of the signed-in user's own requests, optionally with its whole conversation. Returns its status, the form it was submitted on and whether the user may mark it solved; with include_comments, each public message is labelled with its author and marked when that author is a support agent. Internal agent notes are never returned, so nothing agent-private can leak. Someone else's request answers "permission denied", not "not found", so a denial does not tell whether the id exists. Agents reading a ticket they do not own want get_ticket instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "include_comments": {
              "default": false,
              "description": "When true, appends every public message: agent replies and the user's own. Leave off for a cheap status check.",
              "type": "boolean",
            },
            "request_id": {
              "description": "Number of the request to read, from list_requests or returned when it was submitted.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "request_id",
          ],
          "type": "object",
        },
        "name": "get_request",
        "title": "Get My Request",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Reply on one of the signed-in user's own requests, optionally attaching files. Returns the request's status after the reply: replying on a solved request REOPENS it (Zendesk moves it back to open), and the user should know their message did that. Always public: end users cannot post internal notes, and Zendesk silently ignores a private flag. A closed request rejects new comments. Agents replying to a requester want add_public_comment, or add_private_note for an internal note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to this reply, such as a screenshot or a log.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "content_type": {
                    "default": "application/octet-stream",
                    "description": "MIME type, e.g. "text/plain", "image/png", "application/pdf".",
                    "minLength": 1,
                    "type": "string",
                  },
                  "file_base64": {
                    "contentEncoding": "base64",
                    "description": "File content as base64, about 7.45 MB of file at most; the attachments of one call share that limit, and the HTTP transport caps request bodies at 4 MB.",
                    "format": "base64",
                    "maxLength": 10420224,
                    "minLength": 1,
                    "pattern": "^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$",
                    "type": "string",
                  },
                  "file_name": {
                    "description": "File name, e.g. "app.log" or "screenshot.png".",
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "file_name",
                  "file_base64",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "body": {
              "description": "The message, visible to the support agents on the ticket and included in their email notification. Sent as plain text: an end user sees Markdown and HTML as literal text, so write it without formatting markup.",
              "minLength": 1,
              "type": "string",
            },
            "request_id": {
              "description": "Number of the request to reply on, as shown by list_requests.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "request_id",
            "body",
          ],
          "type": "object",
        },
        "name": "add_request_comment",
        "title": "Reply on My Request",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Mark one of the signed-in user's own requests solved, when they consider it resolved. Returns the status read back from Zendesk, not a bare acknowledgement: a request its requester cannot solve is refused, because Zendesk would answer 200, change nothing and look successful. It becomes solvable only once an agent is assigned, so a new or unassigned one cannot be closed this way: leave it, or say it is no longer needed with add_request_comment. Already solved is a no-op. Agents closing a ticket want update_ticket with status solved.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "request_id": {
              "description": "Number of the request to close. Check get_request first: its "can you mark it solved" line has to say yes.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "request_id",
          ],
          "type": "object",
        },
        "name": "mark_request_solved",
        "title": "Mark My Request Solved",
      },
    ]
  `);
});
