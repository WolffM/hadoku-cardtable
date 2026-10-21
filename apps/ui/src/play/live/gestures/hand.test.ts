// @vitest-environment jsdom
/*
 * `./hand.ts`'s own geometry, sizing, indicator and commit — in isolation
 * from `install.ts`'s state machine (that seam is proven end to end by
 * `gestures.test.ts`'s own hand-press cases and `e2e/drag.spec.ts`).
 * jsdom lays nothing out, so every box here is a stubbed
 * `getBoundingClientRect`, the same technique `presence.test.ts` and
 * `Board.test.ts`'s own drag suite already use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as BoardModule from '../../Board.tsx';
import * as presenceModule from '../presence.ts';
import {
  clearHandIndicator,
  closeHandGap,
  commitHandReorder,
  HAND_FLIP_ATTR,
  HAND_GAP_ATTR,
  handCardPress,
  handOrderIds,
  openHandGap,
  updateHandIndicator,
} from './hand.ts';

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect =>
  ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

function stubBox(el: Element, b: Box): void {
  (el as HTMLElement).getBoundingClientRect = () => rect(b);
}

/** A board with the viewer's own hand (`n` cards, 70px apart) and battlefield, a theirs-hand too. */
function board(n = 4): { canvas: HTMLElement; cards: HTMLElement[] } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-zone="battlefield" data-owner="you"></div>
      <div data-zone="hand" data-owner="them"><ul><li class="board-card" data-card-id="999"></li></ul></div>
      <div data-zone="hand" data-owner="you"><ul class="zone__cards"></ul></div>
    </div>`;
  document.body.append(canvas);
  const list = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] ul.zone__cards')!;
  const cards: HTMLElement[] = [];
  for (let i = 0; i < n; i += 1) {
    const li = document.createElement('li');
    li.className = 'board-card';
    li.dataset.cardId = String(100 + i);
    li.dataset.boardCard = String(100 + i);
    li.innerHTML = '<button class="board-card__face"></button>';
    stubBox(li, { left: i * 70, top: 500, width: 60, height: 84 });
    list.append(li);
    cards.push(li);
  }
  return { canvas, cards };
}

afterEach(() => {
  document.body.innerHTML = '';
  clearHandIndicator();
  closeHandGap();
  vi.restoreAllMocks();
});

describe('openHandGap — the slot a picked-up card leaves stays open', () => {
  it('holds the slot with an empty li no hand reader counts, until the card is neither lifted nor floating home', async () => {
    const { canvas, cards } = board(4);
    cards[1]!.setAttribute('data-cast-lift', 'lifted');
    openHandGap(cards[1]!);
    const gap = cards[1]!.previousElementSibling as HTMLElement;
    expect(gap.hasAttribute(HAND_GAP_ATTR), 'right where the card was').toBe(true);
    expect(gap.style.height).toBe('84px');
    expect(handOrderIds(canvas), 'never counted as a card').toEqual([100, 101, 102, 103]);
    cards[1]!.setAttribute('data-cast-lift', 'returning');
    await Promise.resolve();
    expect(gap.isConnected, 'still open while it floats home into it').toBe(true);
    cards[1]!.setAttribute('data-cast-lift', 'parked');
    await Promise.resolve();
    expect(gap.isConnected, 'closed once it is cast').toBe(false);
  });

  it('closes when the lift comes off, and a second lift moves it rather than leaving two', async () => {
    const { canvas, cards } = board(4);
    cards[0]!.setAttribute('data-cast-lift', 'lifted');
    openHandGap(cards[0]!);
    cards[2]!.setAttribute('data-cast-lift', 'lifted');
    openHandGap(cards[2]!);
    expect(canvas.querySelectorAll(`[${HAND_GAP_ATTR}]`)).toHaveLength(1);
    expect(cards[2]!.previousElementSibling!.hasAttribute(HAND_GAP_ATTR)).toBe(true);
    cards[2]!.removeAttribute('data-cast-lift');
    await Promise.resolve();
    expect(canvas.querySelectorAll(`[${HAND_GAP_ATTR}]`)).toHaveLength(0);
  });
});

describe('handCardPress', () => {
  it('finds the viewer’s own hand card under a press — never the other seat’s hand, never the battlefield, never null', () => {
    const { canvas, cards } = board();
    expect(handCardPress(cards[1]!.querySelector('button'))).toEqual({ id: 101, li: cards[1] });
    expect(handCardPress(canvas.querySelector('[data-zone="battlefield"]'))).toBeNull();
    expect(handCardPress(canvas.querySelector('[data-zone="hand"][data-owner="them"] li'))).toBeNull();
    expect(handCardPress(null)).toBeNull();
  });
});

describe('handOrderIds', () => {
  it('reads the hand’s DOM order — the same order handOrder just rendered', () => {
    const { canvas } = board(3);
    expect(handOrderIds(canvas)).toEqual([100, 101, 102]);
  });

  it('is empty off a board with no hand drawn at all', () => {
    expect(handOrderIds(document.createElement('div'))).toEqual([]);
  });
});

describe('updateHandIndicator / clearHandIndicator — the row’s own data-arrange-target/indicator, reused', () => {
  it('marks the sibling in front of the pointer and draws a bar at its left edge', () => {
    const { canvas, cards } = board(3);
    updateHandIndicator(canvas, 101, { x: 5, y: 540 }); // left of card 100 (box 0..60)
    expect(cards[0]!.getAttribute('data-arrange-target'), 'the same mark the battlefield’s own rearrange draws').toBe('before');
    const bar = canvas.querySelector<HTMLElement>('[data-arrange-indicator]');
    expect(bar).not.toBeNull();
    expect(bar!.dataset.arrangeSlot).toBe('hand');
    clearHandIndicator();
    expect(cards[0]!.hasAttribute('data-arrange-target')).toBe(false);
    expect(canvas.querySelector('[data-arrange-indicator]')).toBeNull();
  });

  it('marks the last sibling "end" past every one of them', () => {
    const { cards, canvas } = board(3);
    updateHandIndicator(canvas, 100, { x: 500, y: 540 });
    expect(cards.at(-1)!.getAttribute('data-arrange-target')).toBe('end');
  });

  it('a second call replaces the mark rather than leaving both', () => {
    const { canvas, cards } = board(3);
    updateHandIndicator(canvas, 102, { x: 5, y: 540 });
    const bar = canvas.querySelector('[data-arrange-indicator]');
    updateHandIndicator(canvas, 102, { x: 500, y: 540 });
    expect(cards[0]!.hasAttribute('data-arrange-target'), 'the old mark is gone').toBe(false);
    expect(canvas.querySelectorAll('[data-arrange-indicator]')).toHaveLength(1);
    expect(canvas.querySelector('[data-arrange-indicator]'), 'the same bar, moved: never taken out of the board and put back').toBe(bar);
  });
});

describe('commitHandReorder — never Forge, always Board.tsx and presence.ts', () => {
  it('writes the order without the dragged card and the target it landed on, and queues the two indices', () => {
    const { canvas } = board(3);
    const commit = vi.spyOn(BoardModule, 'commitHandMove').mockImplementation(() => {});
    const queue = vi.spyOn(presenceModule, 'queueHandMove').mockImplementation(() => {});
    // Card 102 (hand index 2), dropped in front of card 100 (index 0).
    commitHandReorder(canvas, 102, 2, { x: 5, y: 540 });
    expect(commit).toHaveBeenCalledWith([100, 101], 102, { kind: 'before', id: 100 });
    expect(queue, 'indices only, never a card id or name').toHaveBeenCalledWith(2, 0);
  });

  /** Mutation: drop `queueHandMove`’s guard → this case fails, sending a no-op move. */
  it('a same-spot release commits (idempotent) but queues nothing — nothing actually moved', () => {
    const { canvas } = board(3);
    const commit = vi.spyOn(BoardModule, 'commitHandMove').mockImplementation(() => {});
    const queue = vi.spyOn(presenceModule, 'queueHandMove').mockImplementation(() => {});
    commitHandReorder(canvas, 100, 0, { x: 5, y: 540 });
    expect(commit).toHaveBeenCalled();
    expect(queue, 'from === to: never sent').not.toHaveBeenCalled();
  });

  /**
   * Mutation: drop the FLIP (comment out `flipHand`'s call in
   * `commitHandReorder`) and only THIS case fails — the reorder still
   * commits and queues correctly either way; only the motion is gone.
   */
  it('FLIPs every hand card whose box moved, the dragged one included: no transition first, then one', async () => {
    vi.spyOn(BoardModule, 'commitHandMove').mockImplementation(() => {});
    vi.spyOn(presenceModule, 'queueHandMove').mockImplementation(() => {});
    const { canvas, cards } = board(3);
    commitHandReorder(canvas, 102, 2, { x: 5, y: 540 }); // captures the ORIGINAL boxes as "before", synchronously
    // `Board.tsx`'s own re-render moved card 102 to the front — simulate the
    // new layout landing before this module's own `requestAnimationFrame` reads it.
    stubBox(cards[2]!, { left: 0, top: 500, width: 60, height: 84 });
    stubBox(cards[0]!, { left: 70, top: 500, width: 60, height: 84 });
    stubBox(cards[1]!, { left: 140, top: 500, width: 60, height: 84 });
    await new Promise((r) => requestAnimationFrame(r));
    for (const li of cards) {
      expect(li.getAttribute(HAND_FLIP_ATTR), `card ${li.dataset.cardId} is mid-FLIP`).toBe('');
      expect(li.style.transform, 'the inverse offset, before the transition swaps in').not.toBe('');
      expect(li.style.transition).toBe('none');
    }
    await new Promise((r) => requestAnimationFrame(r));
    for (const li of cards) {
      expect(li.style.transition, 'the house-curve transition now runs').toContain('cubic-bezier');
      expect(li.style.transform, 'cleared — the transition carries it the rest of the way').toBe('');
    }
  });

  it('a hand with nobody left to flip against (no board at all) just clears the indicator and returns', () => {
    const commit = vi.spyOn(BoardModule, 'commitHandMove').mockImplementation(() => {});
    const bare = document.createElement('div');
    expect(() => commitHandReorder(bare, 100, 0, { x: 0, y: 0 })).not.toThrow();
    expect(commit).not.toHaveBeenCalled();
  });
});
