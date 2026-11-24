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
        "description": "Retrieve a Zendesk ticket by ID as it stands now: its details (subject, status, priority, assignee, tags, description), its live SLA state when an SLA policy applies, and optionally its comments and internal notes. Followers and email CCs are listed by name, which tells who an update reaches: followers are notified of every update, internal notes included, email CCs take part in the public correspondence, and being the requester makes someone neither; both lists are empty when the account's "CCs and followers" setting is off. The SLA block (per-metric stage and breach countdown) comes from a scoped search, since the ticket endpoint exposes no SLA, so it may be absent for a very high-volume requester or a just-updated ticket; when the operator turned SLA push on, it adds an Urgency line naming the most urgent running metric as BREACHED, CRITICAL or WARNING against the caller's alert thresholds. SLA targets and policy conditions: list_sla_policies. Who changed what, and when: get_ticket_history. A long thread, newest first and paged: list_ticket_comments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "include_comments": {
              "default": false,
              "description": "When true, appends the public comment and internal note thread; off by default to keep the payload small. The thread is one unpaginated block: comments past Zendesk's first page are absent and the rest is cut at the response character limit, so on a long thread use list_ticket_comments instead.",
              "type": "boolean",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket to fetch, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Read a ticket's change history — its audit trail — as an oldest-first timeline of who changed what and when. Each entry gives the actor (name and id), the channel and the field changes (status, priority, assignee, group, tags, custom fields) as before → after, with assignee, requester and group ids resolved to names. Comments show only as a public comment or internal note marker: read their bodies with list_ticket_comments (or get_ticket(include_comments=true) on a short thread). System notification events (trigger emails, collaborator/CC notifications, pushes) are dropped, and so is an update carrying nothing else; CC-list edits still show as changes. Use it to answer "what happened on this ticket?", "why was it reassigned?" or "when did it go to pending?", from the founding context onward.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page. Pages run oldest-first, so following the cursor moves toward the most recent changes.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Audits (ticket updates) per page. One audit can expand to several change lines, and audits carrying only system events are dropped, so a page can show fewer entries than this.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket whose change history to read, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Read a ticket's conversation — public replies and internal notes with their full bodies — one cursor-paginated page at a time, newest comment first. Each entry carries the comment id, the author's name, the timestamp, public or internal, and the ids of attached files. Prefer it over get_ticket(include_comments=true) on a long thread or when you only need the latest exchange: get_ticket appends the thread as one unpaginated block cut at the response character limit, which drops the most recent comments first. Who changed which field and when, without bodies: get_ticket_history. To download the attached files, pass their ids to get_ticket_attachments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page. It holds that response's sort_order: after changing sort_order, start again without it.",
              "type": "string",
            },
            "page_size": {
              "default": 20,
              "description": "Comments per page. The default is small on purpose: comment bodies are long and a bigger page risks being cut at the response character limit, so follow the cursor rather than raising it.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "sort_order": {
              "default": "desc",
              "description": "Chronological direction. "desc" starts at the latest reply and the cursor walks back in time; "asc" replays the conversation forward from the ticket's opening description, which under "desc" lands on the last page.",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket whose conversation to read, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Download the files attached to a ticket's comments so you can look at them: images come back embedded inline, other files as text references (file name, id, content type, size, download URL). To only learn which files a comment carries, list_ticket_comments is enough. Without attachment_ids, comments are read up to a page cap (10 pages of 100 by default; the response says when later ones were not scanned): files attached to comments come first, then images pasted into email bodies, once each (quoted replies repeat them), those under 4 KB (signature icons) as references only. An image over the per-image size limit or past the embedded-image cap comes back as a reference saying why; once the response size budget is spent, the remaining files are counted as omitted.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachment_ids": {
              "description": "Ids of the only files to fetch, as shown by list_ticket_comments or get_ticket(include_comments=true); they also reach files past the page cap. The ticket's comments are then read only until every id is found, and an id not on the ticket is named rather than listed. Omit to collect all the ticket's attachments.",
              "items": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer",
              },
              "maxItems": 25,
              "minItems": 1,
              "type": "array",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket whose attachments to fetch, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Search tickets using Zendesk query syntax, returning each result with its live SLA state (per-metric stage and breach countdown) when an SLA policy applies. The total count comes back too, so queue triage like "breaching today" needs no per-ticket fetch. When the operator turned SLA push on, each SLA block also carries an Urgency line (BREACHED, CRITICAL or WARNING) against the caller's alert thresholds. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
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
              "default": 25,
              "description": "Number of results per page for offset pagination (1-100). Pair with \`page\` to walk large result sets; the response header reports the total count and whether more pages remain.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "query": {
              "description": "Zendesk ticket search query: field filters like "status:open assignee:me" or "priority:urgent ticket_type:incident", combined with free text. A "type:ticket" scope is added for you, so filter the ticket kind with ticket_type:, never type: (which the API rejects here). "me" is a value of the user keywords only (assignee:, requester:, submitter:); group:me is read as your group when you belong to exactly one, else the call fails naming your groups, so use group:<id>.",
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
        "description": "Create a new Zendesk support ticket from a subject and a description, with optional requester, organization, priority, type, assignee, group, tags and custom fields; the new ticket is returned with its id. A requester or organization Zendesk did not keep is reported as not applied. After creation, use update_ticket to change status or assignee, add_public_comment or add_private_note to reply, and manage_tags to adjust tags.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "assignee_id": {
              "description": "User id of the agent to assign the ticket to, from search_users.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "custom_fields": {
              "description": "Custom field values as { id, value } pairs. Call list_ticket_fields first for the numeric field ids and, for dropdown/multiselect fields, the exact option values Zendesk accepts.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "description": "Numeric id of the ticket field to set, as listed by list_ticket_fields.",
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
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
              "description": "Body of the request; it becomes the ticket's first public comment, visible to the requester. Markdown is rendered (**bold**, lists, links): wrap code, identifiers containing _ or *, and <placeholders> in backticks to show them literally. Do not send HTML: its tags show as literal text.",
              "minLength": 1,
              "type": "string",
            },
            "group_id": {
              "description": "Id of the group to assign the ticket to, from your Zendesk admin settings.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "organization_id": {
              "description": "Id of the organization the ticket belongs to. It must be one the requester is a member of, or Zendesk rejects or ignores it; omit to let Zendesk use the requester's default organization.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
              "description": "User id of the person the ticket is on behalf of (end user or agent), from search_users; defaults to you.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "subject": {
              "description": "Short summary line shown in ticket lists and search results.",
              "minLength": 1,
              "type": "string",
            },
            "tags": {
              "description": "Tags for the new ticket, each a single lowercase token (join multi-word tags with an underscore).",
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
        "description": "Update an existing ticket's fields, followers and email CCs; only the fields you pass are changed, and the updated ticket is returned. Tags passed here replace the whole set: use manage_tags to add or remove single tags without overwriting the rest. Followers and email CCs are edited incrementally, and the response lists who is subscribed afterwards. Zendesk can skip a change without an error, so the response names it: a requester or organization it did not set as not applied, a follower or CC change as unconfirmed, and an organization it moved along with a new requester (organization_id not passed) as changed with the requester. This tool does not post replies: use add_public_comment or add_private_note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "assignee_id": {
              "description": "User id of the agent to assign the ticket to, from search_users.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "custom_fields": {
              "description": "Custom field values as { id, value } pairs. Call list_ticket_fields first for the numeric field ids and, for dropdown/multiselect fields, the exact option values Zendesk accepts.",
              "items": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "description": "Numeric id of the ticket field to set, as listed by list_ticket_fields.",
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
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
              "description": "End users or agents to add to or remove from the email CC list, as user ids: { add: [123], remove: [456] }. CCs receive the public correspondence, subject to your account's triggers. Ids only, not email addresses: resolve each person with search_users and confirm the match, since a name query can return several users. Zendesk caps a ticket at 48 email CCs, those already set included, so going over comes back as unconfirmed rather than as a validation error. An id in both lists is removed. Omit to leave CCs untouched.",
              "properties": {
                "add": {
                  "description": "User ids to CC on the ticket. Omit to only remove.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer",
                  },
                  "maxItems": 48,
                  "type": "array",
                },
                "remove": {
                  "description": "User ids to drop from the CC list. Omit to only add.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer",
                  },
                  "type": "array",
                },
              },
              "type": "object",
            },
            "followers": {
              "additionalProperties": false,
              "description": "Agents to add to or remove from the follower list, as user ids: { add: [123], remove: [456] }. Followers are notified of ticket updates, internal notes included. Ids only, not email addresses: resolve each person with search_users and confirm the match before writing, since a name query can return several users and removing the wrong id succeeds silently. Adding a current follower or removing a non-follower is a no-op; an id in both lists is removed. Omit to leave followers untouched.",
              "properties": {
                "add": {
                  "description": "User ids to start following the ticket. Omit to only remove.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer",
                  },
                  "type": "array",
                },
                "remove": {
                  "description": "User ids to stop following the ticket. Omit to only add.",
                  "items": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer",
                  },
                  "type": "array",
                },
              },
              "type": "object",
            },
            "group_id": {
              "description": "Id of the group to assign the ticket to.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "organization_id": {
              "description": "Id of the organization to move the ticket to. It must be one the requester is a member of, or Zendesk rejects or ignores it.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
              "description": "User id of the new requester (end user or agent), to fix who the ticket is on behalf of, from search_users. Zendesk may move the ticket to an organization of the new requester; pass organization_id to choose which.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
              "description": "New subject line, replacing the current one.",
              "type": "string",
            },
            "tags": {
              "description": "The full new tag set; tags left out are removed from the ticket.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket to update, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Add an internal note, hidden from the requester, to a ticket, optionally with file attachments uploaded through the Zendesk Uploads API. The note is appended to the ticket thread; use add_public_comment instead when the requester should see the reply.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to this note (base64-encoded content).",
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
              "description": "Note text, seen by agents only. Markdown is rendered (**bold**, lists, links): wrap code, identifiers containing _ or *, and <placeholders> in backticks to show them literally. Do not send HTML: its tags show as literal text.",
              "minLength": 1,
              "type": "string",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket to annotate, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Add a public comment, visible to the requester, to a ticket, optionally with file attachments uploaded through the Zendesk Uploads API. The comment is appended to the ticket thread and emails the requester; use add_private_note instead for an internal, agent-only note.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachments": {
              "description": "Files to attach to this comment (base64-encoded content).",
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
              "description": "Comment text sent to the requester and shown in the ticket. Markdown is rendered (**bold**, lists, links): wrap code, identifiers containing _ or *, and <placeholders> in backticks to show them literally. Do not send HTML: its tags show as literal text.",
              "minLength": 1,
              "type": "string",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket to reply on, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "List tickets with cursor-based pagination, in Zendesk's default order (ascending ticket id), not by recency: page with page_size and the returned cursor, not search_tickets' offset per_page. To find tickets by recency or any other criterion, use search_tickets with a query. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 25,
              "description": "Number of tickets returned per page.",
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
        "description": "Get all incident tickets linked to a problem ticket (Zendesk's problem/incident relationship), to gauge a problem's blast radius before resolving it. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "problem_id": {
              "description": "Numeric id of the ticket of type "problem" whose linked incidents to list, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "Add or remove tags on a ticket, leaving the others untouched. It reads the current tags, applies \`add\` and \`remove\`, and saves the merged set with duplicates collapsed; adding a present tag or removing an absent one is a no-op (idempotent). Returns the ticket's full tag set after the update. To overwrite the whole tag set, or to change tags alongside other fields, use update_ticket instead.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "add": {
              "description": "Tags to add. Zendesk tags are single tokens: a value containing spaces is stored as separate tags, so join multi-word tags with an underscore or dash (e.g. "urgent_request"). Omit to only remove.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "remove": {
              "description": "Tags to remove from the ticket. Omit to only add.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket whose tags to modify, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "List the configured SLA policies with their filter conditions and per-priority reply/resolution targets, to explain why a target applies to a ticket and reconstruct deadlines instead of hard-coding the policy matrix. Requires an admin token (or a custom role granted the SLA-management permission); a standard agent token gets 403 here, though it can still read live per-ticket SLA via get_ticket / search_tickets.",
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
        "description": "Read the elapsed-time metrics of up to 100 tickets in one call: first reply, first and full resolution, agent wait, requester wait and on-hold times in calendar and business minutes, reopen, reply, assignee-station and group-station counts, and the assigned, solved and latest-comment timestamps. Zendesk records them on every ticket, so they exist even where no SLA policy applies; they say how long things took, not how long is left (live breach countdown: get_ticket, search_tickets or list_sla_alerts). A duration still running reads "not reached yet"; a ticket the caller cannot see is reported as such rather than failing the call.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "ticket_ids": {
              "description": "Numeric ids of the tickets to read, from search_tickets, list_tickets or get_view_tickets; duplicates are read once and the answer keeps this order.",
              "items": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
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
        "description": "List the ticket field definitions configured on this Zendesk (system and custom), returning each field's id, type, whether it is active/required and, for dropdown and multiselect fields, the valid option values. Use it to map an intent such as "set severity to High" to the field id and option tag that create_ticket and update_ticket expect in custom_fields, instead of guessing. Cursor-paginated in Zendesk's default field order.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Number of field definitions returned per page.",
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
        "description": "List the agent's active Zendesk views — saved ticket queues such as "Unassigned tickets" or "Breaching today" — each with its ticket count, to see where the workload sits. Views are scoped per agent, so per-user auth returns exactly the queues this agent sees, with no shared key. Counts come from Zendesk's cache and can lag by up to about an hour ("(count updating)" while a fresh value is computed). To read the tickets inside a view, pass its title or id to get_view_tickets.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Number of views returned per page.",
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
        "description": "Read the tickets inside a Zendesk view, in the view's own sort order as the agent sees it in Zendesk: the natural way to work a named queue like "Unassigned tickets" or "Breaching today". Tickets carry the same fields as list_tickets, cursor-paginated, and each one an SLA policy covers shows its next SLA breach: the one metric closest to breaching, read from the view at no extra cost (every metric: get_ticket or search_tickets). Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 25,
              "description": "Number of tickets returned per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "sort_by": {
              "description": "Column to sort by instead of the view's own order: one of the view's columns (e.g. "status", "priority", "updated_at", or a custom field id), except "subject" and "submitter". Omit to keep the view's order.",
              "type": "string",
            },
            "sort_order": {
              "description": "Direction for sort_by, and only meaningful with it: "asc" (oldest/lowest first) or "desc" (newest/highest first). Omit to keep the view's direction.",
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
                  "maximum": 9007199254740991,
                  "type": "integer",
                },
              ],
              "description": "The view to read: its title as shown in Zendesk (e.g. "Unassigned tickets") or its numeric id, both listed by list_views. A title is matched case-insensitively against your active views; on no match the available titles come back instead of an error, so you can retry in one step.",
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
        "description": "List the active macros available to the authenticated user, offset-paginated: each macro's id, title, description, availability scope and ordered actions. A macro bundles a canned reply and/or field changes (status, priority, assignee, group, tags, custom fields) an agent applies to a ticket in one gesture. Per-user OAuth scopes the list to what the current user can see, with no shared admin key. Pass a macro id to preview_macro_diff to preview its effect on a ticket.",
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
        "description": "Preview the exact changes a macro would make to a specific ticket, as a before → after diff, WITHOUT saving anything. It reads the ticket and Zendesk's macro-apply preview, then returns only the fields the macro changes (status, priority, assignee, group, tags, custom fields) plus the canned reply with its public/internal flag; unchanged and identity fields are omitted. To apply it, follow up with update_ticket for the fields and add_public_comment or add_private_note for the reply: a deliberate two-step that keeps the mutation explicit and reviewable.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "macro_id": {
              "description": "Numeric id of the macro to preview, from list_macros.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "ticket_id": {
              "description": "Numeric id of the ticket to preview the macro against, from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
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
        "description": "List the SLA metrics breached or about to breach across a set of tickets, most urgent first. Pick the set with exactly one of scope, view or query; with none, the client may ask the user which, else the caller's own tickets are checked. Each running metric past its deadline, or nearer to it than its CRITICAL or WARNING threshold, is one line under BREACHED, CRITICAL or WARNING, soonest first: ticket id, metric, time left or overdue, subject, status, priority. Paused and achieved metrics never appear. Thresholds are per metric family (reply metrics vs the rest): the caller's own from configure_sla_alerts, else the server's. On a user's first call they are shown too, in the same form or in the reply. Never changes Zendesk; its one side effect is remembering, in this connector's own per-user state, that the user was shown the thresholds. Results are cached per user for about a minute; a set over a few hundred tickets is read in part. For one ticket's full SLA state use get_ticket; for elapsed times, get_ticket_metrics.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "critical": {
              "description": "Overrides, for this call only, every metric family's CRITICAL threshold. Alone, it raises a family's warning threshold to it where shorter; with warning, it must not exceed it. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "include_breached": {
              "default": true,
              "description": "List metrics already past their deadline (BREACHED); false shows only what can still be saved.",
              "type": "boolean",
            },
            "query": {
              "description": "A Zendesk ticket search query, e.g. "status<solved priority:urgent" or "organization:acme status<solved"; "type:ticket" is added automatically.",
              "minLength": 1,
              "type": "string",
            },
            "scope": {
              "description": "A named set of unsolved tickets: "mine" (assigned to you), "my_groups" (in any group you belong to) or "all" (the whole account, as far as your role sees it).",
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
                  "maximum": 9007199254740991,
                  "type": "integer",
                },
              ],
              "description": "A Zendesk view, by exact title (case-insensitive) or numeric id, as listed by list_views.",
            },
            "warning": {
              "description": "Overrides, for this call only, every metric family's WARNING threshold: the time left before a breach that counts as a warning. Alone, it lowers a family's critical threshold to it where longer. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "within": {
              "description": "Only list alerts breaching within this time from now; breached ones follow include_breached. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h. Omit to list everything inside the thresholds.",
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
        "description": "Search across tickets, users and organizations. Returns the total count and a page of results; a ticket description is cut to a 200-character excerpt (get_ticket returns it in full), and an organization result carries only its name and id (get_organization adds tags, domains and details).",
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
              "default": 25,
              "description": "Number of results per page for offset pagination (1-100). Pair with \`page\` to walk large result sets; the response header reports the total count and whether more pages remain.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "query": {
              "description": "Zendesk search query: type/status/role filters (e.g. "type:ticket status:open", "type:user role:agent") and free text; without a type filter it searches all three at once. "me" is a value of the user keywords only (assignee:, requester:, submitter:); group:me is read as your group when you belong to exactly one, else the call fails naming your groups, so use group:<id>.",
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
