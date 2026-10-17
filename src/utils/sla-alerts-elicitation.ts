import type { ElicitRequestFormParams } from '@modelcontextprotocol/server';
import { formatMinutes } from './durations';
import type { SlaPreferenceChange } from './sla-preferences';
import type { NamedScope } from './sla-scope';
import {
  parseThresholdPair,
  type SlaThreshold,
  type SlaThresholds,
  toThreshold,
} from './sla-thresholds';

/** The key the alert tool's one elicitation is asked and answered under. */
export const ALERTS_ELICITATION_KEY = 'sla_alerts';

const SCOPE_CHOICES: ReadonlyArray<{ const: NamedScope; title: string }> = [
  { const: 'mine', title: 'My assigned tickets' },
  { const: 'my_groups', title: "My groups' tickets" },
  { const: 'all', title: 'All unsolved tickets' },
];

const pair = (t: SlaThreshold): string =>
  `${formatMinutes(t.warning)},${formatMinutes(t.critical)}`;

type FormSchema = ElicitRequestFormParams['requestedSchema'];

export interface AlertsElicitation {
  message: string;
  requestedSchema: FormSchema;
}

/**
 * The one form the alert tool may show: the scope when none was given, and on
 * a user's first call the thresholds, explained and editable. `undefined` when
 * there is nothing to ask.
 */
export const buildAlertsElicitation = (options: {
  askScope: boolean;
  introduce: boolean;
  thresholds: SlaThresholds;
}): AlertsElicitation | undefined => {
  const { askScope, introduce, thresholds } = options;
  if (!askScope && !introduce) return undefined;
  const properties: FormSchema['properties'] = {};
  const message: string[] = [];
  if (askScope) {
    message.push('Which tickets should be checked for SLA alerts?');
    properties['scope'] = {
      type: 'string',
      title: 'Tickets to check',
      oneOf: [...SCOPE_CHOICES],
      default: 'mine',
    };
  }
  if (introduce) {
    message.push(
      `A running SLA metric is flagged WARNING when its breach is closer than the warning threshold, CRITICAL when closer than the critical one, and BREACHED once overdue. In force for you: reply metrics (first_reply_time, next_reply_time) ${pair(thresholds.reply)}, every other metric ${pair(thresholds.wait)}, as warning,critical. Edit them to keep your own, or later with configure_sla_alerts.`,
    );
    properties['reply_thresholds'] = {
      type: 'string',
      title: 'Reply metrics: warning,critical',
      default: pair(thresholds.reply),
    };
    properties['wait_thresholds'] = {
      type: 'string',
      title: 'Wait and resolution metrics: warning,critical',
      default: pair(thresholds.wait),
    };
  }
  return {
    message: message.join('\n\n'),
    requestedSchema: {
      type: 'object',
      properties,
      ...(askScope ? { required: ['scope'] } : {}),
    },
  };
};

export interface AlertsAnswer {
  scope?: NamedScope;
  /** Threshold edits to save as the user's preferences, when any differ. */
  change: SlaPreferenceChange;
  notes: string[];
}

const isNamedScope = (value: unknown): value is NamedScope =>
  SCOPE_CHOICES.some((choice) => choice.const === value);

/**
 * Reads an accepted answer to that form. The content comes from the client
 * unvalidated, so every field is checked here; a bad one is ignored with a
 * note rather than failing the whole call.
 */
export const readAlertsAnswer = (
  content: Record<string, unknown>,
  thresholds: SlaThresholds,
): AlertsAnswer => {
  const answer: AlertsAnswer = { change: {}, notes: [] };
  if (isNamedScope(content['scope'])) answer.scope = content['scope'];
  for (const family of ['reply', 'wait'] as const) {
    const raw = content[`${family}_thresholds`];
    if (typeof raw !== 'string' || raw.trim() === pair(thresholds[family])) continue;
    const parsed = parseThresholdPair(raw);
    if ('error' in parsed) {
      answer.notes.push(`Your ${family} thresholds "${raw}" were not saved: ${parsed.error}`);
      continue;
    }
    answer.change[`${family}_warning`] = formatMinutes(parsed.threshold.warning);
    answer.change[`${family}_critical`] = formatMinutes(parsed.threshold.critical);
  }
  return answer;
};

/**
 * Applies the per-call `warning` / `critical` overrides to both families. A
 * half given alone keeps the family's other half; the pair must still hold
 * critical <= warning.
 */
export const overrideThresholds = (
  thresholds: SlaThresholds,
  warning: string | undefined,
  critical: string | undefined,
): { thresholds: SlaThresholds } | { error: string } => {
  // With nothing overridden each family round-trips through toThreshold unchanged.
  const next: Partial<SlaThresholds> = {};
  for (const family of ['reply', 'wait'] as const) {
    const current = thresholds[family];
    const result = toThreshold(
      warning ?? formatMinutes(current.warning),
      critical ?? formatMinutes(current.critical),
    );
    if ('error' in result) return { error: `${result.error} (${family} metrics)` };
    next[family] = result.threshold;
  }
  return { thresholds: next as SlaThresholds };
};
