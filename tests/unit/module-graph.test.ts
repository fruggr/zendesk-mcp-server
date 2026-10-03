import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static `import`/`export ... from` edges only: `import type`/`export type` are
// erased and `import()` is what defers a module to the transport that needs it.
const STATIC_IMPORT =
  /^(?:import\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?|export\s+(?!type\s)[^'"]*?\sfrom\s+)['"]([^'"]+)['"]/gm;

// A `.js` specifier names its `.ts` source, as TypeScript resolves it.
const resolveLocal = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  return [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
};

// Every module (local path or package name) a cold start of `entry` loads.
const staticClosure = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      if (specifier === undefined) continue;
      const local = resolveLocal(file, specifier);
      if (local) visit(local);
      else if (!specifier.startsWith('.')) seen.add(specifier);
    }
  };
  visit(resolve(entry));
  return seen;
};

const STDIO_ONLY = [
  'open',
  resolve('src/auth/browser-oauth.ts'),
  resolve('src/auth/token-store.ts'),
];

describe('module graph', () => {
  it('keeps the stdio sign-in path out of what every start loads', () => {
    const loaded = staticClosure('src/index.ts');
    expect(STDIO_ONLY.filter((m) => loaded.has(m))).toEqual([]);
  });

  it('keeps the stdio sign-in path out of the HTTP transport', () => {
    const loaded = staticClosure('src/transports/http.ts');
    expect(loaded.has('oidc-provider')).toBe(true);
    expect(STDIO_ONLY.filter((m) => loaded.has(m))).toEqual([]);
  });

  it('still reaches the browser sign-in from the stdio token store', () => {
    const loaded = staticClosure('src/auth/token-store.ts');
    expect(loaded.has('open')).toBe(true);
  });
});
