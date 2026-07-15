import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createTicketTools } from '../../../src/tools/tickets';
import {
  auditsMorePageHandler,
  MOCK_SLA_SIDELOAD,
  MOCK_TICKET,
  MOCK_UPLOAD,
  MOCK_VIEW,
} from '../../msw-handlers';
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
  it('creates 17 tools (search_tickets lives here; the unified search is elsewhere)', () => {
    const tools = createTicketTools(ctx);
    expect(tools).toHaveLength(17);
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

  describe('get_ticket_history', () => {
    it('renders a chronological timeline with resolved actor names', async () => {
      const tool = findTool('get_ticket_history');
      const result = await tool.handler({ ticket_id: 1, page_size: 100 });
      const text = getAllText(result);
      expect(text).toContain('Change history for ticket #1');
      // Actors resolved to name (id) via the batched show_many look-up.
      expect(text).toContain('User 200 (200)');
      expect(text).toContain('**status**: new → open');
      expect(text).toContain('**assignee**: (none) → User 100 (100)');
      expect(text).toContain('**group**: (none) → Group 300 (300)');
      expect(text).toContain('**tags**: +urgent');
    });

    it('shows comment presence without leaking comment bodies', async () => {
      const tool = findTool('get_ticket_history');
      const text = getAllText(await tool.handler({ ticket_id: 1, page_size: 100 }));
      expect(text).toContain('Public comment added');
      expect(text).toContain('Internal note added');
      expect(text).not.toContain('Initial request body');
      expect(text).not.toContain('internal note body');
    });

    it('filters out system-noise events and all-noise audits', async () => {
      const tool = findTool('get_ticket_history');
      const text = getAllText(await tool.handler({ ticket_id: 1, page_size: 100 }));
      // The Notification/Push audit (author 999) produces no block.
      expect(text).not.toContain('email sent');
      expect(text).not.toContain('999');
    });

    it('surfaces the pagination cursor when more audits remain', async () => {
      mswServer.use(auditsMorePageHandler);
      const tool = findTool('get_ticket_history');
      const text = getAllText(await tool.handler({ ticket_id: 1, page_size: 1 }));
      expect(text).toContain('More available');
      expect(text).toContain('next-audit-cursor');
    });

    it('still renders when name resolution fails, falling back to bare ids', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/users/show_many', () =>
          HttpResponse.json({}, { status: 500 }),
        ),
        http.get('https://testsubdomain.zendesk.com/api/v2/groups/show_many', () =>
          HttpResponse.json({}, { status: 500 }),
        ),
      );
      const tool = findTool('get_ticket_history');
      const result = await tool.handler({ ticket_id: 1, page_size: 100 });
      const text = getAllText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('**assignee**: (none) → 100');
      expect(text).toContain('**group**: (none) → 300');
    });

    it('rewrites a 403 into actionable OAuth-scope guidance', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/audits', () =>
          HttpResponse.json({}, { status: 403 }),
        ),
      );
      const tool = findTool('get_ticket_history');
      await expect(tool.handler({ ticket_id: 1, page_size: 100 })).rejects.toThrow(/global 'read'/);
    });

    it('returns a clear message when the ticket has no change history', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/audits', () =>
          HttpResponse.json({ audits: [], meta: { has_more: false, after_cursor: '' } }),
        ),
      );
      const tool = findTool('get_ticket_history');
      const text = getAllText(await tool.handler({ ticket_id: 1, page_size: 100 }));
      expect(text).toContain('No change history to show for ticket #1');
    });

    it('has readOnly annotation', () => {
      const tool = findTool('get_ticket_history');
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

      const mockCommentAttachments = (attachments: Array<Record<string, unknown>>) => {
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
                  attachments,
                },
              ],
            }),
          ),
        );
      };

      const buildImages = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: 41000 + i,
          file_name: `img-${i}.png`,
          content_url: `https://testsubdomain.zendesk.com/attachments/token/abc/?name=img-${i}.png`,
          content_type: 'image/png',
          size: 1024,
          inline: false,
        }));

      it('honors ZENDESK_MAX_EMBEDDED_IMAGES', async () => {
        vi.resetModules();
        vi.stubEnv('ZENDESK_MAX_EMBEDDED_IMAGES', '2');
        mockCommentAttachments(buildImages(12));
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
        mockCommentAttachments(buildImages(12));
        const tool = await loadAttachmentsTool();
        const result = await tool.handler({ ticket_id: 1 });
        const imageBlocks = result.content.filter((c) => c.type === 'image');
        expect(imageBlocks).toHaveLength(10);
        expect(getAllText(result)).toContain('skipped: max 10 embedded images reached');
      });

      it('honors ZENDESK_MAX_ATTACHMENT_BYTES (with a dynamic skip message)', async () => {
        vi.resetModules();
        vi.stubEnv('ZENDESK_MAX_ATTACHMENT_BYTES', String(2 * 1024 * 1024));
        mockCommentAttachments([
          {
            id: 71000,
            file_name: 'mid.png',
            content_url: 'https://testsubdomain.zendesk.com/attachments/token/mid/?name=mid.png',
            content_type: 'image/png',
            size: 3 * 1024 * 1024,
            inline: false,
          },
        ]);
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

  describe('list_ticket_fields', () => {
    it('lists field definitions with ids, types, and option values', async () => {
      const tool = findTool('list_ticket_fields');
      const result = await tool.handler({ page_size: 100 });
      const text = result.content[0]?.text ?? '';
      // System field: title, id, and its system_field_options.
      expect(text).toContain('Priority (id 10)');
      expect(text).toContain('High → high');
      // Custom dropdown: id and its custom_field_options tags.
      expect(text).toContain('Severity (id 360000000001)');
      expect(text).toContain('Sev-2 → severity_2');
      expect(text).toContain('required');
    });

    it('is read-only and passes the cursor through to Zendesk', async () => {
      let sawCursor: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/ticket_fields', ({ request }) => {
          sawCursor = new URL(request.url).searchParams.get('page[after]');
          return HttpResponse.json({
            ticket_fields: [],
            meta: { has_more: false, after_cursor: '' },
          });
        }),
      );
      const tool = findTool('list_ticket_fields');
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
      await tool.handler({ page_size: 50, cursor: 'CURSOR123' });
      expect(sawCursor).toBe('CURSOR123');
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
      const comment = ((putBody as Record<string, unknown>)['ticket'] as Record<string, unknown>)[
        'comment'
      ] as Record<string, unknown>;
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
      const comment = ((putBody as Record<string, unknown>)['ticket'] as Record<string, unknown>)[
        'comment'
      ] as Record<string, unknown>;
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
      const comment = ((putBody as Record<string, unknown>)['ticket'] as Record<string, unknown>)[
        'comment'
      ] as Record<string, unknown>;
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

  describe('list_views', () => {
    it('lists active views with their ticket counts', async () => {
      const tool = findTool('list_views');
      const result = await tool.handler({ page_size: 100 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain(MOCK_VIEW.title);
      expect(text).toContain(`(id ${MOCK_VIEW.id})`);
      expect(text).toContain('298 ticket(s)');
    });

    it('marks a non-fresh count as updating instead of implying it is exact', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views/count_many', () =>
          HttpResponse.json({
            view_counts: [{ view_id: MOCK_VIEW.id, value: null, pretty: '...', fresh: false }],
          }),
        ),
      );
      const tool = findTool('list_views');
      const result = await tool.handler({ page_size: 100 });
      expect(result.content[0]?.text).toContain('(count updating)');
    });

    it('still lists views when the counts endpoint errors (best-effort counts)', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views/count_many', () =>
          HttpResponse.json({}, { status: 500 }),
        ),
      );
      const tool = findTool('list_views');
      const result = await tool.handler({ page_size: 100 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain(MOCK_VIEW.title);
      expect(text).not.toContain('ticket(s)');
    });

    it('is read-only and passes the cursor through to Zendesk', async () => {
      let sawCursor: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views', ({ request }) => {
          sawCursor = new URL(request.url).searchParams.get('page[after]');
          return HttpResponse.json({ views: [], meta: { has_more: false, after_cursor: '' } });
        }),
      );
      const tool = findTool('list_views');
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
      await tool.handler({ page_size: 50, cursor: 'CURSOR123' });
      expect(sawCursor).toBe('CURSOR123');
    });
  });

  describe('get_view_tickets', () => {
    it('resolves a view by title and returns its tickets', async () => {
      const tool = findTool('get_view_tickets');
      const result = await tool.handler({ view: MOCK_VIEW.title, page_size: 100 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Ticket #1');
      expect(text).toContain('Test ticket');
    });

    it('accepts a numeric view id directly', async () => {
      const tool = findTool('get_view_tickets');
      const result = await tool.handler({ view: MOCK_VIEW.id, page_size: 100 });
      expect(result.content[0]?.text).toContain('Ticket #1');
    });

    it('paginates the active-views lookup to resolve a title on a later page', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views', ({ request }) => {
          const cursor = new URL(request.url).searchParams.get('page[after]');
          if (!cursor) {
            return HttpResponse.json({
              views: [{ ...MOCK_VIEW, id: 11, title: 'Some other queue' }],
              meta: { has_more: true, after_cursor: 'PAGE2' },
            });
          }
          return HttpResponse.json({
            views: [{ ...MOCK_VIEW, id: 77, title: 'Breaching today' }],
            meta: { has_more: false, after_cursor: '' },
          });
        }),
      );
      const tool = findTool('get_view_tickets');
      const result = await tool.handler({ view: 'Breaching today', page_size: 100 });
      // Resolved to id 77 on page 2, then executed + hydrated to a ticket.
      expect(result.content[0]?.text).toContain('Ticket #1');
    });

    it('treats a digit-only string as a title, not an id', async () => {
      let executedViewId: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views', () =>
          HttpResponse.json({
            views: [{ ...MOCK_VIEW, id: 55, title: '2024' }],
            meta: { has_more: false, after_cursor: '' },
          }),
        ),
        http.get('https://testsubdomain.zendesk.com/api/v2/views/:id/execute', ({ params }) => {
          executedViewId = params['id'] as string;
          return HttpResponse.json({ rows: [], meta: { has_more: false, after_cursor: '' } });
        }),
      );
      const tool = findTool('get_view_tickets');
      await tool.handler({ view: '2024', page_size: 100 });
      // "2024" is matched as a title (view id 55), not used directly as id 2024.
      expect(executedViewId).toBe('55');
    });

    it("preserves the view's order after hydrating full tickets", async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views/:id/execute', () =>
          HttpResponse.json({
            rows: [{ ticket: { id: 3 } }, { ticket: { id: 1 } }, { ticket: { id: 2 } }],
            meta: { has_more: false, after_cursor: '' },
          }),
        ),
        // show_many returns tickets in ascending id order, NOT the requested order.
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/show_many', ({ request }) => {
          const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').map(Number);
          const tickets = [...ids].sort((a, b) => a - b).map((id) => ({ ...MOCK_TICKET, id }));
          return HttpResponse.json({ tickets });
        }),
      );
      const tool = findTool('get_view_tickets');
      const result = await tool.handler({ view: MOCK_VIEW.id, page_size: 100 });
      const text = result.content[0]?.text ?? '';
      const i3 = text.indexOf('Ticket #3');
      const i1 = text.indexOf('Ticket #1');
      const i2 = text.indexOf('Ticket #2');
      expect(i3).toBeGreaterThanOrEqual(0);
      expect(i3).toBeLessThan(i1);
      expect(i1).toBeLessThan(i2);
    });

    it('passes sort_by/sort_order and the cursor through to the execute endpoint', async () => {
      let sawSortBy: string | null = null;
      let sawSortOrder: string | null = null;
      let sawCursor: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views/:id/execute', ({ request }) => {
          const url = new URL(request.url);
          sawSortBy = url.searchParams.get('sort_by');
          sawSortOrder = url.searchParams.get('sort_order');
          sawCursor = url.searchParams.get('page[after]');
          return HttpResponse.json({ rows: [], meta: { has_more: false, after_cursor: '' } });
        }),
      );
      const tool = findTool('get_view_tickets');
      await tool.handler({
        view: MOCK_VIEW.id,
        sort_by: 'priority',
        sort_order: 'desc',
        page_size: 50,
        cursor: 'CUR',
      });
      expect(sawSortBy).toBe('priority');
      expect(sawSortOrder).toBe('desc');
      expect(sawCursor).toBe('CUR');
    });

    it('returns the available view titles when the title does not match', async () => {
      const tool = findTool('get_view_tickets');
      const result = await tool.handler({ view: 'Nonexistent queue', page_size: 100 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Available views');
      expect(text).toContain(MOCK_VIEW.title);
      expect(text).not.toContain('Ticket #');
    });

    it('rewrites a 403 on a restricted view into actionable guidance', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/views/:id/execute', () =>
          HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
        ),
      );
      const tool = findTool('get_view_tickets');
      const error = await tool.handler({ view: MOCK_VIEW.id, page_size: 100 }).then(
        () => {
          throw new Error('expected get_view_tickets to reject on 403');
        },
        (err: unknown) => err as Error,
      );
      expect(error.message).toMatch(/list_views/);
      expect(error.message).toMatch(/403|restricted|denied/i);
    });

    it('has readOnly annotation', () => {
      const tool = findTool('get_view_tickets');
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe('list_macros', () => {
    it('lists active macros with their actions', async () => {
      const tool = findTool('list_macros');
      const result = await tool.handler({ per_page: 100, page: 1 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Close and thank the customer');
      expect(text).toContain('(id 700)');
      expect(text).toContain('status → solved');
      expect(text).toContain('set_tags → resolved, macro_applied');
    });

    it('hits the active-macros endpoint (scoped to the current user)', async () => {
      let requestedPath: string | null = null;
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/macros/active', ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({ macros: [], count: 0 });
        }),
      );
      const tool = findTool('list_macros');
      await tool.handler({ per_page: 100, page: 1 });
      expect(requestedPath).toBe('/api/v2/macros/active');
    });

    it('is read-only (survives --read-only)', () => {
      const tool = findTool('list_macros');
      expect(tool.readOnly).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe('preview_macro_diff', () => {
    it('diffs the ticket before/after the macro, showing only what changes', async () => {
      const tool = findTool('preview_macro_diff');
      const result = await tool.handler({ ticket_id: 1, macro_id: 700 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('diff — nothing saved yet');
      // Changed fields render as before → after; tags as added/removed tokens.
      expect(text).toContain('**status**: open → solved');
      expect(text).toContain('**tags**: +resolved, +macro_applied');
      expect(text).toContain('custom field 360000000001');
      expect(text).toContain('(empty) → severity_2');
      expect(text).toContain('Thanks for your business!');
      // Steers the caller to the commit tools (the deliberate two-step).
      expect(text).toContain('update_ticket');
      expect(text).toContain('add_public_comment');
      // Unchanged and identity fields are omitted (the bug this fixes): the
      // ticket's untouched fields and its url/id/created_at must not appear.
      expect(text).not.toContain('**priority**');
      expect(text).not.toContain('**assignee_id**');
      expect(text).not.toContain('**url**');
      expect(text).not.toContain('**id**');
      expect(text).not.toContain('**created_at**');
    });

    it('omits identity/volatile fields and unchanged custom fields from the diff', async () => {
      // The apply endpoint returns the WHOLE ticket; only the macro's real
      // change (status) must surface — not url/via (identity), not a bumped
      // generated_timestamp (volatile), not an unchanged custom field.
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id', () =>
          HttpResponse.json({
            ticket: {
              id: 42,
              url: 'https://testsubdomain.zendesk.com/api/v2/tickets/42.json',
              status: 'open',
              via: { channel: 'web' },
              generated_timestamp: 111,
              tags: ['keep'],
              custom_fields: [{ id: 9, value: 'unchanged' }],
            },
          }),
        ),
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/macros/:mid/apply', () =>
          HttpResponse.json({
            result: {
              ticket: {
                id: 42,
                url: 'https://testsubdomain.zendesk.com/api/v2/tickets/42.json',
                status: 'pending',
                // `via` DIFFERS from the before-read: a nested object is never a
                // macro change, so the object-guard must drop it regardless.
                via: { channel: 'api' },
                generated_timestamp: 222,
                tags: ['keep'],
                // Present as `null` here but absent from the before-read: a no-op
                // that used to leak as "(empty) → (empty)" — must be dropped.
                deleted_ticket_form_id: null,
                fields: [{ id: 9, value: 'unchanged' }],
              },
            },
          }),
        ),
      );
      const tool = findTool('preview_macro_diff');
      const result = await tool.handler({ ticket_id: 42, macro_id: 700 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('**status**: open → pending');
      expect(text).not.toContain('**url**');
      expect(text).not.toContain('**via**');
      expect(text).not.toContain('generated_timestamp');
      expect(text).not.toContain('custom field 9');
      expect(text).not.toContain('**tags**');
      // The no-op null-vs-absent field must not render at all.
      expect(text).not.toContain('deleted_ticket_form_id');
      expect(text).not.toContain('(empty) → (empty)');
    });

    it('marks a macro comment with public=false as an internal note', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/macros/:mid/apply', () =>
          HttpResponse.json({
            result: { ticket: { comment: { body: 'Internal only', public: false } } },
          }),
        ),
      );
      const tool = findTool('preview_macro_diff');
      const result = await tool.handler({ ticket_id: 1, macro_id: 700 });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('internal note');
      expect(text).toContain('Internal only');
    });

    it('renders a single custom field returned as a bare object (not an array)', async () => {
      // The Zendesk docs show one changed custom field as `fields: {id, value}`
      // rather than a one-element array; the diff must not choke on it.
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/macros/:mid/apply', () =>
          HttpResponse.json({
            result: { ticket: { fields: { id: 27642, value: '745' } } },
          }),
        ),
      );
      const tool = findTool('preview_macro_diff');
      const result = await tool.handler({ ticket_id: 1, macro_id: 700 });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('custom field 27642');
      expect(text).toContain('745');
    });

    it('degrades to "no changes" when the apply response has no result body', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/macros/:mid/apply', () =>
          HttpResponse.json({}),
        ),
      );
      const tool = findTool('preview_macro_diff');
      const result = await tool.handler({ ticket_id: 1, macro_id: 700 });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('## Field changes');
      expect(text).toContain('- none');
    });

    it('reads the ticket state as well as the apply preview (two GETs)', async () => {
      const paths: string[] = [];
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id', ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json({ ticket: { id: 1, status: 'open' } });
        }),
        http.get(
          'https://testsubdomain.zendesk.com/api/v2/tickets/:id/macros/:mid/apply',
          ({ request }) => {
            paths.push(new URL(request.url).pathname);
            return HttpResponse.json({ result: { ticket: { status: 'solved' } } });
          },
        ),
      );
      const tool = findTool('preview_macro_diff');
      await tool.handler({ ticket_id: 1, macro_id: 700 });
      expect(paths).toContain('/api/v2/tickets/1');
      expect(paths).toContain('/api/v2/tickets/1/macros/700/apply');
    });

    it('is a write tool so it is filtered out under --read-only', () => {
      const tool = findTool('preview_macro_diff');
      expect(tool.readOnly).toBe(false);
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(tool.annotations.destructiveHint).toBe(false);
    });
  });
});
