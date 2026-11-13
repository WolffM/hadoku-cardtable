/*
 * The front page's banner: one row of cards, at most ~380px tall, wrapping on narrow screens
 * (`docs/planning/wave77-2026-10-27.md` §A, approved canvas "A"). The live slot is two columns wide;
 * patch notes, Upcoming and the wildcard each take one.
 */

import type { FeaturedPick } from '../rooms/api.ts';
import { LiveSlot } from './LiveSlot.tsx';
import { PatchNotesCard } from '@hadoku/game-ui/front/PatchNotesCard.tsx';
import { UpcomingCard } from './UpcomingCard.tsx';
import { WildcardCard } from './WildcardCard.tsx';
import './front.css';

/** `featured`: the live slot's pick, `undefined` until the first room list has answered. */
export function Banner({ featured }: { featured: FeaturedPick | null | undefined }) {
  return (
    <div className="front-banner" data-testid="front-banner">
      <LiveSlot pick={featured} />
      <PatchNotesCard />
      <UpcomingCard />
      <WildcardCard />
    </div>
  );
}
