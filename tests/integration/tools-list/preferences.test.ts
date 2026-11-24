import { expect, it } from 'vitest';
import { listExposedTools } from './list-exposed-tools';

it('exposes the preferences tool surface unchanged', async () => {
  expect(await listExposedTools('preferences')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": false,
          "readOnlyHint": false,
        },
        "description": "Read or set your SLA alert thresholds: how close to a breach a metric must be to count as WARNING or CRITICAL. Without parameters it returns the thresholds in force and their source (yours or the server default). With them it saves yours per metric family on this server, never in Zendesk, for list_sla_alerts and the Urgency line of get_ticket / search_tickets. If the operator disabled personal thresholds, only reading works and the reply says so.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "reply_critical": {
              "description": "Time left at which a reply metric turns CRITICAL; at most reply_warning. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "reply_warning": {
              "description": "Time left at which a reply metric (first_reply_time, next_reply_time) turns WARNING. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "reset": {
              "description": "Go back to the server defaults for "reply", "wait" or "all"; "all" also makes list_sla_alerts explain the thresholds again. Not with new values for the same family.",
              "enum": [
                "reply",
                "wait",
                "all",
              ],
              "type": "string",
            },
            "wait_critical": {
              "description": "Time left at which any other metric turns CRITICAL; at most wait_warning. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
            "wait_warning": {
              "description": "Time left at which any other metric (requester_wait_time, agent_work_time…) turns WARNING. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.",
              "type": "string",
            },
          },
          "type": "object",
        },
        "name": "configure_sla_alerts",
        "title": "Configure SLA Alert Thresholds",
      },
    ]
  `);
});

it('exposes the preferences proxy unchanged', async () => {
  expect(await listExposedTools('preferences', 'namespace')).toMatchInlineSnapshot(`
    [
      {
        "annotations": {
          "destructiveHint": false,
          "idempotentHint": true,
          "openWorldHint": false,
          "readOnlyHint": false,
        },
        "description": "Connector preferences (this MCP server, not Zendesk). Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.

    Operations: configure_sla_alerts",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "properties": {
            "operation": {
              "description": "One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.
    - configure_sla_alerts(reply_warning, reply_critical, wait_warning, wait_critical, reset): Read or set your SLA alert thresholds: how close to a breach a metric must be to count as WARNING or CRITICAL. (write)",
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
        "name": "connector_preferences",
        "title": "Connector preferences (this MCP server, not Zendesk)",
      },
    ]
  `);
});
