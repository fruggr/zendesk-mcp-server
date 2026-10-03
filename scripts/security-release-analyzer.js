/**
 * semantic-release plugin (analyzeCommits + generateNotes): cut a patch release
 * when HEAD fixes a known advisory in a package that dist/ bundles.
 *
 * dist/ inlines its dependencies, so a fix reaches users only through a release.
 * Dependency batches and lockfile refreshes are `chore` commits and release
 * nothing on their own: this plugin is what turns the ones that fix an advisory
 * into a patch. It compares `pnpm audit` on the last release's lockfile with
 * HEAD's, keeping only advisories against a package named in the bundle SBOM
 * (dist/sbom.cdx.json, written by the build), so a fixed dev tool releases
 * nothing. Rationale: docs/decisions/oauth-authorization-server.md (Packaging).
 *
 * It fails open: an audit that cannot run (registry outage) warns and leaves the
 * decision to the commit analyzer rather than blocking every release.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCKFILE_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

export const bundledNames = (sbom) =>
  new Set((sbom.components ?? []).map((component) => component.name));

// Matched on the package name: the SBOM is HEAD's, and the last release may have
// bundled another version of the same package.
export const advisoriesOn = (report, names) =>
  new Map(
    Object.entries(report.advisories ?? {}).filter(([, advisory]) =>
      names.has(advisory.module_name),
    ),
  );

export const fixedAdvisories = (before, after) =>
  [...before].filter(([id]) => !after.has(id)).map(([, advisory]) => advisory);

export const renderSecurityNotes = (fixed) =>
  fixed.length === 0
    ? ''
    : [
        '### Security',
        '',
        ...fixed.map(
          (a) =>
            `* **${a.module_name}:** ${a.title} ([${a.github_advisory_id}](${a.url}), ${a.severity})`,
        ),
        '',
      ].join('\n');

// pnpm exits non-zero whenever it finds an advisory; the report is on stdout either way.
const runAudit = (dir) => {
  let stdout;
  try {
    stdout = execFileSync('pnpm', ['audit', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    stdout = err.stdout;
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`pnpm audit returned no report in ${dir}`, { cause: err });
  }
};

const auditAt = (cwd) => (ref) => {
  if (ref === 'HEAD') return runAudit(cwd);
  const dir = mkdtempSync(join(tmpdir(), 'security-release-'));
  try {
    for (const file of LOCKFILE_INPUTS) {
      writeFileSync(join(dir, file), execFileSync('git', ['show', `${ref}:${file}`], { cwd }));
    }
    return runAudit(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The plugin over injectable IO, so its decisions are testable without a registry. */
export const createAnalyzer = (io) => {
  let fixed = [];
  return {
    analyzeCommits: async (_pluginConfig, { cwd, lastRelease, logger }) => {
      fixed = [];
      if (!lastRelease?.gitTag) return null;
      try {
        const names = bundledNames(io.readSbom(cwd));
        const audit = io.audit ?? auditAt(cwd);
        fixed = fixedAdvisories(
          advisoriesOn(audit(lastRelease.gitTag), names),
          advisoriesOn(audit('HEAD'), names),
        );
      } catch (err) {
        logger.warn(`Security release check skipped: ${err.message}`);
        return null;
      }
      if (fixed.length === 0) return null;
      logger.log(
        `HEAD fixes ${fixed.length} ${fixed.length === 1 ? 'advisory' : 'advisories'} in the bundle: ${fixed
          .map((a) => `${a.module_name} (${a.github_advisory_id})`)
          .join(', ')}.`,
      );
      return 'patch';
    },
    generateNotes: async () => renderSecurityNotes(fixed),
  };
};

const plugin = createAnalyzer({
  readSbom: (cwd) => JSON.parse(readFileSync(join(cwd, 'dist', 'sbom.cdx.json'), 'utf8')),
});

export const { analyzeCommits, generateNotes } = plugin;
