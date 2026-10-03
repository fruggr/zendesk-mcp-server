import { describe, expect, it, vi } from 'vitest';
import {
  advisoriesOn,
  bundledNames,
  createAnalyzer,
  fixedAdvisories,
  renderSecurityNotes,
  // @ts-expect-error - plain JS semantic-release plugin, no type declarations
} from '../../scripts/security-release-analyzer.js';

const advisory = (id: number, module: string, title = `${module} is vulnerable`) => ({
  id,
  module_name: module,
  title,
  severity: 'high',
  github_advisory_id: `GHSA-${id}`,
  url: `https://github.com/advisories/GHSA-${id}`,
  findings: [{ version: '1.0.0', paths: [`.>${module}`] }],
});

const audit = (...entries: ReturnType<typeof advisory>[]) => ({
  advisories: Object.fromEntries(entries.map((entry) => [String(entry.id), entry])),
  metadata: {},
});

const SBOM = {
  components: [{ name: 'cheerio' }, { name: '@scope/pkg' }, { name: 'zod' }],
};

describe('bundledNames', () => {
  it('reads the package names out of the bundle SBOM', () => {
    expect([...bundledNames(SBOM)].sort()).toEqual(['@scope/pkg', 'cheerio', 'zod']);
  });

  it('treats an SBOM without components as an empty bundle', () => {
    expect(bundledNames({}).size).toBe(0);
  });
});

describe('advisoriesOn', () => {
  it('keeps only the advisories against a bundled package', () => {
    const report = audit(advisory(1, 'cheerio'), advisory(2, 'vitest'), advisory(3, '@scope/pkg'));
    expect([...advisoriesOn(report, bundledNames(SBOM)).keys()]).toEqual(['1', '3']);
  });

  it('reads an audit with no advisories as none', () => {
    expect(advisoriesOn({}, bundledNames(SBOM)).size).toBe(0);
  });
});

describe('fixedAdvisories', () => {
  it('lists what the last release carried and HEAD no longer does', () => {
    const names = bundledNames(SBOM);
    const before = advisoriesOn(audit(advisory(1, 'cheerio'), advisory(3, 'zod')), names);
    const after = advisoriesOn(audit(advisory(3, 'zod'), advisory(4, 'cheerio')), names);
    expect(fixedAdvisories(before, after).map((a: { id: number }) => a.id)).toEqual([1]);
  });
});

describe('renderSecurityNotes', () => {
  it('renders one line per fixed advisory', () => {
    expect(renderSecurityNotes([advisory(1, 'cheerio', 'XSS in cheerio')])).toMatchInlineSnapshot(`
      "### Security

      * **cheerio:** XSS in cheerio ([GHSA-1](https://github.com/advisories/GHSA-1), high)
      "
    `);
  });

  it('renders nothing when nothing was fixed', () => {
    expect(renderSecurityNotes([])).toBe('');
  });
});

describe('the semantic-release plugin', () => {
  const context = (gitTag?: string) => ({
    cwd: '/repo',
    lastRelease: gitTag ? { gitTag, version: '3.0.2' } : {},
    logger: { log: vi.fn(), warn: vi.fn() },
  });

  const analyzerWith = (audits: Record<string, unknown>) =>
    createAnalyzer({
      readSbom: () => SBOM,
      audit: (ref: string) => audits[ref],
    });

  it('asks for a patch release when HEAD fixes an advisory against a bundled package', async () => {
    const plugin = analyzerWith({
      'v3.0.2': audit(advisory(1, 'cheerio'), advisory(2, 'vitest')),
      HEAD: audit(),
    });
    const ctx = context('v3.0.2');
    expect(await plugin.analyzeCommits({}, ctx)).toBe('patch');
    expect(ctx.logger.log).toHaveBeenCalledWith(
      'HEAD fixes 1 advisory in the bundle: cheerio (GHSA-1).',
    );
    expect(await plugin.generateNotes({}, ctx)).toContain('* **cheerio:** cheerio is vulnerable');
  });

  it('leaves the decision to the commits when only a dev tool was fixed', async () => {
    const plugin = analyzerWith({ 'v3.0.2': audit(advisory(2, 'vitest')), HEAD: audit() });
    expect(await plugin.analyzeCommits({}, context('v3.0.2'))).toBeNull();
    expect(await plugin.generateNotes({}, context('v3.0.2'))).toBe('');
  });

  it('leaves the decision to the commits before the first release', async () => {
    const audits = vi.fn();
    const plugin = createAnalyzer({ readSbom: () => SBOM, audit: audits });
    expect(await plugin.analyzeCommits({}, context())).toBeNull();
    expect(audits).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an error report',
      { error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: 'registry said 500' } },
      'registry said 500',
    ],
    [
      'an error without message',
      { error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } },
      'ERR_PNPM_AUDIT_BAD_RESPONSE',
    ],
    ['a report without advisories', { metadata: {} }, 'no advisories in the report'],
    ['a null advisories field', { advisories: null }, 'no advisories in the report'],
  ])('never reads %s at HEAD as every advisory fixed', async (_, headReport, reason) => {
    const plugin = analyzerWith({ 'v3.0.2': audit(advisory(1, 'cheerio')), HEAD: headReport });
    const ctx = context('v3.0.2');
    expect(await plugin.analyzeCommits({}, ctx)).toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      `Security release check skipped: pnpm audit failed at HEAD: ${reason}`,
    );
    expect(await plugin.generateNotes({}, ctx)).toBe('');
  });

  it('warns and asks for nothing when an audit cannot run', async () => {
    const plugin = createAnalyzer({
      readSbom: () => SBOM,
      audit: () => {
        throw new Error('registry unreachable');
      },
    });
    const ctx = context('v3.0.2');
    expect(await plugin.analyzeCommits({}, ctx)).toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'Security release check skipped: registry unreachable',
    );
  });
});
