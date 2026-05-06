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
      const allText = result.content
        .filter((c) => c.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      expect(allText).toContain(
        'https://testsubdomain.zendesk.com/attachments/token/abc/?name=screenshot.png',
      );
    });

    it('returns text reference for non-image attachments', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const textBlocks = result.content.filter((c) => c.type === 'text');
      const allText = textBlocks.map((b) => (b as { text: string }).text).join('\n');
      expect(allText).toContain('report.pdf');
      expect(allText).toContain('application/pdf');
      expect(allText).toContain(
        'https://testsubdomain.zendesk.com/attachments/token/def/?name=report.pdf',
      );
    });

    it('respects MAX_ATTACHMENT_BYTES for oversize images', async () => {
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const allText = result.content
        .filter((c) => c.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
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
      const allText = result.content
        .filter((c) => c.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      expect(allText).toContain('skipped: max 10 embedded images reached');
    });

    it('caps total embedded bytes to MAX_TOTAL_ATTACHMENT_BYTES', async () => {
      const fiveMb = 5 * 1024 * 1024;
      const heavyImages = Array.from({ length: 6 }, (_, i) => ({
        id: 50000 + i,
        file_name: `heavy-${i}.png`,
        content_url: `https://testsubdomain.zendesk.com/attachments/token/abc/?name=heavy-${i}.png`,
        content_type: 'image/png',
        size: fiveMb - 1,
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
                attachments: heavyImages,
              },
            ],
          }),
        ),
      );
      const tool = findTool('get_ticket_attachments');
      const result = await tool.handler({ ticket_id: 1 });
      const imageBlocks = result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(4);
      const allText = result.content
        .filter((c) => c.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      expect(allText).toContain('skipped: total embedded budget (20 MB) reached');
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
      const allText = result.content
        .filter((c) => c.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      expect(allText).toContain('page1.png');
      expect(allText).toContain('page2.png');
      expect(allText).toContain('# Attachments for ticket #1 (2 total)');
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
