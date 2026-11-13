import { describe, expect, it, vi } from 'vitest';

import type { Arrangement } from '../Board.tsx';
import type { BoardCard } from '../adapter.ts';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { actionsFor, CARD_ACTIONS, pilesOf, sameToken, sameTokensAs, stackGroups, withStacked, type CardActionContext } from './actions.ts';

const seed = boardFromFixture(PLAY_FIXTURES[0]!).players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === 8)!;
const PLAYER = 1;

/** A plain 1/1 Soldier token; `over` is what sets this one apart. */
const soldier = (id: number, over: Partial<BoardCard> = {}): BoardCard => ({
  ...seed,
  id,
  card: { ...seed.card, name: 'Soldier', power: '1', toughness: '1' },
  token: true,
  tapped: false,
  damage: 0,
  summoningSick: false,
  counters: [],
  keywords: [],
  abilityText: null,
  attachedCardIds: [],
  attachedToId: null,
  hidden: false,
  ...over,
});
const goblin = (id: number): BoardCard => soldier(id, { card: { ...seed.card, name: 'Goblin', power: '1', toughness: '1' } });

describe('sameToken: Forge’s own rule for which tokens stack, tapped apart', () => {
  const a = soldier(1);
  it('the same token, damaged or not', () => {
    expect(sameToken(a, soldier(2))).toBe(true);
    expect(sameToken(a, soldier(2, { damage: 1 }))).toBe(true);
    expect(sameToken(a, soldier(2, { counters: [{ name: 'P1P1', count: 0 }] })), 'a counter at zero is no counter').toBe(true);
  });

  it.each<[string, Partial<BoardCard>]>([
    ['tapped (the operator, 2026-10-20)', { tapped: true }],
    ['another name', { card: { ...seed.card, name: 'Goblin', power: '1', toughness: '1' } }],
    ['another power and toughness', { card: { ...seed.card, name: 'Soldier', power: '2', toughness: '2' } }],
    ['a counter', { counters: [{ name: 'P1P1', count: 1 }] }],
    ['summoning sickness', { summoningSick: true }],
    ['another text', { abilityText: 'Flying' }],
    ['another keyword', { keywords: ['Haste'] }],
    ['an attachment on it', { attachedCardIds: [99] }],
    ['attached to something', { attachedToId: 99 }],
    ['not a token', { token: false }],
    ['a card this seat cannot see', { hidden: true }],
  ])('not the same: %s', (_, over) => {
    expect(sameToken(a, soldier(2, over))).toBe(false);
    expect(sameToken(soldier(2, over), a)).toBe(false);
  });

  it('collects the card and its twins in the battlefield’s order', () => {
    const field = [soldier(1), goblin(2), soldier(3), soldier(4, { counters: [{ name: 'P1P1', count: 1 }] }), soldier(5), soldier(6, { tapped: true })];
    expect(sameTokensAs(field[2]!, field).map((c) => c.id)).toEqual([1, 3, 5]);
  });
});

const ctxOf = (card: BoardCard, battlefield: readonly BoardCard[], piles: number[][]): CardActionContext => ({ card, battlefield, piles, stack: vi.fn() });
const stackAction = CARD_ACTIONS.find((a) => a.id === 'stack-same-tokens')!;

describe('Stack all of the same tokens', () => {
  const field = [soldier(1), soldier(2), soldier(3), goblin(4)];
  it('is offered while the same tokens are in more than one pile', () => {
    expect(actionsFor(ctxOf(field[0]!, field, [[1], [2], [3], [4]]))).toEqual([stackAction]);
    expect(actionsFor(ctxOf(field[0]!, field, [[1, 2], [3], [4]]))).toEqual([stackAction]);
  });

  it('is not offered once they are one pile, nor on a token with no twin', () => {
    expect(actionsFor(ctxOf(field[0]!, field, [[1, 2, 3], [4]]))).toEqual([]);
    expect(actionsFor(ctxOf(field[3]!, field, [[1], [2], [3], [4]]))).toEqual([]);
  });

  it('gathers every twin onto the card it was opened on', () => {
    const ctx = ctxOf(field[1]!, field, [[1], [2], [3], [4]]);
    stackAction.run(ctx);
    expect(ctx.stack).toHaveBeenCalledWith([{ ids: [1, 2, 3], onto: 2 }]);
  });

  it('stacks the tapped and the untapped each into a pile of its own', () => {
    const mixed = [soldier(1), soldier(2, { tapped: true }), soldier(3), soldier(4, { tapped: true }), soldier(5)];
    const ctx = ctxOf(mixed[2]!, mixed, [[1], [2], [3], [4], [5]]);
    expect(stackGroups(ctx)).toEqual([
      { ids: [1, 3, 5], onto: 3 },
      { ids: [2, 4], onto: 2 },
    ]);
    // Only the state that is still split: the untapped are one pile already.
    expect(stackGroups(ctxOf(mixed[0]!, mixed, [[1, 3, 5], [2], [4]]))).toEqual([{ ids: [2, 4], onto: 2 }]);
    expect(actionsFor(ctxOf(mixed[0]!, mixed, [[1, 3, 5], [2, 4]]))).toEqual([]);
  });

  it('is offered again once an untap splits a pile — not a one-shot', () => {
    // Two piles, one tapped and one untapped; then the untap step untaps them all.
    const piles = [[1, 3], [2, 4]];
    const tapped = [soldier(1), soldier(2, { tapped: true }), soldier(3), soldier(4, { tapped: true })];
    expect(actionsFor(ctxOf(tapped[0]!, tapped, piles))).toEqual([]);
    const untapped = tapped.map((c) => ({ ...c, tapped: false }));
    const ctx = ctxOf(untapped[0]!, untapped, piles);
    expect(actionsFor(ctx)).toEqual([stackAction]);
    stackAction.run(ctx);
    expect(ctx.stack).toHaveBeenCalledWith([{ ids: [1, 2, 3, 4], onto: 1 }]);
  });
});

describe('withStacked: the arrangement’s own stacking, every twin at once', () => {
  const field = [soldier(1), soldier(2), soldier(3), soldier(4), soldier(5), goblin(6)];
  const split: Arrangement = { [`${PLAYER}:front`]: [[1, 2], [3], [6], [4], [5]] };
  const all = [{ ids: [1, 2, 3, 4, 5], onto: 4 }];

  it('one pile, in the column of the pile it was gathered onto; nothing else moves', () => {
    const next = withStacked(field, PLAYER, split, all, 'single');
    expect(pilesOf(field, PLAYER, next, 'single')).toEqual([[6], [4, 1, 2, 3, 5]]);
    // The columns the Soldiers left stay columns — as any stack leaves them — so the Goblin keeps its own.
    expect(next[`${PLAYER}:front`]).toEqual([[], [], [6], [4, 1, 2, 3, 5]]);
  });

  it('keeps a pile already gathered, and changes nothing when there is nothing to gather', () => {
    const together: Arrangement = { [`${PLAYER}:front`]: [[1, 2, 3, 4, 5], [6]] };
    expect(withStacked(field, PLAYER, together, [{ ids: [1, 2, 3, 4, 5], onto: 1 }], 'single')).toBe(together);
  });

  it('works from the default grouping, where every token is its own pile, one group after another', () => {
    const next = withStacked(field, PLAYER, {}, [{ ids: [1, 3, 5], onto: 1 }, { ids: [2, 4], onto: 2 }], 'single');
    expect(pilesOf(field, PLAYER, next, 'single')).toEqual([[1, 3, 5], [2, 4], [6]]);
  });
});
