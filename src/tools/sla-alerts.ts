import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { zendeskGet } from '../client/zendesk-api';
import { parseDuration } from '../utils/durations';
import { inputRequiredError } from '../utils/elicitation';
import { checkAlerts, thresholdsSource } from '../utils/sla-alerts-check';
import {
  ALERTS_ELICITATION_KEY,
  buildAlertsElicitation,
  overrideThresholds,
  readAlertsAnswer,
} from '../utils/sla-alerts-elicitation';
import {
  applyPreferenceChange,
  describeEffectiveThresholds,
  type SlaPreferences,
} from '../utils/sla-preferences';
import { parseAlertsUri } from '../utils/sla-resource';
import type { NamedScope, SlaScope } from '../utils/sla-scope';
import type { SlaService } from '../utils/sla-service';
import type { ToolCallContext, ToolContext, ToolDefinition } from './definitions';
import { resolveViewId } from './tickets';

const DURATION_HINT = 'A readable duration: 30m, 4h, 2d, 1w, or a mix like 1d4h.';

const requireSla = (sla: SlaService | undefined): SlaService => {
  if (!sla) throw new Error('SLA alerting is not available on this server.');
  return sla;
};

interface AlertParams {
  query?: string;
  view?: string | number;
  scope?: NamedScope;
  within?: string;
  include_breached: boolean;
  warning?: string;
  critical?: string;
}

const parseWithin = (within: string | undefined): number | undefined => {
  if (within === undefined) return undefined;
  const minutes = parseDuration(within);
  if (minutes === undefined)
    throw new Error(`within: "${within}" is not a duration. ${DURATION_HINT}`);
  return minutes;
};

/**
 * The one form the tool may show — the scope when none was given, the
 * thresholds on a user's first call — and what came of it. Asking throws the
 * SDK's input-required signal; a client that cannot answer forms gets the
 * thresholds explained in the reply instead. Either way the user is marked as
 * introduced, so it happens once.
 */
const settleForm = async (
  sla: SlaService,
  call: ToolCallContext | undefined,
  askScope: boolean,
): Promise<{
  picked: NamedScope | undefined;
  notes: string[];
  prefs: SlaPreferences | undefined;
}> => {
  let prefs = sla.userPreferencesAllowed ? await sla.preferences() : undefined;
  const introduce = sla.userPreferencesAllowed && !prefs?.introduced;
  const notes: string[] = [];
  let picked: NamedScope | undefined;
  const form = buildAlertsElicitation({ askScope, introduce, thresholds: await sla.thresholds() });
  const answered = call?.inputResponses?.[ALERTS_ELICITATION_KEY] !== undefined;
  if (form && call?.canElicit && !answered) {
    throw inputRequiredError(
      inputRequired({ inputRequests: { [ALERTS_ELICITATION_KEY]: inputRequired.elicit(form) } }),
    );
  }
  const content = answered
    ? acceptedContent(call?.inputResponses, ALERTS_ELICITATION_KEY)
    : undefined;
  if (content) {
    const answer = readAlertsAnswer(content, await sla.thresholds());
    picked = answer.scope;
    notes.push(...answer.notes);
    const applied = applyPreferenceChange(sla.adminThresholds, prefs, answer.change);
    if ('preferences' in applied) prefs = applied.preferences;
    else notes.push(`Your thresholds were not saved: ${applied.error}`);
  } else if (introduce && !answered) {
    notes.push('', describeEffectiveThresholds(sla.adminThresholds, prefs, true), '');
  }
  if (introduce) await sla.savePreferences({ ...prefs, introduced: true });
  return { picked, notes, prefs };
};

