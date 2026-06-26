import type * as z from 'zod/v4';

/**
 * Strict-parse operation params against a tool's input schema.
 *
 * Zod objects default to `strip`, which silently drops unknown keys. That hid
 * #100: a caller passing `per_page` to list_tickets (whose parameter is
 * `page_size`) had the key dropped, so `page_size` fell back to its default and
 * a large unpaginated page came back. Strict parsing rejects unknown keys, and
 * we rewrite the raw Zod error into a message that names the offending keys and
 * lists the valid parameters so a mistyped/misremembered name fails loudly.
 *
 * Used on the proxy dispatch path (namespace/single modes), where this code
 * owns the parse. In `all` mode the SDK validates against the strict schema we
 * register and produces its own (also explicit) "Unrecognized key" message.
 */
export const parseToolParams = (schema: z.ZodObject, params: unknown): Record<string, unknown> => {
  const result = schema.strict().safeParse(params);
  if (result.success) return result.data as Record<string, unknown>;

  const unknownKeys = result.error.issues
    .filter((issue) => issue.code === 'unrecognized_keys')
    .flatMap((issue) => (issue as { keys?: string[] }).keys ?? []);

  if (unknownKeys.length > 0) {
    const validKeys = Object.keys(schema.shape).sort().join(', ');
    throw new Error(
      `Unknown parameter(s): ${unknownKeys.join(', ')}. Valid parameters: ${validKeys || '(none)'}.`,
    );
  }
  throw result.error;
};
