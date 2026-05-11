import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../src/tools/definitions';
import { createTicketTools } from '../../../src/tools/tickets';
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
  it('creates 10 tools (10 tickets + 1 search elsewhere)', () => {
    const tools = createTicketTools(ctx);
    expect(tools).toHaveLength(10);
  });

  describe('get_ticket', () => {
    it('returns ticket details', async () => {
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: false });
      expect(result.content[0]?.text).toContain('Ticket #1');
      expect(result.content[0]?.text).toContain('Test ticket');
    });

    it('paginates through all comments when requested', async () => {
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id/comments', ({ request }) => {
          const cursor = new URL(request.url).searchParams.get('page[after]');
          if (!cursor) {
            return HttpResponse.json({
              comments: [
                {
                  id: 1,
                  body: 'first page comment',
                  author_id: 1,
                  public: true,
                  created_at: '2026-01-01T00:00:00Z',
                },
              ],
              meta: { has_more: true, after_cursor: 'CURSOR_2' },
            });
          }
          return HttpResponse.json({
            comments: [
              {
                id: 2,
                body: 'second page comment',
                author_id: 1,
                public: true,
                created_at: '2026-01-02T00:00:00Z',
              },
            ],
            meta: { has_more: false, after_cursor: null },
          });
        }),
      );
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: true });
      expect(result.content[0]?.text).toContain('first page comment');
      expect(result.content[0]?.text).toContain('second page comment');
    });

    it('includes comments when requested', async () => {
      const tool = findTool('get_ticket');
      const result = await tool.handler({ ticket_id: 1, include_comments: true });
      expect(result.content[0]?.text).toContain('Comments');
      expect(result.content[0]?.text).toContain('This is a comment');
    });

    it('has readOnly annotation', () => {
      const tool = findTool('get_ticket');
      expect(tool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe('get_ticket_attachments', () => {
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
  });

  describe('search_tickets', () => {
    it('searches with query prefix', async () => {
      const tool = findTool('search_tickets');
      const result = await tool.handler({ query: 'status:open', per_page: 100, page: 1 });
      expect(result.content[0]?.text).toContain('Test ticket');
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
  });

  describe('add_public_comment', () => {
    it('adds a comment', async () => {
      const tool = findTool('add_public_comment');
      const result = await tool.handler({ ticket_id: 1, body: 'Public reply' });
      expect(result.content[0]?.text).toContain('Public comment added');
    });
  });

  describe('list_tickets', () => {
    it('lists tickets', async () => {
      const tool = findTool('list_tickets');
      const result = await tool.handler({ page_size: 25 });
      expect(result.content[0]?.text).toContain('Test ticket');
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
  });
});
