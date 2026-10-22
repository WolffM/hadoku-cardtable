/*
 * `runBots`'s loud-stall log (wave 74 §E fix-forward, production incident
 * main 705e2468: every seat frozen, no error, no log, for 120s — `runBots`
 * broke silently on a full pass with no progress). This is the one new
 * behaviour `bot.ts` gained from that incident; `choosePick`/`scoreCard`'s
 * own heuristic is `engine.test.ts`'s coverage.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DraftCard } from '@hadoku/shared';
import { createDraft } from './engine.ts';
import { botTurn, runBots } from './bot.ts';

function card(name: string): DraftCard {
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
});

