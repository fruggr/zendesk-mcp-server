import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain JS script, no type declarations
import { ceilingsOf } from '../../scripts/bundle-size.mjs';

// The ceiling's two copies: the file CI reads and the table in its ADR. Raising
// it therefore edits the ADR too, where the reason is written down.
const ceiling = JSON.parse(readFileSync('bundle-ceiling.json', 'utf8'));
const adr = readFileSync('docs/decisions/startup-footprint.md', 'utf8');
const table =
  /<!-- bundle-ceiling:start -->([\s\S]*?)<!-- bundle-ceiling:end -->/.exec(adr)?.[1] ?? '';
const rows = Object.fromEntries(
  [...table.matchAll(/^\| `(\w+)` \| (\d+) \| (\d+) \|$/gm)].map(([, name, baseline, ceil]) => [
    name,
    { baseline: Number(baseline), ceiling: Number(ceil) },
  ]),
);

describe('bundle ceiling', () => {
  it('matches the table in docs/decisions/startup-footprint.md', () => {
    const ceilings = ceilingsOf(ceiling);
    expect(Object.keys(rows)).toEqual(['index', 'http', 'total']);
    for (const name of Object.keys(rows)) {
      expect(rows[name]).toEqual({
        baseline: ceiling.baseline.bytes[name],
        ceiling: ceilings[name],
      });
    }
    expect(table).toContain(
      `Factor ${ceiling.factor}, baseline measured at \`${ceiling.baseline.commit}\` on ${ceiling.baseline.date}.`,
    );
  });
});
