import type { ToolContext, ToolDefinition } from './definitions';
import { createTicketTools } from './tickets';
import { createSearchTools } from './search';
import { createHelpCenterTools } from './help-center';
import { createUserTools } from './users';

export type { ToolDefinition, ToolContext } from './definitions';

export const createAllTools = (ctx: ToolContext): ToolDefinition[] => [
  ...createTicketTools(ctx),
  ...createSearchTools(ctx),
  ...createHelpCenterTools(ctx),
  ...createUserTools(ctx),
];
