import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// `checks.ts` must stay liftable into a package of its own: it reads a
// `tools/list` result and may import nothing of this repository.
it('checks.ts imports only mcp-tdqs and node built-ins', () => {
  const source = readFileSync(new URL('./checks.ts', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(([, specifier]) => specifier);
  expect(specifiers.filter((s) => s !== 'mcp-tdqs' && !s?.startsWith('node:'))).toEqual([]);
});
