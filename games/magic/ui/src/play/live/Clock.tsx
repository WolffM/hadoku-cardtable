/*
 * A player's chess clock, beside their life total (the operator, 2026-10-30: 20 minutes per player
 * per match). The server decides time: it sends each clock's `ms` left and whether it runs on the
 * roster (`SeatIdentity.clock`), again every time one starts or stops, and the flag falls there.
 * This only counts a running clock down from when that reading arrived, so the number moves
 * between two rosters, and draws it.
 *
 * Warning-coloured in the last minute, danger-coloured in the last ten seconds — theme tokens, so
 * the contrast is the theme's. No words: the number and its colour are the whole of it.
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

export function MatchClock({ clock }: { clock: PlayerClock }) {
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
      data-low={(left <= LOW_MS && left > OUT_MS) || undefined}
      data-out={left <= OUT_MS || undefined}
    >
      {clockText(left)}
    </span>
  );
}
