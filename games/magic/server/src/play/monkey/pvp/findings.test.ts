/*
 * The two-seat run's findings, and the board its decks start on.
 */
import { describe, expect, it } from 'vitest';

import { makeRng } from '../rng.ts';
import { findingsOf } from './findings.ts';
import { podBoard } from './pod.ts';
import type { PvpResult } from './run-pvp.ts';

const result = (over: Partial<PvpResult>): PvpResult => ({
  matchId: 'm-1',
  deck: { seat0: 'a', seat1: 'b' },
  seed: 1,
  turns: 9,
  outcome: 'over',
  decisions: [10, 10],
  flags: [],
  restarts: { asked: [], allowed: [], unavailable: [] },
  report: { restores: [], lossy: [], refused: [] },
  watcher: { isWatcher: true, turn: 9, lives: [0, 7], seatTurn: 9, seatLives: [0, 7] },
  ms: 1,
  ...over,
});

describe('findingsOf', () => {
  it('finds nothing in a clean match, nor in a turn Restart turn was not offered for', () => {
    expect(findingsOf(result({ restarts: { asked: [], allowed: [], unavailable: [4] }, report: { restores: [], lossy: [{ turn: 4, kinds: ['effect'], fresh: ['effect'], arrived: ['Hop to It'] }], refused: [] } }))).toEqual([]);
  });

  it('finds a restored turn that differs, an allowed restart that never restored, and a refused take-back — not an ask the turn outran, nor a press a frame behind', () => {
    const found = findingsOf(
      result({
        restarts: { asked: [4, 7, 9], allowed: [4, 7], unavailable: [] },
        report: { restores: [{ turn: 4, same: false, diff: [{ key: 'p0battlefield', before: ['Fish|Id:Fish'], after: [] }], missing: false }], lossy: [], refused: [{ turn: 7, act: 'ask', error: 'not-restorable' }, { turn: 9, act: 'ask', error: 'not-your-turn' }] },
      }),
    );
    expect(found).toEqual([
      'restart of turn 4: the restored turn differs — p0battlefield lost [Fish|Id:Fish] gained []',
      'restart of turn 7 was allowed but never restored',
      'take-back refused at turn 7: ask → not-restorable',
    ]);
  });

  it('finds a watcher that is not one, or that shows another game than the seats', () => {
    expect(findingsOf(result({ watcher: { isWatcher: false, turn: 9, lives: [0, 7], seatTurn: 9, seatLives: [0, 7] } }))).toEqual(['the third account was not made the watcher']);
    expect(findingsOf(result({ watcher: { isWatcher: true, turn: 8, lives: [3, 7], seatTurn: 9, seatLives: [0, 7] } }))).toHaveLength(1);
  });
});

describe('podBoard', () => {
  it('deals each deck seven to hand and the rest to its library, every card kept, seat 0 on turn 1', () => {
    const deck = (p: string): string[] => Array.from({ length: 40 }, (_, i) => `${p}${i}`);
    const board = podBoard([deck('a'), deck('b')], makeRng(5));
    const line = (k: string): string[] => (board.split('\n').find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1).split(';');
    expect(line('humanhand')).toHaveLength(7);
    expect([...line('humanhand'), ...line('humanlibrary')].sort()).toEqual(deck('a').sort());
    expect([...line('aihand'), ...line('ailibrary')].sort()).toEqual(deck('b').sort());
    expect(board).toContain('turn=1\nactiveplayer=human\nactivephase=MAIN1');
  });
});
