/*
 * A room made for an event seats nobody until `SEATS_OPEN_BEFORE_MS` before it starts: anyone may
 * come in and chat, but its seats are drawn shut, with one line saying when they open. The server
 * holds the rule by its own clock (`Lobby.seatsShutUntil`); this only draws it, and redraws at the
 * opening so the seats come alive without a reload.
 */

import { useEffect, useState } from 'react';

import { seatsOpenAt } from '@hadoku/platform-wire/events';
import { countdown } from '../front/countdown.ts';

/** When a room whose event starts at `scheduledFor` (ISO) opens its seats, in ms, while that is after `now`; null once open or for a room no event made. */
export function seatsShutUntil(scheduledFor: string | null, now: number): number | null {
  if (scheduledFor === null) return null;
  const starts = Date.parse(scheduledFor);
  if (Number.isNaN(starts)) return null;
  const opens = seatsOpenAt(starts);
  return now < opens ? opens : null;
}

/** How often the line's countdown is redrawn: its finest unit is a minute. */
const TICK_MS = 30_000;

/** `seatsShutUntil` against the browser's clock, redrawn each tick until the seats open. */
export function useSeatsShutUntil(scheduledFor: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  const shut = seatsShutUntil(scheduledFor, now);
  useEffect(() => {
    if (shut === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(TICK_MS, Math.max(0, shut - Date.now())));
    return () => clearTimeout(timer);
  }, [shut, now]);
  return shut;
}

export function SeatsOpenNote({ opensAt }: { opensAt: number }) {
  return (
    <p className="lobby__note" data-testid="seats-open-at">
      Seats open {countdown(new Date(opensAt).toISOString(), Date.now())}
    </p>
  );
}
