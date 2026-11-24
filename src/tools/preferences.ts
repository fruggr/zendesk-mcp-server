import * as z from 'zod/v4';
import {
  applyPreferenceChange,
  describeEffectiveThresholds,
  isEmptyChange,
  type SlaPreferenceChange,
} from '../utils/sla-preferences';
import type { SlaService } from '../utils/sla-service';
import type { ToolDefinition } from './definitions';

/** How every SLA duration parameter is spelled, for their descriptions. */
export const DURATION_HINT = 'A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.';

/** The caller's SLA service, or the plain error of a server that wires none. */
export const requireSla = (sla: SlaService | undefined): SlaService => {
  if (!sla) throw new Error('SLA alerting is not available on this server.');
  return sla;
};

export const createPreferenceTools = (): ToolDefinition[] => [
  {
    name: 'configure_sla_alerts',
    namespace: 'preferences',
    // `--read-only` means "no Zendesk writes": this writes only the caller's own
    // preferences on this server, so it stays available there.
    readOnly: true,
    title: 'Configure SLA Alert Thresholds',
    description:
      'Read or set your SLA alert thresholds: how close to a breach a metric must be to count as WARNING or CRITICAL. Without parameters it returns the thresholds in force and their source (yours or the server default). With them it saves yours per metric family on this server, never in Zendesk, for list_sla_alerts and the Urgency line of get_ticket / search_tickets. If the operator disabled personal thresholds, only reading works and the reply says so.',
    inputSchema: z.object({
      reply_warning: z
        .string()
        .optional()
        .describe(
          `Time left at which a reply metric (first_reply_time, next_reply_time) turns WARNING. ${DURATION_HINT}`,
        ),
      reply_critical: z
        .string()
        .optional()
        .describe(
          `Time left at which a reply metric turns CRITICAL; at most reply_warning. ${DURATION_HINT}`,
        ),
      wait_warning: z
        .string()
        .optional()
        .describe(
          `Time left at which any other metric (requester_wait_time, agent_work_time…) turns WARNING. ${DURATION_HINT}`,
        ),
      wait_critical: z
        .string()
        .optional()
        .describe(
          `Time left at which any other metric turns CRITICAL; at most wait_warning. ${DURATION_HINT}`,
        ),
      reset: z
        .enum(['reply', 'wait', 'all'])
        .optional()
        .describe(
          'Go back to the server defaults for "reply", "wait" or "all"; "all" also makes list_sla_alerts explain the thresholds again. Not with new values for the same family.',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (params, { caller }) => {
      const sla = requireSla(caller.sla);
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
