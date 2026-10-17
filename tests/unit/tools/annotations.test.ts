import { describe, expect, it } from 'vitest';
import { createAllTools, type ToolContext } from '../../../src/tools';
import { testToolContext } from '../../tool-context';

const ctx: ToolContext = testToolContext({
  subdomain: 'testsubdomain',
  getToken: () => 'test-token',
});
const tools = createAllTools(ctx);

describe('tool annotation invariants', () => {
  // `preferences` is the one namespace that stays on this server: its tool
  // writes the caller's own settings, so its hints say "writes, closed world",
  // while its `readOnly` flag keeps it under --read-only (no Zendesk write).
  const zendeskTools = tools.filter((t) => t.namespace !== 'preferences');
  const localTools = tools.filter((t) => t.namespace === 'preferences');

  it('every Zendesk tool: readOnly matches annotations.readOnlyHint', () => {
    const violations = zendeskTools
      .filter((t) => t.annotations.readOnlyHint !== t.readOnly)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it('every preferences tool: survives --read-only, yet is announced as a closed-world write', () => {
    expect(localTools.map((t) => t.name)).toEqual(['configure_sla_alerts']);
    for (const t of localTools) {
      expect(t.readOnly).toBe(true);
      expect(t.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('every tool: a read-only tool cannot be destructive', () => {
    const violations = tools
      .filter((t) => t.readOnly && t.annotations.destructiveHint)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it('every Zendesk tool: openWorldHint=true', () => {
    const violations = zendeskTools.filter((t) => !t.annotations.openWorldHint).map((t) => t.name);
    expect(violations).toEqual([]);
  });
});
