import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { createStrictParamsParser, toStrictStandardSchema } from '../../../src/utils/validation';

const parse = createStrictParamsParser(
  z.object({
    page_size: z.number().int().min(1).max(100).default(100),
    cursor: z.string().optional(),
  }),
);

describe('createStrictParamsParser', () => {
  it('returns parsed params and applies defaults for valid input', () => {
    expect(parse({ page_size: 5 })).toEqual({ page_size: 5 });
    expect(parse({})).toEqual({ page_size: 100 });
  });

  it('rejects unknown parameters instead of silently dropping them (#100)', () => {
    expect(() => parse({ per_page: 3 })).toThrow(/per_page/);
  });

  it('names the unknown parameter and lists the valid ones', () => {
    // The whole message is pinned, not just its parts: the valid-key list is
    // sorted so an LLM reading the error gets a stable, scannable list, and
    // the separators are what make it readable at all.
    expect(() => parse({ per_page: 3 })).toThrow(
      'Unknown parameter(s): per_page. Valid parameters: cursor, page_size.',
    );
  });

  it('lists every unknown parameter, not just the first', () => {
    // Zod reports unrecognized keys in the caller's insertion order, so the
    // whole message can be pinned here too rather than an order-agnostic regex.
    expect(() => parse({ per_page: 3, sort_by: 'id' })).toThrow(
      'Unknown parameter(s): per_page, sort_by. Valid parameters: cursor, page_size.',
    );
  });

  // A proxy is rebuilt with every server, one per 2026-07-28 HTTP request: its
  // parsers must outlive the server, or every request rebuilds them.
  it('builds one parser per schema', () => {
    const schema = z.object({ id: z.number() });

    expect(createStrictParamsParser(schema)).toBe(createStrictParamsParser(schema));
    expect(createStrictParamsParser(z.object({ id: z.number() }))).not.toBe(
      createStrictParamsParser(schema),
    );
  });

  it('says "(none)" rather than trailing off when the tool takes no parameters', () => {
    const parseNoParams = createStrictParamsParser(z.object({}));
    expect(() => parseNoParams({ anything: 1 })).toThrow(
      'Unknown parameter(s): anything. Valid parameters: (none).',
    );
  });

  it('reports only the unknown parameters when a known one is also malformed', () => {
    // Both failures arrive in one ZodError, and the caller has to be told about
    // the unknown key -- the one it can only have got from guessing -- rather
    // than about the type error it can see in its own arguments.
    expect(() => parse({ per_page: 3, page_size: 'big' })).toThrow(
      'Unknown parameter(s): per_page. Valid parameters: cursor, page_size.',
    );
  });

  it('reports a wrongly typed parameter as "path: message", not as a JSON dump of the issues (#206)', () => {
    expect(messageOf(() => parse({ page_size: 'big' }))).toMatchInlineSnapshot(
      `"Invalid parameter(s): page_size: Invalid input: expected number, received string"`,
    );
  });
});

/** The message a call throws, so the whole text can be pinned rather than a substring. */
const messageOf = (call: () => unknown): string => {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the call to throw');
};

const nestedSchema = z.object({
  ticket_id: z.number().int(),
  status: z.enum(['open', 'solved']).optional(),
  brand_id: z.union([z.number().int(), z.string().min(1)]).optional(),
  followers: z
    .object({ add: z.array(z.number()).optional(), remove: z.array(z.number()).optional() })
    .strict()
    .optional(),
  custom_fields: z
    .array(z.object({ id: z.number().int(), value: z.unknown() }).strict())
    .optional(),
  settings: z.object({}).strict().optional(),
  by_locale: z.record(z.string(), z.object({ title: z.string() }).strict()).optional(),
  levels: z.record(z.enum(['low', 'high']), z.number()).optional(),
});
const parseNested = createStrictParamsParser(nestedSchema);

describe('createStrictParamsParser: message shape (#206)', () => {
  it('names the path of an issue nested in an array of objects, segments joined by dots', () => {
    expect(
      messageOf(() =>
        parseNested({
          ticket_id: 1,
          custom_fields: [
            { id: 1, value: 2 },
            { id: 'x', value: 3 },
          ],
        }),
      ),
    ).toMatchInlineSnapshot(
      `"Invalid parameter(s): custom_fields.1.id: Invalid input: expected number, received string"`,
    );
  });

  it("keeps zod's wording for an enum and for a missing required parameter", () => {
    expect(messageOf(() => parseNested({ ticket_id: 1, status: 'nope' }))).toMatchInlineSnapshot(
      `"Invalid parameter(s): status: Invalid option: expected one of "open"|"solved""`,
    );
    expect(messageOf(() => parseNested({}))).toMatchInlineSnapshot(
      `"Invalid parameter(s): ticket_id: Invalid input: expected number, received undefined"`,
    );
  });

  it('separates several issues with "; ", since zod messages already contain commas', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 'abc', status: 'nope' })),
    ).toMatchInlineSnapshot(
      `"Invalid parameter(s): ticket_id: Invalid input: expected number, received string; status: Invalid option: expected one of "open"|"solved""`,
    );
  });

  it("reports a union mismatch with the path and zod's summary only", () => {
    expect(messageOf(() => parseNested({ ticket_id: 1, brand_id: true }))).toMatchInlineSnapshot(
      `"Invalid parameter(s): brand_id: Invalid input"`,
    );
  });

  it('gives a pathless issue (a refinement on the whole object) as its bare message', () => {
    const parseRefined = createStrictParamsParser(
      z
        .object({ a: z.string().optional(), b: z.string().optional() })
        .refine((params) => params.a !== undefined || params.b !== undefined, 'Pass a or b.'),
    );
    expect(messageOf(() => parseRefined({}))).toMatchInlineSnapshot(
      `"Invalid parameter(s): Pass a or b."`,
    );
  });
});

