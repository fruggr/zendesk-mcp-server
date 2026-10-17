import { describe, expect, it } from 'vitest';
import {
  type AlertTicket,
  alertFingerprint,
  mergeSnapshots,
  renderAlerts,
  selectAlerts,
  toAlertTicket,
} from '../../../src/utils/sla-alerts';
import { DEFAULT_SLA_THRESHOLDS } from '../../../src/utils/sla-thresholds';
import { MOCK_TICKET } from '../../msw-handlers';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const ticket = (id: number, metrics: [string, number, string?][]): AlertTicket => ({
  id,
  subject: `Subject ${id}`,
  status: 'open',
  priority: id % 2 ? 'high' : null,
  metrics: metrics.map(([metric, minutes, stage = 'active']) => ({
    metric,
    stage,
    breach_at: at(minutes),
  })),
});
const select = (tickets: AlertTicket[], filter = { includeBreached: true }) =>
  selectAlerts(tickets, DEFAULT_SLA_THRESHOLDS, NOW, filter);
const summary = (alerts: ReturnType<typeof select>) =>
  alerts.map((a) => `${a.ticket.id}:${a.urgency.metric}:${a.urgency.level}`);

describe('toAlertTicket', () => {
  it('keeps what the alerts need and the live metrics', () => {
    const slas = {
      policy_metrics: [{ metric: 'first_reply_time', stage: 'active', breach_at: at(5) }],
    };
    expect(toAlertTicket({ ...MOCK_TICKET, slas })).toEqual({
      id: 1,
      subject: 'Test ticket',
      status: 'open',
      priority: 'normal',
      metrics: slas.policy_metrics,
    });
  });

  it('reads a ticket with no SLA as having no metrics', () => {
    expect(toAlertTicket(MOCK_TICKET).metrics).toEqual([]);
  });
});

describe('mergeSnapshots', () => {
  it('keeps each ticket once, first seen wins, and adds up the unread', () => {
    const a = ticket(1, []);
    const b = ticket(2, []);
    const merged = mergeSnapshots([
      { tickets: [a, b], truncated: false, unread: 0 },
      { tickets: [{ ...a, subject: 'dup' }, ticket(3, [])], truncated: true, unread: 4 },
    ]);
    expect(merged.tickets.map((t) => [t.id, t.subject])).toEqual([
      [1, 'Subject 1'],
      [2, 'Subject 2'],
      [3, 'Subject 3'],
    ]);
    expect(merged.truncated).toBe(true);
    expect(merged.unread).toBe(4);
  });

  it('merges nothing into an empty snapshot', () => {
    expect(mergeSnapshots([])).toEqual({ tickets: [], truncated: false, unread: 0 });
  });
});

describe('selectAlerts', () => {
  const tickets = [
    ticket(1, [
      ['first_reply_time', 30],
      ['requester_wait_time', 10_000],
    ]),
    ticket(2, [['requester_wait_time', -60]]),
    ticket(3, [
      ['next_reply_time', 200],
      ['first_reply_time', -5, 'paused'],
    ]),
    ticket(4, [['agent_work_time', 100]]),
    ticket(5, [['first_reply_time', 30]]),
  ];

  it('lists one alert per urgent running metric, by level then soonest breach then ticket', () => {
    expect(summary(select(tickets))).toEqual([
      '2:requester_wait_time:BREACHED',
      '1:first_reply_time:CRITICAL',
      '5:first_reply_time:CRITICAL',
      '4:agent_work_time:CRITICAL',
      '3:next_reply_time:WARNING',
    ]);
  });

  it('breaks a tie on the ticket id, whatever order the tickets came in', () => {
    const tied = [ticket(8, [['first_reply_time', 30]]), ticket(3, [['first_reply_time', 30]])];
    expect(summary(select(tied))).toEqual([
      '3:first_reply_time:CRITICAL',
      '8:first_reply_time:CRITICAL',
    ]);
    expect(summary(select([...tied].reverse()))).toEqual(summary(select(tied)));
  });

  it('drops the breached ones when asked', () => {
    expect(summary(select(tickets, { includeBreached: false }))[0]).toBe(
      '1:first_reply_time:CRITICAL',
    );
  });

  it('keeps only what breaches within the window, breached ones aside', () => {
    expect(summary(select(tickets, { includeBreached: true, withinMinutes: 30 } as never))).toEqual(
      [
        '2:requester_wait_time:BREACHED',
        '1:first_reply_time:CRITICAL',
        '5:first_reply_time:CRITICAL',
      ],
    );
    expect(
      summary(select(tickets, { includeBreached: false, withinMinutes: 29 } as never)),
    ).toEqual([]);
  });
});

