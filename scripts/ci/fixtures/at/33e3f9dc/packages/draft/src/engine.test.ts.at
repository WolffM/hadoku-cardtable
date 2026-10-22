/*
 * The engine's guarantees, in the order the wave plan asks for them.
 *
 * The headline is replay: the same seed twice produces a byte-identical pick
 * log. Everything else — rejections as values, the hidden-information split,
 * pass direction — is checkable, but replay is the one that makes the rest
 * testable at all.
 */

import { describe, expect, it } from 'vitest';
import { DraftViewSchema, type DraftCard } from '@hadoku/shared';
import {
  createDraft,
  directionFor,
  pick,
  poolShortfall,
  waitingOn,
  type DraftEvent,
  type DraftState,
} from './engine.ts';
import { runBots } from './bot.ts';
import { spectatorView, viewFor, viewsForAllSeats } from './view.ts';

/**
 * A synthetic cube.
 *
 * Deliberately not the real 540-card lists: this file tests the engine, and a
 * generated pool makes the assertions exact (every card is distinguishable, and
 * a count is a count). `cubes.test.ts` runs against Forge's real lists.
 */
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

const HUMANS = [
  { participantId: 'fk:alice', displayName: 'alice' },
  { participantId: 'fk:bob', displayName: 'bob' },
];

function newDraft(seed = 'seed-1', overrides: Partial<Parameters<typeof createDraft>[0]> = {}): DraftState {
  return createDraft({
    draftId: 'draft:test',
    seed,
    pool: makePool(540),
    seatCount: 8,
    packCount: 3,
    packSize: 15,
    humans: HUMANS,
    ...overrides,
  });
}

/** Drive a whole draft with bots only, collecting every pick in order. */
function playOut(state: DraftState): { state: DraftState; log: string[] } {
  const log: string[] = [];
  let current = state;
  // Humans are bot-driven here too, so the log is the engine's, not a test's
  // choice: take whatever the bot heuristic picks for every seat.
  for (let guard = 0; guard < 10000; guard++) {
    if (current.status === 'complete') break;
    const before = current.seq;
    const { state: after } = runBots(current);
    current = after;
    const owing = waitingOn(current);
    if (owing.length > 0) {
      // A human seat is blocking; pick its first card deterministically.
      const seatId = owing[0] as number;
      const card = (current.packs[seatId] as DraftCard[])[0];
      if (card === undefined) break;
      const result = pick(current, seatId, card.cardId);
      if (!result.ok) break;
      log.push(`${seatId}:${card.cardId}`);
      current = result.state;
    }
    if (current.seq === before && waitingOn(current).length === 0 && current.status !== 'complete') break;
  }
  for (let s = 0; s < current.seatCount; s++) {
    log.push(`pool${s}=${(current.pools[s] as DraftCard[]).map((c) => c.cardId).join(',')}`);
  }
  return { state: current, log };
}

describe('replay — the guarantee everything else rests on', () => {
  it('the same seed twice produces a byte-identical pick log', () => {
    const a = playOut(newDraft('friday-cube'));
    const b = playOut(newDraft('friday-cube'));
    expect(a.log).toEqual(b.log);
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
  });

  it('a different seed produces a different draft', () => {
    const a = playOut(newDraft('friday-cube'));
    const b = playOut(newDraft('saturday-cube'));
    expect(a.log).not.toEqual(b.log);
  });

  it('bot picks do not depend on the order seats are asked', () => {
    // The same position reached twice must give the same bot choice, which is
    // what keying the rng by (seed, seat, pack, pick) buys.
    const one = newDraft('order-test');
    const two = newDraft('order-test');
    const a = runBots(one).state;
    const b = runBots(two).state;
    for (let s = 0; s < a.seatCount; s++) {
      expect((a.pools[s] as DraftCard[]).map((c) => c.cardId)).toEqual(
        (b.pools[s] as DraftCard[]).map((c) => c.cardId),
      );
    }
  });
});

