import type { ToolContext, ToolDefinition } from './definitions';
import { createHelpCenterTools } from './help-center';
import { createRequestTools } from './requests';
import { createSearchTools } from './search';
import { createTicketTools } from './tickets';
import { createUserTools } from './users';

export type { ToolContext, ToolDefinition } from './definitions';

export const createAllTools = (ctx: ToolContext): ToolDefinition[] => [
  ...createTicketTools(ctx),
  ...createRequestTools(ctx),
  ...createSearchTools(ctx),
  ...createHelpCenterTools(ctx),
  ...createUserTools(ctx),
];
