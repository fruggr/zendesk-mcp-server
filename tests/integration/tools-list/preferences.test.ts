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
        "description": "Read or change your personal SLA alert thresholds: how close to a breach a running SLA metric must be to count as WARNING or CRITICAL. Called with no parameters it changes nothing and reports the thresholds in force for you and where each comes from (your preference or the server default). With parameters it saves your own thresholds per metric family (reply: first_reply_time and next_reply_time; wait: every other metric) on this MCP server — nothing is written to Zendesk — and they then drive list_sla_alerts and the Urgency line of get_ticket / search_tickets for you only; reset goes back to the server defaults. When the operator turned personal thresholds off (SLA_USER_PREFERENCES=off), only the read works and the reply says so.",
        "inputSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "reply_critical": {
              "description": "Time left before a reply metric breaches at which it turns CRITICAL; must not exceed the reply warning threshold. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h. Omit to keep the current value.",
              "type": "string",
            },
            "reply_warning": {
              "description": "Time left before a reply metric (first_reply_time, next_reply_time) breaches at which it turns WARNING. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h. Omit to keep the current value.",
              "type": "string",
            },
            "reset": {
              "description": "Drop your personal thresholds for one family ("reply" or "wait") or both ("all") and follow the server defaults again; "all" also makes your next list_sla_alerts call explain the thresholds again. Cannot be combined with new values for the same family.",
              "enum": [
                "reply",
                "wait",
                "all",
              ],
              "type": "string",
            },
            "wait_critical": {
              "description": "Time left before a wait or resolution metric breaches at which it turns CRITICAL; must not exceed the wait warning threshold. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h. Omit to keep the current value.",
              "type": "string",
            },
            "wait_warning": {
              "description": "Time left before a wait or resolution metric (requester_wait_time, agent_work_time and every other non-reply metric) breaches at which it turns WARNING. A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h. Omit to keep the current value.",
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
    - configure_sla_alerts(reply_warning, reply_critical, wait_warning, wait_critical, reset): Read or change your personal SLA alert thresholds: how close to a breach a running SLA metric must be to count as WARNING or CRITICAL. (write)",
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
