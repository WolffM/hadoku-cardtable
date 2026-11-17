/*
 * The front page's banner: one row of cards, at most ~380px tall, wrapping on narrow screens
 * (`docs/planning/wave77-2026-10-27.md` §A, approved canvas "A"). The live slot is two columns wide;
 * patch notes, Upcoming and the wildcard each take one.
 *
 * ## Independently omittable (wave 120 §F)
 *
 * Each card decides for itself whether it has anything to show, the same way `LiveSlot` already
 * does (`data-present`, `front.css`'s own `[data-present='false']` rule): a card that sets
 * `data-present="false"` on its own root leaves the grid, the others close the gap. This file adds
 * nothing to any one card for that — `Banner` itself only ADDS the other half: when EVERY card
 * says it is absent (or there are no cards at all), the whole banner draws no section, not an empty
 * row. A card that never sets `data-present` is read as present, same as today — none of the four
 * currently ever go fully empty in cardtable's own app, so this is new reach, not a visible change.
 *
 * Read generically off the mounted DOM (a `MutationObserver` on `data-present` and on the card list
 * itself) rather than by importing each card's own "am I empty" state: `UpcomingCard` is mid-edit
 * elsewhere this wave (`closed-polls`' own claim) and this file must not touch it, or know anything
 * about what it draws, to work.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FeaturedPick } from '../rooms/api.ts';
import { LiveSlot } from './LiveSlot.tsx';
import { PatchNotesCard } from '@hadoku/game-ui/front/PatchNotesCard.tsx';
import { UpcomingCard } from './UpcomingCard.tsx';
import { WildcardCard } from './WildcardCard.tsx';
import './front.css';

/** Whether any direct child of `el` is NOT explicitly marked `data-present="false"` — true (present) for a card that says nothing either way, and for `el` itself having no children yet. */
function anyCardPresent(el: HTMLElement): boolean {
  if (el.childElementCount === 0) return true;
  return [...el.children].some((card) => card.getAttribute('data-present') !== 'false');
}

/** `ref`'s direct children, re-read whenever one is added, removed, or changes its own `data-present`. Starts `true` (present) so the row's first paint never flashes empty before anything has actually said so. */
function useAnyCardPresent(ref: RefObject<HTMLElement | null>): boolean {
  const [present, setPresent] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const check = (): void => setPresent(anyCardPresent(el));
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-present'] });
    return () => observer.disconnect();
  });
  return present;
}

/** `featured`: the live slot's pick, `undefined` until the first room list has answered. */
export function Banner({ featured }: { featured: FeaturedPick | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useAnyCardPresent(ref);
  if (!present) return null;
  return (
    <div ref={ref} className="front-banner" data-testid="front-banner">
      <LiveSlot pick={featured} />
      <PatchNotesCard />
      <UpcomingCard />
      <WildcardCard />
    </div>
  );
}
