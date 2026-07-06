import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createTicketTools } from '../../../src/tools/tickets';
import { MOCK_SLA_SIDELOAD, MOCK_TICKET, MOCK_UPLOAD } from '../../msw-handlers';
import { mswServer } from '../../setup';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

const findTool = (name: string) => {
  const tools = createTicketTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

const getAllText = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content
    .filter((c) => c.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');

describe('ticket tools', () => {
  it('creates 11 tools (search_tickets lives here; the unified search is elsewhere)', () => {
    const tools = createTicketTools(ctx);
    expect(tools).toHaveLength(11);
  });

  describe('get_ticket', () => {
    it('returns ticket details', async () => {
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: false });
      expect(result.content[0]?.text).toContain('Ticket #1');
      expect(result.content[0]?.text).toContain('Test ticket');
    });

    it('surfaces live SLA state resolved via the scoped search fallback', async () => {
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: false });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('### SLA');
      expect(text).toContain('requester_wait_time');
      expect(text).toContain('remaining');
    });

    it('omits the SLA block when the ticket is not in the fallback search window', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/search', () =>
          // A result for a *different* ticket id — correlation must not match.
          HttpResponse.json({ results: [{ ...MOCK_TICKET, id: 999, slas: MOCK_SLA_SIDELOAD }] }),
        ),
      );
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: false });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Ticket #1');
      expect(text).not.toContain('### SLA');
    });

    it('still returns the ticket when the SLA fallback search errors', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/search', () =>
          HttpResponse.json({}, { status: 500 }),
        ),
      );
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: false });
      const text = result.content[0]?.text ?? '';
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Ticket #1');
      expect(text).not.toContain('### SLA');
    });

    it('includes comments when requested', async () => {
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: true });
      expect(result.content[0]?.text).toContain('Comments');
      expect(result.content[0]?.text).toContain('This is a comment');
    });

    it('requests inline images when include_comments is set', async () => {
      let inlineParam: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', ({ request }) => {
          inlineParam = new URL(request.url).searchParams.get('include_inline_images');
          return HttpResponse.json({ comments: [] });
        }),
      );
      const tool = findTool('get_ticket');
      await tool.handler({ ticket_id: 1, include_comments: true });
      expect(inlineParam).toBe('true');
    });

    it('has readOnly annotation', () => {
      const tool = findTool('get_ticket');
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe('get_ticket_attachments', () => {
    it('requests inline images from the comments endpoint', async () => {
      let inlineParam: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', ({ request }) => {
          inlineParam = new URL(request.url).searchParams.get('include_inline_images');
          return HttpResponse.json({ comments: [] });
        }),
      );
      const tool = findTool('get_ticket_attachments');
      await tool.handler({ ticket_id: 1 });
      expect(inlineParam).toBe('true');
    });

    it('returns image content for image attachments', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const imageBlocks = result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      const image = imageBlocks[0] as { type: 'image'; data: string; mimeType: string };
      expect(image.mimeType).toBe('image/png');
      expect(image.data.length).toBeGreaterThan(0);
    });

    it('includes content_url in caption of embedded images', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const allText = getAllText(result);
      expect(allText).toContain(
        'https://testsubdomain.zendesk.com/attachments/token/abc/?name=screenshot.png',
      );
    });

    it('returns text reference for non-image attachments', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const allText = getAllText(result);
      expect(allText).toContain('report.pdf');
      expect(allText).toContain('application/pdf');
      expect(allText).toContain(
        'https://testsubdomain.zendesk.com/attachments/token/def/?name=report.pdf',
      );
    });

    it('respects MAX_ATTACHMENT_BYTES for oversize images', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const allText = getAllText(result);
      expect(allText).toContain('huge.png');
      expect(allText).toContain('skipped: exceeds 5 MB per-image limit');
      const imageBlocks = result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(1);
    });

    it('caps embedded image count to MAX_EMBEDDED_IMAGE_COUNT', async () => {
      const manyImages = Array.from({ length: 12 }, (_, i) => ({
        id: 40000 + i,
        file_name: `img-${i}.png`,
        content_url: `https://testsubdomain.zendesk.com/attachments/token/abc/?name=img-${i}.png`,
        content_type: 'image/png',
        size: 1024,
        inline: false,
      }));
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
          HttpResponse.json({
            comments: [
              {
                id: 1,
                body: '',
                author_id: 1,
                public: true,
                created_at: '2026-01-01T00:00:00Z',
                attachments: manyImages,
              },
            ],
          }),
        ),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const imageBlocks = result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(10);
      const allText = getAllText(result);
      expect(allText).toContain('skipped: max 10 embedded images reached');
    });

    it('paginates through all pages of comments', async () => {
      const page1Attachment = {
        id: 60001,
        file_name: 'page1.png',
        content_url: 'https://testsubdomain.zendesk.com/attachments/token/p1/?name=page1.png',
        content_type: 'image/png',
        size: 1024,
        inline: false,
      };
      const page2Attachment = {
        id: 60002,
        file_name: 'page2.png',
        content_url: 'https://testsubdomain.zendesk.com/attachments/token/p2/?name=page2.png',
        content_type: 'image/png',
        size: 1024,
        inline: false,
      };
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', ({ request }) => {
          const cursor = new URL(request.url).searchParams.get('page[after]');
          if (!cursor) {
            return HttpResponse.json({
              comments: [
                {
                  id: 1,
                  body: '',
                  author_id: 1,
                  public: true,
                  created_at: '2026-01-01T00:00:00Z',
                  attachments: [page1Attachment],
                },
              ],
              meta: { has_more: true, after_cursor: 'CURSOR_2' },
            });
          }
          return HttpResponse.json({
            comments: [
              {
                id: 2,
                body: '',
                author_id: 1,
                public: true,
                created_at: '2026-01-02T00:00:00Z',
                attachments: [page2Attachment],
              },
            ],
            meta: { has_more: false, after_cursor: null },
          });
        }),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const allText = getAllText(result);
      expect(allText).toContain('page1.png');
      expect(allText).toContain('page2.png');
      expect(allText).toContain('# Attachments for ticket #1 (2 total)');
    });

    it('falls back to a text reference when binary download fails', async () => {
      const goodImage = {
        id: 80001,
        file_name: 'good.png',
        content_url: 'https://testsubdomain.zendesk.com/attachments/token/good/?name=good.png',
        content_type: 'image/png',
        size: 1024,
        inline: false,
      };
      const brokenImage = {
        id: 80002,
        file_name: 'broken.png',
        content_url: 'https://testsubdomain.zendesk.com/attachments/token/broken/?name=broken.png',
        content_type: 'image/png',
        size: 1024,
        inline: false,
      };
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
          HttpResponse.json({
            comments: [
              {
                id: 1,
                body: '',
                author_id: 1,
                public: true,
                created_at: '2026-01-01T00:00:00Z',
                attachments: [goodImage, brokenImage],
              },
            ],
          }),
        ),
        http.get('https://testsubdomain.zendesk.com/attachments/token/good/', () =>
          HttpResponse.arrayBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, {
            headers: { 'content-type': 'image/png' },
          }),
        ),
        http.get('https://testsubdomain.zendesk.com/attachments/token/broken/', () =>
          HttpResponse.text('Not Found', { status: 404, statusText: 'Not Found' }),
        ),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const imageBlocks = result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      const allText = getAllText(result);
      expect(allText).toContain('good.png');
      expect(allText).toContain('broken.png');
      expect(allText).toContain('download failed: 404');
    });

    it('fetches attachments directly via /attachments/:id when attachment_ids is provided', async () => {
      let commentsCallCount = 0;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () => {
          commentsCallCount += 1;
          return HttpResponse.json({ comments: [] });
        }),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1, attachment_ids: [30001, 30002] });
      expect(commentsCallCount).toBe(0);
      const allText = getAllText(result);
      expect(allText).toContain('# Attachments for ticket #1 (2 total)');
      expect(allText).toContain('screenshot.png');
      expect(allText).toContain('report.pdf');
    });

    it('fail-softs on unknown attachment_ids', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1, attachment_ids: [30001, 999999] });
      const allText = getAllText(result);
      expect(allText).toContain('# Attachments for ticket #1 (1 total)');
      expect(allText).toContain('screenshot.png');
      expect(allText).not.toContain('999999');
    });

    it('returns "no attachments" when all attachment_ids are unknown', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1, attachment_ids: [999999] });
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as { text: string }).text).toContain('No attachments found');
    });

    it('preserves order and image/caption pairing across multiple images', async () => {
      const images = [
        {
          id: 90001,
          file_name: 'first.png',
          content_url: 'https://testsubdomain.zendesk.com/attachments/token/p1/?name=first.png',
          content_type: 'image/png',
          size: 100,
          inline: false,
        },
        {
          id: 90002,
          file_name: 'second.png',
          content_url: 'https://testsubdomain.zendesk.com/attachments/token/p2/?name=second.png',
          content_type: 'image/png',
          size: 200,
          inline: false,
        },
        {
          id: 90003,
          file_name: 'third.png',
          content_url: 'https://testsubdomain.zendesk.com/attachments/token/p3/?name=third.png',
          content_type: 'image/png',
          size: 300,
          inline: false,
        },
      ];
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
          HttpResponse.json({
            comments: [
              {
                id: 1,
                body: '',
                author_id: 1,
                public: true,
                created_at: '2026-01-01T00:00:00Z',
                attachments: images,
              },
            ],
          }),
        ),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      expect(result.content).toHaveLength(7);
      expect(result.content[0]).toMatchObject({ type: 'text' });
      expect((result.content[0] as { text: string }).text).toContain(
        '# Attachments for ticket #1 (3 total)',
      );
      expect(result.content[1]).toMatchObject({ type: 'image' });
      expect((result.content[2] as { text: string }).text).toContain('first.png');
      expect(result.content[3]).toMatchObject({ type: 'image' });
      expect((result.content[4] as { text: string }).text).toContain('second.png');
      expect(result.content[5]).toMatchObject({ type: 'image' });
      expect((result.content[6] as { text: string }).text).toContain('third.png');
    });

    it('handles comments where the attachments field is omitted', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
          HttpResponse.json({
            comments: [
              {
                id: 1,
                body: 'no attachments key',
                author_id: 1,
                public: true,
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
          }),
        ),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as { text: string }).text).toContain('No attachments found');
    });

    it('returns "no attachments" message when ticket has none', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
          HttpResponse.json({
            comments: [
              { id: 99, body: '', author_id: 1, public: true, created_at: '2026-01-01T00:00:00Z' },
            ],
          }),
        ),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as { text: string }).text).toContain('No attachments found');
    });

    it('has readOnly annotation', () => {
      const tool = findTool('get_ticket_attachments');
      expect(tool.annotations.readOnlyHint).toBe(true);
    });

    describe('env-configurable guardrails', () => {
      // The caps are read from process.env at module load, so overrides must be
      // stubbed before a fresh import of the tool module.
      afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
      });

      const loadAttachmentsTool = async () => {
        const { createTicketTools } = await import('../../../src/tools/tickets');
        const tool = createTicketTools(ctx).find((t) => t.name === 'get_ticket_attachments');
        if (!tool) throw new Error('get_ticket_attachments not found');
        return tool;
      };

      it('honors ZENDESK_MAX_EMBEDDED_IMAGES', async () => {
        vi.resetModules();
        vi.stubEnv('ZENDESK_MAX_EMBEDDED_IMAGES', '2');
        const manyImages = Array.from({ length: 12 }, (_, i) => ({
          id: 41000 + i,
          file_name: `img-${i}.png`,
          content_url: `https://testsubdomain.zendesk.com/attachments/token/abc/?name=img-${i}.png`,
          content_type: 'image/png',
          size: 1024,
          inline: false,
        }));
        mswServer.use(
          http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
            HttpResponse.json({
              comments: [
                {
                  id: 1,
                  body: '',
                  author_id: 1,
                  public: true,
                  created_at: '2026-01-01T00:00:00Z',
                  attachments: manyImages,
                },
              ],
            }),
          ),
        );
        const tool = await loadAttachmentsTool();
        const result = await tool.handler({ ticket_id: 1 });
        const imageBlocks = result.content.filter((c) => c.type === 'image');
        expect(imageBlocks).toHaveLength(2);
        expect(getAllText(result)).toContain('skipped: max 2 embedded images reached');
      });

      it('falls back to the default cap when the override is empty or non-numeric', async () => {
        vi.resetModules();
        // Empty string is not caught by `??`; a raw Number() would yield 0 and
        // skip every image. It must fall back to the 10-image default instead.
        vi.stubEnv('ZENDESK_MAX_EMBEDDED_IMAGES', '');
        vi.stubEnv('ZENDESK_MAX_ATTACHMENT_BYTES', 'not-a-number');
        const manyImages = Array.from({ length: 12 }, (_, i) => ({
          id: 42000 + i,
          file_name: `img-${i}.png`,
          content_url: `https://testsubdomain.zendesk.com/attachments/token/abc/?name=img-${i}.png`,
          content_type: 'image/png',
          size: 1024,
          inline: false,
        }));
        mswServer.use(
          http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
            HttpResponse.json({
              comments: [
                {
                  id: 1,
                  body: '',
                  author_id: 1,
                  public: true,
                  created_at: '2026-01-01T00:00:00Z',
                  attachments: manyImages,
                },
              ],
            }),
          ),
        );
        const tool = await loadAttachmentsTool();
        const result = await tool.handler({ ticket_id: 1 });
        const imageBlocks = result.content.filter((c) => c.type === 'image');
        expect(imageBlocks).toHaveLength(10);
        expect(getAllText(result)).toContain('skipped: max 10 embedded images reached');
      });

      it('honors ZENDESK_MAX_ATTACHMENT_BYTES (with a dynamic skip message)', async () => {
        vi.resetModules();
        vi.stubEnv('ZENDESK_MAX_ATTACHMENT_BYTES', String(2 * 1024 * 1024));
        const midImage = {
          id: 71000,
          file_name: 'mid.png',
          content_url: 'https://testsubdomain.zendesk.com/attachments/token/mid/?name=mid.png',
          content_type: 'image/png',
          size: 3 * 1024 * 1024,
          inline: false,
        };
        mswServer.use(
          http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', () =>
            HttpResponse.json({
              comments: [
                {
                  id: 1,
                  body: '',
                  author_id: 1,
                  public: true,
                  created_at: '2026-01-01T00:00:00Z',
                  attachments: [midImage],
                },
              ],
            }),
          ),
        );
        const tool = await loadAttachmentsTool();
        const result = await tool.handler({ ticket_id: 1 });
        const imageBlocks = result.content.filter((c) => c.type === 'image');
        expect(imageBlocks).toHaveLength(0);
        expect(getAllText(result)).toContain('exceeds 2 MB per-image limit');
      });
    });
  });

  describe('search_tickets', () => {
    it('searches with query prefix', async () => {
      const tool = findTool('search_tickets');
      const result = await tool.handler({ query: 'status:open', per_page: 100, page: 1 });
      expect(result.content[0]?.text).toContain('Test ticket');
    });

    it('surfaces per-result SLA state for queue triage', async () => {
      const tool = findTool('search_tickets');
      const result = await tool.handler({ query: 'status:open', per_page: 100, page: 1 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('### SLA');
      expect(text).toContain('requester_wait_time');
    });
  });

  describe('list_sla_policies', () => {
    it('returns the policy matrix with conditions and targets', async () => {
      const tool = findTool('list_sla_policies');
      const result = await tool.handler({ per_page: 100, page: 1 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('SLA contractuels fruggr - Bugs/Incidents');
      expect(text).toContain('first_reply_time');
      expect(text).toContain('420 min');
      expect(text).toContain('type is incident');
    });

    it('has readOnly annotation', () => {
      const tool = findTool('list_sla_policies');
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
    });

    it('explains the admin-only requirement (and the alternative) on a 403', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/slas/policies', () =>
          HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
        ),
      );
      const tool = findTool('list_sla_policies');
      const error = await tool.handler({ per_page: 100, page: 1 }).then(
        () => {
          throw new Error('expected list_sla_policies to reject on 403');
        },
        (err: unknown) => err as Error,
      );
      expect(error.message).toMatch(/admin/i);
      expect(error.message).toMatch(/get_ticket|search_tickets/);
    });
  });

  describe('create_ticket', () => {
    it('creates a ticket and returns its id', async () => {
      const tool = findTool('create_ticket');
      const result = await tool.handler({ subject: 'New bug', description: 'Details' });
      expect(result.content[0]?.text).toContain('Ticket #42 created');
    });

    it('is not readOnly', () => {
      const tool = findTool('create_ticket');
      expect(tool.readOnly).toBe(false);
    });
  });

  describe('update_ticket', () => {
    it('updates and returns ticket', async () => {
      const tool = findTool('update_ticket');
      const result = await tool.handler({ ticket_id: 1, status: 'solved' });
      expect(result.content[0]?.text).toContain('updated');
    });
  });

  describe('add_private_note', () => {
    it('adds a note', async () => {
      const tool = findTool('add_private_note');
      const result = await tool.handler({ ticket_id: 1, body: 'Internal note' });
      expect(result.content[0]?.text).toContain('Private note added');
    });

    it('uploads and attaches a file to the note (kept private)', async () => {
      let putBody: Record<string, unknown> | undefined;
      mswServer.use(
        http.put(
          'https://testsubdomain.zendesk.com/api/v2/tickets/:id',
          async ({ request, params }) => {
            putBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: Number(params['id']) } });
          },
        ),
      );
      const tool = findTool('add_private_note');
      const result = await tool.handler({
        ticket_id: 1,
        body: 'Internal note',
        attachments: [
          {
            file_name: 'trace.log',
            file_base64: Buffer.from('boom').toString('base64'),
            content_type: 'text/plain',
          },
        ],
      });
      expect(result.content[0]?.text).toContain('with 1 attachment(s)');
      const comment = (putBody?.['ticket'] as Record<string, unknown>)['comment'] as Record<
        string,
        unknown
      >;
      expect(comment['uploads']).toEqual(['mock-upload-token']);
      expect(comment['public']).toBe(false);
    });
  });

  describe('add_public_comment', () => {
    it('adds a comment', async () => {
      const tool = findTool('add_public_comment');
      const result = await tool.handler({ ticket_id: 1, body: 'Public reply' });
      expect(result.content[0]?.text).toContain('Public comment added');
    });

    it('uploads and attaches a file to the comment', async () => {
      let putBody: Record<string, unknown> | undefined;
      mswServer.use(
        http.put(
          'https://testsubdomain.zendesk.com/api/v2/tickets/:id',
          async ({ request, params }) => {
            putBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: Number(params['id']) } });
          },
        ),
      );
      const tool = findTool('add_public_comment');
      const result = await tool.handler({
        ticket_id: 1,
        body: 'See attached',
        attachments: [
          {
            file_name: 'a.log',
            file_base64: Buffer.from('hello').toString('base64'),
            content_type: 'text/plain',
          },
        ],
      });
      expect(result.content[0]?.text).toContain('with 1 attachment(s)');
      const comment = (putBody?.['ticket'] as Record<string, unknown>)['comment'] as Record<
        string,
        unknown
      >;
      expect(comment['uploads']).toEqual(['mock-upload-token']);
      expect(comment['public']).toBe(true);
    });

    it('rejects an attachment with an empty content_type', () => {
      const tool = findTool('add_public_comment');
      const result = tool.inputSchema.safeParse({
        ticket_id: 1,
        body: 'x',
        attachments: [{ file_name: 'a.txt', file_base64: 'aGk=', content_type: '' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an attachment whose file_base64 is not valid base64', () => {
      const tool = findTool('add_public_comment');
      const result = tool.inputSchema.safeParse({
        ticket_id: 1,
        body: 'x',
        attachments: [
          { file_name: 'a.txt', file_base64: 'not base64!!', content_type: 'text/plain' },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('defaults content_type when omitted on an attachment', () => {
      const tool = findTool('add_public_comment');
      const parsed = tool.inputSchema.parse({
        ticket_id: 1,
        body: 'x',
        attachments: [{ file_name: 'a.txt', file_base64: 'aGk=' }],
      }) as { attachments: Array<{ content_type: string }> };
      expect(parsed.attachments[0]?.content_type).toBe('application/octet-stream');
    });

    it('aggregates multiple files under a single upload token', async () => {
      const uploadReqs: { filename: string | null; token: string | null }[] = [];
      let putBody: Record<string, unknown> | undefined;
      mswServer.use(
        http.post('https://testsubdomain.zendesk.com/api/v2/uploads', ({ request }) => {
          const url = new URL(request.url);
          uploadReqs.push({
            filename: url.searchParams.get('filename'),
            token: url.searchParams.get('token'),
          });
          return HttpResponse.json({ upload: MOCK_UPLOAD });
        }),
        http.put(
          'https://testsubdomain.zendesk.com/api/v2/tickets/:id',
          async ({ request, params }) => {
            putBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ ticket: { ...MOCK_TICKET, id: Number(params['id']) } });
          },
        ),
      );
      const tool = findTool('add_public_comment');
      const b64 = Buffer.from('x').toString('base64');
      await tool.handler({
        ticket_id: 1,
        body: 'multi',
        attachments: [
          { file_name: 'a.txt', file_base64: b64, content_type: 'text/plain' },
          { file_name: 'b.txt', file_base64: b64, content_type: 'text/plain' },
        ],
      });
      expect(uploadReqs).toHaveLength(2);
      expect(uploadReqs[0]?.token).toBeNull();
      expect(uploadReqs[1]?.token).toBe('mock-upload-token');
      const comment = (putBody?.['ticket'] as Record<string, unknown>)['comment'] as Record<
        string,
        unknown
      >;
      expect(comment['uploads']).toEqual(['mock-upload-token']);
    });
  });

  describe('list_tickets', () => {
    it('lists tickets', async () => {
      const tool = findTool('list_tickets');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).toContain('Test ticket');
    });

    it('reports the page item count when the cursor endpoint omits count (#100)', async () => {
      // The real /tickets endpoint returns no `count` wrapper; ensure the footer
      // reflects the number of tickets returned rather than a misleading "Results: 0".
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets', () =>
          HttpResponse.json({
            tickets: [MOCK_TICKET, { ...MOCK_TICKET, id: 2 }],
            meta: { has_more: true, after_cursor: 'NEXT' },
          }),
        ),
      );
      const tool = findTool('list_tickets');
      const result = await tool.handler({ page_size: 25 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Results: 2');
      expect(text).not.toContain('Results: 0');
      expect(text).toContain('cursor: NEXT');
    });
  });

  describe('get_linked_incidents', () => {
    it('returns linked incidents', async () => {
      const tool = findTool('get_linked_incidents');
      const result = await tool.handler({ problem_id: 1 });
      expect(result.content[0]?.text).toContain('Incidents linked to problem #1');
    });
  });

  describe('manage_tags', () => {
    it('adds and removes tags', async () => {
      const tool = findTool('manage_tags');
      const result = await tool.handler({ ticket_id: 1, add: ['urgent'], remove: ['test'] });
      expect(result.content[0]?.text).toContain('Tags updated');
    });

    it('steers callers toward update_ticket and states idempotent behavior', () => {
      const tool = findTool('manage_tags');
      expect(tool.description).toContain('update_ticket');
      expect(tool.description).toContain('idempotent');
    });
  });
});
