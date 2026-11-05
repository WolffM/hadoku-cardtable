/*
 * The banner's live slot — one card-width, the first thing on the front page
 * (`docs/planning/wave77-2026-10-27.md` §A). `FeaturedMatch` draws its own card: the featured match,
 * else a random recent replay on a loop, else nothing — and an empty slot leaves the grid
 * (`data-present`, `front.css`), so the other cards close the gap.
 *
 * Whether the slot is there decides how wide every other banner card is, so until its answer it
 * keeps the place it had last visit (`./shape.ts`), drawn as its skeleton: the card's own title bar
 * and square window, in `FeaturedMatch`'s own classes. `FeaturedMatch` is not started until the
 * first room list has said what is live (`pick` is `undefined` until then).
 *
 * `FeaturedMatch` draws a whole board, so it is a chunk of its own (`../lazy.ts`): the lobby draws
 * without it, and the slot starts loading it as it mounts, beside the room list it waits on. The
 * skeleton stands in until the card has its answer either way.
 */

import { Suspense, useContext, useEffect, useState } from 'react';

import { Reveal } from '../components/Reveal.tsx';
import { lazyComponent } from '../lazy.ts';
import type { FeaturedPick } from '../rooms/api.ts';
import { FrontGateContext, usePartShown } from './gate.ts';

/** The featured card's own chunk. A test preloads it to draw the lobby as the page does once it has landed. */
export const FeaturedMatch = lazyComponent(() => import('./FeaturedMatch.tsx').then((m) => m.FeaturedMatch));

/** `FeaturedMatch`'s card with nothing in it: its title bar and its square window. */
function LiveSkeleton() {
  return (
    <div className="featured-match" data-skeleton="live">
      <div className="featured-match__title">
        <span className="featured-match__tag ghost">LIVE</span>
        <span className="featured-match__players">
          <span className="ghost ghost--text">Player one vs Player two</span>
        </span>
        <span className="featured-match__turn ghost">Turn 1</span>
      </div>
      <div className="featured-match__viewport">
        <span className="ghost ghost--fill" />
      </div>
    </div>
  );
}

export function LiveSlot({ pick }: { pick: FeaturedPick | null | undefined }) {
  const { shape, remember } = useContext(FrontGateContext);
  /** Whether the card drew a match: `null` until it has its answer. */
  const [drawn, setDrawn] = useState<boolean | null>(null);
  const shown = usePartShown('live', drawn !== null);
  useEffect(() => {
    if (drawn !== null) remember({ live: drawn });
  }, [drawn, remember]);
  const present = shown ? drawn === true : shape.live;
  useEffect(() => void FeaturedMatch.preload(), []);

  return (
    <section className="front-live" data-testid="front-live-slot" data-present={present}>
      <Reveal name="live" shown={shown} skeleton={<LiveSkeleton />} className="front-live__reveal">
        <Suspense fallback={null}>{pick !== undefined && <FeaturedMatch pick={pick} onSettled={setDrawn} />}</Suspense>
      </Reveal>
    </section>
  );
}
