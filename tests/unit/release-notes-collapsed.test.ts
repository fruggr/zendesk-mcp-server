import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain JS semantic-release plugin, no type declarations
import { collapseInternalSections } from '../../scripts/release-notes-collapsed.js';

const COLLAPSED = new Set([
  'Documentation',
  'Styles',
  'Chores',
  'Code Refactoring',
  'Tests',
  'Build System',
  'Continuous Integration',
]);
const SUMMARY = 'Internal changes';

describe('collapseInternalSections', () => {
  it('moves internal sections into a single collapsed <details> block after public ones', () => {
    const notes = [
      '## [1.2.0](url) (2026-05-31)',
      '',
      '### Features',
      '',
      '* add a thing (abc)',
      '',
      '### Chores',
      '',
      '* **deps:** bump dep (def)',
      '',
      '### Tests',
      '',
      '* cover edge case (ghi)',
    ].join('\n');

    const result = collapseInternalSections(notes, COLLAPSED, SUMMARY);

    // Public section stays at top level, before the details block.
    const featuresIdx = result.indexOf('### Features');
    const detailsIdx = result.indexOf('<details>');
    expect(featuresIdx).toBeGreaterThan(-1);
    expect(detailsIdx).toBeGreaterThan(featuresIdx);

    // Internal sections live inside the details block.
    expect(result).toContain(`<summary>${SUMMARY}</summary>`);
    expect(result.indexOf('### Chores')).toBeGreaterThan(detailsIdx);
    expect(result.indexOf('### Tests')).toBeGreaterThan(detailsIdx);
    expect(result.trimEnd().endsWith('</details>')).toBe(true);

    // Exactly one collapsible wraps all internal sections.
    expect(result.match(/<details>/g)).toHaveLength(1);
  });

  it('keeps breaking-change notes at the top, outside the collapsed block', () => {
    const notes = [
      '## [2.0.0](url) (2026-05-31)',
      '',
      '### ⚠ BREAKING CHANGES',
      '',
      '* removed v1 routes',
      '',
      '### Chores',
      '',
      '* **deps:** bump dep (def)',
    ].join('\n');

    const result = collapseInternalSections(notes, COLLAPSED, SUMMARY);

    expect(result.indexOf('BREAKING CHANGES')).toBeLessThan(result.indexOf('<details>'));
  });

  it('emits no <details> block when there are no internal sections', () => {
    const notes = ['## [1.0.1](url) (2026-05-31)', '', '### Bug Fixes', '', '* fix it (abc)'].join(
      '\n',
    );

    const result = collapseInternalSections(notes, COLLAPSED, SUMMARY);

    expect(result).not.toContain('<details>');
    expect(result).toContain('### Bug Fixes');
  });

  it('returns the input unchanged when there are no sections', () => {
    expect(collapseInternalSections('## [1.0.0](url) (2026-05-31)', COLLAPSED, SUMMARY)).toBe(
      '## [1.0.0](url) (2026-05-31)',
    );
    expect(collapseInternalSections('', COLLAPSED, SUMMARY)).toBe('');
  });
});
