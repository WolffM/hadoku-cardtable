/*
 * The Magic half of the stats page: what `@wolffm/game-stats-ui`, shared by every hadoku game,
 * cannot know. Colours draw as mana pips (the Mana font, `../components/ManaPip.tsx`), a player as
 * a link to their profile, and a match as its format, its turns and how it ended. A deck, with its
 * list on hover, is `./StatsDecks.tsx`'s.
 */

import type { RenderName } from '@wolffm/game-stats-ui';
import type { MatchView, StatAttrs } from '@wolffm/prefs-client/games';
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

/**
 * A match's format as a room names it: a format and its era's year (`Modern 2016`), Free pick, or a
 * draft pod. `routes.ts`'s matchStart reports the family as `format` and the room's pool as `pool`,
 * an era's date for a library format.
 */
export function formatLabel(attrs: StatAttrs): string | null {
  const { format, pool } = attrs;
  if (format === 'draft') return 'Draft pod';
  if (format === FREE_PICK) return 'Free pick';
  const tab = FORMAT_TABS.find((f) => f.id === format);
  if (tab === undefined) return null;
  const year = typeof pool === 'string' ? /^(\d{4})-\d{2}-\d{2}$/.exec(pool)?.[1] : undefined;
  return year === undefined ? tab.label : `${tab.label} ${year}`;
}

/** How a won game ended (`apps/server/src/stats/facts.ts`'s `EndReason`); `other` says nothing worth a word. */
const ENDED: Readonly<Record<string, string>> = { life: 'Life', poison: 'Poison', decking: 'Decked', concede: 'Concede' };

/** A match's own facts, in order: its format, its turns, how it ended. */
export function matchFacts(m: MatchView): string[] {
  const turns = m.counters.turns;
  const ended = typeof m.attrs.endReason === 'string' ? ENDED[m.attrs.endReason] : undefined;
  return [formatLabel(m.attrs), turns === undefined ? null : `${turns} turns`, ended ?? null].filter((f): f is string => f !== null);
}
