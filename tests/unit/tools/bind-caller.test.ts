import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import type { SharedToolDefinition, ToolCall } from '../../../src/tools/definitions';
import { bindCaller } from '../../../src/tools/index';
import { testToolContext } from '../../tool-context';

const seen: ToolCall[] = [];
const echo: SharedToolDefinition = {
  name: 'echo',
  namespace: 'users',
  readOnly: true,
  title: 'Echo',
  description: 'Test only.',
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (_params, call) => {
    seen.push(call);
    return { content: [] };
  },
};

describe('bindCaller', () => {
  it('hands the bound caller to the handler, with the call context it was given', async () => {
    const caller = testToolContext();
    const [tool] = bindCaller([echo], caller);
    seen.length = 0;

    await tool?.handler({}, { canElicit: true, inputResponses: { color: 'blue' } });
    await tool?.handler({});

    expect(seen[0]).toEqual({ canElicit: true, inputResponses: { color: 'blue' }, caller });
    expect(seen[0]?.caller).toBe(caller);
    expect(seen[1]).toEqual({ canElicit: false, caller });
  });

  it('keeps the definition itself, schema included', () => {
    const [tool] = bindCaller([echo], testToolContext());

    expect(tool?.inputSchema).toBe(echo.inputSchema);
    expect(tool?.name).toBe('echo');
  });
});
