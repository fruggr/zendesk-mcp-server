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

    // Stryker disable MethodExpression,ConditionalExpression,ArrayDeclaration: the
    // filter and the `?? []` are belt and braces, so widening either is invisible --
    // an issue of any other code has no `keys` and contributes nothing to the list,
    // whether the filter drops it or the fallback does. Zod always sets `keys` on an
    // `unrecognized_keys` issue, so the fallback is for the cast, not for a value
    // anything produces. A region, because a directive inside a method chain is not
    // a leading comment of any node and is silently dropped; it therefore also
    // covers the two mutants that ARE killed here -- narrowing the filter, and
    // suppressing it outright -- whose assertions (the unknown-parameter cases in
    // tests/unit/utils/validation.test.ts) stay exactly as they are.
    const unknownKeys = result.error.issues
      .filter((issue) => issue.code === 'unrecognized_keys')
      .flatMap((issue) => (issue as { keys?: string[] }).keys ?? []);
    // Stryker restore MethodExpression,ConditionalExpression,ArrayDeclaration

    if (unknownKeys.length > 0) {
      throw new Error(
        `Unknown parameter(s): ${unknownKeys.join(', ')}. Valid parameters: ${validKeys || '(none)'}.`,
      );
    }
    throw result.error;
  };
};
