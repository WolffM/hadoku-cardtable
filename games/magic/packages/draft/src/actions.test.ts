/*
 * Cards that change the draft itself (`actions.ts`), against the engine: a
 * card drafted face up is public and stays hidden nowhere else, and Cogwork
 * Librarian buys a second card from a pack by going into it.
 */

import { describe, expect, it } from 'vitest';
import { DraftViewSchema, semanticIssues, type DraftCard } from '@hadoku/shared';
import { draftActionsOf } from './actions.ts';
import { createDraft, extraPicksOf, packOf, pick, receiverOf, type DraftState } from './engine.ts';
import { runBots } from './bot.ts';
import { spectatorView, viewFor, watcherView } from './view.ts';

const SEATS = 4;
const PACK = 5;

function card(cardId: string, name = `Card ${cardId}`): DraftCard {
  return {
    cardId,
    name,
    manaCost: ['4'],
    manaValue: 4,
    colors: [],
    typeLine: 'Artifact Creature — Construct',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: '1',
    rarity: 'uncommon',
  };
}

/** Four seats, three rounds of five; seat 0's first pack holds the Librarian. Seat 0 is the one human. */
function table(): DraftState {
  const packs = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: SEATS }, (_, s) => Array.from({ length: PACK }, (_, i) => card(`r${r}s${s}c${i}`))),
  );
  packs[0]![0]![0] = card('librarian', 'Cogwork Librarian');
  return createDraft({
    draftId: 'draft:actions',
    seed: 'actions',
    packs,
    seatCount: SEATS,
    packCount: 3,
    packSize: PACK,
    humans: [{ participantId: 'fk:alice', displayName: 'alice' }],
  });
}

function take(state: DraftState, seat: number, cardId: string, extra?: { cardId: string; with: string }): DraftState {
  const result = pick(state, seat, cardId, extra);
  if (!result.ok) throw new Error(`pick refused: ${result.reason}`);
  return result.state;
}

/** Seat 0 has drafted the Librarian and the bots have passed it a second pack. */
function withLibrarian(): DraftState {
  return runBots(take(table(), 0, 'librarian')).state;
}

describe('the table of draft actions', () => {
  it('names Cogwork Librarian and nothing ordinary', () => {
    expect(draftActionsOf('Cogwork Librarian')).toEqual(['face-up', 'extra-pick-return']);
    expect(draftActionsOf('Lightning Bolt')).toEqual([]);
  });
});

describe('a card drafted face up', () => {
  it('is public on every payload, and no other card of that seat is', () => {
    const state = take(withLibrarian(), 0, packOf(withLibrarian(), 0)[0]!.cardId);
    for (const view of [viewFor(state, 0), viewFor(state, 1), watcherView(state, 2), spectatorView(state)]) {
      expect(DraftViewSchema.parse(view).seats[0]?.faceUp?.map((c) => c.name)).toEqual(['Cogwork Librarian']);
      expect(view.seats.slice(1).every((s) => s.faceUp === undefined)).toBe(true);
      expect(semanticIssues(view)).toEqual([]);
    }
    const other = JSON.stringify(viewFor(state, 1));
    for (const c of state.pools[0] as DraftCard[]) {
      if (c.cardId !== 'librarian') expect(other).not.toContain(`"${c.cardId}"`);
    }
  });

  it('an ordinary pick leaves nothing face up', () => {
    const state = take(table(), 0, 'r0s0c1');
    expect(state.faceUp).toEqual([[], [], [], []]);
    expect(viewFor(state, 1).seats[0]?.faceUp).toBeUndefined();
  });
});

