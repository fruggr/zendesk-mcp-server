import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createRequestTools } from '../../../src/tools/requests';
import {
  MOCK_REQUEST,
  MOCK_TICKET_FIELD_CUSTOM,
  MOCK_TICKET_FORM_BUG,
  MOCK_TICKET_FORM_FEATURE,
} from '../../msw-handlers';
import { mswServer } from '../../setup';

const BASE = 'https://testsubdomain.zendesk.com/api/v2';
const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

const findTool = (name: string) => {
  const tool = createRequestTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

const textOf = async (name: string, params: Record<string, unknown>): Promise<string> => {
  const result = await findTool(name).handler(params);
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
};

describe('createRequestTools', () => {
  it('creates 7 tools', () => {
    expect(createRequestTools(ctx)).toHaveLength(7);
  });

  it('puts every tool in the requests namespace', () => {
    expect(createRequestTools(ctx).every((t) => t.namespace === 'requests')).toBe(true);
  });
});

describe('list_request_forms', () => {
  it('lists the customer-facing name, the id and which form is the default', async () => {
    const text = await textOf('list_request_forms', {});
    expect(text).toContain('Report a bug');
    expect(text).toContain('form id 900');
    expect(text).toContain('default');
    expect(text).toContain('Feature request');
  });

  // display_name is what a customer reads; name is internal. Both are shown
  // when they differ so an agent can map one to the other.
  it('shows the internal name only when it differs from the display name', async () => {
    const text = await textOf('list_request_forms', {});
    expect(text).toContain('Internal name: Bug report (internal)');
    // The feature form has display_name === name, so it gets no second line.
    expect(text).not.toContain('Internal name: Feature request');
  });

  // An account with more forms than fit a page would otherwise have some of
  // them invisible here, and resolveForm would then reject their ids as
  // "not available to you" -- a confident refusal of a form that exists.
  it('pages the form listing rather than showing only the first page', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/ticket_forms`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({
            ticket_forms: [MOCK_TICKET_FORM_BUG],
            next_page: `${BASE}/ticket_forms?page=2`,
          });
        }
        return HttpResponse.json({
          ticket_forms: [{ ...MOCK_TICKET_FORM_BUG, id: 902, display_name: 'Billing question' }],
          next_page: null,
        });
      }),
    );
    const text = await textOf('list_request_forms', {});
    expect(calls).toBe(2);
    expect(text).toContain('Report a bug');
    expect(text).toContain('Billing question');
    expect(text).toContain('2 kind(s) of request available');
  });

  it('can resolve a form that only appears on a later page', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/ticket_forms`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({
              ticket_forms: [MOCK_TICKET_FORM_BUG],
              next_page: `${BASE}/ticket_forms?page=2`,
            })
          : HttpResponse.json({
              ticket_forms: [
                { ...MOCK_TICKET_FORM_BUG, id: 902, display_name: 'Billing question' },
              ],
              next_page: null,
            });
      }),
    );
    const text = await textOf('get_request_form', { form_id: 902 });
    expect(text).toContain('Billing question (form id 902)');
  });

  it('refuses to list forms from a truncated scan', async () => {
    mswServer.use(
      http.get(`${BASE}/ticket_forms`, () =>
        HttpResponse.json({
          ticket_forms: [MOCK_TICKET_FORM_BUG],
          // Always another page: forces the cap.
          next_page: `${BASE}/ticket_forms?page=99`,
        }),
      ),
    );
    await expect(textOf('list_request_forms', {})).rejects.toThrow(
      /could not read all of \/ticket_forms/,
    );
  });

  it('says so plainly when the Help Center exposes no form', async () => {
    mswServer.use(http.get(`${BASE}/ticket_forms`, () => HttpResponse.json({ ticket_forms: [] })));
    const text = await textOf('list_request_forms', {});
    expect(text).toContain('No request form is available to you');
  });

  it('rewrites a 403 into guidance naming the agent-side tools', async () => {
    mswServer.use(
      http.get(`${BASE}/ticket_forms`, () => new HttpResponse('nope', { status: 403 })),
    );
    await expect(textOf('list_request_forms', {})).rejects.toThrow(/create_ticket/);
    await expect(textOf('list_request_forms', {})).rejects.toThrow(/HTTP 403/);
  });
});

