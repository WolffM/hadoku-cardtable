/*
 * The front page's featured match, paused (operator, 2026-11-21: a pause button "so users can manually
 * stop it on the front page"). A replay pauses its own clock; a LIVE match cannot, so its transport holds
 * what arrives — every event and every ack, in order — while paused, and lets it all through on play: the
 * card is unpaced (`FeaturedMatch.tsx` builds a bare socket), so the board catches up to the present in
 * one step, nothing replayed beat by beat. The socket stays open while held, so the match never reads
 * "Reconnecting…". Past `HELD_MAX` the hold gives up keeping what arrives and says so (`overflowed`): the
 * card then starts the match again on play, from a fresh snapshot.
 */

import type { MatchTransport } from '../play/live/match.ts';

/** How much a pause keeps before it would rather join again than catch up. */
export const HELD_MAX = 2_000;

export interface HeldTransport {
  transport: MatchTransport;
  hold(): void;
  /** Lets everything held through, in order; false when the hold overflowed and nothing was delivered. */
  release(): boolean;
  held(): number;
}

export function heldTransport(inner: MatchTransport): HeldTransport {
  let holding = false;
  let overflowed = false;
  let queue: (() => void)[] = [];
  const later = (run: () => void): void => {
    if (!holding) return run();
    if (overflowed) return;
    if (queue.length >= HELD_MAX) {
      overflowed = true;
      queue = [];
      return;
    }
    queue.push(run);
  };
  return {
    transport: {
      on: (event, handler) => inner.on(event, (payload) => later(() => handler(payload))),
      emit: (event, payload) => inner.emit(event, payload),
      request: (event, payload, onAck) => inner.request(event, payload, (err, response) => later(() => onAck(err, response))),
      disconnect: () => {
        queue = [];
        inner.disconnect();
      },
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      const lost = overflowed;
      overflowed = false;
      const runs = queue;
      queue = [];
      if (lost) return false;
      for (const run of runs) run();
      return true;
    },
    held: () => queue.length,
  };
}
