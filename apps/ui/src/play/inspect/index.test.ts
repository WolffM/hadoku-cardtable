// @vitest-environment jsdom
/**
 * The inspector, driven the way a player drives it: real pointer events on a
 * real rendered board. Every claim here is behavioural — open, dismiss,
 * swallow, touch nothing — because jsdom zeroes every box; the geometry
 * ("never the hand", "stays in the board") is `place.test.ts`, on real
 * numbers.
 *
 * The view is built by hand, not folded from the committed fixture, on
 * purpose: these tests are about the inspector's behaviour over the DOM
 * contract, and a name like "Their Card" says which seat sent what. The
 * fixture proves the adapter (`../Board.test.ts`); the adapter is not under
 * test here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import { cardImageUrl } from '../../draft/cardImage.ts';
import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import { Board, type BoardInteraction } from '../Board.tsx';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, mountInspector } from './index.ts';

/** Uuid-shaped, so the art resolver accepts it; nothing is fetched in jsdom. */
const SCRYFALL_ID = '00000000-0000-4000-8000-000000000001';

function card(id: number, name: string): BoardCard {
  return {
    id,
    card: {
      cardId: `w${id}`,
      name,
      manaCost: ['3', 'R', 'R'],
      manaValue: 5,
      colors: ['R'],
      typeLine: 'Creature — Goblin',
      oracleText: 'Haste',
      setCode: 'MRD',
      collectorNumber: '',
      rarity: 'rare',
      scryfallId: SCRYFALL_ID,
      power: '2',
      toughness: '2',
    },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
  };
}

const YOU: BoardPlayer = {
  id: 0,
  name: 'You',
  life: 20,
  isViewer: true,
  isActive: false,
  hasPriority: true,
  hasLost: false,
  hand: [card(1, 'Your Hand Card')],
  handCount: 1,
  libraryCount: 30,
  battlefield: [card(2, 'Your Board Card')],
  graveyard: [],
  exile: [],
};

const THEM: BoardPlayer = {
  id: 1,
  name: 'Them',
  life: 20,
  isViewer: false,
  isActive: true,
  hasPriority: false,
  hasLost: false,
  // An opponent's hand is a count, never cards — the inspector must find
  // nothing to enlarge there.
  hand: null,
  handCount: 4,
  libraryCount: 30,
  battlefield: [card(3, 'Their Card')],
  graveyard: [],
  exile: [],
};

const VIEW: BoardView = {
  seq: 1,
  title: 'inspector test',
  turn: 3,
  phase: 'MAIN1',
  phaseLabel: 'Main 1',
  activePlayerId: 1,
  players: [YOU, THEM],
  stack: [
    {
      id: 9,
      description: 'Their Card deals 2 damage to any target.',
      sourceCardId: 3,
      sourceName: 'Their Card',
      sourceCard: card(3, 'Their Card').card,
      controllerName: 'Them',
      isAbility: false,
    },
  ],
  gameOver: false,
  missingCardIds: [],
};

/** Every mounted inspector, disposed per test — the listeners are on the document. */
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  cleanup();
  vi.useRealTimers();
});

function mountBoard(interaction?: BoardInteraction) {
  const utils = render(createElement(Board, interaction === undefined ? { view: VIEW } : { view: VIEW, interaction }));
  const board = utils.container.querySelector<HTMLElement>('.board')!;
  disposers.push(mountInspector(board));
  return {
    ...utils,
    board,
    panel: () => board.querySelector<HTMLElement>('[data-inspect]'),
    theirCard: () => board.querySelector<HTMLElement>('[data-card-id="3"]')!,
    yourHandCard: () => board.querySelector<HTMLElement>('[data-card-id="1"]')!,
    stackItem: () => board.querySelector<HTMLElement>('[data-stack-id="9"]')!,
    cardBack: () => board.querySelector<HTMLElement>('[data-card-back]')!,
  };
}

function hover(el: Element): void {
  fireEvent.pointerOver(el, { pointerType: 'mouse' });
}

function longPress(el: Element): void {
  vi.useFakeTimers();
  fireEvent.pointerDown(el, { pointerType: 'touch', clientX: 40, clientY: 40 });
  vi.advanceTimersByTime(LONG_PRESS_MS);
}

function interaction(offered: number[], onSelectCard: () => void): BoardInteraction {
  return {
    selectable: new Set(offered),
    selectablePlayers: new Set<number>(),
    onSelectCard,
    onSelectPlayer: vi.fn(),
  };
}

