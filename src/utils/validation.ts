import type * as z from 'zod/v4';

/**
 * Build a strict params parser for a tool's input schema, computing the strict
 * schema and the valid-key list once at construction rather than per call.
 *
 * Zod objects default to `strip`, which silently drops unknown keys. That hid
 * #100: a caller passing `per_page` to list_tickets (whose parameter is
 * `page_size`) had the key dropped, so a large unpaginated page came back. The
 * parser rejects unknown keys and names both the offending ones and the valid
 * parameters, so a misremembered name fails loudly.
 *
 * Used on the proxy dispatch path (namespace/single modes); in `all` mode the
 * SDK validates against the strict schema we register.
 */
export const createStrictParamsParser = (
  schema: z.ZodObject,
): ((params: unknown) => Record<string, unknown>) => {
  const strict = schema.strict();
  const validKeys = Object.keys(schema.shape).sort().join(', ');

  return (params) => {
    const result = strict.safeParse(params);
    if (result.success) return result.data as Record<string, unknown>;

    // One narrowing flatMap rather than filter-then-map: Zod's issue union discriminates
    // on `code`, so `keys` is typed here and needs neither a cast nor a fallback.
    const unknownKeys = result.error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' ? issue.keys : [],
    );

    if (unknownKeys.length > 0) {
      throw new Error(
        `Unknown parameter(s): ${unknownKeys.join(', ')}. Valid parameters: ${validKeys || '(none)'}.`,
      );
    }
    throw result.error;
  };
};
