import { describe, expect, it } from 'vitest';
import type { ZendeskTicketMetric } from '../../../src/types';
import { formatTicketMetrics } from '../../../src/utils/ticket-metrics';
import { MOCK_TICKET, MOCK_TICKET_METRIC } from '../../msw-handlers';

describe('formatTicketMetrics', () => {
  it('renders every duration in both clocks, the counters and the timestamps', () => {
    expect(
      formatTicketMetrics(7560, { ...MOCK_TICKET, id: 7560 }, MOCK_TICKET_METRIC),
    ).toMatchInlineSnapshot(`
      "## Ticket #7560: Test ticket
      - **First reply**: calendar 4m, business 0m
      - **First resolution**: not reached yet
      - **Full resolution**: not reached yet
      - **Agent wait**: not reached yet
      - **Requester wait**: calendar 1d2h7m, business 7h
      - **On hold**: calendar 0m, business 0m
      - **Reopens**: 0 | **Replies**: 1 | **Assignee stations**: 1 | **Group stations**: 2
      - **Created**: 2026-10-16T18:46:26Z | **First assigned**: 2026-10-16T18:53:52Z | **Assigned**: 2026-10-16T18:55:00Z | **Solved**: not yet
      - **Latest comment**: 2026-10-16T18:46:25Z | **Status changed**: 2026-10-16T18:53:52Z
      - **Last update by requester**: 2026-10-16T18:46:25Z | **by assignee**: 2026-10-16T18:53:52Z"
    `);
  });

  it('says which half of a duration is still pending', () => {
    const metric: ZendeskTicketMetric = {
      ticket_id: 1,
      reply_time_in_minutes: { calendar: 12, business: null },
    };
    expect(formatTicketMetrics(1, MOCK_TICKET, metric)).toContain(
      '- **First reply**: calendar 12m, business not reached yet',
    );
  });

  it('keeps the calendar half pending when only business time is recorded', () => {
    const metric: ZendeskTicketMetric = {
      ticket_id: 1,
      on_hold_time_in_minutes: { calendar: null, business: 5 },
    };
    expect(formatTicketMetrics(1, MOCK_TICKET, metric)).toContain(
      '- **On hold**: calendar not reached yet, business 5m',
    );
  });

  it('marks a field Zendesk did not send as not recorded rather than inventing a value', () => {
    expect(formatTicketMetrics(1, MOCK_TICKET, { ticket_id: 1 })).toMatchInlineSnapshot(`
      "## Ticket #1: Test ticket
      - **First reply**: not recorded
      - **First resolution**: not recorded
      - **Full resolution**: not recorded
      - **Agent wait**: not recorded
      - **Requester wait**: not recorded
      - **On hold**: not recorded
      - **Reopens**: not recorded | **Replies**: not recorded | **Assignee stations**: not recorded | **Group stations**: not recorded
      - **Created**: not recorded | **First assigned**: not yet | **Assigned**: not yet | **Solved**: not yet
      - **Latest comment**: not yet | **Status changed**: not yet
      - **Last update by requester**: not yet | **by assignee**: not yet"
    `);
  });

  it('shows the solve time once the ticket is solved', () => {
    const text = formatTicketMetrics(1, MOCK_TICKET, {
      ticket_id: 1,
      solved_at: '2026-10-18T10:00:00Z',
    });
    expect(text).toContain('**Solved**: 2026-10-18T10:00:00Z');
  });

  it('reports a ticket with no metric set', () => {
    expect(formatTicketMetrics(1, MOCK_TICKET, undefined)).toBe(
      '## Ticket #1: Test ticket\n- No metrics recorded for this ticket.',
    );
  });

  it('reports a ticket the caller cannot see', () => {
    expect(formatTicketMetrics(99, undefined, undefined)).toBe(
      '## Ticket #99\n- Not found, or not visible to you.',
    );
  });
});
