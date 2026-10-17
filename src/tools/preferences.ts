import * as z from 'zod/v4';
import {
  applyPreferenceChange,
  describeEffectiveThresholds,
  isEmptyChange,
  type SlaPreferenceChange,
} from '../utils/sla-preferences';
import type { SlaService } from '../utils/sla-service';
import type { ToolContext, ToolDefinition } from './definitions';

const DURATION_HINT = 'A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.';

const requireSla = (sla: SlaService | undefined): SlaService => {
  if (!sla) throw new Error('SLA alerting is not available on this server.');
  return sla;
};

export const createPreferenceTools = (ctx: ToolContext): ToolDefinition[] => [
  {
    name: 'configure_sla_alerts',
    namespace: 'preferences',
    // `--read-only` means "no Zendesk writes": this writes only the caller's own
    // preferences on this server, so it stays available there.
    readOnly: true,
    title: 'Configure SLA Alert Thresholds',
    description:
      'Read or change your personal SLA alert thresholds: how close to a breach a running SLA metric must be to count as WARNING or CRITICAL. Called with no parameters it changes nothing and reports the thresholds in force for you and where each comes from (your preference or the server default). With parameters it saves your own thresholds per metric family (reply: first_reply_time and next_reply_time; wait: every other metric) on this MCP server — nothing is written to Zendesk — and they then drive the Urgency line of get_ticket / search_tickets for you only; reset goes back to the server defaults. When the operator turned personal thresholds off (SLA_USER_PREFERENCES=off), only the read works and the reply says so.',
    inputSchema: z.object({
      reply_warning: z
        .string()
        .optional()
        .describe(
          `Time left before a reply metric (first_reply_time, next_reply_time) breaches at which it turns WARNING. ${DURATION_HINT} Omit to keep the current value.`,
        ),
      reply_critical: z
        .string()
        .optional()
        .describe(
          `Time left before a reply metric breaches at which it turns CRITICAL; must not exceed the reply warning threshold. ${DURATION_HINT} Omit to keep the current value.`,
        ),
      wait_warning: z
        .string()
        .optional()
        .describe(
          `Time left before a wait or resolution metric (requester_wait_time, agent_work_time and every other non-reply metric) breaches at which it turns WARNING. ${DURATION_HINT} Omit to keep the current value.`,
        ),
      wait_critical: z
        .string()
        .optional()
        .describe(
          `Time left before a wait or resolution metric breaches at which it turns CRITICAL; must not exceed the wait warning threshold. ${DURATION_HINT} Omit to keep the current value.`,
        ),
      reset: z
        .enum(['reply', 'wait', 'all'])
        .optional()
        .describe(
          'Drop your personal thresholds for one family ("reply" or "wait") or both ("all") and follow the server defaults again. Cannot be combined with new values for the same family.',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (params) => {
      const sla = requireSla(ctx.sla);
      const change = params as SlaPreferenceChange;
      const prefs = await sla.preferences();
      const describe = (current: typeof prefs) =>
        describeEffectiveThresholds(sla.adminThresholds, current, sla.userPreferencesAllowed);
      if (isEmptyChange(change)) {
        return { content: [{ type: 'text', text: describe(prefs) }] };
      }
      if (!sla.userPreferencesAllowed) {
        return {
          content: [{ type: 'text', text: `Nothing was changed.\n\n${describe(prefs)}` }],
        };
      }
      const applied = applyPreferenceChange(sla.adminThresholds, prefs, change);
      if ('error' in applied) throw new Error(`${applied.error} Nothing was changed.`);
      await sla.savePreferences(applied.preferences);
      return {
        content: [
          {
            type: 'text',
            text: `Your SLA alert thresholds were saved.\n\n${describe(applied.preferences)}`,
          },
        ],
      };
    },
  },
];
