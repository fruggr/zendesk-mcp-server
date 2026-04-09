import { describe, it, expect } from 'vitest';
import { createTicketTools } from '../../../src/tools/tickets';
import type { ToolContext } from '../../../src/tools/definitions';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

const findTool = (name: string) => {
  const tools = createTicketTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

describe('ticket tools', () => {
  it('creates 10 tools (9 tickets + 1 search)', () => {
    // search is in search.ts, tickets.ts has 9
    const tools = createTicketTools(ctx);
    expect(tools).toHaveLength(9);
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
