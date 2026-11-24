import { expect, it } from 'vitest';
import { listExposedTools } from './list-exposed-tools';

it('exposes the users tool surface unchanged', async () => {
  expect(await listExposedTools('users')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Get the currently authenticated Zendesk user. Useful to verify identity and permissions.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {},
          "type": "object",
        },
        "name": "get_current_user",
        "title": "Get Current Zendesk User",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Search users by name, email or other criteria in Zendesk query syntax, returning each match's id, name, email, role, active flag and organization id, with the total count. Use it to turn a person into the user id other tools take, such as update_ticket followers; a name can match several users, so confirm the right one. With an id in hand use get_user; for your own account, get_current_user. Prefer it over \`search\` for users only: \`search\` mixes in tickets and organizations unless the query says type:user.",
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
              "description": "Free text matched against name and email, and/or field filters like "email:jane@acme.com", "role:agent", "organization_id:123". "type:user" is added automatically.",
              "minLength": 1,
              "type": "string",
            },
          },
          "required": [
            "query",
          ],
          "type": "object",
        },
        "name": "search_users",
        "title": "Search Zendesk Users",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Retrieve one user by numeric id, with name, email, role, role type, active state and organization id. Use search_users when you only have a name or email, or get_current_user for the authenticated identity.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "user_id": {
              "description": "Numeric id of the user to fetch, from search_users or a ticket's requester/assignee fields.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "user_id",
          ],
          "type": "object",
        },
        "name": "get_user",
        "title": "Get Zendesk User",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "Retrieve one organization by numeric id, with its name, details, domains and tags. Use list_organizations to browse, or search to look one up by name.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "organization_id": {
              "description": "Numeric id of the organization to fetch, from list_organizations, search or a user record.",
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
          },
          "required": [
            "organization_id",
          ],
          "type": "object",
        },
        "name": "get_organization",
        "title": "Get Zendesk Organization",
      },
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": true,
          "readOnlyHint": true,
        },
        "description": "List all organizations, cursor-paginated, with each one's name, id, details, domains and tags. Organizations group end users and can be referenced when creating or filtering tickets. Use get_organization when you already have an id, or search to look one up by name.",
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
              "description": "Organizations per page.",
              "maximum": 100,
              "minimum": 1,
              "type": "integer",
            },
          },
          "type": "object",
        },
        "name": "list_organizations",
        "title": "List Zendesk Organizations",
      },
    ]
  `);
});
