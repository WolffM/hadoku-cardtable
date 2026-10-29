/*
 * The banner's live slot — one card-width, the first thing on the front page
 * (`docs/planning/wave77-2026-10-27.md` §A). `FeaturedMatch` draws its own card: the featured match,
 * else the newest replay on a loop, else nothing — and an empty slot leaves the grid
 * (`front.css`), so the other cards close the gap.
 */

import type { FeaturedPick } from '../rooms/api.ts';
import { FeaturedMatch } from './FeaturedMatch.tsx';

export function LiveSlot({ pick }: { pick: FeaturedPick | null }) {
  return (
    <section className="front-live" data-testid="front-live-slot">
      <FeaturedMatch pick={pick} />
    </section>
  );
}