describe('Cogwork Librarian', () => {
  it('is offered to its drafter alone, while the pack holds two cards', () => {
    const state = withLibrarian();
    expect(extraPicksOf(state, 0)).toEqual(['librarian']);
    const own = viewFor(state, 0).viewer;
    expect(own.kind === 'seat' && own.extraPick).toEqual(['librarian']);
    const watched = watcherView(state, 0).viewer;
    expect('extraPick' in watched).toBe(false);
    expect(extraPicksOf(state, 1)).toEqual([]);
    expect(extraPicksOf(table(), 0)).toEqual([]);
  });

  it('takes two cards and goes into the pack in their place', () => {
    const before = withLibrarian();
    const pack = packOf(before, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    const to = receiverOf(before, 0);
    const queued = before.queues[to]!.length;
    const result = pick(before, 0, a, { cardId: b, with: 'librarian' });
    if (!result.ok) throw new Error(result.reason);
    const after = result.state;

    expect(after.pools[0]!.map((c) => c.cardId)).toEqual([a, b]);
    expect(after.faceUp[0]).toEqual([]);
    expect(after.roundPicks[0]).toBe(before.roundPicks[0]! + 1);
    const passed = after.queues[to]![queued]!;
    expect(passed).toHaveLength(pack.length - 1);
    expect(passed.map((c) => c.cardId)).toContain('librarian');
    expect(passed.map((c) => c.cardId)).not.toContain(a);
    expect(passed.map((c) => c.cardId)).not.toContain(b);
    expect(result.events.map((e) => e.type)).toEqual(['picked', 'picked', 'returned-to-pack', 'pack-passed']);
    expect(extraPicksOf(after, 0)).toEqual([]);
    expect(viewFor(after, 1).seats[0]?.faceUp).toBeUndefined();
  });

  it('is face up again in front of whoever drafts it next', () => {
    const before = withLibrarian();
    const pack = packOf(before, 0);
    const to = receiverOf(before, 0);
    let state = take(before, 0, pack[0]!.cardId, { cardId: pack[1]!.cardId, with: 'librarian' });
    // The receiver works down its queue until the pack holding the Librarian is in front of it.
    while (!packOf(state, to).some((c) => c.cardId === 'librarian')) state = take(state, to, packOf(state, to)[0]!.cardId);
    state = take(state, to, 'librarian');
    expect(state.faceUp[to]).toEqual(['librarian']);
    expect(spectatorView(state).seats[to]?.faceUp?.map((c) => c.cardId)).toEqual(['librarian']);
  });

  it('refuses a second card without it, with the same card twice, with a card not in the pack, and from another seat', () => {
    const state = withLibrarian();
    const pack = packOf(state, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    const refused = (seat: number, cardId: string, extra: { cardId: string; with: string }) => {
      const result = pick(state, seat, cardId, extra);
      return result.ok ? 'ok' : result.reason;
    };
    expect(refused(0, a, { cardId: b, with: 'nothing' })).toBe('extra-pick-refused');
    expect(refused(0, a, { cardId: a, with: 'librarian' })).toBe('extra-pick-refused');
    expect(refused(0, a, { cardId: 'elsewhere', with: 'librarian' })).toBe('extra-pick-refused');
    const theirs = packOf(state, 1);
    if (theirs.length >= 2) expect(refused(1, theirs[0]!.cardId, { cardId: theirs[1]!.cardId, with: 'librarian' })).toBe('extra-pick-refused');
    // A refusal changes nothing.
    expect(packOf(state, 0)).toBe(pack);
  });

  it('cannot be used on a pack of one card', () => {
    let state = withLibrarian();
    // Seat 0 picks down every pack that reaches it until one holds a single card.
    for (let guard = 0; guard < 50 && packOf(state, 0).length !== 1; guard++) {
      if (packOf(state, 0).length === 0) state = runBots(state).state;
      else state = runBots(take(state, 0, packOf(state, 0)[0]!.cardId)).state;
      if (state.packNumber > 1) throw new Error('the round ended before a one-card pack reached seat 0');
    }
    expect(packOf(state, 0)).toHaveLength(1);
    expect(extraPicksOf(state, 0)).toEqual([]);
  });

  it('keeps every seat at one card a pick: the draft ends with full pools', () => {
    let state = withLibrarian();
    const pack = packOf(state, 0);
    state = take(state, 0, pack[0]!.cardId, { cardId: pack[1]!.cardId, with: 'librarian' });
    for (let guard = 0; guard < 500 && state.status !== 'complete'; guard++) {
      state = runBots(state).state;
      const mine = packOf(state, 0);
      if (state.status !== 'complete' && mine.length > 0) state = take(state, 0, mine[0]!.cardId);
    }
    expect(state.status).toBe('complete');
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(new Set(state.pools.flat().map((c) => c.cardId)).size).toBe(60);
  });
});
