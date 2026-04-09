import type * as z from 'zod/v4';
import type { Namespace } from '../config';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export interface ToolDefinition {
  name: string;
  namespace: Namespace;
  readOnly: boolean;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolContext {
  subdomain: string;
  getToken: () => string | Promise<string>;
}
