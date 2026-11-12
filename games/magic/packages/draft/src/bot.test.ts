/*
 * `runBots`'s loud-stall log (wave 74 §E fix-forward, production incident
 * main 705e2468: every seat frozen, no error, no log, for 120s — `runBots`
 * broke silently on a full pass with no progress), and what a bot picks from
 * a pack: card quality from Forge's cube pick order, held by colour once the
 * pool commits.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DraftCard } from '@hadoku/shared';
import { createDraft } from './engine.ts';
import { botTurn, choosePick, runBots, scoreCard } from './bot.ts';

function card(name: string, over: Partial<DraftCard> = {}): DraftCard {
  return {
    cardId: name,
    name,
    manaCost: [],
    manaValue: 1,
    colors: [],
    typeLine: 'Creature — Test',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: '1',
    rarity: 'common',
    ...over,
  };
}

describe('runBots — the loud stall log', () => {
  it('logs nothing on an ordinary pass that completes normally', () => {
    const packs = [Array.from({ length: 8 }, (_, seat) => [card(`a-${seat}`)])];
    const state = createDraft({ draftId: 'd', seed: 'd', packs, seatCount: 8, packCount: 1, packSize: 1, humans: [] });
    const log = vi.fn();
    runBots(state, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('every bot seat failing to resolve a pick (choosePick finds nothing to take) logs one bots-stalled line naming each seat and its pack/pool sizes, then stops', () => {
    // The only reachable stall through the public API: `choosePick` returns
    // null for a NON-empty pack (an empty one is never `waitingOn`), which
    // needs every card's score to come out NaN — here, a NaN manaValue.
    const nanState = createDraft({
      draftId: 'd3',
      seed: 'd3',
      packs: [Array.from({ length: 8 }, (_, seat) => [{ ...card(`a-${seat}`), manaValue: Number.NaN }])],
      seatCount: 8,
      packCount: 1,
      packSize: 1,
      humans: [],
    });
    const log = vi.fn();
    const { state: finalState, picks } = runBots(nanState, log);
    expect(picks).toBe(0);
    expect(finalState.status).toBe('drafting');
    expect(log).toHaveBeenCalledTimes(1);
    const [entry] = log.mock.calls[0] as [Record<string, unknown>];
    expect(entry.evt).toBe('bots-stalled');
    expect(entry.draftId).toBe('d3');
    expect((entry.seats as { seatId: number; packSize: number; poolSize: number }[]).length).toBe(8);
    expect((entry.seats as { seatId: number; packSize: number }[])[0]?.packSize).toBe(1);
  });
});

describe('botTurn — one pick per bot, so a pod is paced rather than drained', () => {
  it('every bot holding a pack takes exactly one card, and the packs move on once', () => {
    const packs = [Array.from({ length: 4 }, (_, seat) => Array.from({ length: 3 }, (_, k) => card(`p${seat}-${k}`)))];
    const state = createDraft({ draftId: 't', seed: 't', packs, seatCount: 4, packCount: 1, packSize: 3, humans: [] });
    const turn = botTurn(state, vi.fn());
    expect(turn.picks).toBe(4);
    expect(turn.state.pools.map((p) => p.length)).toEqual([1, 1, 1, 1]);
    // Each passed once: every seat holds its neighbour's pack, one card down.
    expect(turn.state.queues.map((q) => q.map((p) => p.length))).toEqual([[2], [2], [2], [2]]);
    expect(runBots(state, vi.fn()).state.status).toBe('complete');
  });

  it('a chosen card is taken for its seat; a seat not chosen, or chosen a card its pack lacks, takes the heuristic pick', () => {
    const packs = [Array.from({ length: 3 }, (_, seat) => Array.from({ length: 3 }, (_, k) => card(`p${seat}-${k}`)))];
    const state = createDraft({ draftId: 'c', seed: 'c', packs, seatCount: 3, packCount: 1, packSize: 3, humans: [] });
    const heuristic = botTurn(state, vi.fn()).state.pools.map((p) => p[0]?.cardId);
    const other = ['p0-0', 'p0-1'].find((id) => id !== heuristic[0])!;
    // Seat 1 is "chosen" a card from seat 0's pack, which it does not hold.
    const turn = botTurn(state, vi.fn(), new Map([[0, other], [1, 'p0-2']]));
    expect(turn.picks).toBe(3);
    expect(turn.state.pools.map((p) => p[0]?.cardId)).toEqual([other, heuristic[1], heuristic[2]]);
  });

  it('a held seat sits the turn out, and a turn where every owing seat is held is not a stall', () => {
    const packs = [Array.from({ length: 3 }, (_, seat) => Array.from({ length: 3 }, (_, k) => card(`p${seat}-${k}`)))];
    const state = createDraft({ draftId: 'h', seed: 'h', packs, seatCount: 3, packCount: 1, packSize: 3, humans: [] });
    const log = vi.fn();
    const turn = botTurn(state, log, new Map(), new Set([1]));
    expect(turn.picks).toBe(2);
    expect(turn.state.pools.map((p) => p.length)).toEqual([1, 0, 1]);
    const all = botTurn(state, log, new Map(), new Set([0, 1, 2]));
    expect(all).toMatchObject({ picks: 0, stalled: false });
    expect(log).not.toHaveBeenCalled();
  });
});


describe('choosePick — quality from the cube pick order, then colour', () => {
  const noJitter = { next: () => 0 };
  const red = { colors: ['R' as const], manaCost: ['R'] };
  const blue = { colors: ['U' as const], manaCost: ['U'] };
  const white = { colors: ['W' as const], manaCost: ['W'] };
  const whitePool = [card('w1', white), card('w2', white), card('w3', white)];

  it('takes a well-ranked common over an unranked mythic before the pool commits', () => {
    const pack = [card('Grizzly Bears', { ...red, rarity: 'mythic' }), card('Lightning Bolt', red)];
    expect(choosePick(pack, [], noJitter)?.name).toBe('Lightning Bolt');
  });

  it('orders ranked cards by rank', () => {
    const pack = [card('Counterspell', blue), card('Ancestral Recall', blue), card('Brainstorm', blue)];
    expect(choosePick(pack, [], noJitter)?.name).toBe('Ancestral Recall');
  });

  it('judges unranked cards by rarity, inside the band below the well-ranked ones', () => {
    const mythic = scoreCard(card('Unranked mythic', { ...blue, rarity: 'mythic' }), []);
    const rare = scoreCard(card('Unranked rare', { ...blue, rarity: 'rare' }), []);
    const common = scoreCard(card('Unranked common', blue), []);
    expect(mythic).toBeGreaterThan(rare);
    expect(rare).toBeGreaterThan(common);
    expect(scoreCard(card('Counterspell', blue), [])).toBeGreaterThan(mythic);
    expect(common).toBeGreaterThan(scoreCard(card('Sleight of Hand', blue), []));
  });

  it('once committed, stays on colour over an off-colour staple', () => {
    const pack = [card('Lightning Bolt', red), card('Grizzly Bears', white)];
    expect(choosePick(pack, whitePool, noJitter)?.name).toBe('Grizzly Bears');
  });

  it('once committed, still leaves its colours for a top card when the on-colour choice is the bottom of the order', () => {
    const pack = [card('Lightning Bolt', red), card('Sleight of Hand', white)];
    expect(choosePick(pack, whitePool, noJitter)?.name).toBe('Lightning Bolt');
  });
});
