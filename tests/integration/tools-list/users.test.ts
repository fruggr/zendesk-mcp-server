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
        "description": "Get the signed-in Zendesk user. Use it to check who you act as and your role.",
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
        "description": "Find users by name, email or Zendesk query. Each match has id, name, email, role, active flag and organization id, plus the total. Use it to get the user id other tools take; a name can match several users, so confirm. By id: get_user; yourself: get_current_user. Prefer it to \`search\`, which mixes in tickets and organizations.",
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
              "description": "Name or email text and/or filters like "role:agent" or "organization_id:123"; type:user is added.",
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
        "description": "Get a user by id: name, email, role, role type, active state, organization id. By name or email: search_users; yourself: get_current_user.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "user_id": {
              "description": "User id, from search_users or a ticket's requester or assignee.",
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
        "description": "Get an organization by id: name, details, domains, tags. Browse: list_organizations; by name: search.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "organization_id": {
              "description": "Organization id, from list_organizations, search or a user.",
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
        "description": "List organizations with name, id, details, domains and tags; they group end users and can scope tickets. By id: get_organization; by name: search.",
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
