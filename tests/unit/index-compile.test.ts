import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the zod compilation opt-in.
 *
 * `import 'zod/compile'` installs a global post-processor that compiles each schema on its
 * first parse. It only reaches schemas built by modules that evaluate *after* it, so its
 * position is load-bearing: demote it below any other import in the entrypoint and every
 * schema constructed by the imported module graph silently keeps the runtime parser.
 *
 * Nothing else would catch that. The server keeps working, `tools/list` is unchanged, every
 * test still passes — the compilation just stops happening, several files away from the
 * symptom. `src/index.ts` is out of both the coverage scope (`vitest.config.ts`) and the
 * mutation scope (`stryker.config.mjs`), so this file is the only gate looking at it.
 * Background: `docs/decisions/zod-compile.md`.
 */

const SIDE_EFFECT_IMPORT = /^import\s+['"]zod\/compile['"];?$/;

const firstCodeLine = (relative: string): string => {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const line = source
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
  return line ?? '';
};

describe('zod/compile opt-in', () => {
  it.each([
    ['src/index.ts', '../../src/index.ts'],
    ['tests/setup.ts', '../setup.ts'],
  ])('%s starts with the zod/compile side-effect import', (label, relative) => {
    const first = firstCodeLine(relative);
    expect(
      SIDE_EFFECT_IMPORT.test(first),
      `${label} must begin with \`import 'zod/compile';\` (comments aside) — found \`${first}\`. ` +
        'Schemas built by modules that evaluate before it are never compiled, so moving or ' +
        'dropping this import silently disables the optimisation. See docs/decisions/zod-compile.md.',
    ).toBe(true);
  });
});
