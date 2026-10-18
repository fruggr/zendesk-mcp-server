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
  effectiveThresholds,
  isEmptyChange,
  type SlaPreferenceChange,
  type SlaPreferences,
} from '../utils/sla-preferences';
import { parseAlertsUri } from '../utils/sla-resource';
import type { NamedScope, SlaScope } from '../utils/sla-scope';
import type { SlaService } from '../utils/sla-service';
import type { SlaThresholds } from '../utils/sla-thresholds';
import type { ToolCallContext, ToolContext, ToolDefinition } from './definitions';
import { DURATION_HINT, requireSla } from './preferences';
import { resolveViewId } from './tickets';

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
 * thresholds explained in the reply instead. Thresholds edited in the form
 * apply to this call only: keeping them is configure_sla_alerts' job. The one
 * write is the marker that the user was introduced, so it happens once.
 */
const settleForm = async (
  sla: SlaService,
  call: ToolCallContext | undefined,
  askScope: boolean,
): Promise<{
  picked: NamedScope | undefined;
  notes: string[];
  prefs: SlaPreferences | undefined;
  edited: SlaThresholds | undefined;
}> => {
  const prefs = sla.userPreferencesAllowed ? await sla.preferences() : undefined;
  const introduce = sla.userPreferencesAllowed && !prefs?.introduced;
  const notes: string[] = [];
  let picked: NamedScope | undefined;
  let edited: SlaThresholds | undefined;
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
    if (!isEmptyChange(answer.change)) {
      const applied = applyPreferenceChange(sla.adminThresholds, prefs, answer.change);
      if ('preferences' in applied) {
        edited = effectiveThresholds(sla.adminThresholds, applied.preferences);
        notes.push(keepEditedNote(answer.change));
      } else {
        notes.push(`Your edited thresholds were not applied: ${applied.error}`);
      }
    }
  } else if (introduce && !answered) {
    notes.push('', describeEffectiveThresholds(sla.adminThresholds, prefs, true), '');
  }
  if (introduce) await sla.savePreferences({ ...prefs, introduced: true });
  return { picked, notes, prefs, edited };
};

// How to keep thresholds edited in the form, which this call does not store.
const keepEditedNote = (change: SlaPreferenceChange): string => {
  const args = Object.entries(change)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: "${value}"`)
    .join(', ');
  return `The thresholds you edited apply to this call only. To keep them, call configure_sla_alerts with ${args}.`;
};

export const createSlaAlertTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  // The scope the caller named, the one the user picked in the form, or `mine`
  // by default: with a note saying which.
  const resolveNamedScope = (
    params: AlertParams,
    picked: NamedScope | undefined,
    notes: string[],
  ): SlaScope => {
    if (params.query !== undefined) return { kind: 'query', query: params.query };
    if (params.scope) return { kind: 'scope', scope: params.scope };
    if (picked) return { kind: 'scope', scope: picked };
    notes.push(
      'No scope was given, so this checks your assigned tickets (scope "mine"). Pass scope, view or query for another set.',
    );
    return { kind: 'scope', scope: 'mine' };
  };

  // The view's scope, or the reply naming the views there are when none matches.
  const resolveView = async (token: string, view: string | number): Promise<SlaScope | string> => {
    const resolved = await resolveViewId(subdomain, token, view);
    if ('id' in resolved) return { kind: 'view', viewId: resolved.id };
    return resolved.available.length > 0
      ? `No active view matches "${view}". Available views: ${resolved.available.join(', ')}.`
      : `No active view matches "${view}", and no active views were found for this agent.`;
  };

  return [
    {
      name: 'list_sla_alerts',
      namespace: 'tickets',
      readOnly: true,
      title: 'List SLA Alerts',
      description:
        "List the SLA metrics that are breached or about to breach across a set of tickets, most urgent first. Pick the set with exactly one of scope (mine, my_groups or all unsolved tickets), view (a Zendesk view by title or id) or query (any Zendesk ticket search). Each running metric that is breached, or closer to its breach than its CRITICAL or WARNING threshold, is one line under BREACHED, CRITICAL or WARNING, soonest breach first, with the ticket id, metric, time left or overdue, subject, status and priority; paused and achieved metrics never appear. Thresholds are per metric family (reply metrics vs every other metric), the caller's own when set with configure_sla_alerts, else the server's; warning and critical override them for this call only. When no set is given the client may be asked which one, otherwise it defaults to the caller's own tickets and says so; on a user's first call the thresholds are shown too (in that form, or in the reply), and thresholds edited there apply to this call only. Never changes Zendesk; its one side effect is remembering, in this connector's own per-user state, that the user has been shown the thresholds. Results are cached per user for about a minute, and a set larger than a few hundred tickets is read in part, with a notice. For one ticket's full SLA state use get_ticket; for elapsed times use get_ticket_metrics.",
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
            `Override the WARNING threshold of every metric family for this call only: how much time left before a breach counts as a warning. Given alone, a family's critical threshold is lowered to it where longer. ${DURATION_HINT}`,
          ),
        critical: z
          .string()
          .optional()
          .describe(
            `Override the CRITICAL threshold of every metric family for this call only. Given alone, a family's warning threshold is raised to it where shorter; given with warning, it must not exceed it. ${DURATION_HINT}`,
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
        // Every input is checked, and the view resolved, before the form is
        // shown or anything is written: a bad call fails without side effects.
        const given = [params.scope, params.view, params.query].filter((v) => v !== undefined);
        if (given.length > 1) throw new Error('Pass only one of scope, view or query.');
        const withinMinutes = parseWithin(params.within);
        const overridden = params.warning !== undefined || params.critical !== undefined;
        const checked = overrideThresholds(await sla.thresholds(), params.warning, params.critical);
        if ('error' in checked) throw new Error(checked.error);

        const token = await getToken();
        const view = params.view === undefined ? undefined : await resolveView(token, params.view);
        if (typeof view === 'string') return { content: [{ type: 'text', text: view }] };

        const { picked, notes, prefs, edited } = await settleForm(sla, call, given.length === 0);
        // Per-call overrides win over thresholds edited in the form.
        const override = edited
          ? overrideThresholds(edited, params.warning, params.critical)
          : checked;
        if ('error' in override) throw new Error(override.error);
        const scope = view ?? resolveNamedScope(params, picked, notes);
        const { text } = await checkAlerts({
          sla,
          get: (path, query) => zendeskGet(subdomain, token, path, query),
          target: scope,
          thresholds: override.thresholds,
          source: thresholdsSource(sla, prefs, overridden || edited !== undefined),
          filter: { withinMinutes, includeBreached: params.include_breached },
          notes,
        });
        return { content: [{ type: 'text', text }] };
      },
    },
  ];
};

