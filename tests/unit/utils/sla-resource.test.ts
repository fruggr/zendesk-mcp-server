import { describe, expect, it } from 'vitest';
import {
  NAMED_SCOPES,
  namedAlertsUri,
  parseAlertsUri,
  SLA_ALERTS_TEMPLATES,
} from '../../../src/utils/sla-resource';

describe('alert resource URIs', () => {
  it('names the three templates under zendesk-sla', () => {
    expect(SLA_ALERTS_TEMPLATES).toEqual({
      named: 'zendesk-sla://alerts/{scope}',
      view: 'zendesk-sla://alerts/views/{view}',
      query: 'zendesk-sla://alerts{?query}',
    });
    expect(NAMED_SCOPES.map(namedAlertsUri)).toEqual([
      'zendesk-sla://alerts/mine',
      'zendesk-sla://alerts/my_groups',
      'zendesk-sla://alerts/all',
    ]);
  });

  it.each([
    ['zendesk-sla://alerts/mine', { kind: 'scope', scope: 'mine' }],
    ['zendesk-sla://alerts/my_groups', { kind: 'scope', scope: 'my_groups' }],
    ['zendesk-sla://alerts/all', { kind: 'scope', scope: 'all' }],
    ['zendesk-sla://alerts/views/25', { kind: 'view', view: 25 }],
    ['zendesk-sla://alerts/views/25b', { kind: 'view', view: '25b' }],
    ['zendesk-sla://alerts/views/q25', { kind: 'view', view: 'q25' }],
    [
      'zendesk-sla://alerts/views/Unassigned%20tickets',
      { kind: 'view', view: 'Unassigned tickets' },
    ],
    [
      'zendesk-sla://alerts?query=priority%3Aurgent%20status%3Csolved',
      { kind: 'query', query: 'priority:urgent status<solved' },
    ],
    ['zendesk-sla://alerts/?query=x', { kind: 'query', query: 'x' }],
    // A broken escape in the query decodes leniently, as URLSearchParams does.
    ['zendesk-sla://alerts?query=a%E0%ZZ', { kind: 'query', query: 'a\uFFFD%ZZ' }],
  ])('reads %s', (uri, target) => {
    expect(parseAlertsUri(uri)).toEqual(target);
  });

  it.each([
    'not a uri',
    'zendesk-hc://alerts/mine',
    'zendesk-sla://other/mine',
    'zendesk-sla://alerts/everything',
    'zendesk-sla://alerts/views/',
    'zendesk-sla://alerts/views/1/2',
    'zendesk-sla://alerts',
    'zendesk-sla://alerts?query=%20',
    'zendesk-sla://alerts/mine/extra',
    'zendesk-sla://alerts/x/views/25',
    'zendesk-sla://alerts/views/%E0',
    'zendesk-sla://alerts/views/%ZZ',
  ])('names no alert set: %s', (uri) => {
    expect(parseAlertsUri(uri)).toBeUndefined();
  });
});
