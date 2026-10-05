// @vitest-environment jsdom
/*
 * Wave 42 §P — `classifySelection` and `SelectionPrompt`, synthetic:
 * `SelectionLike`/the lookup are built by hand here (there is no committed
 * fixture for `setSelectables`, unlike the fourteen `ask` methods), but the
 * ids are the real match's own (`fixtureLookup`, `fixtures.ts`), so a card's
 * name and art resolve exactly as a live tile's would. The real-Forge proof
 * — that Relentless Dead's graveyard target really reaches the wire this
 * shape, and that picking or declining it really completes the trigger — is
 * `offboard.jvm.test.ts`; this file is `classifySelection`'s own unit cover
 * and the component's rendering contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

import { classifySelection, SelectionPrompt, type SelectionLike } from './SelectionPrompt.tsx';
import { fixtureLookup } from './fixtures.ts';
import { EMPTY_LOOKUP } from './lookup.ts';

afterEach(cleanup);

// Real ids from the committed match fixture (`fixtures.ts`'s own header):
// 99 Alice's Vulshok War Boar, 21 Bob's Fire Urchin, 67 Goblin Replica — all
// three are on A battlefield in that match, so "on the board" below is
// simulated by which of them this test puts in `boardCardIds`, not by what
// the fixture itself says.
const GRAVEYARD_CARD = 99;
const BOARD_CARD = 21;

describe('classifySelection', () => {
  it('is none when nothing is open', () => {
    expect(classifySelection(null, new Set())).toBe('none');
  });

  it('is none when the selection names no cards (a player-only selection)', () => {
    const sel: SelectionLike = { cards: [], min: 0, max: 1 };
    expect(classifySelection(sel, new Set([BOARD_CARD]))).toBe('none');
  });

  it('is off-board when any named card is not on the board — W18’s soft-lock shape', () => {
    const sel: SelectionLike = { cards: [GRAVEYARD_CARD], min: 1, max: 1 };
    expect(classifySelection(sel, new Set([BOARD_CARD]))).toBe('off-board');
  });

  it('is off-board even when the selection mixes an on-board card with an off-board one', () => {
    const sel: SelectionLike = { cards: [BOARD_CARD, GRAVEYARD_CARD], min: 1, max: 1 };
    expect(classifySelection(sel, new Set([BOARD_CARD]))).toBe('off-board');
  });

  it('is on-board when every named card is already drawable on the board', () => {
    const sel: SelectionLike = { cards: [BOARD_CARD], min: 1, max: 1 };
    expect(classifySelection(sel, new Set([BOARD_CARD]))).toBe('on-board');
  });

  it('is on-board even for a lone card at min 0 — no special-cased "confirm" shape (removed: no real card sends it, see SelectionPrompt.tsx)', () => {
    const sel: SelectionLike = { cards: [BOARD_CARD], min: 0, max: 1 };
    expect(classifySelection(sel, new Set([BOARD_CARD]))).toBe('on-board');
  });
});

describe('SelectionPrompt', () => {
  it('draws Forge’s own message verbatim, one tile per named card, and nothing invented', () => {
    const { getByRole, getAllByTestId } = render(
      createElement(SelectionPrompt, {
        message: 'Select target Zombie creature card',
        cards: [GRAVEYARD_CARD],
        lookup: fixtureLookup(),
        picked: new Set<number>(),
        onPick: () => {},
      }),
    );
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Select target Zombie creature card');
    expect(getAllByTestId('prompt-choice')).toHaveLength(1);
  });

  it('a real on-board message (host line, blank line, then the instruction) splits into a title and a separate instruction line, like every other prompt', () => {
    const { getByText } = render(
      createElement(SelectionPrompt, {
        message:
          'World Breaker (81) - When you cast this spell, exile target artifact, enchantment, or land.\n\nSelect target artifact, enchantment or land',
        cards: [BOARD_CARD],
        lookup: fixtureLookup(),
        picked: new Set<number>(),
        onPick: () => {},
      }),
    );
    expect(getByText('World Breaker (81)')).toBeDefined();
    expect(getByText('When you cast this spell, exile target artifact, enchantment, or land.')).toBeDefined();
    expect(getByText('Select target artifact, enchantment or land')).toBeDefined();
  });

  it('a card the lookup knows nothing about still draws, named by its id, never invented text', () => {
    const { getAllByText } = render(
      createElement(SelectionPrompt, {
        message: 'Select a card',
        cards: [12345],
        lookup: EMPTY_LOOKUP,
        picked: new Set<number>(),
        onPick: () => {},
      }),
    );
    expect(getAllByText('card #12345')).toHaveLength(1);
  });

  it('clicking a tile calls onPick with its id — a selection click answers immediately, it does not stage', () => {
    const picks: number[] = [];
    const { getAllByTestId } = render(
      createElement(SelectionPrompt, {
        message: 'Select target Zombie creature card',
        cards: [GRAVEYARD_CARD],
        lookup: fixtureLookup(),
        picked: new Set<number>(),
        onPick: (id) => picks.push(id),
      }),
    );
    fireEvent.click(getAllByTestId('prompt-choice')[0]!);
    expect(picks).toEqual([GRAVEYARD_CARD]);
  });

  it('a picked card reads checked, from `picked` alone — a redraw never loses what Forge already has', () => {
    const { getAllByTestId } = render(
      createElement(SelectionPrompt, {
        message: 'Select target Zombie creature card',
        cards: [GRAVEYARD_CARD],
        lookup: fixtureLookup(),
        picked: new Set([GRAVEYARD_CARD]),
        onPick: () => {},
      }),
    );
    expect((getAllByTestId('prompt-choice')[0] as HTMLInputElement).checked).toBe(true);
  });

  it('draws Cancel and Done only when the caller supplied them — Forge’s own bar, never invented buttons', () => {
    const { queryByTestId, rerender } = render(
      createElement(SelectionPrompt, {
        message: 'Select target Zombie creature card',
        cards: [GRAVEYARD_CARD],
        lookup: fixtureLookup(),
        picked: new Set<number>(),
        onPick: () => {},
      }),
    );
    expect(queryByTestId('selection-cancel')).toBeNull();
    expect(queryByTestId('selection-done')).toBeNull();

    let cancelled = false;
    let done = false;
    rerender(
      createElement(SelectionPrompt, {
        message: 'Select target Zombie creature card',
        cards: [GRAVEYARD_CARD],
        lookup: fixtureLookup(),
        picked: new Set<number>(),
        onPick: () => {},
        cancel: { label: 'Cancel', enabled: true, onClick: () => (cancelled = true) },
        done: { label: 'Done', enabled: false, onClick: () => (done = true) },
      }),
    );
    const cancelBtn = queryByTestId('selection-cancel') as HTMLButtonElement;
    const doneBtn = queryByTestId('selection-done') as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    expect(doneBtn).not.toBeNull();
    expect(doneBtn.disabled).toBe(true);
    fireEvent.click(cancelBtn);
    expect(cancelled).toBe(true);
    expect(done).toBe(false);
  });
});
