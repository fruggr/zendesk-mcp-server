import { inputRequired } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  inputRequiredError,
  isInputRequiredError,
  supportsFormElicitation,
} from '../../../src/utils/elicitation';

describe('supportsFormElicitation', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ elicitation: {} }, true],
    [{ elicitation: { form: {} } }, true],
    [{ elicitation: { form: {}, url: {} } }, true],
    [{ elicitation: { url: {} } }, false],
  ])('reads %j as %s', (capabilities, expected) => {
    expect(supportsFormElicitation(capabilities)).toBe(expected);
  });
});

describe('inputRequiredError', () => {
  const result = inputRequired({ requestState: 'state' });

  it('carries the input-required result and is recognised', () => {
    const err = inputRequiredError(result);
    expect(err.inputRequired).toBe(result);
    expect(err.message).toBe('The tool needs input from the user before it can answer.');
    expect(isInputRequiredError(err)).toBe(true);
  });

  it('is not confused with an ordinary error, even one of the same name', () => {
    expect(isInputRequiredError(new Error('boom'))).toBe(false);
    expect(
      isInputRequiredError(Object.assign(new Error('x'), { name: 'InputRequiredError' })),
    ).toBe(false);
    expect(isInputRequiredError({ name: 'InputRequiredError', inputRequired: result })).toBe(false);
    expect(isInputRequiredError(Object.assign(new Error('x'), { inputRequired: result }))).toBe(
      false,
    );
  });
});
