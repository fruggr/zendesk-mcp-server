import type { ToolResult } from '../src/tools/definitions';

/** Text of the block at `index`, or `undefined` when that block is an image or absent. */
export const textAt = (result: ToolResult, index: number): string | undefined => {
  const block = result.content[index];
  return block?.type === 'text' ? block.text : undefined;
};

export const firstText = (result: ToolResult): string | undefined => textAt(result, 0);

/** Every text block of a tool result, newline-joined; image blocks are skipped. */
export const allTextOf = (result: ToolResult): string =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
