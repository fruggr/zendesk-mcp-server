/**
 * Custom semantic-release "generateNotes" plugin.
 *
 * Wraps the official @semantic-release/release-notes-generator and post-processes
 * its markdown so that "internal" commit types (chore, ci, build, test, refactor,
 * docs, style…) are still listed in every release — addressing the gap where
 * non-triggering commits never showed up in any changelog — but are tucked away
 * in a single collapsed <details> block so the public-facing sections (Features,
 * Bug Fixes, Performance Improvements, breaking changes…) stay front and center.
 *
 * No Handlebars templates are reimplemented, so this stays robust across preset
 * version bumps: we only reorganize the rendered output.
 *
 * Plugin options (in addition to everything @semantic-release/release-notes-generator
 * accepts, which is passed straight through):
 *   - collapsedSections: string[]  section titles to move into the <details> block.
 *   - collapsedSummary:   string    text shown on the collapsible <summary>.
 */
import { generateNotes as officialGenerateNotes } from '@semantic-release/release-notes-generator';

const DEFAULT_COLLAPSED_SECTIONS = [
  'Documentation',
  'Styles',
  'Code Refactoring',
  'Tests',
  'Build System',
  'Continuous Integration',
  'Chores',
];

const DEFAULT_SUMMARY = '🔧 Internal changes (chore, ci, build, refactor, tests, docs…)';

export async function generateNotes(pluginConfig, context) {
  const { collapsedSections = DEFAULT_COLLAPSED_SECTIONS, collapsedSummary = DEFAULT_SUMMARY } =
    pluginConfig;

  const notes = await officialGenerateNotes(pluginConfig, context);

  return collapseInternalSections(notes, new Set(collapsedSections), collapsedSummary);
}

/**
 * Splits the rendered notes into the leading header and the individual `### …`
 * sections, then rebuilds them with the internal sections grouped inside a single
 * collapsed <details> block placed after the public ones.
 */
export function collapseInternalSections(notes, collapsedSet, summary) {
  if (!notes?.trim()) {
    return notes;
  }

  // First chunk is the header (`## [x.y.z](…) (date)`), the rest are `### …` sections.
  const chunks = notes.split(/\n(?=### )/);
  if (chunks.length <= 1) {
    return notes;
  }

  const header = chunks[0].trimEnd();
  const publicSections = [];
  const internalSections = [];

  for (const chunk of chunks.slice(1)) {
    const firstLine = chunk.split('\n', 1)[0];
    const title = firstLine.replace(/^###\s+/, '').trim();

    if (collapsedSet.has(title)) {
      internalSections.push(chunk.trim());
    } else {
      publicSections.push(chunk.trim());
    }
  }

  let output = header;

  for (const section of publicSections) {
    output += `\n\n${section}`;
  }

  if (internalSections.length > 0) {
    output += `\n\n<details>\n<summary>${summary}</summary>\n\n${internalSections.join('\n\n')}\n</details>`;
  }

  return output;
}