/** What an alert reader needs: the caller's tenant, token and SLA service. */
export type AlertsReaderContext = Pick<ToolContext, 'subdomain' | 'getToken' | 'sla'>;

/**
 * Reads the alert resources (`zendesk-sla://alerts/...`) with the caller's
 * token and thresholds, rendered like list_sla_alerts with its defaults. The
 * poller asks it for the fingerprint only. A view title resolves once per
 * reader (that is, per connection, session or grant): resolving pages through
 * /views, which no scope cache would spare on every poll.
 */
export const createAlertsReader = (ctx: AlertsReaderContext) => {
  const viewIds = new Map<string | number, number>();

  const viewScope = async (view: string | number, token: string): Promise<SlaScope> => {
    const known = viewIds.get(view);
    if (known !== undefined) return { kind: 'view', viewId: known };
    const resolved = await resolveViewId(ctx.subdomain, token, view);
    if ('available' in resolved) {
      throw new Error(
        `No active view matches "${view}". Available views: ${resolved.available.join(', ') || 'none'}.`,
      );
    }
    viewIds.set(view, resolved.id);
    return { kind: 'view', viewId: resolved.id };
  };

  const evaluate = async (uri: string) => {
    const sla = requireSla(ctx.sla);
    const target = parseAlertsUri(uri);
    if (!target) throw new Error(`Not an SLA alert resource: ${uri}`);
    const token = await ctx.getToken();
    const scope = target.kind === 'view' ? await viewScope(target.view, token) : target;
    // Only the report's label reads them: an unreadable store still alerts,
    // on the thresholds sla.thresholds() falls back to.
    const prefs = sla.userPreferencesAllowed
      ? await sla.preferences().catch(() => undefined)
      : undefined;
    try {
      return await checkAlerts({
        sla,
        get: (path, query) => zendeskGet(ctx.subdomain, token, path, query),
        target: scope,
        thresholds: await sla.thresholds(),
        source: thresholdsSource(sla, prefs, false),
        filter: { includeBreached: true },
        notes: [],
      });
    } catch (err) {
      // A view deleted or re-created since: resolve its title afresh next time.
      if (target.kind === 'view') viewIds.delete(target.view);
      throw err;
    }
  };
  return {
    read: async (uri: string): Promise<string> => (await evaluate(uri)).text,
    fingerprint: async (uri: string): Promise<string> => (await evaluate(uri)).fingerprint,
  };
};

export type AlertsReader = ReturnType<typeof createAlertsReader>;
