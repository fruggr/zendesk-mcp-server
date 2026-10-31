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
        "description": "List the kinds of request you can submit to this Zendesk — the forms a customer picks between on the Help Center, such as "Report a bug" or "Feature request". Returns each form's customer-facing name, its numeric id, and which one is the account default. Call this first when opening a request so the user chooses the right kind, then get_request_form to learn what that form asks for. Only forms that are active and visible to end users are listed; an account with a single form returns just that one. This is the end-user view: agents picking a form for someone else want list_ticket_fields and create_ticket instead.",
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
        "description": "Read what one request form actually asks for, so the user can be walked through it question by question. Returns the fields on that form in the order the portal shows them, each with its customer-facing label, whether it is required, and for dropdowns the exact values Zendesk accepts — plus any conditional rules ("if Type is Bug, Version becomes required"). Joins the form definition with the field definitions, because the form itself carries only field ids. Use it after list_request_forms and before create_request; omit form_id to describe the account default form. Conditional fields are reported as rules rather than resolved, since which ones apply depends on answers not yet given.",
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
        "description": "Submit a new support request as the signed-in user — the MCP equivalent of the Help Center's "Submit a request" form. Returns the created request with its number, which the user can then follow with list_requests and get_request. The submission is checked before sending: an unknown form id, a missing field the form marks required, or a dropdown answer the form does not offer is refused here rather than sent, because Zendesk would answer 201 having silently substituted the default form, accepted an empty subject or dropped the unrecognised value. Call get_request_form first to learn which fields to gather. Priority and type cannot be set by an end user — Zendesk drops them — so triage is left to the agents. This posts as the authenticated user; an agent opening a ticket on someone else's behalf wants create_ticket instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to the request, such as a screenshot or a log, with their content base64-encoded.",
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
                    "description": "File content encoded as base64. At most 10420224 characters (about 7.45 MB of file), and the attachments of one call must stay under that total; the HTTP transport additionally caps request bodies at 4 MB.",
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
              "description": "The request itself: what happened, what was expected, and any steps to reproduce. Becomes the first public comment on the ticket.",
              "minLength": 1,
              "type": "string",
            },
            "custom_fields": {
              "description": "Answers to the form's own questions, as { id, value } pairs. Take both the ids and the accepted values from get_request_form; an id this form does not carry, or a value a dropdown does not offer, is refused here because Zendesk would drop it without an error. Option values are the tag strings, never numbers.",
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
              "description": "Form id chosen from list_request_forms, deciding which questions apply. Omit to use the account default form.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "subject": {
              "description": "One-line summary of the request, shown as the ticket title to the support agents who pick it up.",
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
        "description": "List the requests the signed-in user submitted, newest activity first by default. Returns each request with its number, subject, status and whether the user can mark it solved; pass a query to search their own requests by free text instead of listing all of them. Scoped to the caller by Zendesk itself — it can never return anyone else's tickets — which is why an agent calling this sees only requests they raised, not their queue. Use get_request to read one with its full conversation. Agents wanting a queue want list_tickets, search_tickets or get_view_tickets instead.",
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
              "description": "Free text to match against the caller's own requests. When given, the search endpoint is used instead of the plain listing; omit it to list everything.",
              "minLength": 1,
              "type": "string",
            },
            "sort_by": {
              "default": "updated_at",
              "description": "Which timestamp orders the results: updated_at surfaces recent activity, created_at the newest submissions.",
              "enum": [
                "created_at",
                "updated_at",
              ],
              "type": "string",
            },
            "sort_order": {
              "default": "desc",
              "description": "Direction of that ordering; desc puts the most recent first, which is what a user following their tickets wants.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "status": {
              "description": "Restrict to these ticket states, e.g. ["open","pending"] for anything still being worked. Validated here because Zendesk silently returns every request when it does not recognise a status.",
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
        "description": "Read one of the signed-in user's own requests, optionally with the whole conversation on it. Returns the request's status, the form it was submitted on, whether the user may mark it solved, and — with include_comments — every public message on it, each labelled with its author and marked when that author is a support agent. Internal agent notes are never returned on this path, so nothing agent-private can leak through it. A request belonging to someone else answers "permission denied" rather than "not found", so a denial here does not tell you whether that id exists. Find the number with list_requests; agents reading a ticket they do not own want get_ticket instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "include_comments": {
              "default": false,
              "description": "When true, appends the full public conversation — agent replies and the user's own messages. Defaults to false so a status check stays cheap.",
              "type": "boolean",
            },
            "request_id": {
              "description": "Number of the request to read, as shown by list_requests or returned when it was submitted.",
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
        "description": "Reply on one of the signed-in user's own requests, optionally attaching files. Returns confirmation with the request's status after the reply, which matters because replying on a request that was already solved REOPENS it — Zendesk moves it back to open, and the user should know that is what their message did. The comment is always public: end users cannot post internal notes, and Zendesk silently ignores any attempt to mark one private. A closed request rejects new comments outright. Agents replying to a requester want add_public_comment, or add_private_note for an internal note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to this reply, such as a screenshot or a log, with their content base64-encoded.",
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
                    "description": "File content encoded as base64. At most 10420224 characters (about 7.45 MB of file), and the attachments of one call must stay under that total; the HTTP transport additionally caps request bodies at 4 MB.",
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
              "description": "The message to send. Visible to the support agents on the ticket and included in their email notification.",
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
        "description": "Close one of the signed-in user's own requests, for when they consider it resolved. Returns the request's status read back from Zendesk, not merely an acknowledgement: this operation is refused unless the request is actually solvable by its requester, because Zendesk answers 200 and changes nothing when it is not, which would otherwise be reported as success. A request is only solvable once an agent has been assigned to it, so a brand-new or unassigned one cannot be closed this way — leave it, or reply with add_request_comment to say it is no longer needed. Marking an already-solved request solved again is a no-op. Agents closing a ticket want update_ticket with status solved.",
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