/* ── opening ─────────────────────────────────────────────────────────── */

describe('opening', () => {
  it('opens for a battlefield card', () => {
    const { panel, theirCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    const shown = panel();
    expect(shown).not.toBeNull();
    expect(shown!.querySelector('.card__name')!.textContent).toBe('Their Card');
  });

  it('opens for a stack item, found by data-source-card', () => {
    const { panel, stackItem } = mountBoard();
    // The item's text carries no card id of its own — only the `<li>`'s
    // `data-source-card` names the card to enlarge.
    hover(stackItem().querySelector('.stack__what')!);
    expect(panel()!.querySelector('.card__name')!.textContent).toBe('Their Card');
  });

  it('opens for a prompt-grid tile outside the board root', () => {
    const { panel } = mountBoard();
    // Lane C's grid, as the contract describes it: a tile carrying
    // `data-card-id` (the board's numeric namespace) around a `CardTile`,
    // rendered outside the board root entirely.
    const grid = document.createElement('div');
    grid.innerHTML =
      '<ul><li data-card-id="77"><article class="card" data-card-id="w77"><span class="card__name">Grid Card</span></article></li></ul>';
    document.body.appendChild(grid);
    try {
      hover(grid.querySelector('li')!);
      const shown = panel();
      expect(shown).not.toBeNull();
      expect(shown!.querySelector('.card__name')!.textContent).toBe('Grid Card');
    } finally {
      grid.remove();
    }
  });

  it('stays one panel while the pointer moves within the same card', () => {
    const { panel, theirCard } = mountBoard();
    const li = theirCard();
    hover(li.querySelector('.card')!);
    const first = panel()!;
    hover(li);
    expect(theirCard().ownerDocument.querySelectorAll('[data-inspect]')).toHaveLength(1);
    expect(panel()).toBe(first);
  });
});

/* ── what it is allowed to show ──────────────────────────────────────── */

describe('hidden information', () => {
  it('does not open for an opponent’s hidden hand — no face was ever sent', () => {
    const { panel, cardBack } = mountBoard();
    hover(cardBack());
    expect(panel()).toBeNull();
  });

  it('enlarges exactly the tile the seat was sent — the art is the resolver’s own URL', () => {
    const { panel, theirCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    const src = panel()!.querySelector('img')!.getAttribute('src');
    expect(src).toBe(cardImageUrl(SCRYFALL_ID));
    expect(ALLOWED_ART_HOSTS).toContain(new URL(src!).origin);
  });

  it('is not itself a card the DOM can address', () => {
    const { panel, theirCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    const clone = panel()!.querySelector('.card')!;
    expect(clone.getAttribute('data-card-id')).toBeNull();
    expect(clone.getAttribute('data-testid')).toBeNull();
  });
});

/* ── dismissing ──────────────────────────────────────────────────────── */

describe('dismissing', () => {
  it('Escape closes it', () => {
    const { panel, theirCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).toBeNull();
  });

  it('moving the pointer onto anything that is not a card closes it', () => {
    const { panel, board, theirCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    expect(panel()).not.toBeNull();
    hover(board.querySelector('.seat__counts')!);
    expect(panel()).toBeNull();
  });
});

/* ── touch: long-press, and only long-press ──────────────────────────── */

describe('touch', () => {
  it('a long press opens it', () => {
    const { panel, theirCard } = mountBoard();
    longPress(theirCard().querySelector('.card')!);
    expect(panel()!.querySelector('.card__name')!.textContent).toBe('Their Card');
  });

  it('movement past the slop cancels the press', () => {
    const { panel, theirCard } = mountBoard();
    vi.useFakeTimers();
    fireEvent.pointerDown(theirCard().querySelector('.card')!, { pointerType: 'touch', clientX: 40, clientY: 40 });
    fireEvent.pointerMove(theirCard(), {
      pointerType: 'touch',
      clientX: 40 + LONG_PRESS_SLOP_PX,
      clientY: 40,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(panel()).toBeNull();
  });

  it('the click that ends a long-press does not select the card', () => {
    const select = vi.fn();
    const { panel, yourHandCard } = mountBoard(interaction([1], select));
    longPress(yourHandCard().querySelector('button')!);
    expect(panel()).not.toBeNull();
    fireEvent.click(yourHandCard().querySelector('button')!);
    expect(select).not.toHaveBeenCalled();
  });

  it('an ordinary click still reaches the game', () => {
    const select = vi.fn();
    const { yourHandCard } = mountBoard(interaction([1], select));
    vi.useFakeTimers();
    fireEvent.pointerDown(yourHandCard().querySelector('button')!, { pointerType: 'touch', clientX: 40, clientY: 40 });
    // Released well before the long-press: this is a tap, and a tap is the game's.
    fireEvent.pointerUp(yourHandCard().querySelector('button')!, { pointerType: 'touch' });
    fireEvent.click(yourHandCard().querySelector('button')!);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('a tap elsewhere closes a long-pressed preview', () => {
    const { panel, board, theirCard } = mountBoard();
    longPress(theirCard().querySelector('.card')!);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(board.querySelector('.seat__counts')!, { pointerType: 'touch' });
    expect(panel()).toBeNull();
  });

  it('a second press on the card it enlarged toggles it off', () => {
    const { panel, theirCard } = mountBoard();
    longPress(theirCard().querySelector('.card')!);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(theirCard().querySelector('.card')!, { pointerType: 'touch', clientX: 40, clientY: 40 });
    expect(panel()).toBeNull();
  });
});

/* ── the canvas and the mount contract ───────────────────────────────── */

describe('the canvas', () => {
  /** The board's markup with the overlay emptied — what the canvas IS, minus whatever a lane drew into the overlay. */
  function withoutOverlay(board: HTMLElement): string {
    const copy = board.cloneNode(true) as HTMLElement;
    copy.querySelector('[data-board-overlay]')?.replaceChildren();
    return copy.outerHTML;
  }

  it('changes nothing outside the overlay root', () => {
    const { board, theirCard, panel } = mountBoard();
    const before = withoutOverlay(board);
    hover(theirCard().querySelector('.card')!);
    expect(withoutOverlay(board)).toBe(before);
    expect(panel()!.closest('[data-board-overlay]')).not.toBeNull();
  });

  it('dispose stops it entirely', () => {
    const { board, panel, theirCard } = mountBoard();
    const dispose = mountInspector(board);
    dispose();
    hover(theirCard().querySelector('.card')!);
    expect(panel()).toBeNull();
  });
});

/*
 * Wave 31 P12 — a name outside the board (the log's) points at cards with
 * `data-inspect-ids`, and the inspector enlarges the tile the board ALREADY
 * drew: the same panel, no second surface.
 */
describe('a card name elsewhere on the page (the log)', () => {
  function named(ids: string) {
    const utils = mountBoard();
    const name = document.createElement('span');
    name.setAttribute('data-inspect-ids', ids);
    name.tabIndex = 0;
    name.textContent = 'Their Card';
    utils.container.appendChild(name);
    return { ...utils, name };
  }

  it('hovering it opens the board’s own preview of the first id that has a tile', () => {
    const { name, panel } = named('404,3');
    hover(name);
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('.card__name')!.textContent).toBe('Their Card');
  });

  it('leaving it closes the preview', () => {
    const { name, panel } = named('3');
    hover(name);
    fireEvent.pointerOut(name, { pointerType: 'mouse', relatedTarget: document.body });
    expect(panel()).toBeNull();
  });

  it('focusing it opens the same preview and blurring closes it — the keyboard gets what the pointer gets', () => {
    const { name, panel } = named('3');
    fireEvent.focusIn(name);
    expect(panel()).not.toBeNull();
    fireEvent.focusOut(name);
    expect(panel()).toBeNull();
  });

  it('a name whose cards have no tile on the page shows nothing', () => {
    const { name, panel } = named('404,505');
    hover(name);
    expect(panel()).toBeNull();
    fireEvent.focusIn(name);
    expect(panel()).toBeNull();
  });

  it('a name INSIDE a board card whose ids have no tile shows nothing — the card around it is not the answer', () => {
    const { theirCard, panel } = mountBoard();
    const name = document.createElement('span');
    name.setAttribute('data-inspect-ids', '404');
    theirCard().appendChild(name);
    hover(name);
    expect(panel()).toBeNull();
  });
});

/** Wave 32 Q16 (G's half): the preview is a popover, above card labels and the rail. */
describe('Q16 — the inspector sits at the popover layer', () => {
  it('writes z-index: var(--z-popover, 40) on the panel, with the number as the fallback', () => {
    const css = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/inspect', 'inspect.css'), 'utf8');
    expect(css).toMatch(/\n\.inspect \{[^}]*z-index: var\(--z-popover, 40\);/);
  });
});
