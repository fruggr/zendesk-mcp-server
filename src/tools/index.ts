import type { ToolDefinition } from './definitions';
import { createHelpCenterTools } from './help-center';
import { createSearchTools } from './search';
import {
  createTicketAttachmentTools,
  type TicketAttachmentsToolContext,
} from './ticket-attachments';
import { createTicketTools } from './tickets';
import { createUserTools } from './users';

export type { ToolContext, ToolDefinition } from './definitions';

export const createAllTools = (ctx: TicketAttachmentsToolContext): ToolDefinition[] => [
  ...createTicketTools(ctx),
  ...createTicketAttachmentTools(ctx),
  ...createSearchTools(ctx),
  ...createHelpCenterTools(ctx),
  ...createUserTools(ctx),
];
