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
        "description": "Search for users by name, email, or other criteria using Zendesk search query syntax. Returns total count.",
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
              "description": "Zendesk user search query — free text matched against name and email, and/or field filters like "email:jane@acme.com", "role:agent", "organization_id:123". A "type:user" scope is added automatically.",
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
        "description": "Retrieve a single user by their numeric id. Returns the full user record (name, email, role, organization, tags). Use search_users when you only have a name or email, or get_current_user for the authenticated identity.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "user_id": {
              "description": "User ID — the numeric id of the Zendesk user to fetch. Obtain it from search_users, or from the requester/assignee fields of a ticket.",
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
        "description": "Retrieve a single organization by its numeric id. Returns full details (name, tags, domains, notes) — more than the name/id that search or list_organizations surface. Use list_organizations to browse or search for a name-based lookup.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "organization_id": {
              "description": "Organization ID — the numeric id of the Zendesk organization to fetch. Obtain it from list_organizations, search, or a user record.",
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
        "description": "List all organizations with pagination. Returns the name and id of each organization plus basic fields; results are cursor-paginated. Use get_organization with an id for full details (tags, domains, notes), or search for query-based lookups by name. Organizations group end users and can be referenced when creating or filtering tickets.",
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
              "description": "Organizations per page (1-100, default 100).",
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
