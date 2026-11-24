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
        "description": "List the request forms you can submit, such as "Report a bug" or "Feature request". Returns each visible form's name, id and which is the default. Call it first when opening a request, then get_request_form. End-user view: agents filing for someone else want list_ticket_fields and create_ticket.",
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
        "description": "Read what one request form asks, to walk the user through it. Returns its fields in portal order with label, required flag and, for a dropdown, the accepted values, plus conditional rules ("if Type is Bug, Version becomes required") left for you to apply as answers come. Use it after list_request_forms, before create_request.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "form_id": {
              "description": "Form id from list_request_forms; omit for the default form.",
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
        "description": "Submit a support request as the signed-in user, like the Help Center's "Submit a request". Returns the created request with its number. Gather fields with get_request_form first: an unknown form, a field the form lacks, a missing required field or a dropdown value it does not offer is refused before sending, since Zendesk would silently accept and drop it. End users cannot set priority or type. An agent filing for someone else wants create_ticket.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach, such as a screenshot or a log.",
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
              "description": "What happened, what was expected, steps to reproduce; the first public comment. Plain text: Markdown and HTML show as literal text for an end user.",
              "minLength": 1,
              "type": "string",
            },
            "custom_fields": {
              "description": "{ id, value } answers to the form's questions; ids and accepted values from get_request_form.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "description": "Numeric id of a question on the chosen form, from get_request_form.",
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
              "description": "Form id from list_request_forms; omit for the default form.",
              "type": "integer",
            },
            "subject": {
              "description": "One-line summary, the title agents see.",
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
        "description": "List your own requests, newest activity first by default, or search them by text. Returns each with number, subject, status and whether you can mark it solved. Never anyone else's: an agent sees only requests they raised, not their queue (list_tickets, search_tickets, get_view_tickets). One with its conversation: get_request.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
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
              "description": "Free text to search your requests; omit to list all.",
              "minLength": 1,
              "type": "string",
            },
            "sort_by": {
              "default": "updated_at",
              "description": "updated_at for recent activity, created_at for newest submissions.",
              "enum": [
                "created_at",
                "updated_at",
              ],
              "type": "string",
            },
            "sort_order": {
              "default": "desc",
              "description": "desc puts the most recent first.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "status": {
              "description": "Only these states, e.g. ["open","pending"] for anything in progress.",
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
        "description": "Read one of your own requests, optionally with its conversation. Returns status, form and whether you may mark it solved; messages show their author, agents marked, and internal notes never appear. Someone else's request says "permission denied", which does not tell whether it exists. Agents reading a ticket want get_ticket.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "include_comments": {
              "default": false,
              "description": "Append every public message, agents' and yours; leave off for a quick status check.",
              "type": "boolean",
            },
            "request_id": {
              "description": "Request number, from list_requests or create_request.",
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
        "description": "Reply on one of your own requests, optionally with files; returns its status after. Replying on a solved request REOPENS it: tell the user. Always public; a closed request rejects replies. Agents replying to a requester want add_public_comment, or add_private_note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach, such as a screenshot or a log.",
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
              "description": "The message, seen by the agents and in their email. Plain text: Markdown and HTML show as literal text for an end user.",
              "minLength": 1,
              "type": "string",
            },
            "request_id": {
              "description": "Request number, from list_requests.",
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
        "description": "Mark one of your own requests solved; returns the status read back from Zendesk. A request you cannot solve yet, such as one no agent is assigned to, is refused rather than faked: say it is no longer needed with add_request_comment instead. Already solved is a no-op. Agents closing a ticket want update_ticket with status solved.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "request_id": {
              "description": "Request number; get_request must say you can mark it solved.",
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
