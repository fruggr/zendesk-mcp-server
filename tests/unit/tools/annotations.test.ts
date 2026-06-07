import { describe, expect, it } from 'vitest';
import { createAllTools, type ToolContext } from '../../../src/tools';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };
const tools = createAllTools(ctx);

describe('tool annotation invariants', () => {
  it('every tool: readOnly matches annotations.readOnlyHint', () => {
    const violations = tools
      .filter((t) => t.annotations.readOnlyHint !== t.readOnly)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it('every tool: a read-only tool cannot be destructive', () => {
    const violations = tools
      .filter((t) => t.readOnly && t.annotations.destructiveHint)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it('every tool: openWorldHint=true (this server always hits Zendesk)', () => {
    const violations = tools.filter((t) => !t.annotations.openWorldHint).map((t) => t.name);
    expect(violations).toEqual([]);
  });
});
