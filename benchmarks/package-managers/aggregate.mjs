#!/usr/bin/env node
// Aggregate raw benchmark cells (from run.sh) into results.json, results.md and,
// when running under GitHub Actions, a $GITHUB_STEP_SUMMARY table.
//
// Input:  <outDir>/manifest.jsonl  + per-cell files (hf-*.json / simple-*.txt)
// Output: <outDir>/results.json, <outDir>/results.md, step summary (if in CI)

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: aggregate.mjs <outDir>');
  process.exit(1);
}

const manifestPath = join(outDir, 'manifest.jsonl');
if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}`);
  process.exit(1);
}

const stats = (times) => {
  const xs = [...times].sort((a, b) => a - b);
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, stddev: Math.sqrt(variance), min: xs[0], max: xs[n - 1], runs: n };
};

const cells = readFileSync(manifestPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map((cell) => {
    if (cell.status !== 'ok') return { ...cell, stats: null };
    try {
      let times;
      if (cell.mode === 'hyperfine') {
        const hf = JSON.parse(readFileSync(join(outDir, cell.file), 'utf8'));
        times = hf.results[0].times;
      } else {
        times = readFileSync(join(outDir, cell.file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(Number);
      }
      return { ...cell, stats: stats(times) };
    } catch (err) {
      return { ...cell, status: 'failed', stats: null, error: String(err) };
    }
  });

const scenarios = [...new Set(cells.map((c) => c.scenario))];
const tools = [...new Set(cells.map((c) => c.tool))];

const scenarioBlurb = {
  cold: 'empty store + no node_modules (network fetch + extract + link)',
  warm: 'populated store, node_modules removed (link/import only)',
  repeat: 'store + node_modules present and valid (up-to-date no-op)',
};

const fmtMs = (s) => `${(s * 1000).toFixed(0)} ms`;
const cellFor = (tool, scenario) => cells.find((c) => c.tool === tool && c.scenario === scenario);

// --- results.json -------------------------------------------------------------
writeFileSync(
  join(outDir, 'results.json'),
  `${JSON.stringify(
    {
      generatedBy: 'benchmarks/package-managers/run.sh',
      scenarios,
      tools,
      cells: cells.map(({ file, ...rest }) => rest),
    },
    null,
    2,
  )}\n`,
);

// --- Markdown -----------------------------------------------------------------
const lines = [];
lines.push('# Package-manager install benchmark');
lines.push('');
lines.push("Install of this repository's dependencies (`--frozen-lockfile`), per cache scenario.");
lines.push('Lower is better. **Relative** compares against the `pnpm` (JS) baseline.');
lines.push('');

const statusNote = (c) => {
  if (!c) return 'not run';
  if (c.status === 'missing') return '_tool not installed_';
  if (c.status === 'failed') return '_failed / N-A_';
  return null;
};

for (const scenario of scenarios) {
  lines.push(`## \`${scenario}\` — ${scenarioBlurb[scenario] ?? ''}`);
  lines.push('');
  lines.push('| Tool | Engine | Mean | Min | Max | Runs | Relative |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');

  const baseline = cellFor('pnpm', scenario);
  const baseMean = baseline?.stats?.mean ?? null;

  for (const tool of tools) {
    const c = cellFor(tool, scenario);
    const note = statusNote(c);
    if (note) {
      lines.push(`| ${tool} | ${c?.engine ?? tool} | ${note} | | | | |`);
      continue;
    }
    const s = c.stats;
    let rel = '—';
    if (baseMean && tool !== 'pnpm') {
      const x = baseMean / s.mean;
      rel = x >= 1 ? `${x.toFixed(2)}× faster` : `${(1 / x).toFixed(2)}× slower`;
    } else if (tool === 'pnpm') {
      rel = 'baseline';
    }
    lines.push(
      `| ${tool} | ${c.engine} | ${fmtMs(s.mean)} ± ${fmtMs(s.stddev)} | ${fmtMs(
        s.min,
      )} | ${fmtMs(s.max)} | ${s.runs} | ${rel} |`,
    );
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push(
  '> `pnpm-rust` = the pacquet Rust engine driving the fetch/link phase of `pnpm install` (experimental preview). `nub` reads the same `pnpm-lock.yaml`. See `README.md` for methodology and caveats.',
);
lines.push('');

const md = `${lines.join('\n')}\n`;
writeFileSync(join(outDir, 'results.md'), md);

// --- Console + GitHub step summary --------------------------------------------
process.stdout.write(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
