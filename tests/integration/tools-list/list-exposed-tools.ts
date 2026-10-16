import type { Namespace, ToolMode } from '../../../src/config';
import { makeConfig } from '../harness';
import { stdioHarness } from '../stdio-harness';

/**
 * What `tools/list` hands an agent for one namespace: names, titles,
 * descriptions, annotations and the emitted JSON Schema — every tool in `all`
 * mode, the namespace proxy in `namespace` mode. Pinned whole because
 * `docs/mcp-metadata.md` forbids changing any of it silently — a diff here is a
 * schema change to justify in the PR, not a snapshot to refresh.
 */
export const listExposedTools = async (namespace: Namespace, mode: ToolMode = 'all') => {
  const { client, close } = await stdioHarness.connect(
    makeConfig({ mode, namespaces: [namespace] }),
  );
  try {
    const { tools } = await client.listTools();
    return tools.map(({ name, title, description, annotations, inputSchema }) => ({
      name,
      title,
      description,
      annotations,
      inputSchema,
    }));
  } finally {
    await close();
  }
};
