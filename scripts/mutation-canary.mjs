#!/usr/bin/env node
// The mutation canary: proof that StrykerJS is still observing the test run.
// Mutates `scripts/mutation-canary/subject.ts`, whose verdicts are fixed by
// construction, and fails when the report disagrees — so a runner that stopped
// measuring names itself here rather than failing the next author's diff.
// Why it exists and what each design point buys:
// docs/decisions/mutation-testing.md (§9).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_FILE = 'scripts/mutation-canary/stryker.config.mjs';
const SUBJECT = 'scripts/mutation-canary/subject.ts';

/**
 * The verdict the fixture guarantees for each mutant, keyed by the replacement
 * Stryker reports. `a - b` is what `ArithmeticOperator` makes of the sum the
 * fixture's test asserts exactly, so a working runner must kill it; `a / b` is
 * the same mutator on a product no test reaches, so a working runner must
 * report it unreached.
 */
export const EXPECTED_VERDICTS = Object.freeze({
  'a - b': 'Killed',
  'a / b': 'NoCoverage',
});

/**
 * Compare a mutation report against `EXPECTED_VERDICTS`. Pure, and exhaustive
 * in both directions: a missing mutant, an unexpected one and a wrong verdict
 * are each a finding. Exhaustiveness is the point — a report with no mutants at
 * all is precisely the shape a broken run produces, and "nothing escaped" would
 * wave it through.
 */
export const judgeCanary = (report, expected = EXPECTED_VERDICTS) => {
  const findings = [];
  const seen = new Map();

  for (const [file, fileReport] of Object.entries(report.files ?? {})) {
    for (const mutant of fileReport.mutants ?? []) {
      // `Ignored` is Stryker reporting a mutant it never ran — an
      // `excludedMutations` entry, or a `// Stryker disable` comment. It carries
      // no verdict, so it is not evidence either way.
      if (mutant.status === 'Ignored') continue;
      const replacement = mutant.replacement ?? '';
      if (seen.has(replacement)) {
        findings.push(`${file}: two mutants share the replacement \`${replacement}\``);
        continue;
      }
      seen.set(replacement, mutant.status);
      if (!Object.hasOwn(expected, replacement)) {
        findings.push(
          `${file}:${mutant.location.start.line} produced an unexpected mutant ` +
            `\`${replacement}\` (${mutant.status}) — the fixture or the set of mutators ` +
            'applied to it has changed. Check the verdict is the right one, then say so in ' +
            'EXPECTED_VERDICTS.',
        );
      }
    }
  }

  for (const [replacement, wanted] of Object.entries(expected)) {
    const actual = seen.get(replacement);
    if (actual === undefined) {
      findings.push(
        `no mutant replaced anything with \`${replacement}\` — expected one, reported ${wanted}.`,
      );
    } else if (actual !== wanted) {
      findings.push(`\`${replacement}\`: expected ${wanted}, reported ${actual}.`);
    }
  }

  return findings;
};

const versionsOf = (...packages) =>
  packages
    .map((name) => {
      try {
        const manifest = join(repoRoot, 'node_modules', name, 'package.json');
        return `${name}@${JSON.parse(readFileSync(manifest, 'utf8')).version}`;
      } catch {
        return `${name}@unknown`;
      }
    })
    .join(', ');

/**
 * Where the canary's JSON report lands, read from the canary config rather than
 * restated — same rule as the gate's `loadConfig`. A hardcoded copy that fell
 * out of sync would leave this judging whatever report was there before, and
 * "Mutation canary passed" off a stale file is the one output this script must
 * never produce.
 */
const reportPathFromConfig = async () => {
  const { default: config } = await import(pathToFileURL(join(repoRoot, CONFIG_FILE)));
  const reportPath = config.jsonReporter?.fileName;
  if (!reportPath) {
    throw new Error(`${CONFIG_FILE} must set \`jsonReporter.fileName\` — the canary reads it.`);
  }
  return reportPath;
};

const run = async () => {
  const reportFile = await reportPathFromConfig();
  const absolute = join(repoRoot, reportFile);
  // Belt to the braces above: judging a report this run did not write is the
  // same false green by another route (a crashed run, an interrupted one).
  rmSync(absolute, { force: true });

  console.log(`Mutating ${SUBJECT} (${versionsOf('vitest', '@stryker-mutator/vitest-runner')})\n`);
  execFileSync('pnpm', ['exec', 'stryker', 'run', CONFIG_FILE], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (!existsSync(absolute)) {
    throw new Error(`${reportFile} not found — Stryker did not produce a JSON report.`);
  }
  const findings = judgeCanary(JSON.parse(readFileSync(absolute, 'utf8')));

  if (findings.length === 0) {
    console.log('\nMutation canary passed: Stryker still observes what the tests do.');
    return;
  }

  // stdout, not stderr: CI tees this into the job summary, and this list is the
  // whole message — same reasoning as the diff gate's escaped-mutant list.
  console.log('\nThe mutation canary FAILED:\n');
  for (const finding of findings) console.log(`  ${finding}`);
  console.log(
    '\nThis is not a test-quality problem, and it is not about the code under\n' +
      'review. The canary fixture is two lines whose verdicts are fixed by\n' +
      'construction, so a wrong verdict means the mutation gate itself is no\n' +
      'longer measuring anything — and every "no mutant escaped" it reports,\n' +
      'here and on every other PR, is uninformative until this is fixed.\n' +
      '\n' +
      'Look first at what changed under the toolchain: the vitest / StrykerJS\n' +
      'versions printed above, `stryker.config.mjs`, `vitest.config.ts`.\n' +
      'The precedent is #297, where vitest 5 changed the separator in the\n' +
      'qualified test name that the runner filters on, so Stryker ran zero\n' +
      'tests per mutant and reported every one of them as survived.\n' +
      'Background: docs/decisions/mutation-testing.md\n',
  );
  process.exitCode = 1;
};

// Only dispatch when run as a program — `judgeCanary` above is unit-tested.
if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
