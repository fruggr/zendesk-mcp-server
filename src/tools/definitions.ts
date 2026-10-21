import type * as z from 'zod/v4';
import type { Namespace } from '../config';
import type { SlaService } from '../utils/sla-service';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}
export interface ToolImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<ToolTextContent | ToolImageContent>;
}

export interface ToolDefinition {
  name: string;
  namespace: Namespace;
  readOnly: boolean;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (params: Record<string, unknown>, call?: ToolCallContext) => Promise<ToolResult>;
}

/**
 * What a handler may know about the call beyond its parameters. Absent when a
 * handler is invoked outside an MCP request (unit tests).
 */
export interface ToolCallContext {
  /** Whether the client can answer a form elicitation. */
  canElicit: boolean;
  /** Answers to an earlier `input_required` round, keyed as asked. Untrusted input. */
  inputResponses?: Record<string, unknown> | undefined;
}

export interface ToolContext {
  subdomain: string;
  /**
   * Deploy-time brand allow-list (multi-brand accounts): Help Center operations
   * are restricted to these brands. One entry hard-locks the server to that
   * brand (no per-call override accepted); several (or the single entry 'all')
   * expose `list_brands` and make the per-call `brand_id` REQUIRED on every
   * brand-scoped Help Center tool. Unset = account default brand, no `brand_id`
   * field on any schema. Only the help_center namespace reads it; Support-side
   * tools are account-wide. `| undefined` so callers can spread config.brandIds
   * straight in under exactOptionalPropertyTypes.
   */
  brandIds?: string[] | undefined;
  /**
   * Resolves a brand id-or-subdomain to the brand's subdomain, cached. Zendesk
   * addresses brands by host (`<brand.subdomain>.zendesk.com`), so every
   * brand-scoped Help Center call goes through here first. Only ever invoked
   * when a brand is actually selected.
   */
  resolveBrandSubdomain: (idOrSubdomain: string) => Promise<string>;
  getToken: () => string | Promise<string>;
  /**
   * SLA alerting for the caller. Absent where nothing wires it (unit tests,
   * `--print-tools`): no urgency is pushed then.
   */
  sla?: SlaService | undefined;
}
