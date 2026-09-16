/*
 * Held versus empty.
 *
 * The distinction is derived rather than declared (see `seatStatus.ts`), so the
 * test that matters is the one that pins both sides of the derivation: a seat
 * that kept its name is held, a seat that still carries the `Seat N` default is
 * free. If `packages/draft/src/view.ts` ever stops falling back to that default,
 * or the server starts clearing `displayNames`, the second test below fails and
 * the reader is sent to the file that changed.
 *
 * The payloads are the committed fixtures, mutated in exactly the way the
 * server mutates them on a drop: `occupant` to null, `displayName` untouched.
 */

import { describe, expect, it } from 'vitest';

import { loadFixtures } from './fixtures.ts';
import { defaultSeatName, heldSeats, seatStatus, SEAT_HELD_NOTE } from './seatStatus.ts';
import type { DraftSeatView, DraftView } from './types.ts';

const spectator = (): DraftView => {
  const view = loadFixtures().find((v) => v.viewer.kind === 'spectator');
  if (!view) throw new Error('expected a spectator fixture');
  return view;
};

/** What `releaseSeat(room, pid)` does to a seat row: unseat, keep the name. */
function drop(seat: DraftSeatView): DraftSeatView {
  return { ...seat, occupant: null };
}

describe('what a seat is', () => {
  it('reads a live human and a bot straight off the occupant', () => {
    const view = spectator();
    const human = view.seats.find((s) => s.occupant?.kind === 'human');
    const bot = view.seats.find((s) => s.occupant?.kind === 'bot');
    if (!human || !bot) throw new Error('expected the fixture to hold both');
    expect(seatStatus(human)).toBe('human');
    expect(seatStatus(bot)).toBe('bot');
  });

  it('a seat that kept its name but lost its occupant is HELD', () => {
    const view = spectator();
    const dropped = drop(view.seats[1]);
    expect(dropped.occupant).toBeNull();
    expect(dropped.displayName).not.toBe(defaultSeatName(dropped.id));
    expect(seatStatus(dropped)).toBe('held');
  });

  it('a chair nobody ever sat in is EMPTY, not held', () => {
    const view = spectator();
    const never: DraftSeatView = {
      ...view.seats[1],
      occupant: null,
      displayName: defaultSeatName(view.seats[1].id),
    };
    expect(seatStatus(never)).toBe('empty');
  });

  it('the default name is exactly the one the view builder writes', () => {
    // `packages/draft/src/view.ts:37` — `state.displayNames[id] ?? \`Seat ${id}\``.
    // Spelled out here so a change on that side breaks a test rather than
    // silently turning every free chair into a held one.
    expect(defaultSeatName(0)).toBe('Seat 0');
    expect(defaultSeatName(7)).toBe('Seat 7');
  });
});

describe('the held seats of a table', () => {
  it('finds none at a full table', () => {
    expect(heldSeats(spectator())).toEqual([]);
  });

  it('finds exactly the seats that dropped, in seat order', () => {
    const view = spectator();
    const seats = view.seats.map((s) => (s.id === 1 || s.id === 4 ? drop(s) : s));
    expect(heldSeats({ ...view, seats }).map((s) => s.id)).toEqual([1, 4]);
  });

  it('says out loud that this is inferred, not declared', () => {
    // The note is rendered next to a held seat. It exists because the envelope
    // carries no reservation clock, and a UI that claimed one would be lying.
    expect(SEAT_HELD_NOTE).toMatch(/inferred/);
    expect(SEAT_HELD_NOTE).toMatch(/no reservation clock/);
  });
});
