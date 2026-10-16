import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Namespace } from '../../../src/config';
import { createMcpServer } from '../../../src/server';
import { makeConfig } from '../harness';

/**
 * What `tools/list` hands an agent for one namespace in `all` mode: names,
 * titles, descriptions, annotations and the emitted JSON Schema. Pinned whole
 * because `docs/mcp-metadata.md` forbids changing any of it silently — a diff
 * here is a schema change to justify in the PR, not a snapshot to refresh.
 */
export const listExposedTools = async (namespace: Namespace) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(
    makeConfig({ mode: 'all', namespaces: [namespace] }),
    () => 'token',
  );
  await server.connect(serverTransport);
  const client = new Client({ name: 'tools-list-snapshot', version: '0.0.0' });
  await client.connect(clientTransport);
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
    await client.close();
    await server.close();
  }
};
