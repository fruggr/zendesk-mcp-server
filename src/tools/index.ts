import type { SharedToolDefinition, ToolCaller, ToolContext, ToolDefinition } from './definitions';
import { createHelpCenterTools } from './help-center';
import { createPreferenceTools } from './preferences';
import { createRequestTools } from './requests';
import { createSearchTools } from './search';
import { createSlaAlertTools } from './sla-alerts';
import { createTicketTools } from './tickets';
import { createUserTools } from './users';

export type { ToolContext, ToolDefinition } from './definitions';

/**
 * Shared definitions bound to one caller, for a consumer that still calls
 * `handler(params, call?)`: the tool files moving to per-call callers (#393).
 */
export const bindCaller = (
  tools: readonly SharedToolDefinition[],
  caller: ToolCaller,
): ToolDefinition[] =>
  tools.map((tool) => ({
    ...tool,
    handler: (params, call) => tool.handler(params, { canElicit: false, ...call, caller }),
  }));

export const createAllTools = (ctx: ToolContext): ToolDefinition[] => [
  ...bindCaller(createTicketTools(ctx), ctx),
  ...bindCaller(createSlaAlertTools(ctx), ctx),
  ...bindCaller(createRequestTools(ctx), ctx),
  ...bindCaller(createSearchTools(ctx), ctx),
  ...createHelpCenterTools(ctx),
  ...bindCaller(createUserTools(ctx), ctx),
  ...bindCaller(createPreferenceTools(), ctx),
];
