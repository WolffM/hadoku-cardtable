/*
 * The banner's live slot — two card-widths, the first thing on the front page
 * (`docs/planning/wave77-2026-10-27.md` §A). Lane B owns `./FeaturedMatch.tsx` and is building it in
 * parallel; this file renders a labelled placeholder until it lands, then swaps the import in
 * (the wave's own instruction — A does not create `FeaturedMatch.tsx`, and never blocks on B).
 */

import type { FeaturedPick } from '../rooms/api.ts';

export function LiveSlot({ pick }: { pick: FeaturedPick | null }) {
  return (
    <section className="front-card front-card--live" data-testid="front-live-slot">
      {pick === null ? (
        <p className="front-card__empty">Nothing live right now.</p>
      ) : (
        // Placeholder for lane B's <FeaturedMatch pick={pick} />: a live match IS picked, but the
        // watcher view itself is B's to build.
        <p className="front-card__empty" data-match-id={pick.matchId} data-room-id={pick.roomId}>
          A match is live.
        </p>
      )}
    </section>
  );
}
