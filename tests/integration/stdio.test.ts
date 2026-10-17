import { describe, expect, it } from 'vitest';
import { registerCoreScenarios } from './core-scenarios';
import { MODERN_REVISION, makeConfig } from './harness';
import { createStdioHarness, stdioHarness } from './stdio-harness';

// Runs the shared MCP roundtrip scenarios against the stdio transport, in both
// protocol eras; the sibling http.test.ts runs the same scenarios over HTTP.
registerCoreScenarios(stdioHarness);
registerCoreScenarios(createStdioHarness('2026'));

describe('[stdio] protocol eras', () => {
  it('negotiates 2026-07-28 with a client pinned to it', async () => {
    const { client, close } = await createStdioHarness('2026').connect(makeConfig());
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_REVISION);
    } finally {
      await close();
    }
  });

  it('keeps a default client on a 2025 revision', async () => {
    const { client, close } = await stdioHarness.connect(makeConfig());
    try {
      expect(client.getNegotiatedProtocolVersion()).toMatch(/^2025-/);
    } finally {
      await close();
    }
  });

  it('serves the same tool list in both eras', async () => {
    const list = async (era: '2025' | '2026') => {
      const { client, close } = await createStdioHarness(era).connect(makeConfig({ mode: 'all' }));
      try {
        return (await client.listTools()).tools;
      } finally {
        await close();
      }
    };

    expect(await list('2026')).toEqual(await list('2025'));
  });
});
