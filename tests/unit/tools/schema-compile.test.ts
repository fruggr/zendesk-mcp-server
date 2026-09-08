import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { createAllTools, type ToolContext } from '../../../src/tools';
import { createStrictParamsParser } from '../../../src/utils/validation';

// Two things have to hold for `import 'zod/compile'` (src/index.ts) to be worth its line,
// and both fail silently:
//
//  1. Every tool schema must be *compilable*. Hand the compiler a schema whose semantics
//     the fast path can't model and it returns it unchanged, still on the runtime parser.
//     Parsing stays correct, so nothing fails — the tool just stops being covered.
//     `{ strict: true }` turns that silence into a thrown ZodCompileUnsupportedError.
//
//  2. The path that actually runs must be the *synchronous* one. The global shim bypasses
//     the fast path entirely for async parses, and never compiles the schema at all — so a
//     switch from `safeParse` to `safeParseAsync` anywhere in our own code would disable
//     compilation there with no other symptom. That is not hypothetical: it is exactly why
//     the MCP SDK's own tool-argument validation (`safeParseAsync`) is never compiled.
//     See docs/decisions/zod-compile.md.

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };
const tools = createAllTools(ctx);

// The shim records `bag.fallbackRun` when (and only when) it has installed a compiled fast
// path on the instance. Reaching into `_zod` is the only way to observe compilation —
// nothing about it is visible in the parse result, which is the whole problem.
const isCompiled = (schema: z.ZodType): boolean =>
  Boolean(
    (schema as unknown as { _zod?: { bag?: { fallbackRun?: unknown } } })._zod?.bag?.fallbackRun,
  );

describe('tool input schemas compile', () => {
  it('every tool: the strict input schema compiles without falling back', () => {
    const violations = tools
      .filter((tool) => {
        try {
          // `.strict()` is what actually ships — registered in `all` mode (src/server.ts)
          // and re-derived by createStrictParamsParser on the proxy path.
          z.compile(tool.inputSchema.strict(), { strict: true });
          return false;
        } catch {
          return true;
        }
      })
      .map((tool) => tool.name);

    expect(
      violations,
      `These tools' input schemas fall back to the runtime parser instead of compiling: ` +
        `${violations.join(', ')}. See docs/decisions/zod-compile.md.`,
    ).toEqual([]);
  });

  it('the proxy dispatch path really compiles, it does not merely could-compile', () => {
    // The default mode (namespace/single) validates params through this parser, so this is
    // the one tool-schema parse in the server that the compiler actually reaches.
    const tool = tools.find((t) => t.name === 'get_ticket');
    if (!tool) throw new Error('get_ticket is gone — repoint this test at another read tool');

    // `.strict()` clones, so the parser holds a schema instance nobody else can reach.
    // Asserting on a clone of our own would pass even if the parser went async; spying on
    // the call the parser itself makes is the narrowest way to get *its* instance.
    const strictSpy = vi.spyOn(tool.inputSchema, 'strict');
    const parse = createStrictParamsParser(tool.inputSchema);
    const parserSchema = strictSpy.mock.results[0]?.value as z.ZodType | undefined;
    strictSpy.mockRestore();

    expect(
      parserSchema,
      'createStrictParamsParser no longer derives its schema via .strict()',
    ).toBeDefined();
    expect(
      isCompiled(parserSchema as z.ZodType),
      'the parser schema is not compiled until it first parses something',
    ).toBe(false);

    parse({ ticket_id: 1 });

    expect(
      isCompiled(parserSchema as z.ZodType),
      'the proxy parser must leave its schema compiled. If this fails, either that parse ' +
        'moved to safeParseAsync (which the shim never compiles) or zod changed how the ' +
        'global post-processor installs the fast path. See docs/decisions/zod-compile.md.',
    ).toBe(true);
  });

  it('an async parse is never compiled — the limitation this rests on', () => {
    // Pins the mechanism behind the SDK caveat in the decision doc: the shim returns the
    // runtime parser for async calls without ever compiling, so async-only schemas stay
    // uncompiled forever. If this ever starts passing as compiled, that caveat is stale.
    const schema = z.object({ id: z.number() });

    return schema.safeParseAsync({ id: 1 }).then(() => {
      expect(isCompiled(schema)).toBe(false);
    });
  });

  it('a schema the fast path cannot model is reported, not ignored', () => {
    // Without `{ strict: true }` an unsupported schema comes back uncompiled and
    // indistinguishable from a compiled one — which is what makes the first test necessary.
    const asyncRefined = z.object({ id: z.number() }).refine(async () => true);

    expect(() => z.compile(asyncRefined, { strict: true })).toThrow();
    expect(z.compile(asyncRefined)).toBeDefined();
  });
});