describe('alertFingerprint', () => {
  it('names ticket, metric and level, in a stable order', () => {
    const alerts = select([
      ticket(9, [['first_reply_time', 30]]),
      ticket(10, [['agent_work_time', -1]]),
    ]);
    expect(alertFingerprint(alerts)).toBe(
      '10:agent_work_time:BREACHED|9:first_reply_time:CRITICAL',
    );
    expect(alertFingerprint([...alerts].reverse())).toBe(alertFingerprint(alerts));
  });

  it('ignores the minutes counting down', () => {
    const before = select([ticket(1, [['first_reply_time', 50]])]);
    const later = select([ticket(1, [['first_reply_time', 20]])]);
    expect(alertFingerprint(later)).toBe(alertFingerprint(before));
  });

  it('changes when a level changes', () => {
    const critical = select([ticket(1, [['first_reply_time', 50]])]);
    const breached = select([ticket(1, [['first_reply_time', -1]])]);
    expect(alertFingerprint(breached)).not.toBe(alertFingerprint(critical));
  });
});

describe('renderAlerts', () => {
  const report = {
    scopeLabel: 'your assigned unsolved tickets',
    checked: 5,
    truncated: false,
    unread: 0,
    thresholds: 'reply warning 4h (server default)',
    notes: [],
    maxLines: 100,
  };

  it('summarises, then lists each level with its alerts', () => {
    const tickets = [
      ticket(1, [['first_reply_time', 30]]),
      ticket(2, [['requester_wait_time', -90]]),
    ];
    expect(renderAlerts(select(tickets), report)).toMatchInlineSnapshot(`
      "SLA alerts for your assigned unsolved tickets: 1 breached, 1 critical, 0 warning (5 ticket(s) checked).
      Thresholds: reply warning 4h (server default).

      ## BREACHED
      - #2 requester_wait_time overdue by 1h30m (due 2026-10-17T10:30:00.000Z) — "Subject 2" [open, no priority]

      ## CRITICAL
      - #1 first_reply_time due in 30m (due 2026-10-17T12:30:00.000Z) — "Subject 1" [open, high]"
    `);
  });

  it('says so when nothing is urgent, after the notes', () => {
    expect(renderAlerts([], { ...report, notes: ['A note.'] })).toBe(
      'SLA alerts for your assigned unsolved tickets: 0 breached, 0 critical, 0 warning (5 ticket(s) checked).\n' +
        'Thresholds: reply warning 4h (server default).\n' +
        'A note.\n\n' +
        'No running SLA metric is breached or within its thresholds.',
    );
  });

  it('warns when part of the scope was not read', () => {
    expect(renderAlerts([], { ...report, truncated: true, unread: 42 })).toContain(
      'Truncated: 42 more ticket(s) in this scope were not read. Narrow it with query or view to see them.',
    );
    expect(renderAlerts([], { ...report, truncated: true, unread: 0 })).toContain(
      'Truncated: More tickets in this scope were not read.',
    );
    expect(renderAlerts([], report)).not.toContain('Truncated');
  });

  it('counts the alerts past the line cap instead of listing them', () => {
    const tickets = [1, 2, 3].map((id) => ticket(id, [['first_reply_time', id]]));
    const text = renderAlerts(select(tickets), { ...report, maxLines: 2 });
    expect(text).toContain('- #2 first_reply_time');
    expect(text).not.toContain('- #3 ');
    expect(
      text.endsWith(
        '\n\n1 more alert(s) not listed. Narrow the scope with query or view, or shorten within.',
      ),
    ).toBe(true);
    expect(renderAlerts(select(tickets), { ...report, maxLines: 3 })).not.toContain('not listed');
  });
});
