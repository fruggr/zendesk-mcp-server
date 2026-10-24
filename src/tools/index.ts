import type { ToolDefinition, ToolEnv } from './definitions';
import { createHelpCenterTools } from './help-center';
import { createPreferenceTools } from './preferences';
import { createRequestTools } from './requests';
import { createSearchTools } from './search';
import { createSlaAlertTools } from './sla-alerts';
import { createTicketTools } from './tickets';
import { createUserTools } from './users';

export type {
  ToolCall,
  ToolCaller,
  ToolContext,
  ToolDefinition,
  ToolEnv,
} from './definitions';

export const createAllTools = (env: ToolEnv): ToolDefinition[] => [
  ...createTicketTools(env),
  ...createSlaAlertTools(env),
  ...createRequestTools(env),
  ...createSearchTools(env),
  ...createHelpCenterTools(env),
  ...createUserTools(env),
  ...createPreferenceTools(),
];
