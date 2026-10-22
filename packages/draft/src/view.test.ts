/*
 * The projection's SEAT ROWS, specifically.
 *
 * `engine.test.ts` covers the projection where the engine built the table
 * itself, which is the easy case: `createDraft` pads every seat with a bot, so
 * `table.seats.length === table.capacity === state.seatCount` and any of those
 * three numbers produces the same rows. Every bug this file is about lives in
 * the gap between them.
 *
 * The gap is real because the two halves have different owners. `state.pools`
 * is fixed when the packs are dealt and never changes length; `state.table` is
 * handed to the room layer and becomes `room.seats` — `draftRooms.ts` seeds the
 * registry with a factory returning it, precisely so there is one table rather
 * than two — and the room layer seats, unseats and re-capacities it for the
 * rest of the draft. So `viewFor` is reading a table it does not own against
 * pools it does, and it may not assume the two agree on how many seats exist.
 *
 * All three cases below are built by handing the engine a table rather than by
 * asking `createDraft` for one, because `createDraft` cannot produce them —
 * which is exactly why nothing caught them.
 */

import { describe, expect, it } from 'vitest';
import {
  createSeatTable,
  seatParticipant,
  seatRows,
  setSeatCapacity,
  type SeatTable,
} from '@wolffm/rooms-protocol';
import { DraftViewSchema, type DraftCard, type PoolSource } from '@hadoku/shared';
import { createDraft, pick, type DraftState } from './engine.ts';
import { deal } from './deal.ts';
import { spectatorView, viewFor } from './view.ts';

function makePool(size: number): DraftCard[] {
  const colours = ['W', 'U', 'B', 'R', 'G'] as const;
  const rarities = ['common', 'uncommon', 'rare', 'mythic'] as const;
  return Array.from({ length: size }, (_, i) => ({
    cardId: `c${i}`,
    name: `Card ${i}`,
    manaCost: [String(i % 6), colours[i % 5] as string],
    manaValue: (i % 6) + 1,
    colors: [colours[i % 5]],
    typeLine: i % 3 === 0 ? 'Creature — Test' : 'Instant',
    oracleText: `Test card ${i}.`,
    setCode: 'TST',
    collectorNumber: String(i + 1),
    rarity: rarities[i % 4],
  })) as DraftCard[];
}

/**
 * A draft dealt for four seats. Two humans, two bots, four pools.
 *
 * `packSize` is small so the fixture is cheap; nothing here depends on it.
 */
function dealtForFour(): DraftState {
  const src: PoolSource = { kind: 'cube', cubeId: 'seat-rows' };
  const pool = makePool(240);
  return createDraft({
    draftId: 'draft:seat-rows',
    seed: 'seat-rows',
    packs: deal({ rounds: [src, src, src] }, () => pool, 'seat-rows', 4, 5),
    seatCount: 4,
    packCount: 3,
    packSize: 5,
    humans: [
      { participantId: 'fk:alice', displayName: 'alice' },
      { participantId: 'fk:bob', displayName: 'bob' },
    ],
  });
}

/** A table as the room layer's would be mid-arrival: grown, not pre-allocated. */
function tableWithArrivals(capacity: number, arrivals: readonly string[]): SeatTable {
  const table = createSeatTable(capacity);
  for (const id of arrivals) expect(seatParticipant(table, id)).not.toBeNull();
  return table;
}