describe('get_request_form', () => {
  it('describes the default form when no id is given', async () => {
    const text = await textOf('get_request_form', {});
    expect(text).toContain('Report a bug (form id 900)');
  });

  it('renders the portal label, not the agent title', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('How severe is it? (field id 360000000001)');
  });

  it('marks the portal-required field required and lists it up front', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('**Required**: How severe is it?');
    expect(text).toContain('**required**');
  });

  it('reports a portal-visible but optional field as optional', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('Affected version (field id 360000000002)');
    expect(text).toContain('**optional**');
  });

  // Priority is visible_in_portal: false. An end-user token would not even
  // receive it, but an agent token does, and the same form must be described
  // the same way either way.
  it('drops fields the portal does not show, whoever is asking', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).not.toContain('Priority');
  });

  it('lists the exact values a dropdown accepts', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('Sev-1 → severity_1');
  });

  it('reports conditional rules as rules instead of resolving them', async () => {
    const text = await textOf('get_request_form', { form_id: 901 });
    expect(text).toContain('## Conditional fields');
    // Both sides of the rule are named by their portal label, with the id kept
    // so the rule joins onto the Fields section. A rule reading "when field
    // 360000000003 is yes" is not something an assistant can ask a customer.
    expect(text).toContain(
      'When Is it blocking you? (field id 360000000003) is `yes`: ' +
        'Affected version (field id 360000000002) (then required)',
    );
    // And the field the rule gates on is described in the same output, with the
    // values it accepts -- otherwise the rule names an unanswerable question.
    expect(text).toContain('### Is it blocking you? (field id 360000000003)');
    expect(text).toContain('Yes → yes');
  });

  // The fallback path: a rule may name a field the caller cannot see (an
  // agent-only parent, or one beyond the field scan). It degrades to the bare
  // id rather than dropping the rule or inventing a label.
  it('falls back to the bare field id when the rule names an invisible field', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/ticket_forms', () =>
        HttpResponse.json({
          ticket_forms: [
            {
              ...MOCK_TICKET_FORM_FEATURE,
              end_user_conditions: [
                { parent_field_id: 999999, value: 'x', child_fields: [{ id: 888888 }] },
              ],
            },
          ],
          count: 1,
          next_page: null,
        }),
      ),
    );
    const text = await textOf('get_request_form', { form_id: 901 });
    expect(text).toContain('When field 999999 is `x`: field 888888');
    expect(text).not.toContain('(then required)');
  });

  it('omits the conditional section for a form without conditions', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).not.toContain('## Conditional fields');
  });

  // The bug this guards: every real form carries the system subject and
  // description fields, both portal-required. Treating them as custom fields
  // made create_request demand "Subject (field id 1)" in `custom_fields`,
  // which no caller can satisfy, and made this spec tell them to send it.
  it('does not present the system subject and description as fields to send', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).not.toContain('field id 1)');
    expect(text).not.toContain('field id 2)');
    expect(text).not.toContain('### Subject');
    expect(text).not.toContain('### Description');
  });

  it('says up front that a subject and a description are always needed', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('Always needed: a subject and a description');
  });

  it('lists only the custom fields as required, not the system ones', async () => {
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('**Required**: How severe is it?');
    expect(text).not.toContain('**Required**: Subject');
  });

  it('reports a form with no custom fields as needing nothing more', async () => {
    mswServer.use(
      http.get(`${BASE}/ticket_forms`, () =>
        HttpResponse.json({
          ticket_forms: [{ ...MOCK_TICKET_FORM_BUG, ticket_field_ids: [1, 2] }],
        }),
      ),
    );
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(text).toContain('**Required**: nothing beyond the subject and description.');
    expect(text).toContain('send subject and body only');
  });

  // Reading a form from a partial field list would omit a required field, which
  // validateSubmission would then not enforce -- producing the opaque 422 that
  // check exists to prevent. So it must fail loudly instead.
  it('refuses to describe a form when the field list is truncated', async () => {
    mswServer.use(
      http.get(`${BASE}/ticket_fields`, () =>
        HttpResponse.json({
          ticket_fields: [MOCK_TICKET_FIELD_CUSTOM],
          // Always another page: forces the page cap.
          next_page: `${BASE}/ticket_fields?page=99`,
        }),
      ),
    );
    await expect(textOf('get_request_form', { form_id: 900 })).rejects.toThrow(
      /could not read all of \/ticket_fields/,
    );
  });

  it('refuses an unknown form id and names the ones that exist', async () => {
    await expect(textOf('get_request_form', { form_id: 4242 })).rejects.toThrow(
      /No request form with id 4242/,
    );
    await expect(textOf('get_request_form', { form_id: 4242 })).rejects.toThrow(/Report a bug/);
  });

  // The endpoint's `count` is the unfiltered total and `next_page` is the only
  // honest end-of-list signal, so the walker must follow it across pages.
  it('follows next_page rather than trusting count or a short page', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/ticket_fields`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({
            ticket_fields: [
              {
                id: 360000000001,
                type: 'tagger',
                title: 'Severity',
                description: null,
                active: true,
                required: false,
                visible_in_portal: true,
                required_in_portal: true,
                title_in_portal: 'How severe is it?',
              },
            ],
            // A lie on both counts: more than returned, yet a next page exists.
            count: 99,
            next_page: `${BASE}/ticket_fields?page=2`,
          });
        }
        return HttpResponse.json({
          ticket_fields: [
            {
              id: 360000000002,
              type: 'text',
              title: 'Affected version',
              description: null,
              active: true,
              required: false,
              visible_in_portal: true,
              required_in_portal: false,
            },
          ],
          count: 99,
          next_page: null,
        });
      }),
    );
    const text = await textOf('get_request_form', { form_id: 900 });
    expect(calls).toBe(2);
    expect(text).toContain('How severe is it?');
    expect(text).toContain('Affected version');
  });
});

describe('create_request', () => {
  it('submits and returns the created request with its number', async () => {
    const text = await textOf('create_request', {
      subject: 'Export is broken',
      body: 'Nothing downloads.',
      form_id: 900,
      custom_fields: [{ id: 360000000001, value: 'severity_2' }],
    });
    expect(text).toContain('Request #5010 submitted.');
    expect(text).toContain('Export is broken');
  });

  it('sends the chosen form id through to Zendesk', async () => {
    let sent: Record<string, unknown> | undefined;
    mswServer.use(
      http.post(`${BASE}/requests`, async ({ request }) => {
        const body = (await request.json()) as { request: Record<string, unknown> };
        sent = body.request;
        return HttpResponse.json({ request: { ...MOCK_REQUEST, id: 5010 } });
      }),
    );
    await textOf('create_request', {
      subject: 'S',
      body: 'B',
      form_id: 901,
      custom_fields: [{ id: 360000000002, value: '2.1' }],
    });
    expect(sent?.['ticket_form_id']).toBe(901);
  });

  // Zendesk answers 201 having substituted the default form, so an unknown id
  // has to be caught here or the request lands on the wrong form silently.
  it('refuses an unknown form id rather than letting Zendesk substitute one', async () => {
    await expect(
      textOf('create_request', { subject: 'S', body: 'B', form_id: 4242 }),
    ).rejects.toThrow(/silently substitute the default form/);
  });

  // required_in_portal is enforced by Zendesk only against end users, so an
  // agent-side preview would disagree with what a customer hits. Check locally.
  it('refuses a submission missing a portal-required field, naming it', async () => {
    await expect(
      textOf('create_request', { subject: 'S', body: 'B', form_id: 900 }),
    ).rejects.toThrow(/How severe is it\? \(field id 360000000001\)/);
  });

  // The other half of the blocking bug: with the system fields enforced, this
  // call -- the simplest valid submission there is -- threw.
  it('accepts a submission carrying only subject, body and the custom field', async () => {
    const text = await textOf('create_request', {
      subject: 'Export is broken',
      body: 'Nothing downloads.',
      form_id: 900,
      custom_fields: [{ id: 360000000001, value: 'severity_2' }],
    });
    expect(text).toContain('submitted');
  });

  it('never demands the system subject or description in custom_fields', async () => {
    await expect(
      textOf('create_request', { subject: 'S', body: 'B', form_id: 900 }),
    ).rejects.toThrow(/How severe is it\?/);
    // The error names the custom field only -- not "Subject (field id 1)".
    await expect(
      textOf('create_request', { subject: 'S', body: 'B', form_id: 900 }),
    ).rejects.not.toThrow(/field id 1\)/);
  });

  it('submits a form whose only portal-required fields are the system ones', async () => {
    const text = await textOf('create_request', { subject: 'S', body: 'B', form_id: 901 });
    expect(text).toContain('submitted');
  });

  it('treats an empty value as absent for a required field', async () => {
    await expect(
      textOf('create_request', {
        subject: 'S',
        body: 'B',
        form_id: 900,
        custom_fields: [{ id: 360000000001, value: '' }],
      }),
    ).rejects.toThrow(/requires values the submission does not carry/);
  });

  // Conditional requirements depend on answers we may not have; blocking on
  // them would refuse valid submissions.
  it('does not block on a field required only through a condition', async () => {
    const text = await textOf('create_request', { subject: 'S', body: 'B', form_id: 901 });
    expect(text).toContain('Request #5010 submitted.');
  });

  it('uploads attachments and reports how many were carried', async () => {
    const text = await textOf('create_request', {
      subject: 'S',
      body: 'B',
      form_id: 901,
      attachments: [{ file_name: 'log.txt', file_base64: 'aGVsbG8=', content_type: 'text/plain' }],
    });
    expect(text).toContain('with 1 attachment(s)');
  });
});

describe('list_requests', () => {
  it('lists the requests with their status and solvability', async () => {
    const text = await textOf('list_requests', {
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: 100,
      page: 1,
    });
    expect(text).toContain('Your requests.');
    expect(text).toContain('Request #5001');
    expect(text).toContain('Can you mark it solved**: yes');
  });

  it('switches to the search endpoint when a query is given, and says so', async () => {
    const text = await textOf('list_requests', {
      query: 'export',
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: 100,
      page: 1,
    });
    expect(text).toContain('Searched your requests for "export".');
    expect(text).toContain('Request #5001');
  });

  // The search endpoint otherwise defaults to 15 while the listing defaults to
  // 100; one tool paginating two ways would be a trap.
  it('passes per_page on the search path too, so the page size never differs', async () => {
    let seen: string | null = null;
    mswServer.use(
      http.get(`${BASE}/requests/search`, ({ request }) => {
        seen = new URL(request.url).searchParams.get('per_page');
        return HttpResponse.json({ requests: [MOCK_REQUEST], count: 1 });
      }),
    );
    await textOf('list_requests', {
      query: 'export',
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: 25,
      page: 1,
    });
    expect(seen).toBe('25');
  });

  it('comma-joins the status filter Zendesk expects', async () => {
    let seen: string | null = null;
    mswServer.use(
      http.get(`${BASE}/requests`, ({ request }) => {
        seen = new URL(request.url).searchParams.get('status');
        return HttpResponse.json({ requests: [MOCK_REQUEST], count: 1 });
      }),
    );
    await textOf('list_requests', {
      status: ['open', 'pending'],
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: 100,
      page: 1,
    });
    expect(seen).toBe('open,pending');
  });

  it('reports an empty listing rather than an empty block', async () => {
    const text = await textOf('list_requests', {
      status: ['closed'],
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: 100,
      page: 1,
    });
    expect(text).toContain('You have not submitted any request matching this filter.');
  });

  it('reports an empty search with the query that found nothing', async () => {
    const text = await textOf('list_requests', {
      query: 'nothing',
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: 100,
      page: 1,
    });
    expect(text).toContain('No request of yours matches "nothing".');
  });

  // Zendesk returns EVERY request when it does not recognise a status, so the
  // enum is validated here rather than sent.
  it('rejects a status outside the ticket states', () => {
    const parsed = findTool('list_requests').inputSchema.safeParse({ status: ['bogus'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty status array', () => {
    const parsed = findTool('list_requests').inputSchema.safeParse({ status: [] });
    expect(parsed.success).toBe(false);
  });
});

describe('get_request', () => {
  it('returns the request without its conversation by default', async () => {
    const text = await textOf('get_request', { request_id: 5001, include_comments: false });
    expect(text).toContain('Request #5001');
    expect(text).not.toContain('# Conversation');
  });

  it('appends the conversation when asked', async () => {
    const text = await textOf('get_request', { request_id: 5001, include_comments: true });
    expect(text).toContain('# Conversation');
    expect(text).toContain('Clicking export spins forever');
  });

  // The `users` sideload carries an `agent` flag; that is what tells a support
  // reply from the customer's own comment, without inferring from ids.
  it('names each author and marks the support agents', async () => {
    const text = await textOf('get_request', { request_id: 5001, include_comments: true });
    expect(text).toContain('Comment by Dana Customer');
    expect(text).toContain('Comment by Sam Support (support agent)');
  });

  it('lists a comment attachment by name', async () => {
    const text = await textOf('get_request', { request_id: 5001, include_comments: true });
    expect(text).toContain('diagnostic.txt');
  });

  // The description promises "every public message", so a thread longer than one
  // page must be walked rather than silently cut off.
  it('pages the conversation and accumulates authors across pages', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/requests/:id/comments`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({
            comments: [{ id: 1, body: 'First', author_id: 456, public: true, created_at: 'day1' }],
            users: [{ id: 456, name: 'Dana Customer', agent: false }],
            next_page: `${BASE}/requests/5001/comments?page=2`,
          });
        }
        return HttpResponse.json({
          comments: [{ id: 2, body: 'Second', author_id: 789, public: true, created_at: 'day2' }],
          // An author who appears only on the later page.
          users: [{ id: 789, name: 'Sam Support', agent: true }],
          next_page: null,
        });
      }),
    );
    const text = await textOf('get_request', { request_id: 5001, include_comments: true });
    expect(calls).toBe(2);
    expect(text).toContain('First');
    expect(text).toContain('Second');
    expect(text).toContain('Comment by Dana Customer');
    expect(text).toContain('Comment by Sam Support (support agent)');
  });

  // The same failure the form and field walks refuse: a partial thread on the
  // one tool whose description promises "every public message".
  it('refuses a conversation it could not read to the end', async () => {
    mswServer.use(
      http.get(`${BASE}/requests/:id/comments`, () =>
        HttpResponse.json({
          comments: [{ id: 1, body: 'First', author_id: 456, public: true, created_at: 'day1' }],
          users: [{ id: 456, name: 'Dana Customer', agent: false }],
          // Always another page: forces the cap.
          next_page: `${BASE}/requests/5001/comments?page=99`,
        }),
      ),
    );
    await expect(
      textOf('get_request', { request_id: 5001, include_comments: true }),
    ).rejects.toThrow(/could not read all of \/requests\/5001\/comments/);
  });

  it('names the comment page cap variable, not the field one, when it truncates', async () => {
    mswServer.use(
      http.get(`${BASE}/requests/:id/comments`, () =>
        HttpResponse.json({
          comments: [],
          next_page: `${BASE}/requests/5001/comments?page=99`,
        }),
      ),
    );
    await expect(
      textOf('get_request', { request_id: 5001, include_comments: true }),
    ).rejects.toThrow(/ZENDESK_MAX_COMMENT_PAGES/);
  });

  it('falls back to the author id when the sideload is absent', async () => {
    mswServer.use(
      http.get(`${BASE}/requests/:id/comments`, () =>
        HttpResponse.json({
          comments: [{ id: 1, body: 'Hi', author_id: 456, public: true, created_at: 'now' }],
        }),
      ),
    );
    const text = await textOf('get_request', { request_id: 5001, include_comments: true });
    expect(text).toContain('Comment by user 456');
  });

  it('rewrites a 403 into end-user guidance', async () => {
    mswServer.use(
      http.get(`${BASE}/requests/:id`, () => new HttpResponse('nope', { status: 403 })),
    );
    await expect(
      textOf('get_request', { request_id: 5001, include_comments: false }),
    ).rejects.toThrow(/end-user Requests surface/);
  });
});