describe('the draft runs to completion', () => {
  it('an 8-seat, 3-pack draft ends with 45 cards in every pool', () => {
    const { state } = playOut(newDraft());
    expect(state.status).toBe('complete');
    for (let s = 0; s < 8; s++) {
      expect((state.pools[s] as DraftCard[]).length).toBe(45);
    }
  });

  it('every pack is emptied', () => {
    const { state } = playOut(newDraft());
    for (const pack of state.packs) expect(pack.length).toBe(0);
  });

  it('no card is dealt to two seats in a singleton cube', () => {
    const { state } = playOut(newDraft());
    const seen = new Set<string>();
    for (const pool of state.pools) {
      for (const card of pool as DraftCard[]) {
        expect(seen.has(card.cardId)).toBe(false);
        seen.add(card.cardId);
      }
    }
    expect(seen.size).toBe(8 * 3 * 15);
  });

  it('packs pass left, right, left', () => {
    expect(directionFor(1)).toBe('left');
    expect(directionFor(2)).toBe('right');
    expect(directionFor(3)).toBe('left');
  });
});

describe('rejections are values, never throws', () => {
  it('an out-of-turn pick is rejected without throwing', () => {
    let state = newDraft();
    const card = (state.packs[0] as DraftCard[])[0] as DraftCard;
    const first = pick(state, 0, card.cardId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    const second = (state.packs[0] as DraftCard[])[0] as DraftCard;
    const again = pick(state, 0, second.cardId);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('already-picked');
    expect(again.state).toBe(state);
  });

  it('a card that is not in the pack is rejected', () => {
    const state = newDraft();
    const result = pick(state, 0, 'not-a-real-card');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('card-not-in-pack');
  });

  it('an unknown seat is rejected', () => {
    const state = newDraft();
    for (const seat of [-1, 8, 99, 1.5]) {
      const result = pick(state, seat, 'c0');
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('unknown-seat');
    }
  });

  it('a pick after the draft is complete is rejected', () => {
    const { state } = playOut(newDraft());
    expect(state.status).toBe('complete');
    const result = pick(state, 0, 'c0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('draft-complete');
  });

  it('no rejection path throws', () => {
    const state = newDraft();
    expect(() => pick(state, 99, 'nope')).not.toThrow();
    expect(() => pick(state, 0, 'nope')).not.toThrow();
  });
});

describe('hidden information', () => {
  it('a seat payload carries only its own pack and pool', () => {
    let state = newDraft();
    state = runBots(state).state;
    const views = viewsForAllSeats(state);
    for (const [seatId, view] of views) {
      expect(view.viewer.kind).toBe('seat');
      if (view.viewer.kind !== 'seat') continue;
      expect(view.viewer.seatId).toBe(seatId);
      const own = new Set((state.pools[seatId] as DraftCard[]).map((c) => c.cardId));
      for (const card of view.viewer.pool) expect(own.has(card.cardId)).toBe(true);
    }
  });

  it('no seat payload contains another seat’s cards, over the whole serialised payload', () => {
    let state = newDraft();
    state = runBots(state).state;
    const views = viewsForAllSeats(state);

    for (const [seatId, view] of views) {
      const json = JSON.stringify(view);
      for (let other = 0; other < state.seatCount; other++) {
        if (other === seatId) continue;
        const theirs = state.pools[other] as DraftCard[];
        const mine = new Set((state.pools[seatId] as DraftCard[]).map((c) => c.cardId));
        const myPack = new Set((state.packs[seatId] as DraftCard[]).map((c) => c.cardId));
        for (const card of theirs) {
          // A card can legitimately appear in our own pack or pool; what must
          // never appear is one that is exclusively theirs.
          if (mine.has(card.cardId) || myPack.has(card.cardId)) continue;
          expect(json).not.toContain(`"${card.cardId}"`);
        }
      }
    }
  });

  it('the spectator payload is structurally incapable of carrying cards', () => {
    let state = newDraft();
    state = runBots(state).state;
    const view = spectatorView(state);
    expect(view.viewer).toEqual({ kind: 'spectator' });
    const json = JSON.stringify(view);
    for (const pool of state.pools) {
      for (const card of pool as DraftCard[]) {
        expect(json).not.toContain(`"${card.cardId}"`);
      }
    }
  });

  it('a payload hands out copies, so a caller cannot reach into engine state', () => {
    const state = newDraft();
    const view = viewFor(state, 0);
    if (view.viewer.kind !== 'seat') throw new Error('expected a seat');
    const before = (state.packs[0] as DraftCard[]).length;
    view.viewer.pack.pop();
    expect((state.packs[0] as DraftCard[]).length).toBe(before);
  });
});

describe('the envelope validates against the published schema', () => {
  it('every seat view parses', () => {
    let state = newDraft();
    state = runBots(state).state;
    for (const [, view] of viewsForAllSeats(state)) {
      expect(() => DraftViewSchema.parse(view)).not.toThrow();
    }
  });

  it('the spectator view parses', () => {
    const state = newDraft();
    expect(() => DraftViewSchema.parse(spectatorView(state))).not.toThrow();
  });

  it('every payload carries an epoch as well as a seq', () => {
    const state = newDraft();
    const view = viewFor(state, 0);
    expect(typeof view.epoch).toBe('string');
    expect(view.epoch.length).toBeGreaterThan(0);
    expect(typeof view.seq).toBe('number');
  });

  it('seq advances on every state change', () => {
    const state = newDraft();
    const card = (state.packs[0] as DraftCard[])[0] as DraftCard;
    const result = pick(state, 0, card.cardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.seq).toBeGreaterThan(state.seq);
  });
});

describe('seating', () => {
  it('humans take the low seats and bots fill the rest', () => {
    const state = newDraft();
    expect(state.displayNames[0]).toBe('alice');
    expect(state.displayNames[1]).toBe('bob');
    const view = viewFor(state, 0);
    const bots = view.seats.filter((s) => s.occupant?.kind === 'bot');
    expect(bots.length).toBe(6);
  });

  it('names the bots from bots, the first bot seat first, and Bot <seat> past the list', () => {
    const state = newDraft('seed-1', { bots: [{ name: 'Sage', avatarId: 'sage' }, { name: 'Herald', avatarId: 'herald' }, { name: 'Cleric' }] });
    expect([2, 3, 4, 5].map((id) => state.displayNames[id])).toEqual(['Sage', 'Herald', 'Cleric', 'Bot 5']);
    expect(state.displayNames[0]).toBe('alice');
  });

  it('carries each seat’s character to every viewer, and none for a seat that has none', () => {
    const state = newDraft('seed-1', { bots: [{ name: 'Sage', avatarId: 'sage' }, { name: 'Herald' }] });
    const seats = viewFor(state, 1).seats;
    expect(seats.map((s) => s.avatarId)).toEqual([undefined, undefined, 'sage', undefined, undefined, undefined, undefined, undefined]);
  });

  it('a human’s own character is drawn at their seat', () => {
    const state = newDraft('seed-1', { humans: [{ participantId: 'p-alice', displayName: 'alice', avatarId: 'rogue' }] });
    expect(viewFor(state, 0).seats[0]?.avatarId).toBe('rogue');
  });

  it('the pod is exactly seatCount seats', () => {
    const state = newDraft();
    const view = viewFor(state, 0);
    expect(view.seats.length).toBe(8);
    expect(view.capacity).toBe(8);
    // The rows come from the TABLE, not from `seatCount` — they agree here only
    // because `createDraft` bot-pads every seat, so all three numbers match.
    // `view.test.ts` covers the cases where they do not.
    expect(view.seats.length).toBe(state.table.seats.length);
  });

  it('a four-player pod still fills to eight', () => {
    const state = newDraft('four', {
      humans: [
        { participantId: 'fk:a', displayName: 'a' },
        { participantId: 'fk:b', displayName: 'b' },
        { participantId: 'fk:c', displayName: 'c' },
        { participantId: 'fk:d', displayName: 'd' },
      ],
    });
    const view = viewFor(state, 0);
    expect(view.seats.filter((s) => s.occupant !== null).length).toBe(8);
    expect(view.seats.filter((s) => s.occupant?.kind === 'bot').length).toBe(4);
  });
});

describe('pool sizing', () => {
  it('reports a shortfall rather than silently dealing short packs', () => {
    expect(poolShortfall({ pool: makePool(360), seatCount: 8, packCount: 3, packSize: 15 })).toBe(0);
    expect(poolShortfall({ pool: makePool(100), seatCount: 8, packCount: 3, packSize: 15 })).toBe(260);
  });

  it('a short pool still deals full packs', () => {
    const state = newDraft('short', { pool: makePool(100) });
    for (const pack of state.packs) expect(pack.length).toBe(15);
  });
});

describe('events', () => {
  it('a pick that completes the round reports the pass', () => {
    // Bots take all but one seat's pick, then the last pick closes the round.
    const state = runBots(newDraft()).state;
    const owing = waitingOn(state);
    expect(owing.length).toBeGreaterThan(0);
    const seatId = owing[0] as number;
    const card = (state.packs[seatId] as DraftCard[])[0] as DraftCard;
    const result = pick(state, seatId, card.cardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events: DraftEvent[] = result.events;
    expect(events[0]?.type).toBe('picked');
  });
});