describe('a pod whose table is bigger than what the engine dealt', () => {
  /**
   * The done-when, and the shape the operator saw: a bounded pod holding fewer
   * players than its size must still draw its size.
   *
   * `SeatTable.seats` grows with arrivals — `seatParticipant` creates the next
   * seat on demand — so a six-seat table with two people in it has a
   * TWO-element `seats` array. Anything that renders a row per element draws a
   * two-seat pod, which reads as full. The bound is the package's `seatRows`,
   * which pads to `capacity`.
   */
  it('a partly filled pod draws a row for every seat, not one per arrival', () => {
    const state = dealtForFour();
    state.table = tableWithArrivals(6, ['fk:alice', 'fk:bob']);
    expect(state.table.seats.length).toBe(2);

    const view = viewFor(state, 0);

    expect(view.seats.length).toBe(6);
    expect(view.capacity).toBe(6);
    expect(view.seats.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5]);
    // Row for row with the package, which is what `apps/server` asserts of the
    // wire too — so the two cannot drift into two answers.
    expect(view.seats.map((s) => ({ id: s.id, occupant: s.occupant }))).toEqual(
      seatRows(state.table),
    );
    // The spectator arm is the same rows, built from the same `common`.
    expect(spectatorView(state).seats).toEqual(view.seats);
  });

  /**
   * The crash that made this more than a one-liner.
   *
   * Seats 4 and 5 above exist on the table but were never dealt to — there is
   * no `state.pools[4]`. The old `(state.pools[id] as unknown[]).length` read
   * `.length` off `undefined` and threw on the first such row, so padding the
   * rows without fixing the index just moved the failure.
   */
  it('an empty seat reports zero picks instead of throwing', () => {
    const state = dealtForFour();
    state.table = tableWithArrivals(6, ['fk:alice', 'fk:bob']);
    expect(state.pools.length).toBe(4);

    expect(() => viewFor(state, 0)).not.toThrow();

    const view = viewFor(state, 0);
    // Stated here too: without the padding there is no undealt row to report
    // on, and this test would pass by never reaching one.
    expect(view.seats.length).toBe(6);
    for (const seat of view.seats.slice(2)) {
      expect(seat.occupant).toBeNull();
      expect(seat.pickedCount).toBe(0);
    }
    // And an undealt seat is still a legal wire row, not a hole.
    expect(DraftViewSchema.safeParse(view).success).toBe(true);
  });

  /** A real pick still counts, so the guard did not turn every row into zero. */
  it('a seat that has picked still reports its picks beside the empty ones', () => {
    const state = dealtForFour();
    state.table = tableWithArrivals(6, ['fk:alice', 'fk:bob']);
    const card = (state.packs[0] as DraftCard[])[0] as DraftCard;
    const result = pick(state, 0, card.cardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const view = viewFor(result.state, 0);
    expect(view.seats[0]?.pickedCount).toBe(1);
    expect(view.seats[1]?.pickedCount).toBe(0);
    expect(view.seats[5]?.pickedCount).toBe(0);
  });
});

describe('a table carrying more seats than its capacity', () => {
  /**
   * The other failure mode, and the reason the bound is `seatRows(table)`
   * rather than a hand-rolled `Array.from({ length: capacity })`: when
   * `seats.length > capacity`, a loop to `capacity` DROPS the seats past it —
   * a player who vanishes from the pod while still seated and still playing.
   *
   * `setSeatCapacity` truncates, so the live API will not build this state;
   * it is built here by writing `capacity` directly, which is what a decoded
   * snapshot amounts to (`room-store` validates the table's SHAPE, not that
   * `seats.length <= capacity`). The point of delegating the loop is that the
   * render side survives it without every consumer having read
   * `setSeatCapacity`.
   */
  it('keeps every occupied seat even past the capacity', () => {
    const state = dealtForFour();
    const table = tableWithArrivals(6, ['fk:alice', 'fk:bob', 'fk:carol', 'fk:dave', 'fk:erin']);
    expect(table.seats.length).toBe(5);
    table.capacity = 3;
    state.table = table;

    const view = viewFor(state, 0);

    expect(view.seats.length).toBe(5);
    expect(view.seats.filter((s) => s.occupant !== null).length).toBe(5);
    expect(view.seats.map((s) => ({ id: s.id, occupant: s.occupant }))).toEqual(
      seatRows(state.table),
    );
  });

  /** Lowering capacity through the API truncates, and the rows follow. */
  it('follows the table down when capacity is lowered through the API', () => {
    const state = dealtForFour();
    const table = tableWithArrivals(4, ['fk:alice', 'fk:bob', 'fk:carol', 'fk:dave']);
    setSeatCapacity(table, 2);
    state.table = table;

    const view = viewFor(state, 0);

    expect(view.seats.length).toBe(2);
    expect(view.capacity).toBe(2);
  });
});

describe('an unbounded table', () => {
  /**
   * `capacity === null` is a pass-through in the package — there is no number
   * to pad to, and inventing one draws empty seats nobody may sit in. A draft
   * pod always sets a capacity, so this is here to pin that `viewFor` does not
   * quietly invent `state.seatCount` rows for a table that never asked for a
   * bound.
   */
  it('draws one row per arrival and no padding', () => {
    const state = dealtForFour();
    state.table = tableWithArrivals(6, ['fk:alice', 'fk:bob']);
    state.table.capacity = null;

    const view = viewFor(state, 0);

    expect(view.seats.length).toBe(2);
    expect(view.capacity).toBeNull();
  });
});
