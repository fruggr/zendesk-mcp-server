// Pure ordering logic for reorder_article (see src/tools/help-center.ts).
//
// Zendesk exposes no bulk-reorder endpoint and no "sort mode" field: the only
// lever is each article's integer `position` (>= 0), and several articles
// routinely share position 0, so ties resolve in an undefined display order.
// These helpers turn a "move article X relative to the section" request into the
// MINIMAL set of absolute position writes that realises it deterministically,
// leaving unrelated articles untouched. All functions are pure so the tricky
// numeric transform can be unit-tested without any network.

export type ReorderTarget = 'top' | 'bottom' | 'before' | 'after';

// One article's identity and current sort position within its section.
export interface OrderedArticle {
  id: number;
  position: number;
}

// A single absolute position assignment to PUT back to Zendesk.
export interface ReorderWrite {
  id: number;
  position: number;
}

// A section is manually sorted iff its effective display order is non-decreasing
// in `position`. A STRICT decrease means the display ignores `position` (the
// section is auto-sorted by date/alphabetical), so any position write would be
// silently ignored. Ties (equal positions) are NOT an inversion — they are the
// undefined-order bug this tool fixes, not evidence of auto-sort.
export const hasPositionInversion = (order: readonly OrderedArticle[]): boolean => {
  for (let i = 0; i < order.length - 1; i += 1) {
    const here = order[i];
    const next = order[i + 1];
    if (here && next && here.position > next.position) return true;
  }
  return false;
};

// Rearrange `effective` (the current display order) into the desired final order
// by moving `movedId` to the slot implied by target/referenceId. Returns the new
// ordering as ids-with-current-positions; callers pass it to computePositionWrites.
// Assumes the moved article (and, for before/after, the reference) are present —
// the handler validates presence first to produce friendly error messages.
export const arrangeDesiredOrder = (
  effective: readonly OrderedArticle[],
  movedId: number,
  target: ReorderTarget,
  referenceId?: number,
): OrderedArticle[] => {
  const moved = effective.find((a) => a.id === movedId);
  if (!moved) throw new Error(`Article ${movedId} is not in the section.`);
  const rest = effective.filter((a) => a.id !== movedId);

  let slot: number;
  if (target === 'top') {
    slot = 0;
  } else if (target === 'bottom') {
    slot = rest.length;
  } else {
    const refIndex = rest.findIndex((a) => a.id === referenceId);
    if (refIndex === -1) throw new Error(`Reference article ${referenceId} is not in the section.`);
    slot = target === 'before' ? refIndex : refIndex + 1;
  }
  return [...rest.slice(0, slot), moved, ...rest.slice(slot)];
};

// Given the desired final order, return the minimal set of position writes that
// realises it as a strictly-increasing sequence.
//
// normalize=true: renumber the whole section contiguously 0..N-1 (tidy positions,
//   up to N writes — guarded by the confirm threshold in the handler).
// normalize=false (default, gap-aware):
//   - bottom (moved is last): one write, position = max(section) + 1.
//   - otherwise: a right-cascade starting at the moved article — place it just
//     above its left neighbour, then bump only the following articles that would
//     otherwise tie/precede it, stopping at the first one already clear of the
//     running maximum. On a section with integer slack this is a single write;
//     with pervasive ties (all at 0) it degrades to renumbering the affected run,
//     which is the genuine lower bound for that case.
// Only articles whose position actually changes are returned.
export const computePositionWrites = (
  desired: readonly OrderedArticle[],
  movedId: number,
  normalize: boolean,
): ReorderWrite[] => {
  const writes: ReorderWrite[] = [];

  if (normalize) {
    desired.forEach((a, index) => {
      if (a.position !== index) writes.push({ id: a.id, position: index });
    });
    return writes;
  }

  const movedIndex = desired.findIndex((a) => a.id === movedId);
  const moved = desired[movedIndex];
  if (!moved) return writes;

  // bottom: no right neighbour. Anchor above the section maximum (not just the
  // left neighbour) so the article lands last even if positions are unsorted.
  if (movedIndex === desired.length - 1) {
    const maxPos = desired.reduce((max, a) => Math.max(max, a.position), 0);
    const target = maxPos + 1;
    if (moved.position !== target) writes.push({ id: moved.id, position: target });
    return writes;
  }

  // top / middle: cascade right from the moved article, healing only the run that
  // blocks its placement.
  const left = desired[movedIndex - 1];
  let running = left ? left.position : -1;
  for (let i = movedIndex; i < desired.length; i += 1) {
    const article = desired[i];
    if (!article) break;
    if (i !== movedIndex && article.position > running) break; // already clear — stop
    const target = running + 1;
    if (article.position !== target) writes.push({ id: article.id, position: target });
    running = target;
  }
  return writes;
};

// After the writes, re-read the effective order and confirm the article landed at
// the requested spot. A failure here (writes accepted but order unchanged) means
// the section is auto-sorted and `position` is being ignored.
export const isPlacedAsRequested = (
  effectiveAfter: readonly OrderedArticle[],
  movedId: number,
  target: ReorderTarget,
  referenceId?: number,
): boolean => {
  const movedIndex = effectiveAfter.findIndex((a) => a.id === movedId);
  if (movedIndex === -1) return false;
  if (target === 'top') return movedIndex === 0;
  if (target === 'bottom') return movedIndex === effectiveAfter.length - 1;
  const refIndex = effectiveAfter.findIndex((a) => a.id === referenceId);
  if (refIndex === -1) return false;
  return target === 'before' ? movedIndex === refIndex - 1 : movedIndex === refIndex + 1;
};
