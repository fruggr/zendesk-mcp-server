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
        "description": "Retrieve a Zendesk ticket by ID, including its live SLA state (per-metric stage and breach countdown) when an SLA policy applies, plus its comments if requested. Returns ticket details (subject, status, priority, assignee, tags, description) and optionally all comments/internal notes. It also lists the followers and email CCs on the ticket, resolved to names, which is how you tell who a ticket update actually reaches: followers are notified of updates including internal notes, email CCs take part in the public correspondence, and being the requester makes someone neither. Both lists come back empty on an account where the "CCs and followers" setting is not enabled in Zendesk. The per-ticket Show endpoint exposes no SLA, so the SLA block is resolved via a scoped search and may be absent for a very high-volume requester or a just-updated ticket; SLA targets and policy conditions live in list_sla_policies. When the operator turned SLA push on, the SLA block also carries an Urgency line naming the most urgent running metric as BREACHED, CRITICAL or WARNING against the caller's alert thresholds. This returns the ticket as it stands now; for the history of changes behind that state (who changed what, and when), use get_ticket_history. The comment thread is appended in one block — the first page of comments Zendesk returns, cut past the response character limit — so on a long ticket read it with list_ticket_comments, which pages the comments and returns the newest first.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "include_comments": {
              "default": false,
              "description": "When true, appends the full public comment and internal note thread to the response. Defaults to false to keep the payload small; enable it when you need the conversation, not just the ticket fields. On a long thread prefer list_ticket_comments — this flag appends one unpaginated block, so comments past Zendesk's first page are absent and the rest is cut at the response character limit.",
              "type": "boolean",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket to fetch. Obtain it from search_tickets or list_tickets.",
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
        "description": "Read a ticket's change history — its audit trail — as a chronological, oldest-first timeline of who changed what and when. Each entry shows the actor (name and id) and the channel, then the field changes that update carried (status, priority, assignee, group, tags, custom fields) as before → after, with assignee/requester/group ids resolved to names. Comments appear as one-line presence markers (public comment vs internal note added), not their text — fetch the bodies with list_ticket_comments (or get_ticket(include_comments=true) for a short thread). Purely system-generated notification events (trigger emails, collaborator/CC notifications, pushes) are filtered out — note this filters notification delivery, not CC-list edits, which are shown as changes — and an update carrying only such events produces no entry, so the timeline stays a readable narrative rather than a raw log. Use it to answer "what happened on this ticket?", "why was it reassigned?" or "when did it go to pending?", reading oldest-first so the founding context is not missed. Read-only, and cursor-paginated oldest-first: pass the returned cursor to page a long-lived ticket toward its most recent changes.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page. The timeline is ordered oldest-first, so paging forward moves toward the most recent changes.",
              "type": "string",
            },
            "page_size": {
              "default": 100,
              "description": "Audits (ticket updates) per page (1-100, default 100). Each audit is one update to the ticket and may expand to several change lines; audits carrying only system events are dropped, so a page can render fewer entries than this.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket whose change history to read. Obtain it from search_tickets or list_tickets.",
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
        "description": "Read a ticket's conversation — public replies and internal notes with their full bodies — one cursor-paginated page at a time, newest comment first. Each entry carries the comment id, the author resolved to a name, the timestamp, whether it is public or internal, and the ids of any attached files. Prefer this over get_ticket(include_comments=true) whenever a thread is long or you only need the latest exchange: get_ticket appends the thread as one unpaginated block and cuts it past the response character limit, which drops the most recent comments first. Keep sort_order "desc" (the default) to read the latest reply first and follow the returned cursor to walk further back in time, or pass "asc" to replay the conversation forward from the ticket's opening description. For who changed which field and when — without comment bodies — use get_ticket_history; to download the attached files themselves, pass the attachment ids shown here to get_ticket_attachments.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "description": "Pagination cursor from a previous response; omit for the first page. Zendesk issues it for the ordering that response used, so after changing sort_order drop the cursor and start again from the first page.",
              "type": "string",
            },
            "page_size": {
              "default": 20,
              "description": "Comments per page (1-100, default 20). The default is deliberately small because comment bodies are long and a bigger page risks being cut short by the response character limit; follow the returned cursor rather than raising it.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "sort_order": {
              "default": "desc",
              "description": "Chronological direction of the page. "desc" (the default) starts at the most recent comment and walks backward in time, which is what you want to see the latest reply; "asc" replays the conversation forward, starting from the ticket's opening description — that first comment therefore lands on the last page under "desc".",
              "enum": [
                "asc",
                "desc",
              ],
              "type": "string",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket whose conversation to read. Obtain it from search_tickets or list_tickets.",
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
        "description": "Download the files attached to a ticket's comments so you can look at them: images come back embedded inline, other files as text references (file name, id, content type, size, download URL). Use it when you need what an attachment contains; to learn which files a comment carries, list_ticket_comments already shows their ids. Pass those ids as attachment_ids to fetch only them, or omit it to retrieve every attachment on the ticket. An image over the per-image size limit or past the embedded-image cap comes back as a reference saying why, and once the response size budget is spent the remaining files are counted as omitted.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attachment_ids": {
              "description": "Attachment IDs to fetch directly (e.g. extracted from a previous list_ticket_comments or get_ticket(include_comments=true) call). When provided, skips the comments fetch entirely. When omitted, all attachments of the ticket are returned.",
              "items": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket whose attachments to fetch. Obtain it from search_tickets or list_tickets.",
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
        "description": "Search tickets using Zendesk query syntax, returning each result with its live SLA state (per-metric stage and breach countdown) when an SLA policy applies. Examples: "status:open assignee:me", "priority:urgent ticket_type:incident". Returns total count, so queue triage like "breaching today" works without a per-ticket fetch. When the operator turned SLA push on, each SLA block also carries an Urgency line (BREACHED, CRITICAL or WARNING) against the caller's alert thresholds. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
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
              "description": "Zendesk ticket search query — field filters like "status:open", "assignee:me", "priority:urgent ticket_type:incident", combined with free text. A "type:ticket" scope is added automatically, so filter the ticket kind with ticket_type: (e.g. ticket_type:incident), never type: (which the API rejects here). "me" is a value of the user keywords only (assignee:, requester:, submitter:); group:me is read as your group when you belong to exactly one, else the call fails naming your groups, so use group:<id>.",
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
        "description": "Create a new Zendesk support ticket with subject, description, and optional priority/type/assignee/tags. The description becomes the first public comment of the ticket, and the new ticket id is returned. After creation, use update_ticket to change status or assignee, add_public_comment or add_private_note to reply, and manage_tags to adjust tags. Look up valid assignee_id / group_id and custom field ids via search_users or your Zendesk admin settings. Discover custom field ids and their accepted option values with list_ticket_fields.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "assignee_id": {
              "description": "User id of the agent to assign the ticket to.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "custom_fields": {
              "description": "Custom field values as { id, value } pairs (field ids come from your Zendesk admin settings). Call list_ticket_fields first to discover the numeric field ids and, for dropdown/multiselect fields, the exact option values Zendesk accepts.",
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
                    "description": "Value typed after the field: the option tag (a string) for a dropdown, an array of option tags for a multiselect, true or false for a checkbox, text or a number otherwise. list_ticket_fields lists each dropdown's accepted tags.",
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
              "description": "Ticket description — the body of the request. It becomes the ticket's first public comment (visible to the requester).",
              "minLength": 1,
              "type": "string",
            },
            "group_id": {
              "description": "Id of the group to assign the ticket to.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "priority": {
              "description": "Ticket priority. One of urgent, high, normal, low.",
              "enum": [
                "urgent",
                "high",
                "normal",
                "low",
              ],
              "type": "string",
            },
            "subject": {
              "description": "Ticket subject — the short summary line shown in ticket lists and search results.",
              "minLength": 1,
              "type": "string",
            },
            "tags": {
              "description": "Tags to set on the new ticket. Each tag is a single lowercase token (join multi-word tags with an underscore). Use manage_tags later to add or remove individual tags.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "type": {
              "description": "Ticket type. One of problem, incident, question, task.",
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
        "description": "Update an existing ticket (status, priority, type, assignee, group, subject, tags, custom fields, followers, email CCs). Only the fields you pass are changed, and the updated ticket is returned. Followers and email CCs are incremental instead of replacing: pass { add, remove } lists of user ids, and the response reports who is subscribed afterwards. Zendesk applies those two silently, so a requested change it did not apply comes back listed as unconfirmed rather than raised as an error. Setting tags here replaces the whole tag set — use manage_tags to add or remove individual tags without overwriting the rest. This tool does not post replies: use add_public_comment or add_private_note for that. Find the ticket id via search_tickets or list_tickets.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "assignee_id": {
              "description": "User id of the agent to assign the ticket to.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "custom_fields": {
              "description": "Custom field values as { id, value } pairs (field ids come from your Zendesk admin settings). Call list_ticket_fields first to discover the numeric field ids and, for dropdown/multiselect fields, the exact option values Zendesk accepts.",
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
                    "description": "Value typed after the field: the option tag (a string) for a dropdown, an array of option tags for a multiselect, true or false for a checkbox, text or a number otherwise. list_ticket_fields lists each dropdown's accepted tags.",
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
              "description": "End users or agents to add to or remove from the ticket's email CC list, as numeric user ids: { add: [123], remove: [456] }. CCs receive the ticket's public correspondence, subject to your account's triggers. Numeric ids only, no email addresses: resolve the person with search_users first and confirm the match, because a name query can return several users. Zendesk caps a ticket at 48 email CCs and this tool cannot know how many are already set, so going over shows up as an unconfirmed entry in the response rather than a validation error. An id listed in both add and remove is removed. Omit to leave CCs untouched.",
              "properties": {
                "add": {
                  "description": "User ids to CC on the ticket, at most 48. Omit to only remove.",
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
              "description": "Agents to add to or remove from the ticket's follower list, as numeric user ids: { add: [123], remove: [456] }. Followers are notified of ticket updates, internal notes included, so this controls who hears about the ticket. Numeric ids only, no email addresses: resolve the person with search_users first and confirm the match before writing, because a name query can return several users and removing the wrong id succeeds silently. Adding someone already following, or removing someone who is not, is a no-op. An id listed in both add and remove is removed. Omit to leave followers untouched.",
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
            "priority": {
              "description": "Ticket priority. One of urgent, high, normal, low.",
              "enum": [
                "urgent",
                "high",
                "normal",
                "low",
              ],
              "type": "string",
            },
            "status": {
              "description": "New ticket status. One of new, open, pending, hold, solved, closed.",
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
              "description": "New subject line for the ticket; replaces the current subject when provided.",
              "type": "string",
            },
            "tags": {
              "description": "Replaces the full tag set on the ticket. Use manage_tags for incremental add/remove.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket to update. Obtain it from search_tickets or list_tickets.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "type": {
              "description": "Ticket type. One of problem, incident, question, task.",
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
        "description": "Add an internal note (not visible to requester) to a ticket, optionally with file attachments (uploaded via the Zendesk Uploads API and carried on the note). The note is appended to the ticket thread; use add_public_comment instead when the reply should be visible to the requester.",
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
              "description": "Note text (internal, agent-only). Plain text or HTML; not shown to the requester.",
              "minLength": 1,
              "type": "string",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket to annotate. Obtain it from search_tickets or list_tickets.",
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
        "description": "Add a public comment (visible to requester) to a ticket, optionally with file attachments (uploaded via the Zendesk Uploads API and carried on the comment). The comment is appended to the ticket thread and emails the requester; use add_private_note instead for an internal, agent-only note.",
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
              "description": "Comment text sent to the requester. Plain text or HTML; visible in the ticket.",
              "minLength": 1,
              "type": "string",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket to reply on. Obtain it from search_tickets or list_tickets.",
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
        "description": "List tickets with cursor-based pagination, in Zendesk's default order (ascending ticket id), not by recency. Page size is controlled by page_size (not per_page, which is the offset-based parameter used by search_tickets); paginate by passing the returned cursor. To find tickets by recency or any other criterion, use search_tickets with a query. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
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
              "description": "Tickets per page (1-100, default 25).",
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
        "description": "Get all incident tickets linked to a problem ticket. Returns the list of incidents that reference the given problem (Zendesk problem/incident relationship); useful to gauge a problem's blast radius before resolving it. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "problem_id": {
              "description": "Problem ticket ID — the numeric id of the ticket of type "problem" whose linked incidents to list. Obtain it from search_tickets or list_tickets.",
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
        "description": "Add or remove tags on a ticket. Performs an incremental read-modify-write: it fetches the ticket's current tags, adds those in \`add\` and deletes those in \`remove\`, then saves the merged set — tags you don't list are left untouched and duplicates are collapsed. Adding a tag already present, or removing one that is absent, is a no-op (idempotent). Returns the ticket's full tag set after the update. Use this for incremental tag edits; to overwrite the entire tag set at once, or to change tags alongside other fields, use update_ticket instead. Find the ticket id via search_tickets or list_tickets.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "add": {
              "description": "Tags to add. Zendesk tags are single tokens: a value containing spaces is stored as separate tags rather than one tag, so join multi-word tags yourself with an underscore or dash (e.g. "urgent_request"). Adding a tag already on the ticket is a no-op. Omit to only remove.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "remove": {
              "description": "Tags to remove. Removing a tag that is not present is a no-op; tags not listed here stay in place. Omit to only add.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket whose tags to modify. Obtain it from search_tickets or list_tickets.",
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
        "description": "List the configured SLA policies with their filter conditions and per-priority reply/resolution targets. Use this to explain why a given target applies to a ticket and to reconstruct deadlines deterministically instead of hard-coding the policy matrix. Requires an admin token (or a custom role granted the SLA-management permission); a standard agent token gets 403 here, though it can still read live per-ticket SLA via get_ticket / search_tickets.",
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
        "description": "Read the elapsed-time metrics (reply, resolution, wait and on-hold times, reopens, replies) of up to 100 tickets in one call. Each ticket gets first reply, first and full resolution, agent wait, requester wait and on-hold times in calendar and business minutes, plus reopen, reply, assignee-station and group-station counts and the key timestamps (assigned, solved, latest comment). These are facts Zendesk records on every ticket, so they are available even on tickets no SLA policy covers; they say how long things took, not how long is left — for the live breach countdown use get_ticket, search_tickets or list_sla_alerts. A duration still running reads "not reached yet". Read-only; tickets the caller cannot see are reported as such rather than failing the call.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "ticket_ids": {
              "description": "Ticket IDs to read metrics for, 1 to 100 numeric ids (duplicates are read once), as returned by search_tickets, list_tickets or get_view_tickets. The answer keeps this order.",
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
        "description": "List the ticket field definitions configured on this Zendesk (both system fields and custom fields), returning each field's id, type, whether it is active/required, and — for dropdown and multiselect fields — the valid option values. Use this to discover the numeric field ids and accepted option tags that create_ticket and update_ticket expect in their custom_fields argument, so a natural-language intent ("set severity to High") maps to the right id and a value Zendesk will accept instead of a blind guess. Read-only reference lookup; cursor-paginated in Zendesk's default field order.",
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
              "description": "Ticket field definitions per page (1-100, default 100).",
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
        "description": "List the agent's active Zendesk views — the saved ticket queues ("Unassigned tickets", "My open tickets", "Breaching today") the agent sees in the Zendesk UI — each with its current ticket count so you can tell at a glance where the workload sits. Views are per-agent scoped, so per-user auth returns exactly the queues this agent can see, with no shared key. Counts come from Zendesk's cache and can lag by up to about an hour (shown as "(count updating)" while a fresh value is still being computed); pass a view's title or id to get_view_tickets to read the tickets inside it.",
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
              "description": "Views per page (1-100, default 100).",
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
        "description": "Read the tickets inside a Zendesk view, in the view's own configured sort order — the same order the agent sees in the Zendesk UI — which is the natural way to work a named queue like "Unassigned tickets" or "Breaching today". Accepts the view by title or by numeric id (discover both with list_views); a title is matched case-insensitively against the agent's active views, and on no match the available titles are returned so you can retry in one step. Tickets come back with the same fields as list_tickets and are cursor-paginated. Each ticket an SLA policy covers also shows its next SLA breach: only the one metric closest to breaching, read from the view itself at no extra cost (use get_ticket or search_tickets for every metric). sort_by/sort_order override the view's order when you want a different cut. Each ticket's description is cut to a 200-character excerpt; get_ticket returns it in full.",
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
              "description": "Tickets per page (1-100, default 25).",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
            "sort_by": {
              "description": "Optional column to sort by, overriding the view's own sort. Must be one of the view's columns (e.g. "status", "priority", "updated_at", or a custom field id); "subject" and "submitter" are not sortable. Omit to keep the view's configured order.",
              "type": "string",
            },
            "sort_order": {
              "description": "Sort direction applied to sort_by: "asc" (oldest/lowest first) or "desc" (newest/highest first). Only meaningful together with sort_by; omit to keep the view's configured direction.",
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
              "description": "The view to read: its exact title as shown in Zendesk (e.g. "Unassigned tickets") or its numeric id from list_views. A title is matched case-insensitively against your active views; on no match the tool returns the available titles instead of erroring, so you can retry with a correct one.",
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
        "description": "List the active macros available to the authenticated user. A macro bundles a canned reply and/or a set of field changes (status, priority, assignee, group, tags, custom fields) an agent applies to a ticket in one gesture; this returns each macro id, title, description, availability scope, and its ordered list of actions, offset-paginated. Results are scoped by per-user OAuth to what the current user can see, so no shared admin key is needed. Pass a macro id from here to preview_macro_diff to preview its effect on a specific ticket.",
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
        "description": "Preview the exact changes a macro would make to a specific ticket, as a before → after diff, WITHOUT saving anything. Orchestrates two reads — the ticket's current state and Zendesk's macro-apply preview (which returns the whole resulting ticket) — and returns only the fields the macro actually changes (status, priority, assignee, group, tags, custom fields) plus the canned reply with its public/internal flag; unchanged and identity fields are omitted. Nothing is committed: to apply it, follow up with update_ticket for the field changes and add_public_comment or add_private_note for the reply. This deliberate two-step keeps the mutation explicit and reviewable rather than hidden. Find macro ids via list_macros and the ticket id via search_tickets or list_tickets.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "macro_id": {
              "description": "Macro ID — the numeric id of the macro to preview. Obtain it from list_macros.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "ticket_id": {
              "description": "Ticket ID — the numeric id of the ticket to preview the macro against. Obtain it from search_tickets or list_tickets.",
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
        "description": "List the SLA metrics that are breached or about to breach across a set of tickets, most urgent first. Pick the set with exactly one of scope (mine, my_groups or all unsolved tickets), view (a Zendesk view by title or id) or query (any Zendesk ticket search). Each running metric that is breached, or closer to its breach than its CRITICAL or WARNING threshold, is one line under BREACHED, CRITICAL or WARNING, soonest breach first, with the ticket id, metric, time left or overdue, subject, status and priority; paused and achieved metrics never appear. Thresholds are per metric family (reply metrics vs every other metric), the caller's own when set with configure_sla_alerts, else the server's; warning and critical override them for this call only. When no set is given the client may be asked which one, otherwise it defaults to the caller's own tickets and says so; on a user's first call the thresholds are shown too (in that form, or in the reply), and thresholds edited there apply to this call only. Never changes Zendesk; its one side effect is remembering, in this connector's own per-user state, that the user has been shown the thresholds. Results are cached per user for about a minute, and a set larger than a few hundred tickets is read in part, with a notice. For one ticket's full SLA state use get_ticket; for elapsed times use get_ticket_metrics.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "critical": {
              "description": "Override the CRITICAL threshold of every metric family for this call only. Given alone, a family's warning threshold is raised to it where shorter; given with warning, it must not exceed it. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "include_breached": {
              "default": true,
              "description": "Whether to list metrics already past their deadline (BREACHED). Defaults to true; set false to see only what can still be saved.",
              "type": "boolean",
            },
            "query": {
              "description": "A Zendesk ticket search query selecting the tickets to check, e.g. "status<solved priority:urgent" or "organization:acme status<solved"; "type:ticket" is added automatically. Use instead of scope or view.",
              "minLength": 1,
              "type": "string",
            },
            "scope": {
              "description": "A named set of unsolved tickets: "mine" (assigned to you), "my_groups" (in any group you belong to) or "all" (the whole account, as far as your role sees it). Use instead of view or query.",
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
              "description": "A Zendesk view to check, by its exact title (matched case-insensitively) or numeric id, as listed by list_views. Use instead of scope or query.",
            },
            "warning": {
              "description": "Override the WARNING threshold of every metric family for this call only: how much time left before a breach counts as a warning. Given alone, a family's critical threshold is lowered to it where longer. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "within": {
              "description": "Only list alerts breaching within this time from now (breached ones aside, see include_breached). A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h. Omit to list everything inside the thresholds.",
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
        "description": "Search across tickets, users, and organizations. Supports filters like "type:ticket status:open", "type:user role:agent". Returns total count and paginated results (25 per page by default, up to 100); a ticket description is cut to a 200-character excerpt, which get_ticket returns in full. Organization results include name and ID only — use get_organization for full details (tags, domains, details).",
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
              "description": "Zendesk search query. Supports type/status/role filters (e.g. "type:ticket status:open", "type:user role:agent") and free text; omit a type filter to search tickets, users and organizations at once. "me" is a value of the user keywords only (assignee:, requester:, submitter:); group:me is read as your group when you belong to exactly one, else the call fails naming your groups, so use group:<id>.",
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
