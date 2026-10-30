import { describe, expect, it } from 'vitest';
import type { ToolMode } from '../../src/config';
import { reviewToolDefinitions, type ToolDefinitionProblem } from './checks';
import { listSurface } from './surface';

// The deterministic gate on what a client reads. The rubric's judgment part is
// the `tool-definition-review` skill's job: docs/mcp-metadata.md.

const report = (problems: readonly ToolDefinitionProblem[]): string =>
  `\n${problems.length} tool definition problem(s):\n\n${problems.map(({ message }) => `- ${message}`).join('\n')}\n`;

describe.each<ToolMode>(['all', 'namespace', 'single'])('tools/list in %s mode', (mode) => {
  it('passes the tool-definition checks', async () => {
    const { problems } = reviewToolDefinitions('zendesk', await listSurface(mode));
    expect(problems, report(problems)).toEqual([]);
  });
});
