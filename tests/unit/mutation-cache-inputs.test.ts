import { describe, expect, it } from 'vitest';
import {
  closureOf,
  fingerprint,
  importRoots,
  packageIdentity,
  verdictFieldsOf,
  // @ts-expect-error -- plain .mjs helper, no declaration file (same as the other
  // script tests in this directory).
} from '../../scripts/mutation-cache-inputs.mjs';

// The mutation baseline is reused only while nothing that can change a verdict
// has moved. These helpers decide what "nothing" means, so a gap here replays
// stale verdicts silently, and an excess throws away a cold run for nothing.

const node = (path: string, dependencies?: Record<string, unknown>) => ({
  version: '1.0.0',
  path,
  ...(dependencies ? { dependencies } : {}),
});
const pnpmPath = (dir: string, name: string) =>
  `/repo/node_modules/.pnpm/${dir}/node_modules/${name}`;

describe('importRoots', () => {
  it('reduces every bare specifier to its package name', () => {
    const source = [
      "import { z } from 'zod';",
      "import type { Mock } from 'vitest';",
      "import { setupServer } from 'msw/node';",
      "export { McpServer } from '@modelcontextprotocol/server/mcp';",
      "const html = await import('rehype-parse');",
    ].join('\n');
    expect([...importRoots(source)].sort((a, b) => a.localeCompare(b))).toEqual([
      '@modelcontextprotocol/server',
      'msw',
      'rehype-parse',
      'vitest',
      'zod',
    ]);
  });

  it('ignores relative paths and Node built-ins', () => {
    const source = [
      "import { join } from 'node:path';",
      "import { helper } from './helper.js';",
      "import { other } from '../other.js';",
    ].join('\n');
    expect([...importRoots(source)]).toEqual([]);
  });

  it('drops what a loose scan meets in prose but is not a package name', () => {
    const source = "const msg = `expected a value from 'the token cache'`;";
    expect([...importRoots(source)]).toEqual([]);
  });

  it('reads multi-line imports', () => {
    const source = "import {\n  a,\n  b,\n} from 'cheerio';";
    expect([...importRoots(source)]).toEqual(['cheerio']);
  });
});

describe('packageIdentity', () => {
  it('takes the pnpm store directory, which pins version, peers and patch hash', () => {
    expect(packageIdentity('r', node(pnpmPath('r@10.0.0_patch_hash=d15f_20313f', 'r')))).toBe(
      'r@10.0.0_patch_hash=d15f_20313f',
    );
  });

  it('falls back to name@version outside the store', () => {
    expect(packageIdentity('r', { version: '2.0.0', path: '/elsewhere/r' })).toBe('r@2.0.0');
  });
});

describe('closureOf', () => {
  const tree = {
    devDependencies: {
      vitest: node(pnpmPath('vitest@5.0.0', 'vitest'), {
        tinypool: node(pnpmPath('tinypool@1.0.0', 'tinypool')),
      }),
      '@biomejs/biome': node(pnpmPath('@biomejs+biome@2.0.0', '@biomejs/biome')),
      // pnpm prints a package's subtree once and marks later copies `deduped`.
      msw: { ...node(pnpmPath('msw@3.0.0', 'msw')), deduped: true },
      'mcp-tdqs': node(pnpmPath('mcp-tdqs@1.0.0', 'mcp-tdqs'), {
        msw: node(pnpmPath('msw@3.0.0', 'msw'), {
          'path-to-regexp': node(pnpmPath('path-to-regexp@8.0.0', 'path-to-regexp')),
        }),
      }),
    },
  };

  it('follows transitive dependencies from the roots only', () => {
    expect(closureOf(tree, ['vitest'])).toEqual(['tinypool@1.0.0', 'vitest@5.0.0']);
  });

  it('leaves a tooling package out when nothing imports it', () => {
    expect(closureOf(tree, ['vitest', 'msw'])).not.toContain('@biomejs+biome@2.0.0');
  });

  it('expands a deduped root from the copy printed elsewhere in the tree', () => {
    expect(closureOf(tree, ['msw'])).toEqual(['msw@3.0.0', 'path-to-regexp@8.0.0']);
  });

  it('skips a root that is not installed rather than failing', () => {
    expect(closureOf(tree, ['hast'])).toEqual([]);
  });
});

describe('verdictFieldsOf', () => {
  it('drops the fields a release or a pnpm bump rewrites, and the versions the closure covers', () => {
    const manifest = {
      name: 'zendesk-mcp-server',
      version: '3.10.0',
      packageManager: 'pnpm@12.17.0',
      scripts: { 'test:mutation': 'stryker run' },
      devDependencies: { vitest: '5.0.5' },
    };
    expect(verdictFieldsOf(manifest)).toEqual({
      name: 'zendesk-mcp-server',
      scripts: { 'test:mutation': 'stryker run' },
    });
  });
});

describe('fingerprint', () => {
  const base = { packages: ['a@1.0.0', 'b@1.0.0'], manifest: { name: 'x' } };

  it('does not depend on the order packages were found in', () => {
    expect(fingerprint({ ...base, packages: ['b@1.0.0', 'a@1.0.0'] })).toBe(fingerprint(base));
  });

  it('changes when a package in the closure moves', () => {
    expect(fingerprint({ ...base, packages: ['a@1.0.1', 'b@1.0.0'] })).not.toBe(fingerprint(base));
  });

  it('changes when a kept manifest field moves', () => {
    expect(fingerprint({ ...base, manifest: { name: 'y' } })).not.toBe(fingerprint(base));
  });

  it('is a SHA-256 in hex, usable in a cache key', () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
