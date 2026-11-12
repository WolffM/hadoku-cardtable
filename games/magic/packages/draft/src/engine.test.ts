/*
 * The engine's guarantees, in the order the wave plan asks for them.
 *
 * The headline is replay: the same seed twice produces a byte-identical pick
 * log. Everything else — rejections as values, the hidden-information split,
 * pass direction — is checkable, but replay is the one that makes the rest
 * testable at all.
 */

import { describe, expect, it } from 'vitest';
import { DraftViewSchema, type DraftCard, type DraftPlan, type PoolSource } from '@hadoku/shared';
import {
  createDraft,
  directionFor,
  fromLockstep,
  packOf,
  pick,
  pickNumberOf,
  queueDepth,
  waitingOn,
  type LockstepState,
  type DraftConfig,
  type DraftEvent,
  type DraftState,
} from './engine.ts';
import { deal, poolShortfall } from './deal.ts';
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

/** A plan whose three rounds all draw from the one synthetic pool this test names. */
function planOf(cubeId: string): DraftPlan {
  const src: PoolSource = { kind: 'cube', cubeId };
  return { rounds: [src, src, src] };
}

function newDraft(
  seed = 'seed-1',
  overrides: Partial<DraftConfig> & { pool?: DraftCard[] } = {},
): DraftState {
  const { pool, ...configOverrides } = overrides;
  const seatCount = configOverrides.seatCount ?? 8;
  const packSize = configOverrides.packSize ?? 15;
  const packs = deal(planOf('test-pool'), () => pool ?? makePool(540), seed, seatCount, packSize);
  return createDraft({
    draftId: 'draft:test',
    seed,
    packs,
    seatCount,
    packCount: 3,
    packSize,
    humans: HUMANS,
    ...configOverrides,
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
      const card = packOf(current, seatId)[0];
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
    for (const queue of state.queues) expect(queue).toEqual([]);
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
  it('a pick with no pack in front of the seat is rejected without throwing', () => {
    let state = newDraft();
    const card = packOf(state, 0)[0] as DraftCard;
    const first = pick(state, 0, card.cardId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    // Seat 0 passed its pack on and seat 7 has not passed one to it yet.
    const second = packOf(newDraft(), 0)[1] as DraftCard;
    const again = pick(state, 0, second.cardId);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('empty-pack');
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
        const myPack = new Set(packOf(state, seatId).map((c) => c.cardId));
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
    const before = packOf(state, 0).length;
    view.viewer.pack.pop();
    expect(packOf(state, 0).length).toBe(before);
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
    const card = packOf(state, 0)[0] as DraftCard;
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
    const plan = planOf('test-pool');
    expect(poolShortfall(plan, () => makePool(360), 8, 15)).toBe(0);
    expect(poolShortfall(plan, () => makePool(100), 8, 15)).toBe(260);
  });

  it('a short pool still deals full packs', () => {
    const state = newDraft('short', { pool: makePool(100) });
    for (const queue of state.queues) expect(queue.map((p) => p.length)).toEqual([15]);
  });
});

describe('events', () => {
  it('a pick reports the card, then the pass to the neighbour', () => {
    const state = runBots(newDraft()).state;
    const owing = waitingOn(state);
    expect(owing.length).toBeGreaterThan(0);
    const seatId = owing[0] as number;
    const card = packOf(state, seatId)[0] as DraftCard;
    const result = pick(state, seatId, card.cardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events: DraftEvent[] = result.events;
    expect(events.map((e) => e.type)).toEqual(['picked', 'pack-passed']);
    expect(events[1]).toEqual({ type: 'pack-passed', from: seatId, to: (seatId + 1) % 8, direction: 'left' });
  });
});

/** Four seats, every one a bot by occupant but driven here by hand, so a test decides who is fast and who is slow. */
function table(seed = 'async', seatCount = 4, packSize = 6): DraftState {
  const packs = deal(planOf('test-pool'), () => makePool(seatCount * packSize * 3), seed, seatCount, packSize);
  return createDraft({ draftId: 'draft:async', seed, packs, seatCount, packCount: 3, packSize, humans: [] });
}

/** Seat `s` takes the first card of the pack in front of it. */
function takeFirst(state: DraftState, s: number): DraftState {
  const card = packOf(state, s)[0];
  if (card === undefined) throw new Error(`seat ${s} holds no pack`);
  const result = pick(state, s, card.cardId);
  if (!result.ok) throw new Error(`seat ${s}: ${result.reason}`);
  return result.state;
}

/** Every seat in `fast` picks until none of them holds a pack. */
function drainFast(state: DraftState, fast: readonly number[]): DraftState {
  let current = state;
  for (let guard = 0; guard < 1000; guard++) {
    const s = fast.find((seat) => packOf(current, seat).length > 0);
    if (s === undefined) return current;
    current = takeFirst(current, s);
  }
  throw new Error('fast seats never ran dry');
}

describe('packs queue: each seat picks at its own pace', () => {
  it('a pick passes the rest of the pack to the neighbour at once, without waiting for the table', () => {
    const state = takeFirst(table(), 0);
    expect(state.queues.map((q) => q.length)).toEqual([0, 2, 1, 1]);
    expect(queueDepth(state, 1)).toBe(1);
    expect(packOf(state, 1).length).toBe(6);
    expect(state.queues[1]?.[1]?.length).toBe(5);
    expect(waitingOn(state)).toEqual([1, 2, 3]);
    expect(pickNumberOf(state, 0)).toBe(2);
    expect(pickNumberOf(state, 1)).toBe(1);
  });

  it('a fast seat accumulates nothing while a slow seat’s queue grows to seats − 1', () => {
    const slow = 3;
    const fast = [0, 1, 2];
    let state = table();
    let deepest = 0;
    for (let k = 0; k < 4; k++) {
      state = drainFast(state, fast);
      deepest = Math.max(deepest, queueDepth(state, slow));
      for (const s of fast) expect(queueDepth(state, s)).toBe(0);
    }
    // Every pack of the round sits in front of the slow seat: its own and the three behind it.
    expect(state.queues.map((q) => q.length)).toEqual([0, 0, 0, 4]);
    expect(queueDepth(state, slow)).toBe(3);
    expect(deepest).toBe(3);
    // Nothing in front of the fast seats: they wait on the slow one.
    expect(waitingOn(state)).toEqual([slow]);
    // The slow seat picks once: one pack moves on to seat 0, the rest still wait.
    state = takeFirst(state, slow);
    expect(state.queues.map((q) => q.length)).toEqual([1, 0, 0, 3]);
  });

  it('the next round opens only when every pack of this one is empty, with the direction reversed', () => {
    let state = table('rounds', 4, 3);
    // Seats 0–2 drain everything they can; seat 3 never picks, so round one cannot end.
    state = drainFast(state, [0, 1, 2]);
    expect(state.packNumber).toBe(1);
    // Three-card packs: seat 0's is emptied by seats 0–2 before it reaches seat 3.
    expect(queueDepth(state, 3)).toBe(2);
    const events: DraftEvent[] = [];
    for (let guard = 0; guard < 100 && state.packNumber === 1; guard++) {
      const s = waitingOn(state)[0] as number;
      const card = packOf(state, s)[0] as DraftCard;
      const result = pick(state, s, card.cardId);
      if (!result.ok) throw new Error(result.reason);
      events.push(...result.events);
      state = result.state;
    }
    expect(state.packNumber).toBe(2);
    expect(events.at(-1)).toEqual({ type: 'round-started', packNumber: 2, direction: 'right' });
    expect(state.queues.map((q) => q.length)).toEqual([1, 1, 1, 1]);
    for (let s = 0; s < 4; s++) {
      expect(pickNumberOf(state, s)).toBe(1);
      expect((state.pools[s] as DraftCard[]).length).toBe(3);
    }
    // Round two passes right: seat 0's pack goes to seat 3.
    expect(takeFirst(state, 0).queues.map((q) => q.length)).toEqual([0, 1, 1, 2]);
  });

  it('the same choices make the same draft at any pace', () => {
    /** Lock-step: everyone picks once, in seat order, every pass. */
    const lockstep = (start: DraftState) => {
      let s = start;
      while (s.status !== 'complete') for (const seat of waitingOn(s)) s = takeFirst(s, seat);
      return s;
    };
    /** Ragged: seat 3 picks only when nobody else can. */
    const ragged = (start: DraftState) => {
      let s = start;
      while (s.status !== 'complete') {
        s = drainFast(s, [0, 1, 2]);
        if (s.status !== 'complete' && packOf(s, 3).length > 0) s = takeFirst(s, 3);
      }
      return s;
    };
    const a = lockstep(table('pace'));
    const b = ragged(table('pace'));
    expect(b.pools.map((p) => p.map((c) => c.cardId))).toEqual(a.pools.map((p) => p.map((c) => c.cardId)));
    for (const pool of a.pools) expect(pool.length).toBe(18);
  });

  it('a seat’s payload carries the pack it picks from, never the packs waiting behind it', () => {
    const state = drainFast(table(), [0, 1, 2]);
    const view = viewFor(state, 3);
    expect(view.seats.map((s) => s.queueDepth)).toEqual([0, 0, 0, 3]);
    if (view.viewer.kind !== 'seat') throw new Error('expected a seat');
    expect(view.viewer.pack.map((c) => c.cardId)).toEqual(packOf(state, 3).map((c) => c.cardId));
    const json = JSON.stringify(view);
    for (const waiting of (state.queues[3] as DraftCard[][]).slice(1)) {
      for (const card of waiting) expect(json).not.toContain(`"${card.cardId}"`);
    }
    // Everyone sees the pile's depth, and the spectator sees the slowest seat's pick.
    expect(spectatorView(state).seats[3]?.queueDepth).toBe(3);
    expect(spectatorView(state).pickNumber).toBe(1);
    expect(viewFor(state, 0).pickNumber).toBe(pickNumberOf(state, 0));
  });

  it('reads a draft saved before packs queued: a seat that had picked has passed its pack on', () => {
    const fresh = table('saved');
    const packs = fresh.queues.map((q) => (q[0] as DraftCard[]).slice());
    packs[1] = packs[1]!.slice(1);
    const { queues: _q, roundPicks: _r, ...rest } = fresh;
    const saved: LockstepState = { ...rest, packs, picked: [1], pickNumber: 1 };
    const state = fromLockstep(saved);
    expect(state.queues.map((q) => q.length)).toEqual([1, 0, 2, 1]);
    expect(state.queues[2]?.[1]).toEqual(packs[1]);
    expect(state.roundPicks).toEqual([0, 1, 0, 0]);
    expect(fromLockstep(state)).toBe(state);
  });
});