export const createSlaAlertTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  // The scope the caller named, the one the user picked in the form, or `mine`
  // by default: with a note saying which.
  const resolveNamedScope = (
    params: AlertParams,
    picked: NamedScope | undefined,
    notes: string[],
  ): SlaScope | undefined => {
    if (params.query !== undefined) return { kind: 'query', query: params.query };
    if (params.view !== undefined) return undefined;
    if (params.scope) return { kind: 'scope', scope: params.scope };
    if (picked) return { kind: 'scope', scope: picked };
    notes.push(
      'No scope was given, so this checks your assigned tickets (scope "mine"). Pass scope, view or query for another set.',
    );
    return { kind: 'scope', scope: 'mine' };
  };

  return [
    {
      name: 'list_sla_alerts',
      namespace: 'tickets',
      readOnly: true,
      title: 'List SLA Alerts',
      description:
        "List the SLA metrics that are breached or about to breach across a set of tickets, most urgent first. Pick the set with exactly one of scope (mine, my_groups or all unsolved tickets), view (a Zendesk view by title or id) or query (any Zendesk ticket search). Each running metric that is breached, or closer to its breach than its CRITICAL or WARNING threshold, is one line under BREACHED, CRITICAL or WARNING, soonest breach first, with the ticket id, metric, time left or overdue, subject, status and priority; paused and achieved metrics never appear. Thresholds are per metric family (reply metrics vs every other metric), the caller's own when set with configure_sla_alerts, else the server's; warning and critical override them for this call only. When no set is given the client may be asked which one (and, on a first call, shown the thresholds); otherwise it defaults to the caller's own tickets and says so. Read-only; results are cached per user for about a minute, and a set larger than a few hundred tickets is read in part, with a notice. For one ticket's full SLA state use get_ticket; for elapsed times use get_ticket_metrics.",
      inputSchema: z.object({
        scope: z
          .enum(['mine', 'my_groups', 'all'])
          .optional()
          .describe(
            'A named set of unsolved tickets: "mine" (assigned to you), "my_groups" (in any group you belong to) or "all" (the whole account, as far as your role sees it). Use instead of view or query.',
          ),
        view: z
          .union([z.string().min(1), z.number().int().positive()])
          .optional()
          .describe(
            'A Zendesk view to check, by its exact title (matched case-insensitively) or numeric id, as listed by list_views. Use instead of scope or query.',
          ),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            'A Zendesk ticket search query selecting the tickets to check, e.g. "status<solved priority:urgent" or "organization:acme status<solved"; "type:ticket" is added automatically. Use instead of scope or view.',
          ),
        within: z
          .string()
          .optional()
          .describe(
            `Only list alerts breaching within this time from now (breached ones aside, see include_breached). ${DURATION_HINT} Omit to list everything inside the thresholds.`,
          ),
        include_breached: z
          .boolean()
          .default(true)
          .describe(
            'Whether to list metrics already past their deadline (BREACHED). Defaults to true; set false to see only what can still be saved.',
          ),
        warning: z
          .string()
          .optional()
          .describe(
            `Override the WARNING threshold of every metric family for this call only: how much time left before a breach counts as a warning. ${DURATION_HINT}`,
          ),
        critical: z
          .string()
          .optional()
          .describe(
            `Override the CRITICAL threshold of every metric family for this call only; must not exceed the warning threshold in force. ${DURATION_HINT}`,
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (rawParams, call?: ToolCallContext) => {
        const params = rawParams as unknown as AlertParams;
        const sla = requireSla(ctx.sla);
        const given = [params.scope, params.view, params.query].filter((v) => v !== undefined);
        if (given.length > 1) throw new Error('Pass only one of scope, view or query.');
        const withinMinutes = parseWithin(params.within);
        const { picked, notes, prefs } = await settleForm(sla, call, given.length === 0);

        const override = overrideThresholds(
          await sla.thresholds(),
          params.warning,
          params.critical,
        );
        if ('error' in override) throw new Error(override.error);

        const token = await getToken();
        let scope = resolveNamedScope(params, picked, notes);
        if (!scope) {
          const resolved = await resolveViewId(subdomain, token, params.view as string | number);
          if ('available' in resolved) {
            const text =
              resolved.available.length > 0
                ? `No active view matches "${params.view}". Available views: ${resolved.available.join(', ')}.`
                : `No active view matches "${params.view}", and no active views were found for this agent.`;
            return { content: [{ type: 'text', text }] };
          }
          scope = { kind: 'view', viewId: resolved.id };
        }
        const { text } = await checkAlerts({
          sla,
          get: (path, query) => zendeskGet(subdomain, token, path, query),
          target: scope,
          thresholds: override.thresholds,
          source: thresholdsSource(
            sla,
            prefs,
            params.warning !== undefined || params.critical !== undefined,
          ),
          filter: { withinMinutes, includeBreached: params.include_breached },
          notes,
        });
        return { content: [{ type: 'text', text }] };
      },
    },
  ];
};

/**
 * Reads the alert resources (`zendesk-sla://alerts/...`) with the caller's
 * token and thresholds, rendered like list_sla_alerts with its defaults. The
 * poller asks it for the fingerprint only.
 */
export const createAlertsReader = (ctx: ToolContext) => {
  const evaluate = async (uri: string) => {
    const sla = requireSla(ctx.sla);
    const target = parseAlertsUri(uri);
    if (!target) throw new Error(`Not an SLA alert resource: ${uri}`);
    const token = await ctx.getToken();
    let scope: SlaScope;
    if (target.kind === 'view') {
      const resolved = await resolveViewId(ctx.subdomain, token, target.view);
      if ('available' in resolved) {
        throw new Error(
          `No active view matches "${target.view}". Available views: ${resolved.available.join(', ') || 'none'}.`,
        );
      }
      scope = { kind: 'view', viewId: resolved.id };
    } else {
      scope = target;
    }
    const prefs = sla.userPreferencesAllowed ? await sla.preferences() : undefined;
    return checkAlerts({
      sla,
      get: (path, query) => zendeskGet(ctx.subdomain, token, path, query),
      target: scope,
      thresholds: await sla.thresholds(),
      source: thresholdsSource(sla, prefs, false),
      filter: { includeBreached: true },
      notes: [],
    });
  };
  return {
    read: async (uri: string): Promise<string> => (await evaluate(uri)).text,
    fingerprint: async (uri: string): Promise<string> => (await evaluate(uri)).fingerprint,
  };
};

export type AlertsReader = ReturnType<typeof createAlertsReader>;
