// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { Board, forgetArrangements, onOwnArrangement, type BoardLayout } from '../Board.tsx';
import type { BoardCard, BoardView } from '../adapter.ts';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { CARD_LONG_PRESS } from '../inspect/index.ts';

afterEach(() => {
  cleanup();
  forgetArrangements();
  globalThis.sessionStorage?.clear();
});

const base = boardFromFixture(PLAY_FIXTURES[0]!);
const me = base.players.find((p) => p.isViewer)!;
const seed = me.battlefield.find((c) => c.id === 8)!;
const token = (id: number, name: string, over: Partial<BoardCard> = {}): BoardCard => ({
  ...seed,
  id,
  card: { ...seed.card, name, power: '1', toughness: '1' },
  token: true,
  tapped: false,
  summoningSick: false,
  counters: [],
  keywords: [],
  abilityText: null,
  attachedCardIds: [],
  attachedToId: null,
  ...over,
});
/** Four untapped Soldiers and two tapped, a Soldier with a counter, a Goblin, and the fixture's own first card. */
const SOLDIERS = [901, 902, 904, 905];
const TAPPED = [903, 908];
const view: BoardView = {
  ...base,
  players: base.players.map((p) =>
    !p.isViewer
      ? p
      : {
          ...p,
          battlefield: [
            ...[...SOLDIERS, ...TAPPED].sort().map((id) => token(id, 'Soldier', { tapped: TAPPED.includes(id) })),
            token(906, 'Soldier', { counters: [{ name: 'P1P1', count: 1 }] }),
            token(907, 'Goblin'),
            { ...seed, token: false },
          ],
        },
  ),
};

function renderBoard(layout: BoardLayout = 'single') {
  const utils = render(createElement(Board, { view, boardLayout: layout }));
  const card = (id: number) => utils.container.querySelector<HTMLElement>(`.seat[data-viewer] li.board-card[data-card-id="${id}"]`)!;
  const menu = () => utils.container.querySelector<HTMLElement>('[role="menu"]');
  const items = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  /** A right-click: the `contextmenu` a browser fires, bubbling to the document; true when it was prevented. */
  const rightClick = (id: number): boolean => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
    act(() => {
      card(id).dispatchEvent(ev);
    });
    return ev.defaultPrevented;
  };
  const pileOf = (id: number): number[] => {
    // The pile's base: the outermost card around this one, in either layout's markup.
    let base = card(id);
    for (let up = base.parentElement?.closest<HTMLElement>('li.board-card'); up; up = up.parentElement?.closest<HTMLElement>('li.board-card')) base = up;
    return [Number(base.dataset.cardId), ...[...base.querySelectorAll<HTMLElement>(':scope > ul li.board-card')].map((m) => Number(m.dataset.cardId))];
  };
  return { ...utils, card, menu, items, rightClick, pileOf };
}

describe('the board’s card menu', () => {
  it('a right-click on a token with twins opens it, the first action focused, and the browser’s menu stays shut', () => {
    const b = renderBoard();
    // A browser will not focus what is still `visibility: hidden` (the menu before it is placed).
    const shownAtFocus: string[] = [];
    const onFocus = (e: FocusEvent) => shownAtFocus.push((e.target as HTMLElement).closest<HTMLElement>('[role="menu"]')?.style.visibility ?? '');
    document.addEventListener('focusin', onFocus);
    try {
      expect(b.rightClick(902)).toBe(true);
    } finally {
      document.removeEventListener('focusin', onFocus);
    }
    expect(b.menu()).not.toBeNull();
    expect(b.items().map((i) => i.textContent)).toEqual(['Stack all of the same tokens']);
    expect(document.activeElement).toBe(b.items()[0]);
    expect(shownAtFocus, 'focused once placed, never while hidden').toEqual(['']);
  });

  it('opens nothing on a card with nothing to offer, and leaves that right-click alone', () => {
    const b = renderBoard();
    for (const id of [906, 907, 8]) {
      expect(b.rightClick(id), `card ${id}`).toBe(false);
      expect(b.menu(), `card ${id}`).toBeNull();
    }
  });

  it('never opens on the other seat’s cards', () => {
    const b = renderBoard();
    const theirs = b.container.querySelector<HTMLElement>('.seat:not([data-viewer]) li.board-card')!;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      theirs.dispatchEvent(ev);
    });
    expect(b.menu()).toBeNull();
  });

  it('Escape closes it, and so does a press outside it', () => {
    const b = renderBoard();
    b.rightClick(902);
    fireEvent.keyDown(b.items()[0]!, { key: 'Escape' });
    expect(b.menu()).toBeNull();
    b.rightClick(902);
    fireEvent.pointerDown(b.card(907));
    expect(b.menu()).toBeNull();
  });

  it('the arrow keys move between items and wrap', () => {
    const b = renderBoard();
    b.rightClick(902);
    const [first] = b.items();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'End' });
    expect(document.activeElement).toBe(first);
  });

  it.each<BoardLayout>(['single', 'type-separated'])('"Stack all of the same tokens": the untapped into one pile, the tapped into another; the other screen is told, and it closes (%s)', (layout) => {
    const b = renderBoard(layout);
    const sent: number[][][] = [];
    const stop = onOwnArrangement(({ rows }) => sent.push(Object.values(rows).flat().map((p) => [...p])));
    try {
      b.rightClick(904);
      act(() => {
        b.items()[0]!.click();
      });
    } finally {
      stop();
    }
    expect(b.menu()).toBeNull();
    expect(b.pileOf(904).sort()).toEqual([...SOLDIERS].sort());
    expect(b.pileOf(908).sort()).toEqual([...TAPPED].sort());
    expect(b.pileOf(906)).toEqual([906]);
    expect(b.pileOf(907)).toEqual([907]);
    const piles = sent.at(-1)!.filter((p) => p.length > 0);
    expect(piles.find((p) => p.includes(904))!.sort()).toEqual([...SOLDIERS].sort());
    expect(piles.find((p) => p.includes(903))!.sort()).toEqual([...TAPPED].sort());
    // Nothing left to stack: no menu.
    expect(b.rightClick(901)).toBe(false);
    expect(b.menu()).toBeNull();
  });

  it('a touch long-press on a card (the inspector’s own) opens it too', () => {
    const b = renderBoard();
    act(() => {
      b.card(901).dispatchEvent(new CustomEvent(CARD_LONG_PRESS, { bubbles: true, detail: { x: 30, y: 30 } }));
    });
    expect(b.items().map((i) => i.textContent)).toEqual(['Stack all of the same tokens']);
  });
});
