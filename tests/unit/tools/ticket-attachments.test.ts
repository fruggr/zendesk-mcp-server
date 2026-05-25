import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  createTicketAttachmentTools,
  type TicketAttachmentsToolContext,
} from '../../../src/tools/ticket-attachments';
import { buildMarker } from '../../../src/utils/attachment-marker';
import { MOCK_TICKET, MOCK_TICKET_ATTACHMENT_IMAGE } from '../../msw-handlers';
import { mswServer } from '../../setup';

const ctx: TicketAttachmentsToolContext = {
  subdomain: 'testsubdomain',
  getToken: () => 'test-token',
};

const findTool = (name: string, c: TicketAttachmentsToolContext = ctx) => {
  const tool = createTicketAttachmentTools(c).find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

const stubTicket = (id: number) =>
  http.get(`https://testsubdomain.zendesk.com/api/v2/tickets/${id}`, () =>
    HttpResponse.json({ ticket: { ...MOCK_TICKET, id } }),
  );

const stubComments = (id: number, comments: unknown) =>
  http.get(`https://testsubdomain.zendesk.com/api/v2/tickets/${id}/comments`, () =>
    HttpResponse.json({ comments }),
  );

describe('createTicketAttachmentTools', () => {
  it('exposes one tool (record_attachment_analysis)', () => {
    const tools = createTicketAttachmentTools(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('record_attachment_analysis');
  });
});

describe('record_attachment_analysis', () => {
  it('writes an internal note with a marker on first call', async () => {
    let captured: unknown;
    mswServer.use(
      http.put('https://testsubdomain.zendesk.com/api/v2/tickets/1', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: 1 } });
      }),
    );
    const tool = findTool('record_attachment_analysis');
    const result = await tool.handler({
      ticket_id: 1,
      attachment_id: MOCK_TICKET_ATTACHMENT_IMAGE.id,
      analysis: 'Login error dialog.',
      replace_existing: false,
    });
    expect((result.content[0] as { text: string }).text).toContain('recorded');

    const body = captured as { ticket: { comment: { body: string; public: boolean } } };
    expect(body.ticket.comment.public).toBe(false);
    expect(body.ticket.comment.body).toContain('mcp:image-analysis v=1');
    expect(body.ticket.comment.body).toContain(`attachment_id=${MOCK_TICKET_ATTACHMENT_IMAGE.id}`);
    expect(body.ticket.comment.body).toContain('Login error dialog.');
  });

  it('reports missing attachment id', async () => {
    const tool = findTool('record_attachment_analysis');
    const result = await tool.handler({
      ticket_id: 1,
      attachment_id: 999_999,
      analysis: 'whatever',
      replace_existing: false,
    });
    expect((result.content[0] as { text: string }).text).toContain('not found');
  });

  it('is idempotent when an analysis already exists', async () => {
    mswServer.use(
      stubTicket(77),
      stubComments(77, [
        {
          id: 1,
          body: buildMarker(MOCK_TICKET_ATTACHMENT_IMAGE, 'pre-existing'),
          author_id: 1,
          public: false,
          created_at: '2026-05-01T10:00:00Z',
          attachments: [MOCK_TICKET_ATTACHMENT_IMAGE],
        },
      ]),
    );
    const tool = findTool('record_attachment_analysis');
    const result = await tool.handler({
      ticket_id: 77,
      attachment_id: MOCK_TICKET_ATTACHMENT_IMAGE.id,
      analysis: 'New attempt',
      replace_existing: false,
    });
    expect((result.content[0] as { text: string }).text).toContain('already recorded');
  });

  it('overrides an existing analysis when replace_existing is true', async () => {
    let putCount = 0;
    mswServer.use(
      stubTicket(77),
      stubComments(77, [
        {
          id: 1,
          body: buildMarker(MOCK_TICKET_ATTACHMENT_IMAGE, 'old'),
          author_id: 1,
          public: false,
          created_at: '2026-05-01T10:00:00Z',
          attachments: [MOCK_TICKET_ATTACHMENT_IMAGE],
        },
      ]),
      http.put('https://testsubdomain.zendesk.com/api/v2/tickets/77', () => {
        putCount += 1;
        return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: 77 } });
      }),
    );
    const tool = findTool('record_attachment_analysis');
    const result = await tool.handler({
      ticket_id: 77,
      attachment_id: MOCK_TICKET_ATTACHMENT_IMAGE.id,
      analysis: 'refreshed',
      replace_existing: true,
    });
    expect(putCount).toBe(1);
    expect((result.content[0] as { text: string }).text).toContain('recorded');
  });

  it('mirrors to a custom field when analysisFieldId is configured', async () => {
    const calls: Array<{ body: unknown }> = [];
    mswServer.use(
      http.put('https://testsubdomain.zendesk.com/api/v2/tickets/1', async ({ request }) => {
        calls.push({ body: await request.json() });
        return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: 1 } });
      }),
    );
    const tool = findTool('record_attachment_analysis', { ...ctx, analysisFieldId: 999_001 });
    await tool.handler({
      ticket_id: 1,
      attachment_id: MOCK_TICKET_ATTACHMENT_IMAGE.id,
      analysis: 'Mirror me',
      replace_existing: false,
    });
    expect(calls).toHaveLength(2);
    const second = calls[1]?.body as {
      ticket: { custom_fields: Array<{ id: number; value: string }> };
    };
    expect(second.ticket.custom_fields[0]?.id).toBe(999_001);
    const parsed = JSON.parse(second.ticket.custom_fields[0]?.value ?? '{}') as Record<
      string,
      { analysis: string; fingerprint: string }
    >;
    expect(parsed[String(MOCK_TICKET_ATTACHMENT_IMAGE.id)]?.analysis).toBe('Mirror me');
    expect(parsed[String(MOCK_TICKET_ATTACHMENT_IMAGE.id)]?.fingerprint).toContain('image/png');
  });

  it('still succeeds when the custom-field mirror PUT fails (note is canonical)', async () => {
    let putCount = 0;
    mswServer.use(
      http.put('https://testsubdomain.zendesk.com/api/v2/tickets/1', () => {
        putCount += 1;
        if (putCount === 1) return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: 1 } });
        return HttpResponse.json({ error: 'boom' }, { status: 500 });
      }),
    );
    const tool = findTool('record_attachment_analysis', { ...ctx, analysisFieldId: 999_001 });
    const result = await tool.handler({
      ticket_id: 1,
      attachment_id: MOCK_TICKET_ATTACHMENT_IMAGE.id,
      analysis: 'Mirror this',
      replace_existing: false,
    });
    expect(putCount).toBe(2);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('recorded');
    expect(text).toContain('mirror failed');
  });
});
