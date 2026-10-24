import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

type Issue = z.core.$ZodIssue;

// The slice of zod's internal schema definition the key lookup walks. Wrappers
// (optional, default, nullable...) all expose `innerType`.
interface SchemaNode {
  _zod: {
    def: {
      type: string;
      innerType?: SchemaNode;
      shape?: Record<string, SchemaNode>;
      element?: SchemaNode;
    };
  };
}

const formatPath = (path: readonly PropertyKey[]): string => path.map(String).join('.');

const formatIssue = (issue: Issue): string =>
  issue.path.length > 0 ? `${formatPath(issue.path)}: ${issue.message}` : issue.message;

/**
 * `path: message` per issue, joined by `; ` since zod messages carry commas.
 * Ours rather than the SDK's (not exported): one wording for every mode and for
 * startup config errors, stable across SDK bumps.
 */
export const formatIssues = (issues: readonly Issue[]): string =>
  issues.map(formatIssue).join('; ');

const unwrap = (node: SchemaNode): SchemaNode =>
  node._zod.def.innerType ? unwrap(node._zod.def.innerType) : node;

/**
 * Keys declared by the object at `path`, or undefined when no plain object sits
 * there (a record, say, whose keys zod checks against an enum).
 */
const keysAt = (node: SchemaNode, path: readonly PropertyKey[]): string[] | undefined => {
  const { def } = unwrap(node)._zod;
  if (path.length === 0) return def.shape && Object.keys(def.shape);
  const [head, ...rest] = path;
  const child = typeof head === 'number' ? def.element : def.shape?.[String(head)];
  return child && keysAt(child, rest);
};

const keyList = (keys: string[]): string => [...keys].sort().join(', ') || '(none)';

/** One sentence per object holding unknown keys, the top level first. */
const unknownKeysMessage = (
  schema: z.ZodObject,
  issues: Array<Issue & { code: 'unrecognized_keys' }>,
  topLevelKeys: string,
): string =>
  [...issues]
    .sort((a, b) => a.path.length - b.path.length)
    .map(({ path, keys }) => {
      if (path.length === 0) {
        return `Unknown parameter(s): ${keys.join(', ')}. Valid parameters: ${topLevelKeys}.`;
      }
      const parent = formatPath(path);
      const unknown = `Unknown parameter(s): ${keys.map((key) => `${parent}.${key}`).join(', ')}.`;
      const valid = keysAt(schema as unknown as SchemaNode, path);
      return valid ? `${unknown} Valid parameters for ${parent}: ${keyList(valid)}.` : unknown;
    })
    .join(' ');

type StrictResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; message: string };

/**
 * Build a strict validator for a tool's input schema, computing the strict
 * schema and the valid-key list once at construction rather than per call.
 *
 * Zod objects default to `strip`, which silently drops unknown keys. That hid
 * #100: a caller passing `per_page` to list_tickets (whose parameter is
 * `page_size`) had the key dropped, so a large unpaginated page came back. The
 * validator rejects unknown keys and names both the offending ones and the
 * valid parameters, so a misremembered name fails loudly. Any other failure is
 * one `path: message` per issue (#206). When both occur only the unknown keys
 * are reported: a guessed name is the one error a caller cannot spot by
 * re-reading its own arguments.
 */
const createStrictValidator = (
  schema: z.ZodObject,
  strict: z.ZodObject = schema.strict(),
): ((params: unknown) => StrictResult) => {
  const topLevelKeys = keyList(Object.keys(schema.shape));

  return (params) => {
    const result = strict.safeParse(params);
    if (result.success) return { success: true, data: result.data as Record<string, unknown> };

    const unknownKeyIssues = result.error.issues.filter(
      (issue): issue is Issue & { code: 'unrecognized_keys' } => issue.code === 'unrecognized_keys',
    );
    const message =
      unknownKeyIssues.length > 0
        ? unknownKeysMessage(schema, unknownKeyIssues, topLevelKeys)
        : `Invalid parameter(s): ${formatIssues(result.error.issues)}`;
    return { success: false, message };
  };
};

type StrictParamsParser = (params: unknown) => Record<string, unknown>;

// Keyed on the definition's schema: a proxy is rebuilt with every server, while
// the definitions, and so their parsers, are the transport's (#393).
const strictParamsParsers = new WeakMap<z.ZodObject, StrictParamsParser>();

/** The proxy dispatch path (namespace/single modes): throws the validator's message. */
export const createStrictParamsParser = (schema: z.ZodObject): StrictParamsParser => {
  const known = strictParamsParsers.get(schema);
  if (known) return known;
  const validate = createStrictValidator(schema);
  const parse: StrictParamsParser = (params) => {
    const result = validate(params);
    if (!result.success) throw new Error(result.message);
    return result.data;
  };
  strictParamsParsers.set(schema, parse);
  return parse;
};

type StrictStandardSchema = StandardSchemaWithJSON<unknown, Record<string, unknown>>;
// zod's and the SDK's Standard Schema option types are structurally alike but distinct.
type JsonSchemaConversion<Options extends { target: string; libraryOptions?: unknown }> = (
  options: Options,
) => Record<string, unknown>;

// zod converts again on every call, and the SDK asks on every `tools/list`.
// Library options are the caller's own tuning: those calls are not cached.
const convertOncePerTarget = <Options extends { target: string; libraryOptions?: unknown }>(
  convert: JsonSchemaConversion<Options>,
): JsonSchemaConversion<Options> => {
  const byTarget = new Map<string, Record<string, unknown>>();
  return (options) => {
    if (options.libraryOptions) return convert(options);
    const known = byTarget.get(options.target);
    if (known) return known;
    const converted = convert(options);
    byTarget.set(options.target, converted);
    return converted;
  };
};

/**
 * `schema`, its JSON Schema converted once per direction and target: for a
 * schema the SDK validates as is (a proxy's), where a wrapper would hide `shape`.
 * zod's `~standard` setter stores the override on the instance.
 */
export const convertingToJsonSchemaOnce = <T extends z.ZodObject>(schema: T): T => {
  const standard = schema['~standard'];
  schema['~standard'] = {
    ...standard,
    jsonSchema: {
      input: convertOncePerTarget(standard.jsonSchema.input),
      output: convertOncePerTarget(standard.jsonSchema.output),
    },
  };
  return schema;
};

// Keyed on the definition's schema, so every server sharing the definitions
// (#393) shares the wrapper and its conversions.
const strictStandardSchemas = new WeakMap<z.ZodObject, StrictStandardSchema>();

/**
 * The same validator as a Standard Schema, for `all` mode: the SDK calls this
 * `validate` and prints our pathless issue after its own prefix, so all three
 * modes word an error alike. The JSON Schema is zod's own, converted once.
 */
export const toStrictStandardSchema = (schema: z.ZodObject): StrictStandardSchema => {
  const known = strictStandardSchemas.get(schema);
  if (known) return known;
  const strict = schema.strict();
  const validate = createStrictValidator(schema, strict);
  const { jsonSchema } = strict['~standard'];
  const standard: StrictStandardSchema = {
    '~standard': {
      version: 1,
      // Stryker disable next-line StringLiteral: informational; the SDK reads vendor only when jsonSchema is absent.
      vendor: 'zendesk-mcp-server',
      validate: (value) => {
        const result = validate(value);
        return result.success ? { value: result.data } : { issues: [{ message: result.message }] };
      },
      jsonSchema: {
        input: convertOncePerTarget(jsonSchema.input),
        output: convertOncePerTarget(jsonSchema.output),
      },
    },
  };
  strictStandardSchemas.set(schema, standard);
  return standard;
};
