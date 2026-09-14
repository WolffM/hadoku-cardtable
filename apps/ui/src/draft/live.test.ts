/*
 * The live source: the real engine, the real bundled cube, no transport.
 *
 * `DraftScreen.test.ts` proves the screen renders a payload. This proves the
 * payloads are real — produced by `@hadoku/draft` over the cube that actually
 * ships in the bundle, not by a fixture — and that a whole draft can be played
 * from the first pick to the forty-fifth.
 */

import { describe, expect, it } from 'vitest';
import { CUBE_NAME, CUBE_SIZE, MY_SEAT, applyPick, isComplete, myPool, startDraft } from './live.ts';
import { viewerSeat } from './types.ts';

/** Play the whole draft, always taking the first card offered. */
function playOut(seed: string): { names: string[]; picks: number } {
  let draft = startDraft(seed);
  const names: string[] = [];
  for (let i = 0; i < 200; i++) {
    if (isComplete(draft)) break;
    const seat = viewerSeat(draft.view);
    if (!seat || seat.pack.length === 0) break;
    const card = seat.pack[0];
    if (card === undefined) break;
    names.push(card.name);
    draft = applyPick(draft, card.cardId);
  }
  return { names, picks: myPool(draft).length };
}

describe('the bundled pool is a real cube', () => {
  it('names the cube it came from and has enough cards for the pod', () => {
    expect(CUBE_NAME).toMatch(/Cube/i);
    // 8 seats x 3 packs x 15 = 360. The pool must cover it.
    expect(CUBE_SIZE).toBeGreaterThanOrEqual(360);
  });

  it('carries real card data, not placeholders', () => {
    const draft = startDraft('data-check');
    const seat = viewerSeat(draft.view);
    expect(seat).not.toBeNull();
    if (!seat) return;
    // Real cards have real type lines and most have real text.
    expect(seat.pack.every((c) => c.name.length > 0)).toBe(true);
    expect(seat.pack.some((c) => c.typeLine.length > 0)).toBe(true);
    expect(seat.pack.some((c) => c.oracleText.length > 0)).toBe(true);
  });

  it('never carries an image field — the pool ships in the bundle (D13)', () => {
    const draft = startDraft('d13-check');
    const json = JSON.stringify(draft.view);
    expect(json).not.toMatch(/"image[^"]*":/i);
    expect(json).not.toMatch(/https?:\/\/\S*\.(jpe?g|png|webp)/i);
    expect(json).not.toContain('scryfall.io');
  });
});

describe('a live draft', () => {
  it('opens with a full 15-card pack in front of seat 0', () => {
    const draft = startDraft('open');
    const seat = viewerSeat(draft.view);
    expect(seat?.seatId).toBe(MY_SEAT);
    expect(seat?.pack).toHaveLength(15);
    expect(seat?.pool).toHaveLength(0);
  });

  it('seats eight: one human and seven bots', () => {
    const draft = startDraft('pod');
    expect(draft.view.seats).toHaveLength(8);
    expect(draft.view.seats.filter((s) => s.occupant?.kind === 'bot')).toHaveLength(7);
    expect(draft.view.capacity).toBe(8);
  });

  it('a pick moves a card from the pack to the pool', () => {
    const draft = startDraft('one-pick');
    const before = viewerSeat(draft.view);
    if (!before) throw new Error('expected a seat');
    const taken = before.pack[0];
    if (!taken) throw new Error('expected a card');

    const after = applyPick(draft, taken.cardId);
    const seat = viewerSeat(after.view);
    expect(seat?.pool.map((c) => c.cardId)).toContain(taken.cardId);
    expect(seat?.pack.map((c) => c.cardId)).not.toContain(taken.cardId);
  });

  it('the bots run exactly one pick ahead, so only the human is ever on the clock', () => {
    const draft = startDraft('bots');
    const seat = viewerSeat(draft.view);
    if (!seat) throw new Error('expected a seat');
    const after = applyPick(draft, seat.pack[0]!.cardId);

    // Not everyone on the same count, and that is correct rather than a bug.
    // The human's pick completes the round; the packs pass; the bots take their
    // next pick immediately. So they sit at n+1 with the human at n, and
    // `waitingOn` is the human's seat alone — which is what makes the table
    // feel like it is waiting for you rather than you waiting for it.
    expect(after.view.seats[MY_SEAT]?.pickedCount).toBe(1);
    for (const row of after.view.seats) {
      if (row.id === MY_SEAT) continue;
      expect(row.pickedCount).toBe(2);
    }
    expect(after.view.waitingOn).toEqual([MY_SEAT]);
  });

  it('plays a full three-pack draft to 45 cards', () => {
    const { picks } = playOut('full-draft');
    expect(picks).toBe(45);
  });

  it('the pack shrinks as it is passed around the table', () => {
    let draft = startDraft('shrink');
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const seat = viewerSeat(draft.view);
      if (!seat) break;
      sizes.push(seat.pack.length);
      draft = applyPick(draft, seat.pack[0]!.cardId);
    }
    expect(sizes).toEqual([15, 14, 13, 12]);
  });
});

describe('the seed reproduces the draft', () => {
  it('the same seed gives an identical sequence of packs', () => {
    const a = playOut('reproduce-me');
    const b = playOut('reproduce-me');
    expect(a.names).toEqual(b.names);
    expect(a.picks).toBe(b.picks);
  });

  it('a different seed gives a different draft', () => {
    const a = playOut('seed-alpha');
    const b = playOut('seed-beta');
    expect(a.names).not.toEqual(b.names);
  });

  it('every payload carries the epoch as well as the seq', () => {
    const draft = startDraft('epoch-check');
    expect(draft.view.epoch).toBe('epoch-check:1');
    expect(draft.view.seq).toBeGreaterThanOrEqual(1);
  });
});

describe('hidden information holds on live payloads', () => {
  it('a payload never carries another seat’s pool', () => {
    let draft = startDraft('hidden');
    for (let i = 0; i < 5; i++) {
      const seat = viewerSeat(draft.view);
      if (!seat) break;
      draft = applyPick(draft, seat.pack[0]!.cardId);
    }
    const json = JSON.stringify(draft.view);

    // Every other seat has picked five cards; none of them may appear.
    for (let s = 0; s < draft.engine.seatCount; s++) {
      if (s === MY_SEAT) continue;
      const mine = new Set(myPool(draft).map((c) => c.cardId));
      const myPack = new Set(viewerSeat(draft.view)?.pack.map((c) => c.cardId) ?? []);
      for (const card of draft.engine.pools[s] ?? []) {
        if (mine.has(card.cardId) || myPack.has(card.cardId)) continue;
        expect(json).not.toContain(`"${card.cardId}"`);
      }
    }
  });

  it('the seat rows carry counts, never cards', () => {
    const draft = startDraft('counts');
    for (const row of draft.view.seats) {
      expect(typeof row.pickedCount).toBe('number');
      expect(Object.keys(row).sort()).toEqual(['displayName', 'id', 'occupant', 'pickedCount']);
    }
  });
});
