/*
 * The Magic half of the stats page: what `@wolffm/game-stats-ui`, shared by every hadoku game,
 * cannot know. Colours draw as mana pips (the Mana font, `../components/ManaPip.tsx`), a player as
 * a link to their profile, and a match's meta line as its format, its era, its turns and how it
 * ended. A deck, with its list on hover, is `./StatsDecks.tsx`'s.
 */

import type { MatchMeta, RenderName } from '@wolffm/game-stats-ui';
import type { StatAttr } from '@wolffm/prefs-client/games';
import { FREE_PICK } from '@hadoku/shared';

import { ManaPip } from '../components/ManaPip.tsx';
import { routeHash } from '../screens/route.ts';
import { FORMAT_TABS } from '../screens/tables.ts';

/** A set of colours as pips, in the order the seat reported them. */
export function Pips({ colors }: { colors: readonly string[] }) {
  return (
    <span className="cost" data-colors={colors.join('')}>
      {colors.map((c) => (
        <ManaPip key={c} token={c} />
      ))}
    </span>
  );
}

/** The seat attrs a match row draws after each name: the deck's colours, then its name. */
export const SEAT_ATTRS = ['colors', 'deck'] as const;

export const renderName: RenderName = (name) => (
  <a className="shell__link" href={routeHash({ kind: 'stats', player: name })}>
    {name}
  </a>
);

/** The facts a match feed's row ends with, in order: the format, its era's year, the turns, how it ended. */
export const MATCH_META = ['attr:format', 'attr:pool', 'counter:turns', 'attr:endReason'] as const satisfies readonly MatchMeta[];
export const COUNTER_LABELS = { turns: 'turns' } as const;

/** How a won game ended (`games/magic/server/src/stats/facts.ts`'s `EndReason`); `other` says nothing worth a word. */
const ENDED: Readonly<Record<string, string>> = { life: 'Life', poison: 'Poison', decking: 'Decked', concede: 'Concede' };

/**
 * A match attr as a feed's meta line says it, or null to leave it out. `routes.ts`'s matchStart
 * reports the format's family as `format` (`modern`, `free`, `draft`) and the room's pool as `pool`,
 * an era's date for a library format: so `Modern` then `2016`, `Free pick`, `Draft pod`.
 */
export function matchAttr(key: string, value: StatAttr): string | null {
  if (typeof value !== 'string') return null;
  if (key === 'format') {
    if (value === 'draft') return 'Draft pod';
    if (value === FREE_PICK) return 'Free pick';
    return FORMAT_TABS.find((f) => f.id === value)?.label ?? null;
  }
  if (key === 'pool') return /^(\d{4})-\d{2}-\d{2}$/.exec(value)?.[1] ?? null;
  if (key === 'endReason') return ENDED[value] ?? null;
  return null;
}
