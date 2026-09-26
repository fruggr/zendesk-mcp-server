import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HTTP_PEERS, loadHttpTransport } from '../../../src/transports/http-peers';

const notFound = (message: string) =>
  Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });

describe('HTTP_PEERS', () => {
  it('matches the optional peer dependencies declared in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.peerDependencies).toEqual(HTTP_PEERS);
    for (const name of Object.keys(HTTP_PEERS)) {
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
      // Tests and `dev:http` need them; a regular dependency would ship them to stdio users.
      expect(pkg.devDependencies[name]).toBeDefined();
      expect(pkg.dependencies[name]).toBeUndefined();
    }
  });
});

describe('loadHttpTransport', () => {
  it('loads the real transport by default', async () => {
    const module = await loadHttpTransport();
    expect(module.startHttpTransport).toBeTypeOf('function');
  });

  it('returns the module when every peer is installed', async () => {
    const module = { startHttpTransport: () => undefined };
    await expect(loadHttpTransport(async () => module)).resolves.toBe(module);
  });

  it('names the missing package and the whole install command', async () => {
    const importer = () =>
      Promise.reject(
        notFound("Cannot find package 'oidc-provider' imported from /app/dist/http-abc.js"),
      );
    const error = await loadHttpTransport(importer).catch((err: unknown) => err as Error);
    expect(error.message).toMatchInlineSnapshot(`
      "The HTTP transport needs optional packages that are not installed (missing: oidc-provider). Install them next to the server:
        npm install @fruggr/zendesk-mcp-server oidc-provider@~9.12.2 jose@^6.2.12 @modelcontextprotocol/node@^2.0.0
      stdio does not need them. See docs/http-deployment.md."
    `);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('recognises a scoped package', async () => {
    const importer = () =>
      Promise.reject(notFound("Cannot find package '@modelcontextprotocol/node' imported from /x"));
    await expect(loadHttpTransport(importer)).rejects.toThrow(
      '(missing: @modelcontextprotocol/node)',
    );
  });

  it('rethrows a missing module that is not one of the peers untouched', async () => {
    const original = notFound("Cannot find package 'left-pad' imported from /x");
    await expect(loadHttpTransport(() => Promise.reject(original))).rejects.toBe(original);
  });

  it('rethrows any other import failure untouched', async () => {
    const original = new Error("Cannot find package 'jose' but not a resolution error");
    await expect(loadHttpTransport(() => Promise.reject(original))).rejects.toBe(original);
  });

  it('rethrows a non-Error rejection untouched', async () => {
    await expect(loadHttpTransport(() => Promise.reject('boom'))).rejects.toBe('boom');
  });
});
