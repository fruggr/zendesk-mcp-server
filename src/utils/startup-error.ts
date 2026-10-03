/**
 * Misconfigurations an operator fixes before the server can start. `index.ts`
 * prints only the message, which says what to change and links the section of
 * the docs that explains it: a stack trace would bury that line. ASCII only, like
 * every other auth-path message. Links point at `main`, where the docs ship.
 */
const DOCS_BASE = 'https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/';

/** Every docs section a startup error links to; a unit test checks each anchor exists. */
export const STARTUP_DOCS = {
  secretAndStore: `${DOCS_BASE}http-deployment.md#master-secret-and-grant-store`,
  invocation: `${DOCS_BASE}configuration.md#a-malformed-invocation-fails-at-startup`,
  environment: `${DOCS_BASE}configuration.md#environment-variables`,
  cliReference: `${DOCS_BASE}configuration.md#cli-reference`,
} as const;

export type StartupError = Error & { readonly docs: string };

export const createStartupError = (message: string, docs: string, cause?: unknown): StartupError =>
  Object.assign(new Error(`${message} See ${docs}`, { cause }), {
    name: 'StartupError',
    docs,
  });

export const isStartupError = (err: unknown): err is StartupError =>
  err instanceof Error &&
  err.name === 'StartupError' &&
  typeof (err as StartupError).docs === 'string';

/** The errno code of a failed filesystem call, for the message. */
export const errnoCode = (err: unknown): string =>
  (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
