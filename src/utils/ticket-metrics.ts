import type { ZendeskMinutesPair, ZendeskTicket, ZendeskTicketMetric } from '../types';
import { formatMinutes } from './durations';

const NOT_RECORDED = 'not recorded';

const DURATIONS: readonly [label: string, key: keyof ZendeskTicketMetric][] = [
  ['First reply', 'reply_time_in_minutes'],
  ['First resolution', 'first_resolution_time_in_minutes'],
  ['Full resolution', 'full_resolution_time_in_minutes'],
  ['Agent wait', 'agent_wait_time_in_minutes'],
  ['Requester wait', 'requester_wait_time_in_minutes'],
  ['On hold', 'on_hold_time_in_minutes'],
];

const half = (minutes: number | null): string =>
  minutes === null ? 'not reached yet' : formatMinutes(minutes);

const formatPair = (pair: ZendeskMinutesPair | undefined): string => {
  if (!pair) return NOT_RECORDED;
  if (pair.calendar === null && pair.business === null) return 'not reached yet';
  return `calendar ${half(pair.calendar)}, business ${half(pair.business)}`;
};

const count = (value: number | undefined): string =>
  value === undefined ? NOT_RECORDED : `${value}`;

// A missing timestamp is an event that has not happened yet (Zendesk sends null
// until it does), except `created_at`, which every metric set carries.
const when = (value: string | null | undefined): string => value ?? 'not yet';

/**
 * One ticket's elapsed metrics (`ticket_metric`): durations in calendar and
 * business minutes, counters and key timestamps. These are facts recorded
 * whether or not an SLA policy applies, unlike the live SLA countdown.
 */
export const formatTicketMetrics = (
  id: number,
  ticket: ZendeskTicket | undefined,
  metric: ZendeskTicketMetric | undefined,
): string => {
  if (!ticket) return `## Ticket #${id}\n- Not found, or not visible to you.`;
  const header = `## Ticket #${id}: ${ticket.subject}`;
  if (!metric) return `${header}\n- No metrics recorded for this ticket.`;
  return [
    header,
    ...DURATIONS.map(
      ([label, key]) => `- **${label}**: ${formatPair(metric[key] as ZendeskMinutesPair)}`,
    ),
    `- **Reopens**: ${count(metric.reopens)} | **Replies**: ${count(metric.replies)} | **Assignee stations**: ${count(metric.assignee_stations)} | **Group stations**: ${count(metric.group_stations)}`,
    `- **Created**: ${metric.created_at ?? NOT_RECORDED} | **First assigned**: ${when(metric.initially_assigned_at)} | **Assigned**: ${when(metric.assigned_at)} | **Solved**: ${when(metric.solved_at)}`,
    `- **Latest comment**: ${when(metric.latest_comment_added_at)} | **Status changed**: ${when(metric.status_updated_at)}`,
    `- **Last update by requester**: ${when(metric.requester_updated_at)} | **by assignee**: ${when(metric.assignee_updated_at)}`,
  ].join('\n');
};
