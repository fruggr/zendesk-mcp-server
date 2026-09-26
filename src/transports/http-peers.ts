/**
 * Packages only the HTTP transport uses, shipped as optional peer dependencies so
 * a stdio install (npx, bunx) never downloads them. Kept equal to `package.json`
 * `peerDependencies` by a unit test. Rationale: docs/decisions/oauth-authorization-server.md
 * (Packaging).
 */
export const HTTP_PEERS: Readonly<Record<string, string>> = {
  'oidc-provider': '~9.12.2',
  jose: '^6.2.12',
  '@modelcontextprotocol/node': '^2.0.0',
};

type HttpTransportModule = typeof import('./http');

const installCommand = (): string =>
  [
    'npm install @fruggr/zendesk-mcp-server',
    ...Object.entries(HTTP_PEERS).map(([name, range]) => `${name}@${range}`),
  ].join(' ');

const missingPeers = (err: unknown): string[] => {
  if ((err as { code?: unknown } | null)?.code !== 'ERR_MODULE_NOT_FOUND') return [];
  const message = String((err as Error).message);
  return Object.keys(HTTP_PEERS).filter((name) => message.includes(`'${name}'`));
};

/** Import the HTTP transport, turning a missing optional peer into an actionable error. */
export const loadHttpTransport = async (
  importer: () => Promise<HttpTransportModule> = () => import('./http'),
): Promise<HttpTransportModule> => {
  try {
    return await importer();
  } catch (err) {
    const missing = missingPeers(err);
    if (missing.length === 0) throw err;
    throw new Error(
      `The HTTP transport needs optional packages that are not installed (missing: ${missing.join(', ')}). Install them next to the server:\n  ${installCommand()}\nstdio does not need them. See docs/http-deployment.md.`,
      { cause: err },
    );
  }
};
