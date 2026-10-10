import type { ToolResult } from '../src/tools/definitions';

/** Text of a tool result's first block, or `undefined` when that block is an image or absent. */
export const firstText = (result: ToolResult): string | undefined => {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : undefined;
};
