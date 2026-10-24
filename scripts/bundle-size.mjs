/**
 * Watches the size of what ships, chunk by chunk, against two tiers:
 *
 * - bundle-budget.json: a reference per chunk that moves with the project. A
 *   chunk more than `tolerance` over its reference fails the check: a tripwire
 *   for a dependency that grew or arrived unseen, raised in the PR that
 *   justifies the growth.
 * - bundle-ceiling.json: a ceiling fixed from a measured baseline (index, http
 *   and the total). It stops the reference from creeping up forever, and is not
 *   raised without the repository owner.
 *
 * Why two tiers and how to raise each: docs/decisions/startup-footprint.md.
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CEILED = ['index', 'http', 'total'];
const REGION = /^\/\/#region (\S+)/;
const PNPM_PACKAGE = /^node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/;

/** A chunk's name without the content hash Rolldown appends: `http-DLa2DU80.js` is `http`. */
export const logicalChunkName = (file) => file.replace(/(-[A-Za-z0-9_-]{8})?\.js$/, '');

/** The package a bundled module came from, `src` for ours. */
const packageOf = (moduleId) =>
  PNPM_PACKAGE.exec(moduleId)?.[1] ?? moduleId.replace(/^(\\0|\0)/, '').split('/')[0];

/** Bytes per package in one chunk, read from the `//#region <module>` markers Rolldown emits. */
export const packageBreakdown = (source) => {
  const bytes = new Map();
  let current;
  for (const line of source.split('\n')) {
    const region = REGION.exec(line);
    if (region) {
      current = packageOf(region[1]);
      continue;
    }
    if (current === undefined || line.startsWith('//#endregion')) continue;
    bytes.set(current, (bytes.get(current) ?? 0) + Buffer.byteLength(line) + 1);
  }
  return [...bytes]
    .map(([name, size]) => ({ name, bytes: size }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
};

/** The ceiling of each ceiled entry: the baseline times the factor, rounded down. */
export const ceilingsOf = (ceiling) =>
  Object.fromEntries(
    CEILED.map((name) => [name, Math.floor(ceiling.baseline.bytes[name] * ceiling.factor)]),
  );

/**
 * Every chunk's size against both tiers. `sizes` holds one entry per chunk plus
 * `total`. Violations fail the check; notes only suggest.
 */
export const evaluateBudget = (sizes, budget, ceiling) => {
  const ceilings = ceilingsOf(ceiling);
  const chunks = Object.keys(sizes).filter((name) => name !== 'total');
  const violations = [];
  const notes = [];
  for (const name of chunks) {
    const size = sizes[name];
    const reference = budget.references[name];
    if (reference === undefined) {
      violations.push({ tier: 'reference', kind: 'unknown', name, size });
      continue;
    }
    const allowed = Math.max(reference * (1 + budget.tolerance), reference + budget.floorBytes);
    if (size > allowed) violations.push({ tier: 'reference', kind: 'over', name, size, reference });
    else if (size < reference * budget.shrinkNote)
      notes.push({ kind: 'shrunk', name, size, reference });
  }
  for (const name of Object.keys(budget.references)) {
    if (!chunks.includes(name)) violations.push({ tier: 'reference', kind: 'missing', name });
  }
  for (const name of CEILED) {
    const size = sizes[name];
    if (size !== undefined && size > ceilings[name]) {
      violations.push({ tier: 'ceiling', kind: 'over', name, size, ceiling: ceilings[name] });
    }
  }
  return { violations, notes, ceilings };
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const percent = (size, of) => `${size >= of ? '+' : ''}${(((size - of) / of) * 100).toFixed(1)} %`;
const headroom = (size, ceil) => `${(((ceil - size) / ceil) * 100).toFixed(1)} %`;

const describeViolation = (violation, budget, ceiling) => {
  const { name, size } = violation;
  if (violation.kind === 'unknown') {
    return `\`${name}\` (${kb(size)}) is a new chunk with no reference: add it to bundle-budget.json, and say in the PR what it is.`;
  }
  if (violation.kind === 'missing') {
    return `\`${name}\` has a reference but was not built: remove it from bundle-budget.json if it is gone on purpose.`;
  }
  if (violation.tier === 'reference') {
    return `\`${name}\` is ${kb(size)}, ${percent(size, violation.reference)} over its reference (${kb(violation.reference)}; +${budget.tolerance * 100} % allowed).`;
  }
  return `\`${name}\` is ${kb(size)}, over its ceiling of ${kb(violation.ceiling)} (${ceiling.factor} × the ${kb(ceiling.baseline.bytes[name])} measured at ${ceiling.baseline.commit}).`;
};

const REFERENCE_HELP =
  'The reference is a tripwire, not a hard limit. Find what grew in the breakdown below. If the growth is justified (a feature, a dependency upgrade), raise the reference in bundle-budget.json in this PR and say why; otherwise remove the cause (lazy loading, a narrower import, another dependency).';
const CEILING_HELP =
  'The ceiling is not raised in a feature PR: shrink the bundle instead. Raising it takes the `bundle-ceiling-raise` label, a code-owner review and a new section in docs/decisions/startup-footprint.md.';

/** The report: a table of every chunk, then what failed and what grew, as Markdown. */
export const renderReport = (sizes, budget, ceiling, result, breakdowns) => {
  const lines = [
    '## Bundle size',
    '',
    '| Chunk | Size | Reference | vs reference | Ceiling | Ceiling headroom |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const name of Object.keys(sizes)) {
    const size = sizes[name];
    const reference = budget.references[name];
    const ceil = result.ceilings[name];
    lines.push(
      `| \`${name}\` | ${kb(size)} | ${reference === undefined ? '—' : kb(reference)} | ${reference === undefined ? '—' : percent(size, reference)} | ${ceil === undefined ? '—' : kb(ceil)} | ${ceil === undefined ? '—' : headroom(size, ceil)} |`,
    );
  }
  const failed = result.violations;
  if (failed.length > 0) {
    lines.push('', `### ${failed.length} over budget`, '');
    for (const violation of failed)
      lines.push(`- ${describeViolation(violation, budget, ceiling)}`);
    if (failed.some((v) => v.tier === 'reference')) lines.push('', REFERENCE_HELP);
    if (failed.some((v) => v.tier === 'ceiling')) lines.push('', CEILING_HELP);
  }
  for (const note of result.notes) {
    lines.push(
      '',
      `\`${note.name}\` is ${percent(note.size, note.reference)} under its reference: lower it in bundle-budget.json to keep the tripwire tight.`,
    );
  }
  const shown = [...new Set([...failed.map((v) => v.name), ...Object.keys(breakdowns)])].filter(
    (name) => breakdowns[name] !== undefined,
  );
  for (const name of shown) {
    lines.push('', `<details><summary>Largest packages in \`${name}\`</summary>`, '');
    for (const entry of breakdowns[name].slice(0, 8))
      lines.push(`- ${entry.name}: ${kb(entry.bytes)}`);
    lines.push('', '</details>');
  }
  return `${lines.join('\n')}\n`;
};

/** Sizes and per-package breakdowns of every chunk in `dist`, plus the `total`. */
export const measureDist = (dist) => {
  const files = readdirSync(dist).filter((file) => file.endsWith('.js'));
  const sizes = {};
  const breakdowns = {};
  for (const file of files.sort()) {
    const name = logicalChunkName(file);
    sizes[name] = statSync(join(dist, file)).size;
    breakdowns[name] = packageBreakdown(readFileSync(join(dist, file), 'utf8'));
  }
  sizes.total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
  return { sizes, breakdowns };
};

const readJson = (file) => JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));

// Only run when invoked as a program: the exports above are unit-tested.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const budget = readJson('bundle-budget.json');
  const ceiling = readJson('bundle-ceiling.json');
  const { sizes, breakdowns } = measureDist(join(repoRoot, 'dist'));
  const result = evaluateBudget(sizes, budget, ceiling);
  const report = renderReport(sizes, budget, ceiling, result, breakdowns);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (result.violations.length > 0) process.exit(1);
}
