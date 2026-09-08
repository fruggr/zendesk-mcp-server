import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { createAllTools, type ToolContext } from '../../../src/tools';

// Every tool's input schema must be compilable by zod's AOT compiler.
//
// The compiler is deliberately silent: hand it a schema whose semantics the fast path can't
// model and it returns the schema unchanged, still on the runtime parser. Parsing stays
// correct, so nothing fails — the tool just quietly stops being covered by the optimisation
// the entrypoint opted the whole server into (`import 'zod/compile'`, src/index.ts).
//
// `{ strict: true }` turns that silence into a thrown ZodCompileUnsupportedError, which is
// the only way to notice. A failure here is not "the schema is wrong": it means the schema
// grew a feature the fast path can't take (an async refinement, a transform it can't model),
// and the choice is to express the constraint differently or to accept the fallback and say
// so in docs/decisions/zod-compile.md.

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };
const tools = createAllTools(ctx);

describe('tool input schemas compile', () => {
  it('every tool: the strict input schema compiles without falling back', () => {
    const violations = tools
      .filter((tool) => {
        try {
          // `.strict()` is what actually ships — registered in `all` mode (src/server.ts)
          // and used by createStrictParamsParser on the proxy path (src/utils/validation.ts).
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

  it('a schema the fast path cannot model is reported, not ignored', () => {
    // Pins the mechanism the check above relies on: without `{ strict: true }` an
    // unsupported schema comes back uncompiled and indistinguishable from a compiled one.
    const asyncRefined = z.object({ id: z.number() }).refine(async () => true);

    expect(() => z.compile(asyncRefined, { strict: true })).toThrow();
    expect(z.compile(asyncRefined)).toBeDefined();
  });
});
