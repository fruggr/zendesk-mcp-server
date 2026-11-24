import { expect, it } from 'vitest';
import { listExposedTools } from './list-exposed-tools';

it('exposes the tickets tool surface unchanged', async () => {
  expect(await listExposedTools('tickets')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Get a ticket as it stands now, with its live SLA state and who an update reaches. Followers (notified of updates, internal notes included) and email CCs (public correspondence only) are listed by name; the requester is neither, and both lists are empty when "CCs and followers" is off. The SLA block (per-metric stage and countdown) comes from a search, so it can be missing for a very high-volume requester or a just-updated ticket; with SLA push on it adds an Urgency line (BREACHED, CRITICAL or WARNING) against your thresholds. Policies: list_sla_policies. Change history: get_ticket_history. Long thread: list_ticket_comments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "include_comments": {
              "default": false,
              "description": "Append the comments and internal notes as one block: only Zendesk's first page, cut at the response limit. On a long thread use list_ticket_comments.",
              "type": "boolean",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
          ],
          "type": "object",
        },
        "name": "get_ticket",
        "title": "Get Zendesk Ticket",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Read a ticket's audit trail: who changed which field and when, oldest first. Each entry gives the actor (name and id), the channel and each field change as before → after, user and group ids resolved to names. Comments show only as public or internal markers (bodies: list_ticket_comments). Notification events (trigger emails, CC notifications, pushes) are dropped; CC-list edits still show. Use it for "why was it reassigned?" or "when did it go to pending?".",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; it moves toward the latest changes.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Audits (ticket updates) per page; one can give several lines, and audits with only system events are dropped, so a page can show fewer.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
          ],
          "type": "object",
        },
        "name": "get_ticket_history",
        "title": "Get Zendesk Ticket History",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Read a ticket's replies and internal notes in full, newest first, a page at a time. Each entry has the comment id, author, time, public or internal, and attachment ids (download: get_ticket_attachments). Prefer it to get_ticket(include_comments=true) on a long thread, whose cut drops the newest comments. Field changes: get_ticket_history.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; it keeps that sort_order, so drop it when changing sort_order.",
              "type": "string",
            },
            "page_size": {
              "default": 20,
              "description": "Comments per page; bodies are long, so follow the cursor rather than raise it past the response limit.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "sort_order": {
              "default": "desc",
              "description": ""desc" walks back from the latest reply; "asc" reads forward from the opening description.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
          ],
          "type": "object",
        },
        "name": "list_ticket_comments",
        "title": "List Zendesk Ticket Comments",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Download a ticket's attached files to look at them: images inline, other files as references (name, id, type, size, download URL). To only see which files a comment has, use list_ticket_comments. Without attachment_ids it scans up to 10 pages of 100 comments (and says if it stopped): comment files first, then images pasted into email bodies once each, those under 4 KB (signature icons) as references only. An oversized image or one past the embed cap comes back as a reference saying why; past the response budget, the rest are counted as omitted.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachment_ids": {
              "description": "Fetch only these files (ids from list_ticket_comments), even past the page cap; comments are read until all are found. After a full scan an id not on the ticket is named, not fetched; if the scan ends early (page cap, or a page without cursor), a missing id is fetched directly and flagged unchecked.",
              "items": {
                "exclusiveMinimum": 0,
                "type": "integer",
              },
              "maxItems": 25,
              "minItems": 1,
              "type": "array",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
          ],
          "type": "object",
        },
        "name": "get_ticket_attachments",
        "title": "Get Zendesk Ticket Attachments",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Search tickets with Zendesk query syntax; each result carries its live SLA state, and the total count comes back. With SLA push on, each SLA block adds an Urgency line (BREACHED, CRITICAL or WARNING) against your thresholds. Descriptions are cut to 200 characters (full text: get_ticket).",
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
              "default": 25,
              "description": "Results per page; the header gives the total and whether more pages remain.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "query": {
              "description": "Field filters like "status:open assignee:me" or "priority:urgent ticket_type:incident", plus free text. type:ticket is added for you: filter the kind with ticket_type:, never type:. "me" works only with assignee:, requester:, submitter:; group:me works if you are in exactly one group (else the error names them), otherwise use group:<id>.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "query",
          ],
          "type": "object",
        },
        "name": "search_tickets",
        "title": "Search Zendesk Tickets",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Create a ticket from a subject and a description; the new ticket is returned with its id. A requester or organization Zendesk did not keep is reported as not applied. Afterwards: update_ticket for status or assignee, add_public_comment or add_private_note to reply, manage_tags for tags.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "assignee_id": {
              "description": "User id of the agent to assign the ticket to, from search_users.",
              "type": "integer",
            },
            "custom_fields": {
              "description": "{ id, value } pairs; field ids and accepted dropdown/multiselect values come from list_ticket_fields.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "description": "Numeric id of the ticket field to set, as listed by list_ticket_fields.",
                    "type": "integer",
                  },
                  "value": {
                    "description": "Value typed after the field: the option tag (a string) for a dropdown, an array of option tags for a multiselect, true or false for a checkbox, text or a number for a text or numeric field. For any other type (a date, a lookup), follow the type list_ticket_fields reports; it also lists each dropdown's accepted tags.",
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
            "description": {
              "description": "The ticket's first public comment, seen by the requester. Markdown, not HTML (tags show as literal text); put code, identifiers with _ or *, and <placeholders> in backticks.",
              "minLength": 1,
              "type": "string",
            },
            "group_id": {
              "description": "Id of the group to assign the ticket to.",
              "type": "integer",
            },
            "organization_id": {
              "description": "Organization of the ticket; it must be one of the requester's, or Zendesk rejects or ignores it. Omit for the requester's default.",
              "type": "integer",
            },
            "priority": {
              "description": "Priority level of the ticket.",
              "enum": [
                "urgent",
                "high",
                "normal",
                "low",
              ],
              "type": "string",
            },
            "requester_id": {
              "description": "User the ticket is on behalf of (end user or agent), from search_users; defaults to you.",
              "type": "integer",
            },
            "subject": {
              "description": "Summary line shown in ticket lists and search results.",
              "minLength": 1,
              "type": "string",
            },
            "tags": {
              "description": "Single lowercase tokens; join words with an underscore.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "type": {
              "description": "Kind of ticket, as Zendesk classifies it.",
              "enum": [
                "problem",
                "incident",
                "question",
                "task",
              ],
              "type": "string",
            },
          },
          "required": [
            "subject",
            "description",
          ],
          "type": "object",
        },
        "name": "create_ticket",
        "title": "Create Zendesk Ticket",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Change a ticket's fields, followers or email CCs; only what you pass changes, and the updated ticket is returned. Tags here replace the whole set (single tags: manage_tags). Zendesk can skip a change silently, so the response says when a requester or organization was not applied, a follower or CC change is unconfirmed, or the organization moved with a new requester. It posts no reply: use add_public_comment or add_private_note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "assignee_id": {
              "description": "User id of the agent to assign the ticket to, from search_users.",
              "type": "integer",
            },
            "custom_fields": {
              "description": "{ id, value } pairs; field ids and accepted dropdown/multiselect values come from list_ticket_fields.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "description": "Numeric id of the ticket field to set, as listed by list_ticket_fields.",
                    "type": "integer",
                  },
                  "value": {
                    "description": "Value typed after the field: the option tag (a string) for a dropdown, an array of option tags for a multiselect, true or false for a checkbox, text or a number for a text or numeric field. For any other type (a date, a lookup), follow the type list_ticket_fields reports; it also lists each dropdown's accepted tags.",
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
            "email_ccs": {
              "additionalProperties": false,
              "description": "Users to add or remove, as user ids: { add: [123], remove: [456] }; CCs get the public correspondence, subject to your triggers. Resolve each person with search_users and confirm the match. Zendesk caps a ticket at 48 CCs, existing ones included: going over comes back unconfirmed, not as an error. An id in both lists is removed.",
              "properties": {
                "add": {
                  "description": "User ids to CC on the ticket. Omit to only remove.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "type": "integer",
                  },
                  "maxItems": 48,
                  "type": "array",
                },
                "remove": {
                  "description": "User ids to drop from the CC list. Omit to only add.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "type": "integer",
                  },
                  "type": "array",
                },
              },
              "type": "object",
            },
            "followers": {
              "additionalProperties": false,
              "description": "Agents to add or remove, as user ids: { add: [123], remove: [456] }; followers are notified of updates, internal notes included. Resolve each person with search_users and confirm the match: removing a wrong id succeeds silently. A change already in place is a no-op; an id in both lists is removed.",
              "properties": {
                "add": {
                  "description": "User ids to start following the ticket. Omit to only remove.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "type": "integer",
                  },
                  "type": "array",
                },
                "remove": {
                  "description": "User ids to stop following the ticket. Omit to only add.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "type": "integer",
                  },
                  "type": "array",
                },
              },
              "type": "object",
            },
            "group_id": {
              "description": "Id of the group to assign the ticket to.",
              "type": "integer",
            },
            "organization_id": {
              "description": "Organization to move the ticket to; it must be one of the requester's, or Zendesk rejects or ignores it.",
              "type": "integer",
            },
            "priority": {
              "description": "Priority level of the ticket.",
              "enum": [
                "urgent",
                "high",
                "normal",
                "low",
              ],
              "type": "string",
            },
            "requester_id": {
              "description": "New requester (end user or agent), from search_users. Zendesk may move the ticket to one of their organizations; pass organization_id to choose.",
              "type": "integer",
            },
            "status": {
              "description": "New status of the ticket.",
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
            "subject": {
              "description": "Replacement subject line.",
              "type": "string",
            },
            "tags": {
              "description": "The full new tag set; tags left out are removed.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
            "type": {
              "description": "Kind of ticket, as Zendesk classifies it.",
              "enum": [
                "problem",
                "incident",
                "question",
                "task",
              ],
              "type": "string",
            },
          },
          "required": [
            "ticket_id",
          ],
          "type": "object",
        },
        "name": "update_ticket",
        "title": "Update Zendesk Ticket",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Add an internal note, hidden from the requester, to a ticket, optionally with files. It is appended to the thread; for a reply the requester sees, use add_public_comment.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to the note.",
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
              "description": "Note text, for agents only. Markdown, not HTML (tags show as literal text); put code, identifiers with _ or *, and <placeholders> in backticks.",
              "minLength": 1,
              "type": "string",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
            "body",
          ],
          "type": "object",
        },
        "name": "add_private_note",
        "title": "Add Private Note",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": false,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Post a public reply on a ticket, optionally with files. It is appended to the thread and emails the requester; for an agent-only note, use add_private_note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to the reply.",
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
              "description": "Reply text, sent to the requester. Markdown, not HTML (tags show as literal text); put code, identifiers with _ or *, and <placeholders> in backticks.",
              "minLength": 1,
              "type": "string",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
            "body",
          ],
          "type": "object",
        },
        "name": "add_public_comment",
        "title": "Add Public Comment",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List tickets by ascending id, cursor-paginated, not by recency. To filter or sort, use search_tickets. Descriptions are cut to 200 characters (full text: get_ticket).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 25,
              "description": "Tickets per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "list_tickets",
        "title": "List Zendesk Tickets",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the incidents linked to a problem ticket, to gauge its impact before solving it. Descriptions are cut to 200 characters (full text: get_ticket).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "problem_id": {
              "description": "Id of a ticket of type "problem", from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "problem_id",
          ],
          "type": "object",
        },
        "name": "get_linked_incidents",
        "title": "Get Linked Incidents",
      },
      {
        "annotations": {
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Add or remove single tags on a ticket, keeping the others; returns the ticket's full tag set. Adding a present tag or removing an absent one is a no-op (idempotent). To replace the whole set, or change tags with other fields, use update_ticket.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "add": {
              "description": "Tags to add; a value with spaces becomes several tags, so join words with _ or - (e.g. "urgent_request").",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "remove": {
              "description": "Tags to take off the ticket.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
          ],
          "type": "object",
        },
        "name": "manage_tags",
        "title": "Manage Ticket Tags",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List SLA policies with their conditions and per-priority reply and resolution targets, to explain which target applies to a ticket. Needs an admin or a role with the SLA-management permission; other agents get 403 but still see live SLA via get_ticket / search_tickets.",
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
          },
          "type": "object",
        },
        "name": "list_sla_policies",
        "title": "List SLA Policies",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Read elapsed-time metrics for up to 100 tickets: reply, resolution, wait and on-hold times. Times come in calendar and business minutes, with reopen, reply and station counts and key timestamps; they exist without any SLA policy and say how long things took, not time left (countdown: get_ticket, search_tickets, list_sla_alerts). A running duration reads "not reached yet"; a ticket you cannot see is reported, not fatal.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "ticket_ids": {
              "description": "Ticket ids, from search_tickets, list_tickets or get_view_tickets; duplicates are read once, order is kept.",
              "items": {
                "exclusiveMinimum": 0,
                "type": "integer",
              },
              "maxItems": 100,
              "minItems": 1,
              "type": "array",
            },
          },
          "required": [
            "ticket_ids",
          ],
          "type": "object",
        },
        "name": "get_ticket_metrics",
        "title": "Get Ticket Metrics",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List ticket fields (system and custom) with id, type, active and required flags, and dropdown/multiselect options. Use it to turn "set severity to High" into the field id and option tag custom_fields expects in create_ticket and update_ticket.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Field definitions per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "list_ticket_fields",
        "title": "List Ticket Fields",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List your active views (saved ticket queues) with their ticket counts. Counts are cached and can lag up to about an hour ("(count updating)" while refreshed). To read a view's tickets, pass its title or id to get_view_tickets.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Views per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "list_views",
        "title": "List Zendesk Views",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Read a view's tickets in the view's own order, as the agent sees it in Zendesk. Same fields as list_tickets, cursor-paginated; each SLA-covered ticket shows its next breach (every metric: get_ticket or search_tickets). Descriptions are cut to 200 characters (full text: get_ticket).",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Cursor from the previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 25,
              "description": "Tickets per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "sort_by": {
              "description": "One of the view's columns to sort by instead (e.g. "status", "priority", "updated_at", a custom field id), except "subject" and "submitter".",
              "type": "string",
            },
            "sort_order": {
              "description": "Direction for sort_by only: "asc" (oldest/lowest first) or "desc".",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "view": {
              "anyOf": [
                {
                  "minLength": 1,
                  "type": "string",
                },
                {
                  "exclusiveMinimum": 0,
                  "type": "integer",
                },
              ],
              "description": "View title (case-insensitive) or id, from list_views; on no match the available titles come back so you can retry.",
            },
          },
          "required": [
            "view",
          ],
          "type": "object",
        },
        "name": "get_view_tickets",
        "title": "Get Tickets In A View",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List the active macros you can use: id, title, description, scope and ordered actions. A macro applies a canned reply and/or field changes to a ticket in one step; preview its effect with preview_macro_diff.",
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
          },
          "type": "object",
        },
        "name": "list_macros",
        "title": "List Zendesk Macros",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": false,
        },
        "description": "Preview what a macro would change on a ticket, as a before → after diff, without saving. Returns only the changed fields and the canned reply with its public/internal flag. To apply it, call update_ticket for the fields and add_public_comment or add_private_note for the reply.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "macro_id": {
              "description": "Macro id, from list_macros.",
              "type": "integer",
            },
            "ticket_id": {
              "description": "Ticket id, from search_tickets or list_tickets.",
              "type": "integer",
            },
          },
          "required": [
            "ticket_id",
            "macro_id",
          ],
          "type": "object",
        },
        "name": "preview_macro_diff",
        "title": "Preview a Macro Diff on a Ticket",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List SLA metrics breached or about to breach on a set of tickets, most urgent first. Pick the set with exactly one of scope, view or query; with none, the client may ask the user, else your own tickets are checked. Each running metric past its deadline or inside its CRITICAL or WARNING threshold is one line under that heading, soonest first: ticket id, metric, time left or overdue, subject, status, priority; paused and achieved metrics never appear. Thresholds are per family (reply metrics vs the rest), yours from configure_sla_alerts or else the server's, and are shown on your first call. Never changes Zendesk; it only remembers, per user, that you were shown the thresholds. Cached about a minute per user; a set over a few hundred tickets is read in part. One ticket's full SLA: get_ticket; elapsed times: get_ticket_metrics.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "critical": {
              "description": "This call's CRITICAL threshold for every family; alone, it raises a shorter warning threshold to it, and with warning it must not exceed it. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "include_breached": {
              "default": true,
              "description": "Include metrics already past their deadline; false shows only what can still be saved.",
              "type": "boolean",
            },
            "query": {
              "description": "Ticket search query, e.g. "status<solved priority:urgent"; type:ticket is added.",
              "minLength": 1,
              "type": "string",
            },
            "scope": {
              "description": "Unsolved tickets: "mine" (assigned to you), "my_groups" (in your groups) or "all" (all your role sees).",
              "enum": [
                "mine",
                "my_groups",
                "all",
              ],
              "type": "string",
            },
            "view": {
              "anyOf": [
                {
                  "minLength": 1,
                  "type": "string",
                },
                {
                  "exclusiveMinimum": 0,
                  "type": "integer",
                },
              ],
              "description": "View title (case-insensitive) or id, from list_views.",
            },
            "warning": {
              "description": "This call's WARNING threshold (time left that counts as a warning) for every family; alone, it lowers a longer critical threshold to it. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "within": {
              "description": "Only alerts breaching within this time; breached ones follow include_breached. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
          },
          "type": "object",
        },
        "name": "list_sla_alerts",
        "title": "List SLA Alerts",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Search tickets, users and organizations at once; returns the total count and a page of results. Ticket descriptions are cut to 200 characters (full text: get_ticket); organizations show only name and id (more: get_organization).",
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
              "default": 25,
              "description": "Results per page; the header gives the total and whether more pages remain.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "query": {
              "description": "Filters like "type:ticket status:open" or "type:user role:agent", plus free text; no type filter searches all three. "me" works only with assignee:, requester:, submitter:; group:me works if you are in exactly one group (else the error names them), otherwise use group:<id>.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "query",
          ],
          "type": "object",
        },
        "name": "search",
        "title": "Zendesk Unified Search",
      },
    ]
  `);
});
