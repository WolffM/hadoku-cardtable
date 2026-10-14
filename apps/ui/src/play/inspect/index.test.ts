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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import { cardImageUrl } from '../../draft/cardImage.ts';
import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import { Board, type BoardInteraction } from '../Board.tsx';
import { LONG_PRESS_MS, mountInspector } from './index.ts';
import { DRAG_SLOP_PX } from '../live/gestures/types.ts';

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

function mountBoard(interaction?: BoardInteraction, view: BoardView = VIEW) {
  const utils = render(createElement(Board, interaction === undefined ? { view } : { view, interaction }));
  const board = utils.container.querySelector<HTMLElement>('.board')!;
  disposers.push(mountInspector(board));
  return {
    ...utils,
    board,
    panel: () => board.querySelector<HTMLElement>('[data-inspect]'),
    theirCard: () => board.querySelector<HTMLElement>('[data-card-id="3"]')!,
    myHandCard: () => board.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] li[data-card-id]')!,
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

  it('opens for a stack thumbnail — the one expanded view the board has (the stack redesign, 2026-10-06)', () => {
    const { panel, stackItem } = mountBoard();
    // Wave 46 X3 had the stack opt out of this module in favour of a big view
    // of its own below the row. The operator wants exactly one expanded view,
    // so that view is gone and a thumbnail's tile is read like every other.
    hover(stackItem().querySelector('.card')!);
    const shown = panel();
    expect(shown).not.toBeNull();
    expect(shown!.querySelector('.card__name')!.textContent).toBe('Their Card');
  });

  it('opens for an ability chip on the stack: the chip itself, its whole text, enlarged (the operator, 2026-10-10)', () => {
    const text = 'Annihilator 6 (Whenever this creature attacks, defending player sacrifices six permanents.)';
    const ability = { id: 10, description: `Their Card - ${text}`, sourceCardId: 3, sourceName: 'Their Card', sourceCard: card(3, 'Their Card').card, controllerName: 'Them', isAbility: true };
    const { panel, board } = mountBoard(undefined, { ...VIEW, stack: [ability, ...VIEW.stack] });
    const chip = board.querySelector<HTMLElement>('[data-stack-id="10"] [data-ability-chip]')!;
    hover(chip.querySelector('.placed__chip-text')!);
    const shown = panel();
    expect(shown, 'hovering the chip opens the one expanded view').not.toBeNull();
    expect(shown!.querySelector('[data-ability-chip] .placed__chip-text')!.textContent).toContain('defending player sacrifices six permanents');
    fireEvent.pointerDown(chip, { pointerType: 'mouse' });
    expect(panel(), 'a press on the chip puts it away, like a card').toBeNull();
    hover(chip);
    expect(panel(), 'and it stays away until the pointer has left the chip').toBeNull();
  });

  it('while a decision window is open, ANY hovered card enlarges beside the window, never over it', () => {
    // The operator, 2026-10-06: "if theres a decision window up … then the
    // expanded view needs to stack to the left of that decision window."
    const { panel, board, theirCard } = mountBoard();
    const live = document.createElement('div');
    live.className = 'live';
    live.innerHTML = '<div class="live__prompt" data-testid="live-decision-host"><p>Sacrifice a land</p></div>';
    document.body.appendChild(live);
    try {
      hover(theirCard().querySelector('.card')!);
      const shown = document.querySelector<HTMLElement>('[data-inspect]');
      expect(shown, 'the board card still enlarges').not.toBeNull();
      expect(shown!.parentElement, 'in the zoom layer, above the window').toBe(board.querySelector('[data-board-zoom]'));
      expect(panel(), 'the one panel').toBe(shown);
      expect(shown!.querySelector('.card__name')!.textContent).toBe('Their Card');
    } finally {
      live.remove();
    }
  });

  it('beside a decision window, the panel also clears the hovered card itself — real rects, not jsdom zeros', () => {
    // The operator, 2026-10-08: hovering Serum Visions with a decision open
    // blocked the card itself. jsdom zeroes every box by default
    // (`place.test.ts`'s own header), so the geometry claim needs rects
    // stubbed in: the hovered card sits exactly where the previous function
    // would have put the panel (left of the pop-up, blind to the card),
    // which only the fix's hover-awareness steers around.
    const { board, theirCard } = mountBoard();
    const live = document.createElement('div');
    live.className = 'live';
    live.innerHTML = '<div class="live__prompt" data-testid="live-decision-host"><p>Sacrifice a land</p></div>';
    document.body.appendChild(live);
    const cardEl = theirCard().querySelector('.card')!;
    const modalEl = live.querySelector('.live__prompt')!;
    const rect = (box: { left: number; top: number; right: number; bottom: number }): DOMRect =>
      ({ ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON() {} }) as DOMRect;
    board.querySelector<HTMLElement>('[data-board-zoom]')!.getBoundingClientRect = () => rect({ left: 0, top: 0, right: 1200, bottom: 800 });
    modalEl.getBoundingClientRect = () => rect({ left: 600, top: 200, right: 900, bottom: 500 });
    cardEl.getBoundingClientRect = () => rect({ left: 340, top: 250, right: 580, bottom: 380 });
    try {
      hover(cardEl);
      const shown = document.querySelector<HTMLElement>('[data-inspect]');
      expect(shown, 'the board card still enlarges').not.toBeNull();
      expect(shown!.parentElement).toBe(board.querySelector('[data-board-zoom]'));
      // `place.test.ts`'s own "card under the pop-up's left edge" case: the
      // panel is pushed to the pop-up's RIGHT instead of its (blocked) left.
      expect(shown!.style.left).toBe('908px');
      expect(shown!.style.top).toBe('250px');
      expect(parseFloat(shown!.style.width)).toBeCloseTo(1200 - 8 - 908, 6);
    } finally {
      live.remove();
    }
  });

  it('a card in an open pile view enlarges beside the view, never over the cards it lists — the run\'s real rects', () => {
    // Run 38007401024 at 1280×800: alice's 31-card pile view at 125,357 (604×435), Think Twice in it
    // 68×95. The inspector anchored to the card's right, over the view's middle cards.
    const { board } = mountBoard();
    const overlay = board.querySelector<HTMLElement>('[data-board-overlay]')!;
    const view = document.createElement('section');
    view.setAttribute('data-testid', 'pile-view');
    view.innerHTML = '<ul><li data-card-id="143"><article class="card" data-card-id="w143"><span class="card__name">Think Twice</span></article></li></ul>';
    overlay.appendChild(view);
    const rect = (box: { left: number; top: number; right: number; bottom: number }): DOMRect =>
      ({ ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON() {} }) as DOMRect;
    board.querySelector<HTMLElement>('[data-board-zoom]')!.getBoundingClientRect = () => rect({ left: 0, top: 0, right: 1200, bottom: 800 });
    view.getBoundingClientRect = () => rect({ left: 125, top: 357, right: 729, bottom: 792 });
    const cardEl = view.querySelector('.card')!;
    cardEl.getBoundingClientRect = () => rect({ left: 300, top: 400, right: 368, bottom: 495 });
    hover(cardEl);
    const shown = document.querySelector<HTMLElement>('[data-inspect]');
    expect(shown, 'the pile card enlarges').not.toBeNull();
    expect(shown!.parentElement, 'in the zoom layer, beside the view').toBe(board.querySelector('[data-board-zoom]'));
    expect(shown!.querySelector('.card__name')!.textContent).toBe('Think Twice');
    // The view's left has no room (125 px), so the view's RIGHT: 729 + GAP.
    expect(shown!.style.left).toBe('737px');
    // A taller panel than the card's own top allows: it rises to stay inside the overlay.
    expect(parseFloat(shown!.style.top)).toBeCloseTo(800 - 8 - 330 * (680 / 488), 6);
    expect(shown!.style.width).toBe('330px');
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

  it('a tile in a pop-up opens in the zoom layer, above the pop-up', () => {
    // Operator, 2026-10-06: a three-card "put into hand" choice drew the
    // enlargement under the pop-up — the overlay's own layer ranks below it.
    const { panel, board } = mountBoard();
    const live = document.createElement('div');
    live.className = 'live';
    live.innerHTML =
      '<div class="live__prompt"><ul><li data-card-id="78"><article class="card" data-card-id="w78"><span class="card__name">Popup Card</span></article></li></ul></div>';
    document.body.appendChild(live);
    try {
      hover(live.querySelector('li')!);
      const shown = document.querySelector<HTMLElement>('[data-inspect]');
      expect(shown).not.toBeNull();
      expect(shown!.parentElement, 'in the zoom layer, above the pop-up').toBe(board.querySelector('[data-board-zoom]'));
      expect(panel(), 'the one panel').toBe(shown);
      expect(shown!.querySelector('.card__name')!.textContent).toBe('Popup Card');
    } finally {
      live.remove();
    }
  });

  it('a hand card enlarges above the hand whatever is open; the waiting pop-up is not a decision window', () => {
    // The operator, 2026-10-07: hovering a hand card under "Waiting for Bella…" no longer placed it above the hand.
    // The pregame wait and the mid-game wait are now ONE
    // component (`LiveBoard.tsx`'s `WaitingPop`), one testid —
    // `live-waiting-pop` — drawn in the ordinary `.live__prompt` slot.
    const { panel, board, myHandCard } = mountBoard();
    const live = document.createElement('div');
    live.className = 'live';
    live.innerHTML = '<div class="live__prompt"><section class="confirm" data-testid="live-waiting-pop" role="status">Waiting for Bella…</section></div>';
    document.body.appendChild(live);
    try {
      hover(myHandCard().querySelector('.card')!);
      expect(panel(), 'in the board overlay, on the hand anchor').not.toBeNull();
      expect(live.querySelector('[data-inspect]'), 'not beside the pop-up').toBeNull();
      // A real decision window: a hand card still keeps its anchor.
      live.innerHTML = '<div class="live__prompt" data-testid="live-decision-host"><p>Sacrifice a land</p></div>';
      hover(board);
      hover(myHandCard().querySelector('.card')!);
      expect(panel(), 'a hand card, still on the hand anchor').not.toBeNull();
      expect(live.querySelector('[data-inspect]')).toBeNull();
    } finally {
      live.remove();
    }
  });

  it('the waiting pop-up is not a decision window for a BOARD card either — the exclusion itself, not just the hand bypass', () => {
    // The hand case above never exercises the exclusion string at all (a hand
    // card takes the `inHand` branch regardless of what is open) — this is
    // the case that does: a battlefield card, with ONLY a waiting pop-up on
    // screen, still opens in the board overlay, never beside it.
    const { panel, theirCard } = mountBoard();
    const live = document.createElement('div');
    live.className = 'live';
    live.innerHTML = '<div class="live__prompt"><section class="confirm" data-testid="live-waiting-pop" role="status">Waiting for Bella…</section></div>';
    document.body.appendChild(live);
    try {
      hover(theirCard().querySelector('.card')!);
      expect(panel(), 'in the board overlay — the waiting pop-up is not a decision').not.toBeNull();
      expect(live.querySelector('[data-inspect]'), 'not beside the waiting pop-up').toBeNull();
    } finally {
      live.remove();
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

  it('a press on the card being read puts it away, and the card stays quiet until the pointer leaves it', () => {
    const { panel, board, theirCard } = mountBoard();
    const face = theirCard().querySelector('.card')!;
    hover(face);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(face, { pointerType: 'mouse' });
    expect(panel(), 'the press put it away').toBeNull();
    hover(theirCard());
    hover(face);
    expect(panel(), 'moving within the pressed card brings nothing back').toBeNull();
    hover(board.querySelector('.seat__counts')!);
    hover(face);
    expect(panel(), 'back on the card after leaving it').not.toBeNull();
  });

  it('a pointer that leaves the window from the pressed card has left it', () => {
    const { panel, theirCard } = mountBoard();
    const face = theirCard().querySelector('.card')!;
    hover(face);
    fireEvent.pointerDown(face, { pointerType: 'mouse' });
    fireEvent.pointerOut(face, { pointerType: 'mouse', relatedTarget: null });
    hover(face);
    expect(panel()).not.toBeNull();
  });

  it('a press elsewhere leaves the card being read alone, and another card opens at once after a press', () => {
    const { panel, theirCard, yourHandCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    fireEvent.pointerDown(theirCard().querySelector('.card')!, { pointerType: 'mouse' });
    hover(yourHandCard().querySelector('.card')!);
    expect(panel()!.querySelector('.card__name')!.textContent, 'a different card is not the quiet one').toBe('Your Hand Card');
    fireEvent.pointerDown(theirCard().ownerDocument.body, { pointerType: 'mouse' });
    expect(panel(), 'a press that is not on the card being read changes nothing').not.toBeNull();
  });

  it('Escape keeps the card quiet too: a nudge inside it does not reopen it', () => {
    const { panel, theirCard } = mountBoard();
    hover(theirCard().querySelector('.card')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    hover(theirCard());
    expect(panel()).toBeNull();
  });

  it('clicking a graveyard open puts away the card it was reading; a card in the pile view opens as usual', () => {
    const view: BoardView = { ...VIEW, players: [{ ...YOU, graveyard: [card(4, 'Buried One'), card(5, 'Buried Two')] }, THEM] };
    const utils = render(createElement(Board, { view }));
    const board = utils.container.querySelector<HTMLElement>('.board')!;
    disposers.push(mountInspector(board));
    const panel = (): HTMLElement | null => board.ownerDocument.querySelector('[data-inspect]');
    const top = board.querySelector('.seat [data-zone="graveyard"][data-owner="you"] li[data-card-id="5"]')!;
    hover(top.querySelector('.card')!);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(top.querySelector('.card')!, { pointerType: 'mouse' });
    fireEvent.click(top.querySelector('.card')!);
    expect(board.querySelector('[data-testid="pile-view"]'), 'the pile view opened').not.toBeNull();
    expect(panel(), 'the inspector is gone with it').toBeNull();
    hover(top);
    expect(panel(), 'still on the clicked card: nothing').toBeNull();
    hover(board.querySelector('[data-testid="pile-view"] li[data-card-id="4"] .card')!);
    expect(panel()!.querySelector('.card__name')!.textContent).toBe('Buried One');
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
      clientX: 40 + DRAG_SLOP_PX,
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
  /** The board's markup with the zoom layer emptied — what the canvas IS, minus what the inspector drew. */
  function withoutOverlay(board: HTMLElement): string {
    const copy = board.cloneNode(true) as HTMLElement;
    copy.querySelector('[data-board-zoom]')?.replaceChildren();
    return copy.outerHTML;
  }

  it('changes nothing outside the zoom layer', () => {
    const { board, theirCard, panel } = mountBoard();
    const before = withoutOverlay(board);
    hover(theirCard().querySelector('.card')!);
    expect(withoutOverlay(board)).toBe(before);
    expect(panel()!.closest('[data-board-zoom]')).not.toBeNull();
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

