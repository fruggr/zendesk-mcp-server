import { type Namespace, Namespace as Namespaces, type ToolMode } from '../../src/config';
import { makeConfig } from '../integration/harness';
import { stdioHarness } from '../integration/stdio-harness';

/**
 * This repository's `tools/list` with every namespace on — the only part of the
 * tool-definition checks that knows about this server.
 */
export const listSurface = async (
  mode: ToolMode,
  namespaces: readonly Namespace[] = Namespaces.options,
) => {
  const { client, close } = await stdioHarness.connect(
    makeConfig({ mode, namespaces: [...namespaces] }),
  );
  try {
    return await client.listTools();
  } finally {
    await close();
  }
};
