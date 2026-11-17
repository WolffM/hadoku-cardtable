/*
 * A player's chess clock, beside their life total (the operator, 2026-10-30: 20 minutes per player
 * per match). The server decides time: it sends each clock's `ms` left and whether it runs on the
 * roster (`SeatIdentity.clock`), again every time one starts or stops, and the flag falls there.
 * This only counts a running clock down from when that reading arrived, so the number moves
 * between two rosters, and draws it.
 *
 * Warning-coloured in the last minute, danger-coloured in the last ten seconds — theme tokens, so
 * the contrast is the theme's. No words: a drawn clock face and the number, never a sentence.
 *
 * Beside the life pill this badge read as, drawn in the same capsule and the same weight, the two
 * were not tellable apart at a glance. The badge below is its OWN shape (a rounded tag, not the
 * life pill's circle) and carries its own icon; `clock.css` has both.
 *
 * `grace` is a new game's own 1-minute hold before its clock starts at all: neither seat's clock
 * runs, which otherwise draws exactly like a clock idling on the OTHER seat's turn — nothing told
 * the two apart. `Board.tsx` passes `player.clock.grace` straight through; this file does not
 * derive it from `ms`/`running` itself — the server (`Match.clockGrace`, cardtable's server) is
 * what actually knows whether this instant is inside the grace, and rides it on `SeatIdentity.clock`
 * (`adapter.ts`'s `PlayerClock.grace`).
 */

import { useEffect, useState } from 'react';

import type { PlayerClock } from '../adapter.ts';

import './clock.css';

const LOW_MS = 60_000;
const OUT_MS = 10_000;

/** `m:ss`, rounded up: a clock reads 0:00 only once it has run out. */
export function clockText(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What a clock reads at `now`: a running one has spent the time since its reading arrived. */
export function clockLeft(clock: PlayerClock, now: number): number {
  return clock.running ? Math.max(0, clock.ms - (now - clock.at)) : clock.ms;
}

export function MatchClock({ clock, grace = false }: { clock: PlayerClock; grace?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!clock.running) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [clock]);
  const left = clockLeft(clock, now);
  return (
    <span
      className="match-clock"
      data-testid="match-clock"
      data-running={clock.running || undefined}
      // The grace a new game's clock sits in before it starts running at all (the operator: a
      // 1-minute grace): a drawn state of its own, never confused with a clock merely waiting on
      // the other seat, which draws the same as `data-low`/`data-out` could while `running` is
      // false either way. Theme tokens only, no words.
      data-grace={(!clock.running && grace) || undefined}
      data-low={(left <= LOW_MS && left > OUT_MS) || undefined}
      data-out={left <= OUT_MS || undefined}
    >
      {/*
       * Beside the life pill this badge used to read as, a clock face — drawn, not a glyph font,
       * the same convention `marks.tsx`/`Board.tsx`'s own corner marks keep. `currentcolor` so it
       * tints with the state colour exactly as the number already does.
       */}
      <svg className="match-clock__art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.3" />
        <path d="M8 4.6V8.3l2.6 1.6" />
      </svg>
      {clockText(left)}
    </span>
  );
}
