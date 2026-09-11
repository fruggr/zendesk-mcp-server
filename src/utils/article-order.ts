// Pure ordering logic for reorder_article (see src/tools/help-center.ts).
//
// Zendesk has no bulk-reorder endpoint and no "sort mode": the only lever is each
// article's integer `position`, and several routinely share 0, so ties display in
// an undefined order. These helpers derive the minimal absolute writes that fix
// that, leaving unrelated articles untouched.

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

// A section is manually sorted iff its display order is non-decreasing in
// `position`. A STRICT decrease means the display ignores `position` (auto-sorted
// by date or alphabetically), so a write would be silently dropped. Ties are not
// an inversion — they are the undefined-order bug this tool fixes.
export const hasPositionInversion = (order: readonly OrderedArticle[]): boolean => {
  for (let i = 0; i < order.length - 1; i += 1) {
    const here = order[i];
    const next = order[i + 1];
    if (here && next && here.position > next.position) return true;
  }
  return false;
};

// Moves `movedId` to the slot implied by target/referenceId; the result feeds
// computePositionWrites. Assumes the moved article (and, for before/after, the
// reference) is present — the handler validates that first, to produce friendly
// error messages.
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

// Minimal writes realising `desired`. normalize renumbers the section 0..N-1 (up
// to N writes, hence the handler's confirm threshold); the default cascade bumps
// only what would otherwise tie or precede the moved article — one write where
// positions have slack, renumbering the affected run when they all sit at 0.
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

  // bottom: no right neighbour. Anchor above the maximum of the OTHER articles
  // (not the whole section — that includes the moved article's own position) so
  // an article that is already last is a no-op, and the move stays idempotent
  // instead of bumping the position higher on every call.
  if (movedIndex === desired.length - 1) {
    const maxOthers = desired
      .slice(0, movedIndex)
      .reduce((max, a) => Math.max(max, a.position), -1);
    if (moved.position > maxOthers) return writes; // already strictly last
    writes.push({ id: moved.id, position: maxOthers + 1 });
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

// Writes accepted but order unchanged means the section is auto-sorted and
// `position` is ignored.
//
// before/after are checked by SIDE, not index adjacency: Zendesk breaks a display
// tie arbitrarily, so a co-tied sibling can legitimately land between the two.
// Side ordering is the property we control.
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
  return target === 'before' ? movedIndex < refIndex : movedIndex > refIndex;
};