describe('createStrictParamsParser: unknown keys in nested objects', () => {
  it('names a nested unknown key by its path and lists the keys valid at that level', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 1, followers: { add: [1], bogus: 1 } })),
    ).toMatchInlineSnapshot(
      `"Unknown parameter(s): followers.bogus. Valid parameters for followers: add, remove."`,
    );
  });

  it('prefixes every unknown key of one nested object with its path', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 1, followers: { bogus: 1, other: 2 } })),
    ).toMatchInlineSnapshot(
      `"Unknown parameter(s): followers.bogus, followers.other. Valid parameters for followers: add, remove."`,
    );
  });

  it('walks into an array element to find the valid keys', () => {
    expect(
      messageOf(() =>
        parseNested({ ticket_id: 1, custom_fields: [{ id: 1, value: 2, valeu: 3 }] }),
      ),
    ).toMatchInlineSnapshot(
      `"Unknown parameter(s): custom_fields.0.valeu. Valid parameters for custom_fields.0: id, value."`,
    );
  });

  it('says "(none)" for a nested object that takes no keys', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 1, settings: { x: 1 } })),
    ).toMatchInlineSnapshot(
      `"Unknown parameter(s): settings.x. Valid parameters for settings: (none)."`,
    );
  });

  it('drops the valid-key list rather than guessing when the path runs through a record', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 1, by_locale: { fr: { title: 't', body: 'b' } } })),
    ).toMatchInlineSnapshot(`"Unknown parameter(s): by_locale.fr.body."`);
  });

  it('drops it too when the parent is itself a record whose keys zod checks against an enum', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 1, levels: { low: 1, high: 2, mid: 3 } })),
    ).toMatchInlineSnapshot(`"Unknown parameter(s): levels.mid."`);
  });

  it('gives one sentence per object, the top level first and unchanged', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 1, followers: { bogus: 1 }, per_page: 3 })),
    ).toMatchInlineSnapshot(
      `"Unknown parameter(s): per_page. Valid parameters: brand_id, by_locale, custom_fields, followers, levels, settings, status, ticket_id. Unknown parameter(s): followers.bogus. Valid parameters for followers: add, remove."`,
    );
  });

  it('still reports only the unknown keys when a known one is also malformed', () => {
    expect(
      messageOf(() => parseNested({ ticket_id: 'abc', followers: { bogus: 1 } })),
    ).toMatchInlineSnapshot(
      `"Unknown parameter(s): followers.bogus. Valid parameters for followers: add, remove."`,
    );
  });
});

describe('toStrictStandardSchema', () => {
  const schema = z.object({
    page_size: z.number().int().min(1).max(100).default(100),
    cursor: z.string().optional(),
  });
  const standard = toStrictStandardSchema(schema)['~standard'];

  it('returns the parsed value, defaults applied, for valid input', () => {
    expect(standard.validate({ cursor: 'c' })).toEqual({ value: { page_size: 100, cursor: 'c' } });
  });

  it('returns the same message as the proxy parser, as one pathless issue the SDK prints verbatim', () => {
    expect(standard.validate({ page_size: 'big' })).toEqual({
      issues: [{ message: messageOf(() => parse({ page_size: 'big' })) }],
    });
    expect(standard.validate({ per_page: 3 })).toEqual({
      issues: [{ message: 'Unknown parameter(s): per_page. Valid parameters: cursor, page_size.' }],
    });
  });

  it('advertises exactly the JSON Schema of the strict zod schema', () => {
    const options = { target: 'draft-2020-12' } as const;
    expect(standard.jsonSchema.input(options)).toEqual(
      schema.strict()['~standard'].jsonSchema.input(options),
    );
    expect(standard.jsonSchema.output(options)).toEqual(
      schema.strict()['~standard'].jsonSchema.output(options),
    );
  });

  // A 2026-07-28 HTTP request registers its tools on a fresh server: the wrapper
  // and its conversion must outlive the server, or every request redoes them.
  it('wraps a zod schema once', () => {
    expect(toStrictStandardSchema(schema)).toBe(toStrictStandardSchema(schema));
  });

  it('converts to JSON Schema once per direction and target', () => {
    const draft2020 = { target: 'draft-2020-12' } as const;
    const draft07 = { target: 'draft-07' } as const;
    const input = standard.jsonSchema.input(draft2020);

    expect(standard.jsonSchema.input(draft2020)).toBe(input);
    expect(standard.jsonSchema.output(draft2020)).toBe(standard.jsonSchema.output(draft2020));
    expect(standard.jsonSchema.output(draft2020)).not.toBe(input);
    expect(standard.jsonSchema.input(draft07)).not.toBe(input);
    expect(standard.jsonSchema.input(draft07)).toEqual(
      schema.strict()['~standard'].jsonSchema.input(draft07),
    );
  });

  it('converts afresh when the caller passes library options', () => {
    const options = { target: 'draft-2020-12', libraryOptions: {} } as const;

    expect(standard.jsonSchema.input(options)).not.toBe(standard.jsonSchema.input(options));
    expect(standard.jsonSchema.output(options)).not.toBe(standard.jsonSchema.output(options));
  });
});
