import type { ClientCapabilities, InputRequiredResult } from '@modelcontextprotocol/server';

/**
 * Whether a client can answer a form elicitation. A bare `elicitation: {}`
 * predates the modes and counts as form support (spec rule the SDK follows).
 */
export const supportsFormElicitation = (capabilities: ClientCapabilities | undefined): boolean => {
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return Object.keys(elicitation).length === 0 || 'form' in elicitation;
};

/**
 * Raised by a tool handler that needs the user's input before it can answer.
 * The server turns it into the `input_required` result the SDK hands the
 * client (or, for a 2025-era client, into an `elicitation/create` round), so
 * tool handlers keep returning plain results.
 */
export interface InputRequiredError extends Error {
  inputRequired: InputRequiredResult;
}

export const inputRequiredError = (result: InputRequiredResult): InputRequiredError =>
  Object.assign(new Error('The tool needs input from the user before it can answer.'), {
    name: 'InputRequiredError',
    inputRequired: result,
  });

export const isInputRequiredError = (err: unknown): err is InputRequiredError =>
  err instanceof Error && err.name === 'InputRequiredError' && 'inputRequired' in err;
