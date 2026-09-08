import { afterAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { createAllTools, type ToolContext } from '../../src/tools';
import { createStrictParamsParser } from '../../src/utils/validation';

/**
 * The uncompiled path, which the rest of the suite no longer exercises.
 *
 * `tests/setup.ts` opts the whole suite into `zod/compile`, matching what ships. That leaves
 * zod's own escape hatch untested: `z.config({ jitless: true })` is how a runtime without
 * `new Function()` (a CSP-restricted host) stands the compiler down, and the shim honours it
 * by permanently restoring the runtime parser. `docs/decisions/zod-compile.md` states that
 * this degrades gracefully — nothing but this file backs that claim.
 *
 * Vitest isolates test files in their own workers, so flipping the global config here does
 * not reach any other file; `afterAll` restores it regardless.
 */

z.config({ jitless: true });
afterAll(() => z.config({ jitless: false }));

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

const isCompiled = (schema: z.ZodType): boolean =>
  Boolean(
    (schema as unknown as { _zod?: { bag?: { fallbackRun?: unknown } } })._zod?.bag?.fallbackRun,
  );

describe('jitless: the server behaves identically with compilation stood down', () => {
  const tools = createAllTools(ctx);
  const getTicket = tools.find((t) => t.name === 'get_ticket');
  if (!getTicket) throw new Error('get_ticket is gone — repoint this test at another read tool');

  it('no schema is compiled', () => {
    const schema = getTicket.inputSchema.strict();
    schema.safeParse({ ticket_id: 1 });
    expect(isCompiled(schema)).toBe(false);
  });

  it('valid params still parse, and defaults still apply', () => {
    const parse = createStrictParamsParser(getTicket.inputSchema);
    expect(parse({ ticket_id: 1 })).toEqual({ ticket_id: 1, include_comments: false });
  });

  it('an unknown parameter still fails with the exact same message', () => {
    const parse = createStrictParamsParser(getTicket.inputSchema);
    // Byte-identical to what the compiled path produces (tests/unit/utils/validation.test.ts
    // asserts the same wording) — a client cannot tell the two runtimes apart.
    expect(() => parse({ ticket_id: 1, per_page: 10 })).toThrow(
      /^Unknown parameter\(s\): per_page\. Valid parameters: /,
    );
  });

  it('the exposed JSON Schema is unaffected', () => {
    // toJSONSchema reads the schema definition, never the parse path, so a jitless host
    // advertises the same tool surface. Asserted structurally rather than as a snapshot:
    // the descriptions are load-bearing elsewhere (docs/mcp-metadata.md, the tool-quality
    // gate) and re-pinning their prose here would break this test on every wording edit.
    const json = z.toJSONSchema(getTicket.inputSchema.strict()) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type?: string; description?: string }>;
    };

    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(json.properties).sort(byName)).toEqual(['include_comments', 'ticket_id']);
    expect([...json.required].sort(byName)).toEqual(['include_comments', 'ticket_id']);
    expect(json.properties.ticket_id?.type).toBe('integer');
    expect(json.properties.include_comments?.type).toBe('boolean');
    for (const [name, prop] of Object.entries(json.properties)) {
      expect(prop.description, `${name} lost its description`).toBeTruthy();
    }
  });
});