describe('add_request_comment', () => {
  it('replies and reports the status the request is in afterwards', async () => {
    const text = await textOf('add_request_comment', { request_id: 5001, body: 'Still broken.' });
    expect(text).toContain('Reply added to request #5001');
    expect(text).toContain('It is now **open**');
  });

  it('carries attachments on the reply', async () => {
    const text = await textOf('add_request_comment', {
      request_id: 5001,
      body: 'Log attached.',
      attachments: [{ file_name: 'log.txt', file_base64: 'aGVsbG8=', content_type: 'text/plain' }],
    });
    expect(text).toContain('with 1 attachment(s)');
  });
});

describe('mark_request_solved', () => {
  it('solves a solvable request and reads the status back', async () => {
    const text = await textOf('mark_request_solved', { request_id: 5001 });
    expect(text).toContain('Request #5001 is now **solved**.');
  });

  // The sharp case: Zendesk answers 200 and changes nothing, so sending it
  // would report a success that never happened.
  it('refuses an unassigned request instead of reporting a phantom success', async () => {
    let put = false;
    mswServer.use(
      http.put(`${BASE}/requests/:id`, () => {
        put = true;
        return HttpResponse.json({ request: MOCK_REQUEST });
      }),
    );
    const text = await textOf('mark_request_solved', { request_id: 5002 });
    expect(text).toContain('cannot be marked solved by you');
    expect(text).toContain('add_request_comment');
    expect(put).toBe(false);
  });

  it('treats an already-solved request as a no-op', async () => {
    const text = await textOf('mark_request_solved', { request_id: 5003 });
    expect(text).toContain('already **solved**');
  });

  // Verified from the response body, not assumed from the 2xx.
  it('reports the truth when Zendesk accepts the update but does not solve it', async () => {
    mswServer.use(
      http.put(`${BASE}/requests/:id`, () =>
        HttpResponse.json({ request: { ...MOCK_REQUEST, status: 'open' } }),
      ),
    );
    const text = await textOf('mark_request_solved', { request_id: 5001 });
    expect(text).toContain('still **open**');
    expect(text).toContain('so it was not solved');
  });
});

describe('the form fixture', () => {
  // Guards the tests above: they assume this form is the default and carries
  // both a required and an optional portal field.
  it('is the default form and carries the fields the tests rely on', () => {
    expect(MOCK_TICKET_FORM_BUG.default).toBe(true);
    expect(MOCK_TICKET_FORM_BUG.ticket_field_ids).toContain(360000000001);
    expect(MOCK_TICKET_FORM_BUG.ticket_field_ids).toContain(360000000002);
  });
});
