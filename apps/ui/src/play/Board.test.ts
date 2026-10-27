// @vitest-environment jsdom
/**
 * The board renders a real game state — every number asserted here is read
 * off the committed fixture, a real Forge match's packet stream (see
 * `fixtures.ts` for its provenance). If the adapter mis-maps a zone, a count
 * below moves and this file fails.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';

import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import { cardStateKey, DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';
import type { DraftCard } from '@hadoku/shared';

import { createProjector, type StateFrame } from '../../../server/src/play/visibility.ts';
import { EXIT_MOTIONS, LEAVING_GAP_ATTR } from './live/departures.ts';
import { UNLOCK_BEAT_MS } from './motion.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import poolData from '../draft/pool.json';
import {
  artIdIndex,
  CUBE_ART_IDS,
  scryfallIdFor,
  toBoardView,
  type ArtIdIndex,
  type BoardCard,
  type BoardCardChoice,
  type BoardCardState,
  type BoardCardWaiting,
  type BoardEmblem,
  type BoardView,
  type StackEntry,
} from './adapter.ts';
import { expectPlacement, pendingPlacementFor, applyTheirArrangement, onOwnArrangement, type OwnArrangementListener,
  Board,
  clearPlacementColumns,
  commitHandMove,
  copiesIn,
  forgetArrangements,
  forgetPendingPlacements,
  group,
  handOrder,
  notePlayedTo,
  previewPlayedTo,
  showPlacementColumns,
  slotKey,
  snapTo,
  virtualColumns,
  withColumnsToWidth,
  withHandMove,
  withMove,
  type Arrangement,
  type BoardInteraction,
  type Grouped,
  type BoardLayout,
  type DropTarget,
  type SlotGeometry,
} from './Board.tsx';
import { boardFromFixture, loadPackets, PLAY_FIXTURES } from './fixtures.ts';
import { foldPackets, type WireState } from './fold.ts';
import { expectWirePackets, isAnnotationKey, type WireObject } from './wire.ts';

/**
 * The inspector is lane D's and is NOT stubbed — the real module mounts and the
 * real panel appears. The wrapper only counts: how many times the board booted
 * it, on what, and whether the mount effect's dispose actually ran.
 */
const inspector = vi.hoisted(() => ({ mounts: [] as { root: ParentNode; disposed: boolean }[] }));

vi.mock('./inspect/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./inspect/index.ts')>();
  return {
    ...real,
    mountInspector(root: ParentNode) {
      const entry = { root, disposed: false };
      inspector.mounts.push(entry);
      const dispose = real.mountInspector(root);
      return () => {
        entry.disposed = true;
        dispose();
      };
    },
  };
});

afterEach(() => {
  cleanup();
  // The arrangement outlives a mount on purpose (it has to survive a resync),
  // so each test starts from the default grouping.
  forgetArrangements();
  // T10 (wave 36): the arrangement is now ALSO in `sessionStorage`, keyed by
  // match and seat — and the fixture's match key is the SAME string across
  // most of this file's tests, so a drag in one test would otherwise
  // rehydrate into the next one the moment it calls `ARRANGED.get` through
  // `sessionStorage` rather than starting from nothing. `forgetArrangements`
  // alone (in-memory only) is what the T10 reload test below depends on NOT
  // also clearing storage mid-test; this is the per-test boundary instead.
  sessionStorage.clear();
});

const fixture = PLAY_FIXTURES[0]!;

/**
 * Item 11: `Board`'s own default is `single` (the operator's new default,
 * un-bucketed). This FILE's default stays `type-separated`, on purpose — the
 * overwhelming majority of the suite below was written against, and still
 * pins, the four-lane alternate's markup (`data-board-row`, its lanes, its
 * per-row arithmetic), and that markup is not deleted — item 11 says it
 * "survives as the ALTERNATE" and "several tests pin its markup." Passing
 * `boardLayout` explicitly here keeps every one of those tests exercising
 * exactly the alternate they always did, without threading the prop through
 * a few hundred individual call sites. The real DEFAULT — what a caller gets
 * with NO `boardLayout` prop at all — is asserted separately, directly
 * against `<Board view={...} />` with nothing else, in "item 11 — one board by
 * default" below.
 */
function renderBoard(
  view: BoardView = boardFromFixture(fixture),
  interaction?: BoardInteraction,
  boardLayout: BoardLayout = 'type-separated',
) {
  const utils = render(createElement(Board, { view, interaction, boardLayout }));
  const seat = (id: number) => utils.container.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${id}"]`)!;
  const zone = (id: number, name: string) => seat(id).querySelector<HTMLElement>(`[data-zone="${name}"]`)!;
  const cardNames = (el: HTMLElement) => [...el.querySelectorAll('.card__name')].map((n) => n.textContent);
  /** A battlefield row, by the name `Board.tsx` puts in `data-board-row`. Alternate-layout only. */
  const row = (id: number, name: string) => zone(id, 'battlefield').querySelector<HTMLElement>(`[data-board-row="${name}"]`)!;
  /** The ids a row draws, in the order it draws them. Alternate-layout only. */
  const rowIds = (id: number, name: string) =>
    [...row(id, name).querySelectorAll<HTMLElement>('.board-card')].map((c) => Number(c.dataset.cardId));
  return { ...utils, view, seat, zone, cardNames, row, rowIds };
}

/**
 * Forge's own controls are the cards and the seats. `Regroup`, the one control
 * that was ours, was deleted in wave 31 §A.3, so every button NOT taken out of
 * the tab order is Forge's. R10 (wave 35) made every card face a real
 * `<button>` always (fixing a flicker a `button`/`div` element-type switch
 * caused — see `Board.tsx`'s comment above `CardOnBoard`'s face),
 * `tabIndex={-1}` when Forge has not offered it — NOT `disabled`, a second
 * R10 fix found live by lane E's e2e run: a real browser never dispatches a
 * pointer event to, or bubbles one past, a `disabled` element, so a disabled
 * card's arrange-drag could never start on a real mouse (jsdom does not
 * reproduce that suppression, which is why no unit test caught it the first
 * time). So "is a button" no longer distinguishes offered from not; "is a
 * button still in the tab order" does, and is what every test below now reads.
 */
// Wave 46 X3's stack carousel button (no Forge offer behind it, excluded on
// purpose) is gone with the row itself (§S) — nothing left to exclude.
const forgeButtons = (container: HTMLElement) => container.querySelectorAll('button:not([tabindex="-1"])');

/* ── the pointer drag, driven in jsdom (wave 32 Q4b) ──────────────────── */

/**
 * jsdom lays nothing out, and the drag snaps by geometry, so a test that drags
 * has to give the board one. `layOut` stamps a fake `getBoundingClientRect` on the
 * viewer's slots (stacked 200px apart, each 1000 × 100) and on the base card of
 * every pile in them (60 × 84, 70px apart), which is all `Board.tsx` reads.
 * `dragCard` then drives the whole gesture the way a pointer does — press, a move
 * past the slop, a move to the target, release — so what is asserted is what the
 * board does with real pointer events, not a call into its internals.
 */
const CARD_W = 60;
const CARD_H = 84;

function stubBox(el: Element, left: number, top: number, width: number, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function layOut(container: HTMLElement): void {
  const slots = [...container.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-arrange-slot]')];
  slots.forEach((slot, i) => {
    const top = i * 200;
    stubBox(slot, 0, top, 1000, 100);
    const list = slot.matches('.zone__cards') ? slot : slot.querySelector<HTMLElement>(':scope > .zone__cards')!;
    // Every column, a gap (Z8) as much as a card: 70px of pitch.
    [...list.querySelectorAll(':scope > li.board-card, :scope > li.zone__gap')].forEach((li, j) => stubBox(li, 10 + j * 70, top + 8, CARD_W, CARD_H));
  });
}

/** Where to let go: a place on a card (`top` / `bottom` third, left half = `before`, right half = `after`), a whole slot, or a bare point. */
type DragTo =
  | { card: number; at: 'before' | 'after' | 'top' | 'bottom' }
  | { slot: string }
  | { point: { x: number; y: number } };

function pointFor(container: HTMLElement, to: DragTo): { x: number; y: number } {
  if ('point' in to) return to.point;
  if ('slot' in to) {
    // The row's END: just past its last card (within one column's pitch — further right is a column of its own, Z8), or the start of an empty row.
    const slot = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-arrange-slot="${to.slot}"]`)!;
    const box = slot.getBoundingClientRect();
    const last = [...slot.querySelectorAll<HTMLElement>('.zone__cards > li.board-card, :scope > li.board-card')].at(-1);
    const x = last === undefined ? box.left + 20 : last.getBoundingClientRect().right + 12;
    return { x, y: (box.top + box.bottom) / 2 };
  }
  const box = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${to.card}"]`)!.getBoundingClientRect();
  const mid = (box.top + box.bottom) / 2;
  if (to.at === 'before') return { x: box.left + 5, y: mid };
  if (to.at === 'after') return { x: box.right - 5, y: mid };
  return { x: box.left + 10, y: to.at === 'top' ? box.top + 10 : box.bottom - 10 };
}

/** The drag's own pointer, so a second `dragCard` is a second press. */
const POINTER = { pointerId: 1, isPrimary: true, pointerType: 'mouse' } as const;

/**
 * Press `cardId`, move past the slop, move to `to`, and — unless `hold` — let go.
 * With `hold` the drag is left in flight, for a test that reads the ghost and the
 * indicator; `release()` ends it.
 */
function dragCard(container: HTMLElement, cardId: number, to: DragTo, hold = false): () => void {
  layOut(container);
  const from = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${cardId}"]`)!;
  const box = from.getBoundingClientRect();
  const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const end = pointFor(container, to);
  fireEvent.pointerDown(from, { ...POINTER, button: 0, clientX: start.x, clientY: start.y });
  fireEvent.pointerMove(window, { ...POINTER, clientX: start.x + 12, clientY: start.y + 12 });
  fireEvent.pointerMove(window, { ...POINTER, clientX: end.x, clientY: end.y });
  const release = () => {
    fireEvent.pointerUp(window, { ...POINTER, clientX: end.x, clientY: end.y });
  };
  if (!hold) release();
  return release;
}

/**
 * §A.4. The operator, 2026-09-27: *"i dont understand what 'turn bar' and 'seat 1
 * live' are relevant for so i think these should just be deleted."* So the bar is
 * GONE — not hidden, not emptied, not kept behind a `hidden` attribute to keep a
 * spec quiet. Turn and phase are the phase rail's now (`live/LiveBoard.tsx`,
 * §B.2, which is wide enough to be read), and `e2e/play.spec.ts`,
 * `e2e/table-fit.spec.ts` and `e2e/arrow.spec.ts` are re-pointed at `live-turn`
 * by §B.
 *
 * The `game over` banner it also carried (`.board__over`) is gone too, as of
 * wave 35 (R16): the operator's result screen (Rematch / Main menu) replaces
 * it, drawn by `LiveBoard` (lane L) over the board, not by `Board` itself. See
 * seam 4 in `docs/planning/wave35-2026-10-02.md`'s wave file.
 */
describe('the turn bar is deleted (§A.4)', () => {
  it('draws no bar, and leaves nothing of it behind under any name', () => {
    const { container, queryByTestId } = renderBoard();
    const board = container.querySelector<HTMLElement>('.board')!;
    expect(board.querySelector('.board__bar'), 'no bar element').toBeNull();
    expect(board.querySelector('header'), 'and no header of any class').toBeNull();
    for (const id of ['turn', 'turn-bar', 'phase', 'active-player']) {
      expect(queryByTestId(id), `no ${id}`).toBeNull();
    }
    // Nothing is hidden in its place either: the deletion is a deletion.
    expect(board.querySelectorAll('[hidden]'), 'nothing hidden stands in for it').toHaveLength(0);
    expect(board.textContent, 'and the turn number is not written anywhere').not.toContain('Turn 14');
  });

  it('draws no game-over banner of its own; the result screen is LiveBoard\'s', () => {
    const base = boardFromFixture(fixture);
    const { container } = renderBoard({ ...base, gameOver: true });
    expect(container.querySelector('.board__over'), 'Board draws no banner, even when the game is over').toBeNull();
    expect(container.textContent, 'and no "game over" text anywhere').not.toContain('game over');
  });
});

describe('the Command zone', () => {
  // 2026-10-22: *"for command zone i guess we need a place for that. maybe by default we use the bottom right of the board?"*
  it('draws each player’s Command zone as cards at the end of their hand row, and none for a player with nothing there', () => {
    const base = boardFromFixture(fixture);
    const piece = (id: number, name: string): BoardCard => ({ ...base.players[0]!.battlefield[0]!, id, attachedCardIds: [], card: { ...base.players[0]!.battlefield[0]!.card, name } });
    const view = { ...base, players: base.players.map((p) => (p.isViewer ? { ...p, command: [piece(9001, 'The Initiative'), piece(9002, 'Undercity')] } : p)) };
    const { seat, zone, container } = renderBoard(view);
    const mine = zone(0, 'command');
    expect(mine.getAttribute('aria-label')).toMatch(/Command zone$/);
    expect(mine.dataset.count).toBe('2');
    expect([...mine.querySelectorAll<HTMLElement>('.board-card')].map((c) => Number(c.dataset.cardId))).toEqual([9001, 9002]);
    // After the hand, in the seat: `board.css` puts it in the hand row's last column.
    expect(mine.previousElementSibling?.getAttribute('data-zone')).toBe('hand');
    expect(seat(1).querySelector('[data-zone="command"]'), 'the other player holds nothing there').toBeNull();
    expect(container.querySelectorAll('[data-zone="command"]')).toHaveLength(1);
  });

  // The operator, 2026-10-22: "what happens when there are lots of things in the command zone, ideally it is expandable just liky gy/exile".
  it('opens as a pile on a click, every card in it, as a graveyard does', () => {
    const base = boardFromFixture(fixture);
    const piece = (id: number, name: string): BoardCard => ({ ...base.players[0]!.battlefield[0]!, id, attachedCardIds: [], card: { ...base.players[0]!.battlefield[0]!.card, name } });
    const pieces = [piece(9001, 'The Initiative'), piece(9002, 'Undercity'), piece(9003, "Teferi's Effect"), piece(9004, 'The Monarch')];
    const view = { ...base, players: base.players.map((p) => (p.isViewer ? { ...p, command: pieces } : p)) };
    const { zone, container } = renderBoard(view);
    expect(container.querySelector('[data-testid="pile-view"]')).toBeNull();
    fireEvent.click(zone(0, 'command'));
    const pile = container.querySelector<HTMLElement>('[data-testid="pile-view"]');
    expect(pile?.dataset.zoneView).toBe('command');
    expect(pile?.getAttribute('aria-label')).toBe('Command zone');
    expect([...(pile?.querySelectorAll<HTMLElement>('.board-card') ?? [])].map((c) => Number(c.dataset.cardId)).sort()).toEqual([9001, 9002, 9003, 9004]);
  });
});

describe('players', () => {
  it('draws both players, the viewer last on screen, with their life totals', () => {
    const { getAllByTestId, seat } = renderBoard();
    const seats = getAllByTestId('player');
    expect(seats.map((s) => s.dataset.playerId)).toEqual(['1', '0']);
    expect(seat(0).dataset.viewer).toBe('true');
    expect(within(seat(0)).getByTestId('life').textContent).toBe('2');
    expect(within(seat(1)).getByTestId('life').textContent).toBe('16');
  });

  /*
   * §A.10: *"can we get symbols to display hand/deck size instead of words?"* So
   * the count IS the number, the word is the accessible name, and the mark beside
   * it is a drawn `<svg>` — both halves asserted, because a count that lost its
   * word entirely would be a symbol nobody can name. The hand's count is gone
   * (2026-10-17): a hand is drawn card by card, so it counts itself.
   */
  it('draws the library count as a symbol and a number, with the word in its accessible name, and no hand count', () => {
    const { seat } = renderBoard();
    const library = within(seat(0)).getByTestId('library-count');
    expect(library.textContent, 'the number, and no word').toBe('46');
    expect(library.getAttribute('aria-label')).toBe('library 46');
    expect(library.querySelector('svg.seat__count-art'), 'a drawn mark beside it').toBeTruthy();
    expect(within(seat(1)).getByTestId('library-count').textContent).toBe('47');
    expect(library.querySelectorAll('svg.seat__count-art path'), 'three stacked trapezoids').toHaveLength(3);
    expect(within(seat(0)).queryByTestId('hand-count')).toBeNull();
    expect(within(seat(1)).queryByTestId('hand-count')).toBeNull();
  });

  // 2026-10-17: *"Clicking on deck icon should let you open your deck list."* Your own only.
  it('makes the viewer’s own library count a button that opens their deck list, and nobody else’s', () => {
    const view = boardFromFixture(fixture);
    const opened: Element[] = [];
    const utils = render(createElement(Board, { view, boardLayout: 'type-separated', onOpenDeck: (from: Element) => opened.push(from) }));
    const seatEl = (id: number) => utils.container.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${id}"]`)!;
    const viewer = view.players.find((p) => p.isViewer)!;
    const other = view.players.find((p) => !p.isViewer)!;
    const mine = within(seatEl(viewer.id)).getByTestId('library-count');
    expect(mine.tagName).toBe('BUTTON');
    expect(mine.getAttribute('aria-label')).toBe(`library ${viewer.libraryCount}`);
    fireEvent.click(mine);
    expect(opened).toEqual([mine]);
    expect(within(seatEl(other.id)).getByTestId('library-count').tagName, 'the other seat’s list is hidden').toBe('SPAN');
  });

  it('draws the library count as no button when nothing opens a list (a watcher, a test board)', () => {
    const { seat } = renderBoard();
    expect(within(seat(0)).getByTestId('library-count').tagName).toBe('SPAN');
  });
});

/**
 * An emblem as the adapter reads it: Forge's effect card, `Emblem — <source>`, its own face carrying
 * no art of its own (`adapter.ts`'s `readEmblems`), and its source's art for the medallion.
 */
function emblemOf(id: number, source: string, text: string): BoardEmblem {
  const card: DraftCard = {
    cardId: `w${id}`,
    name: `Emblem — ${source}`,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: 'Emblem',
    oracleText: '',
    setCode: 'LCC',
    collectorNumber: '',
    rarity: 'special',
  };
  return { id, source, text, card };
}

/*
 * The operator, 2026-10-14: *"i need a visual for emblems. let's make it so they go around the
 * player's avatar and hovering the players avatar shows all their emblems."* And 2026-10-21: *"we
 * already have the emblem card chip for the trigger, we can just use that. and when hovering over
 * the player, then we display the card chips. i do like the little circular icon around their
 * avatar, that's cute."*
 */
describe('emblems around the avatar', () => {
  const all = [
    emblemOf(1, 'Sorin, Lord of Innistrad', 'Creatures you control get +1/+0.'),
    emblemOf(2, 'Gideon, Ally of Zendikar', 'Creatures you control get +1/+1.'),
    emblemOf(3, 'Elspeth, Sun’s Champion', 'Creatures you control get +2/+2 and have flying.'),
    emblemOf(4, 'Narset Transcendent', "Your opponents can't cast noncreature spells."),
    emblemOf(5, 'Venser, the Sojourner', 'Whenever you cast a spell, exile target permanent.'),
  ];
  const withEmblems = (n: number, seats: 'them' | 'both' = 'them') => {
    const base = boardFromFixture(fixture);
    return { ...base, players: base.players.map((p) => (p.isViewer && seats === 'them' ? p : { ...p, emblems: all.slice(0, n) })) };
  };
  /** The chips a seat's avatar holds for the inspector (`inspect/`): the emblem trigger's own chip, one per emblem. */
  const chipsOf = (seat: HTMLElement) => Array.from(seat.querySelectorAll<HTMLElement>('[data-player-face] [data-emblem-chips] [data-ability-chip]'));

  it('draws one medallion per emblem around their owner’s avatar, and no text tip on the avatar or a medallion', () => {
    const { seat } = renderBoard(withEmblems(2));
    expect(seat(0).querySelectorAll('[data-emblem]'), 'none on the other seat').toHaveLength(0);
    expect(chipsOf(seat(0)), 'and no chips on the other seat').toHaveLength(0);
    const medallions = Array.from(seat(1).querySelectorAll<HTMLElement>('[data-emblem]'));
    expect(medallions.map((m) => m.dataset.slot)).toEqual(['0', '1']);
    expect(seat(1).querySelector('[data-player-face]')!.hasAttribute('data-tip'), 'the avatar’s hover is the inspector, not a tip').toBe(false);
    for (const m of medallions) expect(m.hasAttribute('data-tip'), 'nor a medallion’s').toBe(false);
  });

  it('the avatar holds each emblem as its trigger’s chip — the emblem’s name and Forge’s words — on either seat', () => {
    const { seat } = renderBoard(withEmblems(2, 'both'));
    for (const id of [0, 1]) {
      const chips = chipsOf(seat(id));
      expect(chips.map((c) => c.querySelector('.placed__chip-name')!.textContent), `seat ${id}`).toEqual([
        'Emblem — Sorin, Lord of Innistrad',
        'Emblem — Gideon, Ally of Zendikar',
      ]);
      expect(chips.map((c) => c.querySelector('.placed__chip-text')!.textContent)).toEqual(['Creatures you control get +1/+0.', 'Creatures you control get +1/+1.']);
      expect(seat(id).querySelector<HTMLElement>('[data-emblem-chips]')!.hidden, 'drawn for the inspector to enlarge, not on the table').toBe(true);
    }
  });

  it('an emblem has no printed art of its own: its chip draws no art and no illustrator or copyright line', () => {
    const { seat } = renderBoard(withEmblems(3));
    const chips = chipsOf(seat(1));
    expect(chips).toHaveLength(3);
    for (const c of chips) {
      expect(c.querySelector('img'), 'no art').toBeNull();
      expect(c.querySelector('.placed__chip-credit'), 'no credit line').toBeNull();
      expect(c.textContent).not.toMatch(/Illus\.|WotC/);
    }
    expect(seat(1).querySelector('.face__emblems')!.getAttribute('aria-label')).not.toMatch(/Illus\.|WotC/);
  });

  it('past four, three medallions and a fourth that counts the rest — and every emblem is still a chip', () => {
    const { seat } = renderBoard(withEmblems(5));
    expect(seat(1).querySelectorAll('[data-emblem]')).toHaveLength(3);
    const more = seat(1).querySelector<HTMLElement>('[data-emblem-more]')!;
    expect(more.textContent).toBe('+2');
    expect(more.dataset.slot).toBe('3');
    expect(chipsOf(seat(1))).toHaveLength(5);
  });
});

/*
 * The operator, 2026-10-19: *"let's make a special zone between their name and the deck symbol for
 * this type of information. by default that zone is empty, but when things like storm counters are
 * being tracked or extra turns, then it'd be good to show it there."*
 */
describe('the seat’s status zone', () => {
  const emblem = (id: number) => emblemOf(id, `Source ${id}`, `Text ${id}.`);
  const base = boardFromFixture(fixture);
  const withViewer = (extra: Partial<BoardView['players'][number]>, them: Partial<BoardView['players'][number]> = {}): BoardView => ({
    ...base,
    players: base.players.map((p) => (p.isViewer ? { ...p, ...extra } : { ...p, ...them })),
  });
  const status = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-player-bar] > [data-seat-status]')!;

  it('is in every seat’s bar, between the name and the library mark, and holds nothing while nothing is tracked', () => {
    const { seat } = renderBoard(base);
    for (const p of base.players) {
      const zone = status(seat(p.id));
      expect(zone, `seat ${p.id} has a status zone in its bar`).not.toBeNull();
      expect(zone.children, `seat ${p.id}'s is empty`).toHaveLength(0);
      expect(zone.dataset.items).toBe('0');
      const bar = [...seat(p.id).querySelector('[data-player-bar]')!.children];
      expect(bar.indexOf(zone), 'after the name').toBe(bar.findIndex((c) => c.classList.contains('seat__ident')) + 1);
    }
  });

  it('draws the storm count there, with its tip — not on the avatar', () => {
    const { seat } = renderBoard(withViewer({ storm: 4 }));
    const storm = within(status(seat(0))).getByTestId('storm-count');
    expect([storm.textContent, storm.dataset.storm, storm.dataset.tip, storm.getAttribute('aria-label')]).toEqual(['4', '4', 'Storm 4', 'Storm 4']);
    expect(seat(0).querySelector('[data-player-face] [data-testid="storm-count"], .face__emblems'), 'nothing on the face').toBeNull();
    expect(seat(1).querySelector('[data-testid="storm-count"]'), 'not on the other seat').toBeNull();
  });

  it('gives the avatar’s last slot back to emblems: four emblems are four medallions beside a storm count', () => {
    const { seat } = renderBoard(withViewer({ storm: 1, emblems: [1, 2, 3, 4].map(emblem) }));
    expect(Array.from(seat(0).querySelectorAll<HTMLElement>('[data-emblem]')).map((m) => m.dataset.slot)).toEqual(['0', '1', '2', '3']);
    expect(seat(0).querySelector('[data-emblem-more]')).toBeNull();
  });

  it('draws the extra turns to come on any seat, and the mark that this turn is one on the seat taking it', () => {
    const { seat } = renderBoard(withViewer({ extraTurn: true }, { extraTurns: 2 }));
    const coming = within(status(seat(1))).getByTestId('extra-turns');
    expect([coming.textContent, coming.dataset.extraTurns, coming.dataset.tip]).toEqual(['2', '2', '2 extra turns']);
    expect(coming.querySelector('svg'), 'a drawn mark').not.toBeNull();
    expect(seat(1).querySelector('[data-testid="extra-turn-now"]'), 'their turn is not an extra one').toBeNull();
    const now = within(status(seat(0))).getByTestId('extra-turn-now');
    expect([now.textContent, now.dataset.tip]).toEqual(['', 'Extra turn']);
    expect(seat(0).querySelector('[data-testid="extra-turns"]'), 'none to come on ours').toBeNull();
    expect(renderBoard(withViewer({ extraTurns: 1 })).seat(0).querySelector<HTMLElement>('[data-testid="extra-turns"]')!.dataset.tip).toBe('1 extra turn');
  });

  it('takes no room while empty, so the deck mark sits under the name; only the mana pool keeps its room', () => {
    // The operator, 2026-10-22: "can we squish the deck list / count button up to be below the name? … retain
    // space for the mana pool below that, but reclaim the other space if its not used".
    const css = styled();
    const { seat } = renderBoard(base);
    for (const id of [0, 1]) expect(css(status(seat(id)), 'display'), 'an empty status line is not drawn at all').toBe('none');
    const pool = (view: BoardView): string => {
      const { seat: s, unmount } = renderBoard(view);
      const height = css(s(0).querySelector<HTMLElement>('[data-mana-pool]')!, 'height');
      unmount();
      return height;
    };
    const emptyPool = pool(base);
    expect(emptyPool, 'the mana pool holds a height of its own').not.toBe('');
    expect(pool(withViewer({ manaPool: [{ color: 'R', count: 2 }] })), 'the same with mana as without').toBe(emptyPool);
    const bar = seat(0).querySelector<HTMLElement>('[data-player-bar]')!;
    expect(css(bar, 'display'), 'a column of what it draws, no fixed tracks').toBe('flex');
    const withChips = renderBoard(withViewer({ storm: 3, extraTurn: true, extraTurns: 1 }, { extraTurns: 1 }));
    expect(css(status(withChips.seat(0)), 'display'), 'a chip draws the line').not.toBe('none');
  });
});

describe('zones', () => {
  it('lays out each battlefield with the fixture’s permanents, grouped by what they are', () => {
    const { zone, cardNames } = renderBoard();
    expect(zone(0, 'battlefield').dataset.count).toBe('5');
    // The fixture's own order is two gates, an island, a gate, an island with
    // the creature third; grouped, the lands come first and the creature last.
    expect(cardNames(zone(0, 'battlefield'))).toEqual([
      'Izzet Guildgate',
      'Island',
      'Izzet Guildgate',
      'Island',
      'Fire Urchin',
    ]);
    expect(zone(1, 'battlefield').dataset.count).toBe('8');
    expect(cardNames(zone(1, 'battlefield'))).toContain('Vulshok War Boar');
    expect(cardNames(zone(1, 'battlefield')).filter((n) => n === 'Mountain')).toHaveLength(4);
  });

  /*
   * §A.15: a card's state is DRAWN, not written. The operator: *"all the
   * text you have written on the card looks ugly."* So `tapped` is the turn
   * `card.css` makes, and the WORD is gone from the card entirely — which is the
   * half a revert would put back, so it is the half asserted.
   */
  it('marks tapped permanents by turning them, and writes the word nowhere', () => {
    const { zone } = renderBoard();
    const field = zone(1, 'battlefield');
    const tapped = field.querySelectorAll('[data-tapped]');
    // Mountain 87, Mountain 78, Vulshok War Boar 99.
    expect(tapped).toHaveLength(3);
    expect(field.textContent, 'no card on the board says "tapped"').not.toContain('tapped');
    // And the turn is real: the cascade gives a tapped card a quarter turn, and an untapped one none.
    const css = styled();
    expect(turnOf(css, tapped[0]!)).toContain('90deg');
    expect(turnOf(css, field.querySelector('[data-board-card]:not([data-tapped])')!)).not.toContain('90deg');
  });

  it('reports summoning sickness only for creatures on the battlefield', () => {
    /*
     * Forge's raw `Sickness` is true on most cards in HAND and in a GRAVEYARD too
     * — which is exactly the reason the state layer is drawn on the battlefield
     * and nowhere else: nothing in a hand is sick, blocking or attacking in any
     * way a player can act on.
     *
     * The committed fixture's own board carries none of these states, so the sick
     * creature is put there by hand. Its ZONE is what is under test.
     */
    const base = boardFromFixture(fixture);
    const sicken = (p: (typeof base.players)[number]) =>
      !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => ({ ...c, summoningSick: true })) };
    const { zone } = renderBoard({ ...base, players: base.players.map(sicken) });
    expect(zone(0, 'hand').querySelectorAll('.board-card__marks')).toHaveLength(0);
    expect(zone(0, 'graveyard').querySelectorAll('.board-card__marks')).toHaveLength(0);
    expect(
      zone(0, 'battlefield').querySelectorAll('.board-card__mark[data-mark="sick"]').length,
      'every creature on the battlefield wears the mark',
    ).toBe(base.players.find((p) => p.isViewer)!.battlefield.length);
  });

  it('fills graveyards and leaves exile empty, as the game did', () => {
    const { zone, cardNames } = renderBoard();
    expect(cardNames(zone(0, 'graveyard'))).toEqual(['Fire Urchin', 'Rubblebelt Boar', "Ral's Staticaster"]);
    expect(cardNames(zone(1, 'graveyard'))).toEqual(['Oxidda Golem', 'Gemini Engine', 'Pyrite Spellbomb']);
    expect(zone(0, 'exile').dataset.count).toBe('0');
    expect(zone(1, 'exile').dataset.count).toBe('0');
  });

  it('shows the viewer’s hand as cards', () => {
    const { zone, cardNames } = renderBoard();
    expect(zone(0, 'hand').dataset.count).toBe('5');
    expect(cardNames(zone(0, 'hand'))).toEqual([
      'Leapfrog',
      'Fearless Halberdier',
      "Ral's Dispersal",
      'Fearless Halberdier',
      'Hellkite Whelp',
    ]);
  });
});

/*
 * Wave 59 §S: the thumbnail row, the lone band's pulse on a source
 * (`LoneAbilityContext`), and every class and attribute either one drew
 * (`.stack__item`, `.stack__items`, `data-stack-source`) are deleted outright
 * — `live/placed.ts` draws every item on the stack as a card at a point, in
 * the overlay, for both seats; `placed.test.ts` is where that drawing itself
 * is tested. What is left here is the zone's own bookkeeping (`data-count`,
 * `data-carried`) and the proof that nothing of the old row survives,
 * whatever shape the stack is in — one spell, one ability, two, or several.
 */
describe('the stack with one thing on it (the stack redesign)', () => {
  const base = boardFromFixture(fixture);
  const spell = base.stack.find((item) => !item.isAbility)!;
  const ability = base.stack.find((item) => item.isAbility)!;

  it('a lone spell is a non-visual zone (data-count alone) — live/placed.ts draws the card', () => {
    const { container } = renderBoard({ ...base, stack: [spell] });
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count).toBe('1');
    expect(stack.children, 'the zone itself draws nothing — no row, no band').toHaveLength(0);
    expect(container.querySelector('.stack__item'), 'the old thumbnail class is gone, not merely empty').toBeNull();
  });

  it('a lone ability pulses nothing — the old LoneAbilityContext source mark is deleted with the band', () => {
    const { container } = renderBoard({ ...base, stack: [ability] });
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count, 'Forge still has one item').toBe('1');
    expect(container.querySelectorAll('[data-stack-source]'), 'the ephemeral card replaces the pulse — nothing on the battlefield marks itself any more').toHaveLength(0);
    const source = container.querySelector<HTMLElement>(`li.board-card[data-card-id="${ability.sourceCardId}"]`)!;
    expect(source.dataset.stackId, 'the permanent itself no longer carries the item’s id either').toBeUndefined();
  });

  it('two items: still no row, still no pulse, whatever Forge has on the stack', () => {
    const { container } = renderBoard({ ...base, stack: [ability, spell] });
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count).toBe('2');
    expect(stack.children).toHaveLength(0);
    expect(container.querySelector('[data-stack-source]')).toBeNull();
    expect(container.querySelector('li.board-card[data-stack-id]'), 'no board card carries a stack id').toBeNull();
  });

  it('an ability off a card the board does not draw: still nothing here — live/placed.ts has its own default-spot fallback', () => {
    const { container } = renderBoard({ ...base, stack: [{ ...ability, sourceCardId: 424242 }] });
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count).toBe('1');
    expect(stack.children).toHaveLength(0);
    expect(container.querySelector('[data-stack-source]')).toBeNull();
  });
});

describe('the stack', () => {
  it('data-carried tracks a played card standing in for its own spell, whatever placed.ts draws for it', () => {
    const base = boardFromFixture(fixture);
    const { container } = renderBoard(base);
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count, 'the real fixture’s own two items').toBe('2');
    expect(stack.dataset.carried, 'nothing is carried off-screen without carryCastOffStack').toBeUndefined();
  });

  it('is the one zone every reader still finds its item through — live/placed.ts’s own [data-placed-spell], never the old row', () => {
    const base = boardFromFixture(fixture);
    const { container } = renderBoard(base);
    for (const item of base.stack) {
      expect(container.querySelector(`[data-placed-spell="${item.id}"]`), `item ${item.id} is drawn`).not.toBeNull();
      expect(container.querySelector(`.stack__item[data-stack-id="${item.id}"]`), 'never the deleted row').toBeNull();
    }
  });
});

/* ── art ──────────────────────────────────────────────────────────────── */

/** Every card name the raw stream carries, including ones the viewer may not see. */
function namesOnTheWire(): string[] {
  const names = new Set<string>();
  for (const packet of loadPackets(fixture)) {
    for (const obj of Object.values(packet.newObjects)) {
      if (typeof obj !== 'object' || obj._type !== DELTA_TYPE.cardState) continue;
      const name = obj.Name;
      if (typeof name === 'object' && name !== null && name.t === 'str' && typeof name.v === 'string') names.add(name.v);
    }
  }
  return [...names].sort();
}

/**
 * An id for every name on the wire. Uuid-shaped so the resolver accepts them;
 * they are test ids, not real Scryfall ids — nothing is fetched in jsdom.
 */
const TEST_IDS: ReadonlyMap<string, string> = new Map(
  namesOnTheWire().map((name, i) => [name, `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`]),
);
const TEST_ART_IDS: ArtIdIndex = artIdIndex([...TEST_IDS].map(([name, scryfallId]) => ({ name, setCode: '', scryfallId })));

function viewWithArt(state: WireState = foldPackets(loadPackets(fixture)).state): BoardView {
  return toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
}

describe('art (D15: a lookup, not a URL)', () => {
  it('draws both battlefields and the viewer’s hand as art, through the resolver', () => {
    const { zone } = renderBoard(viewWithArt());
    for (const [seatId, name, count] of [
      [0, 'battlefield', 5],
      [1, 'battlefield', 8],
      [0, 'hand', 5],
    ] as const) {
      const cards = [...zone(seatId, name).querySelectorAll<HTMLElement>('[data-board-card]')];
      expect(cards, `${name} of ${seatId}`).toHaveLength(count);
      for (const card of cards) {
        const cardName = card.querySelector('.card__name')!.textContent!;
        const img = card.querySelector('img');
        expect(img, `${cardName} has art`).not.toBeNull();
        // The exact URL the draft's CardTile builds for that id — no host of our own.
        expect(img!.getAttribute('src')).toBe(cardImageUrl(TEST_IDS.get(cardName)));
        expect(ALLOWED_ART_HOSTS).toContain(new URL(img!.getAttribute('src')!).origin);
      }
    }
  });

  it('builds no image when the index knows none of the cards', () => {
    const view = toBoardView(foldPackets(loadPackets(fixture)).state, 27, {
      viewerPlayerId: 0,
      artIds: artIdIndex([]),
    });
    const { container } = renderBoard(view);
    expect(container.querySelectorAll('[data-testid="card"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/url\(/);
  });

  it('looks ids up in the cube pool by default, exact printing first', () => {
    const pool = (poolData as { cards: { name: string; setCode: string; scryfallId?: string }[] }).cards;
    const giver = pool.find((c) => c.name === 'Giver of Runes')!;
    expect(scryfallIdFor(CUBE_ART_IDS, 'Giver of Runes', giver.setCode)).toBe(giver.scryfallId);
    expect(scryfallIdFor(CUBE_ART_IDS, 'Giver of Runes', 'NOPE')).toBe(giver.scryfallId);
    expect(scryfallIdFor(CUBE_ART_IDS, 'Not A Card In The Cube', '')).toBeUndefined();

    // Rename the viewer's first Island to a cube card and adapt with NO index:
    // the default must find it.
    const state = new Map(foldPackets(loadPackets(fixture)).state);
    const islandFace = [...state.entries()].find(
      ([k, o]) => o._type === DELTA_TYPE.cardState && k === cardStateKey(o._id >> 4, 0) && (o.Name as { v?: unknown } | undefined)?.v === 'Island',
    )!;
    state.set(islandFace[0], { ...islandFace[1], Name: { t: 'str', v: 'Giver of Runes' } } as WireObject);
    const view = toBoardView(state, 27, { viewerPlayerId: 0 });
    const { container } = renderBoard(view);
    // By name, not "the only image on the board": the default index also
    // knows the basic lands now, which is the art lane's whole point, so a
    // census of every `<img>` would be an assertion about that lane's data.
    const artOf = (name: string): string | null | undefined =>
      [...container.querySelectorAll<HTMLElement>('[data-testid="card"]')]
        .find((c) => c.querySelector('.card__name')?.textContent === name)
        ?.querySelector('img')
        ?.getAttribute('src');
    expect(artOf('Giver of Runes'), 'the renamed cube card resolves through the default index').toBe(
      cardImageUrl(giver.scryfallId),
    );
    // And a card the cube pool never held: `Mountain|MRD`, which is exactly
    // the set of cards the operator saw blank.
    expect(scryfallIdFor(CUBE_ART_IDS, 'Mountain', 'MRD'), 'the cube pool alone does not know a basic').toBeUndefined();
    expect(artOf('Mountain'), 'a basic land still gets art from the default index').toBe(
      cardImageUrl('b082f22f-6c01-4e8c-80ad-6fdae5c3f22f'),
    );
    // Whatever the id, the host is the resolver's: nothing here builds a URL.
    for (const name of ['Giver of Runes', 'Mountain']) {
      expect(ALLOWED_ART_HOSTS).toContain(new URL(artOf(name)!).origin);
    }
  });
});

/* ── hidden information ───────────────────────────────────────────────── */

/** Seat 1's hand in the raw stream: the cards the viewer must never see. */
function opponentHandNames(): string[] {
  const { state } = foldPackets(loadPackets(fixture));
  const hand = state.get(deltaKey(DELTA_TYPE.player, 1))?.Hand as { v: { v: number }[] };
  return hand.v.map((x) => {
    const face = state.get(cardStateKey(x.v, 0))!;
    return (face.Name as { v: string }).v;
  });
}

/** The fixture as the SERVER sends it to seat 0: every packet through the seat projector. */
function projectedForViewer(): BoardView {
  const projector = createProjector(fixture.viewerPlayerId);
  const projected = loadPackets(fixture).map((p) => {
    const strip = (m: Record<string, WireObject>) =>
      Object.fromEntries(Object.entries(m).filter(([k]) => !isAnnotationKey(k)));
    const frame = {
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { ...p, newObjects: strip(p.newObjects), objectDeltas: strip(p.objectDeltas) } },
    } as unknown as StateFrame;
    const out = projector.project(frame);
    if (out.method !== 'applyDelta') throw new Error(`projector turned applyDelta into ${out.method}`);
    return out.payload.packet;
  });
  const { state, seq } = foldPackets(expectWirePackets(projected, 'projected fixture'));
  return toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
}

describe('hidden information', () => {
  const secrets = opponentHandNames();

  it('knows what it is guarding: the opponent’s hand is two named cards on the raw wire', () => {
    expect(secrets).toEqual(['Talon of Pain', 'Electrostatic Bolt']);
    const wire = JSON.stringify(fixture.raw);
    for (const name of secrets) expect(wire).toContain(`"${name}"`);
  });

  for (const [source, make] of [
    ['a frame projected for the viewer’s seat', projectedForViewer],
    ['the raw stream (the renderer is the last line)', () => viewWithArt()],
  ] as const) {
    it(`from ${source}: the opponent’s hand is backs and a count — no face, no name, no art`, () => {
      const { zone, container } = renderBoard(make());
      const hand = zone(1, 'hand');
      expect(hand.dataset.count).toBe('2');
      /*
       * The count is `data-count` and nothing else now: §A.3 dropped every zone
       * caption, so the strip holds backs and not one word — neither the old
       * "2 cards, hidden" sentence nor the "Hand 2" head that replaced it.
       */
      expect(hand.textContent).toBe('');
      expect(hand.querySelector('.zone__head'), 'and no caption either').toBeNull();
      const them = make().players.find((pl) => !pl.isViewer)!;
      expect(hand.getAttribute('aria-label'), 'the zone is still named, to a reader').toBe(`${them.name} Hand`);
      expect(hand.querySelectorAll('[data-card-back]')).toHaveLength(2);
      expect(hand.querySelectorAll('[data-board-card], [data-testid="card"], img')).toHaveLength(0);

      for (const name of secrets) {
        expect(container.textContent).not.toContain(name);
        expect(container.innerHTML).not.toContain(TEST_IDS.get(name)!);
      }
      // The same render does show what the viewer may see, with art: the
      // check above is not passing because nothing rendered at all.
      const mine = zone(0, 'hand');
      expect(mine.querySelectorAll('[data-board-card]')).toHaveLength(5);
      expect(mine.querySelectorAll('img')).toHaveLength(5);
    });
  }
});

/* ── what Forge says is clickable ──────────────────────────────────────── */

/**
 * `selectionOpen` defaults to FALSE here on purpose: that is the field's own
 * default, and it is the state Forge is in at priority, during a payment and
 * while declaring attackers or blockers — which is most of a game. The tests
 * that care about an open selection pass `true` explicitly.
 */
function spyInteraction(
  selectable: number[],
  selectablePlayers: number[] = [],
  selectionOpen = false,
  actionable: number[] = [],
  stagedCardId?: number,
  /** `BoardInteraction.highlighted` — ids this seat has already picked, a subset of `selectable`. */
  highlighted: number[] = [],
) {
  const onSelectCard = vi.fn<(id: number) => void>();
  const onSelectPlayer = vi.fn<(id: number) => void>();
  const interaction: BoardInteraction = {
    selectable: new Set(selectable),
    selectablePlayers: new Set(selectablePlayers),
    selectionOpen,
    actionable: new Set(actionable),
    stagedCardId,
    highlighted: new Set(highlighted),
    onSelectCard,
    onSelectPlayer,
  };
  return { interaction, onSelectCard, onSelectPlayer };
}

describe('BoardInteraction', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const them = view.players.find((p) => !p.isViewer)!;
  // One of each zone the viewer can see: my land, my hand, their creature, my graveyard.
  const picks = [me.battlefield[1]!.id, me.hand![2]!.id, them.battlefield.at(-1)!.id, me.graveyard[0]!.id];

  it('with no interaction, nothing Forge offers on the board is a button', () => {
    const { container } = renderBoard(view);
    expect(forgeButtons(container)).toHaveLength(0);
    expect(container.querySelectorAll('[data-selectable]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-arrange-reset]'), 'Regroup is gone (§A.3)').toHaveLength(0);
  });

  it('makes exactly the selectable cards buttons, and a click reports the id', () => {
    const { interaction, onSelectCard, onSelectPlayer } = spyInteraction(picks);
    const { container } = renderBoard(view, interaction);

    const marked = [...container.querySelectorAll<HTMLElement>('[data-board-card][data-selectable]')];
    expect(marked.map((el) => Number(el.dataset.boardCard)).sort()).toEqual([...picks].sort());
    expect(forgeButtons(container)).toHaveLength(picks.length);

    for (const id of picks) {
      const face = container.querySelector<HTMLElement>(`[data-board-card="${id}"] > .board-card__face`)!;
      // A real button: in the tab order, and Enter/Space are the browser's.
      expect(face.tagName).toBe('BUTTON');
      expect(face.tabIndex).toBe(0);
      fireEvent.click(face);
    }
    expect(onSelectCard.mock.calls.map(([id]) => id)).toEqual(picks);
    expect(onSelectPlayer).not.toHaveBeenCalled();
  });

  /**
   * The operator: *"hard to tell when i have a card selected because the
   * background for all cards is green."* `highlighted` is a SUBSET of
   * `selectable` (Forge's own fold, `live/match.ts`) — a card may be picked
   * only once it is also offered — so a picked card must carry both
   * attributes and an offered-only card must carry `data-selectable` alone.
   */
  it('a picked card carries data-picked and data-selectable; an offered-only card carries data-selectable alone', () => {
    const [pickedId, ...restOffered] = picks;
    const { interaction } = spyInteraction(picks, [], false, [], undefined, [pickedId!]);
    const { container } = renderBoard(view, interaction);

    const pickedCard = container.querySelector<HTMLElement>(`[data-board-card="${pickedId}"]`)!;
    expect(pickedCard.hasAttribute('data-selectable')).toBe(true);
    expect(pickedCard.hasAttribute('data-picked')).toBe(true);
    // The same fact the drawing says, for anything that cannot see the mark.
    expect(pickedCard.querySelector('.board-card__face')!.getAttribute('aria-pressed')).toBe('true');

    for (const id of restOffered) {
      const offeredOnly = container.querySelector<HTMLElement>(`[data-board-card="${id}"]`)!;
      expect(offeredOnly.hasAttribute('data-selectable'), 'still offered').toBe(true);
      expect(offeredOnly.hasAttribute('data-picked'), 'but not picked').toBe(false);
      expect(offeredOnly.querySelector('.board-card__face')!.getAttribute('aria-pressed')).toBe('false');
    }
  });

  /**
   * R10 (wave 35): an inert card's face is still a `<button>` — see the
   * comment above `CardOnBoard`'s face in `Board.tsx` for why the element type
   * no longer switches — but it is `tabIndex={-1}`, NOT `disabled` (a second
   * R10 fix, found live: a real browser suppresses pointer events on a
   * `disabled` element, which breaks the arrange-drag's own press; jsdom does
   * not reproduce that, so no unit test caught it the first time). `tabIndex`
   * alone keeps every behaviour this test pins: out of the tab order, not
   * clickable (no `onClick` to call), and reported nowhere.
   */
  it('an inert card is a button taken OUT of the tab order, and a click on it calls nothing', () => {
    const { interaction, onSelectCard } = spyInteraction(picks);
    const { container } = renderBoard(view, interaction);
    const inert = [...container.querySelectorAll<HTMLElement>('[data-board-card]:not([data-selectable])')];
    // 5 + 8 battlefield, 3 + 3 graveyard, 5 in hand: 24 cards, 4 of them picked.
    expect(inert).toHaveLength(24 - picks.length);
    for (const card of inert) {
      const face = card.querySelector<HTMLButtonElement>('button.board-card__face')!;
      expect(face, 'still a button').not.toBeNull();
      expect(face.tabIndex, 'out of the tab order, not disabled').toBe(-1);
      // Never `disabled`: a real browser suppresses a pointer event on a
      // disabled element entirely (jsdom does not, which is why this needs
      // its own assertion rather than relying on the real-browser repro).
      expect(face.hasAttribute('disabled'), 'disabled would break the arrange-drag in a real browser').toBe(false);
      fireEvent.click(card.querySelector('.board-card__face')!);
      fireEvent.click(card.querySelector('[data-testid="card"]')!);
    }
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('a selectable player’s seat is a button that reports the player id; the other is inert', () => {
    const { interaction, onSelectCard, onSelectPlayer } = spyInteraction([], [them.id]);
    const { seat } = renderBoard(view, interaction);
    expect(seat(them.id).dataset.selectable).toBe('true');
    expect(seat(me.id).dataset.selectable).toBeUndefined();
    // Wave 31 §A.3 deleted `Regroup`, the one button of ours in the bar, so a seat
    // that is not selectable holds no button at all.
    expect(seat(me.id).querySelector('[data-player-bar] button')).toBeNull();
    fireEvent.click(seat(me.id).querySelector('.seat__name')!);
    // Their bar holds two ways to choose them — the name and the face. This is
    // the name.
    fireEvent.click(seat(them.id).querySelector<HTMLElement>('.seat__select')!);
    expect(onSelectPlayer.mock.calls).toEqual([[them.id]]);
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('a spell on the stack is selectable by its card id', () => {
    const spell = view.stack.find((s) => !s.isAbility)!;
    expect(spell.sourceCardId).not.toBeNull();
    const { interaction, onSelectCard } = spyInteraction([spell.sourceCardId!]);
    const { container } = renderBoard(view, interaction);
    // §S: `live/placed.ts` owns the drawing now — `Board` only wires `interaction`
    // through (`installPlaced`'s own `notify`, `PlacedInteraction`); the click
    // itself is `placed.test.ts`'s own "Q18" test. This is the end-to-end wiring.
    const item = container.querySelector<HTMLElement>(`[data-placed-spell="${spell.id}"]`)!;
    expect(item.dataset.selectable).toBe('');
    fireEvent.click(item);
    expect(onSelectCard.mock.calls).toEqual([[spell.sourceCardId]]);
  });

  /*
   * Q18 (wave 33 §B.1), reported while w32 ran: Glint Hawk Idol's own trigger
   * drew as clickable on the stack. Its `sourceCardId` is the permanent on
   * the battlefield, which Forge offers for its own (re-)activation, so the
   * stack entry became a second button for the SAME action — a click on it
   * called `onSelectCard(sourceId)`, exactly what clicking the permanent
   * does. Only a SPELL's card may ever be selectable by id this way (above);
   * an ability's never is, however Forge's `selectable` set reads at the
   * moment.
   */
  it('Q18: an ABILITY entry on the stack is never selectable by its card id, even while Forge offers that permanent', () => {
    const permanent = me.battlefield[0]!;
    const abilityEntry: StackEntry = {
      id: 999001,
      description: 'Deals 2 damage to any target.',
      sourceCardId: permanent.id,
      sourceName: permanent.card.name,
      sourceCard: permanent.card,
      controllerName: me.name,
      isAbility: true,
    };
    // Beside a spell: alone, an ability is drawn on its source, not in the row (the stack redesign; its own test below).
    const withAbilityOnStack: BoardView = { ...view, stack: [abilityEntry, view.stack[1]!] };
    // Forge really is offering this card id — for the permanent's own activation.
    const { interaction, onSelectCard } = spyInteraction([permanent.id]);
    const { container } = renderBoard(withAbilityOnStack, interaction);

    const item = container.querySelector<HTMLElement>(`[data-placed-spell="${abilityEntry.id}"]`)!;
    expect(item.dataset.selectable, 'inert, unlike a spell entry above').toBeUndefined();
    fireEvent.click(item);
    expect(onSelectCard).not.toHaveBeenCalled();

    // The permanent itself is still exactly as clickable as Forge said.
    const cardFace = container.querySelector<HTMLElement>(`[data-board-card="${permanent.id}"] > .board-card__face`)!;
    expect(cardFace.tagName).toBe('BUTTON');
    fireEvent.click(cardFace);
    expect(onSelectCard.mock.calls).toEqual([[permanent.id]]);
  });

  it('an id Forge names that is not on the board makes nothing clickable', () => {
    const { interaction } = spyInteraction([987654]);
    const { container } = renderBoard(view, interaction);
    expect(forgeButtons(container)).toHaveLength(0);
  });

  /**
   * R10 (wave 35), diagnosed: a creature taps to attack and, for one frame,
   * "Creature" and its rules text flicker over the art. Root cause — `live/match.ts`'s
   * `declaredAttackers` only re-adds a just-declared attacker to `selectable` once
   * Forge's `buttons` show "Call Back", a signal separate from the view's own
   * `Attacking` flag, so there is a real window where `selectable` goes
   * true → false → true for the same card across consecutive renders. Before this
   * fix, `CardOnBoard` drew `.board-card__face` as a `<button>` when selectable and
   * a `<div>` otherwise — an element-TYPE change, which React can only satisfy by
   * unmounting the old node and mounting a new one. That tore down `CardTile`'s
   * `<img>` each time, and for the frame before the fresh one painted, the text
   * underneath (normally hidden behind the art) showed through.
   *
   * This proves the fix structurally rather than by screenshot timing: the face
   * node's IDENTITY survives a selectable → inert → selectable round trip. Mutate
   * `CardOnBoard` back to the old `button`/`div` ternary and this fails (counts in
   * the lane report).
   */
  it("R10: a card's face never remounts when Forge toggles whether it may be chosen", () => {
    const id = me.battlefield[0]!.id;
    const { interaction: offered } = spyInteraction([id]);
    const { interaction: inert } = spyInteraction([]);
    const { container, rerender } = renderBoard(view, offered);
    const faceOf = () => container.querySelector<HTMLElement>(`[data-board-card="${id}"] > .board-card__face`)!;
    const first = faceOf();
    expect(first.tagName, 'offered: a real button').toBe('BUTTON');
    rerender(createElement(Board, { view, interaction: inert, boardLayout: 'type-separated' }));
    const second = faceOf();
    expect(second, 'the SAME node, not a new one, once Forge withdraws the offer').toBe(first);
    expect(second.tagName, 'still a button, now out of the tab order').toBe('BUTTON');
    expect(second.tabIndex).toBe(-1);
    rerender(createElement(Board, { view, interaction: offered, boardLayout: 'type-separated' }));
    const third = faceOf();
    expect(third, 'and still the same node once Forge re-offers it').toBe(first);
    expect(third.tabIndex).toBe(0);
  });
});

/**
 * Item 16 — the operator: *"things like morbid should be visible when they
 * are active. the 'orange glow' from hearthstone."* `data-can-act` is the
 * buildable half (`BoardInteraction.actionable`'s own note); see
 * `docs/planning/wave29-evidence/A-morbid.md` for the other half.
 */
describe('item 16 — a card that could do something glows (data-can-act)', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const glowing = me.battlefield[0]!;
  const plain = me.battlefield[1]!;

  it('a card in `actionable` carries data-can-act; one outside it does not', () => {
    const { interaction } = spyInteraction([], [], false, [glowing.id]);
    const { container } = renderBoard(view, interaction);
    expect(container.querySelector(`[data-board-card="${glowing.id}"]`)!.getAttribute('data-can-act')).toBe('true');
    expect(container.querySelector(`[data-board-card="${plain.id}"]`)!.hasAttribute('data-can-act')).toBe(false);
  });

  it('with no interaction at all, nothing glows — the safe default every fixture renders in', () => {
    const { container } = renderBoard(view);
    expect(container.querySelectorAll('[data-can-act]')).toHaveLength(0);
  });
});

/**
 * Item 17.2 — the operator: *"when playing a card, it should get put in the
 * 'decision area' and the arrow should draw from there."*
 */
describe('item 17.2 — a card being played is staged, and leaves its hand slot', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const staged = me.hand![0]!;

  it('the staged card is drawn once, inside .staging, and its own hand no longer holds it', () => {
    const { interaction } = spyInteraction([], [], true, [], staged.id);
    const { container } = renderBoard(view, interaction);

    const inStaging = container.querySelector(`.staging [data-board-card="${staged.id}"]`);
    expect(inStaging, 'the staging area draws it').not.toBeNull();
    // Exactly one element on the whole board carries this id — the invariant
    // `Board.tsx`'s own header states (`data-card-id` is unique across the
    // board), which two copies of the staged card would have broken.
    expect(container.querySelectorAll(`[data-board-card="${staged.id}"]`)).toHaveLength(1);

    const hand = container.querySelector('[data-zone="hand"][data-owner="you"]')!;
    expect(hand.querySelector(`[data-board-card="${staged.id}"]`), 'gone from the hand it was drawn from').toBeNull();
    // Every OTHER hand card is unaffected.
    expect(hand.querySelectorAll('[data-board-card]')).toHaveLength(me.hand!.length - 1);
  });

  it('with no stagedCardId, .staging is not on the page and the hand draws every card — the safe default', () => {
    const { interaction } = spyInteraction([]);
    const { container } = renderBoard(view, interaction);
    expect(container.querySelector('.staging')).toBeNull();
    const hand = container.querySelector('[data-zone="hand"][data-owner="you"]')!;
    expect(hand.querySelectorAll('[data-board-card]')).toHaveLength(me.hand!.length);
  });
});

/* ── our words, not their marks ────────────────────────────────────────── */

describe('marks', () => {
  /**
   * §A.7 drew `{T}` as the tap symbol inside the stack's own full-text line
   * (D20). **Superseded by T8 (wave 36), third ask**: the operator said the
   * stack shows what is happening, not all the text, so `item.description` —
   * Forge's own prose, `{T}` and all — is no longer drawn on the board at
   * all; wave 46 X3 went further and deleted the drawn line itself, moving
   * the same structured facts (who, what, at what) into `stackItemLabel`'s
   * `aria-label`, never drawn from the description string either way.
   * `ManaPip`/`RulesText` in this
   * file went with it (`Board.tsx` no longer imports either). The tap symbol
   * still ships from the Mana pack and `CardTile` still draws it in a card's
   * own printed rules text — unchanged, and proven by the inspector's own
   * suite (`inspect/index.test.ts`), which is what a hover now shows instead
   * of this board drawing a second copy of it.
   */
  it('draws costs as our own pips, and every card resolved', () => {
    const { view, zone } = renderBoard();
    expect(view.missingCardIds).toEqual([]);
    const boar = [...zone(1, 'battlefield').querySelectorAll('[data-testid="card"]')].find(
      (c) => c.querySelector('.card__name')?.textContent === 'Vulshok War Boar',
    )!;
    expect([...boar.querySelectorAll('.pip')].map((p) => (p as HTMLElement).dataset.token)).toEqual(['2', 'R', 'R']);
    expect(boar.querySelector('.card__stat')?.textContent).toBe('5/5');
  });
});

/* ── the canvas is static ─────────────────────────────────────────────── */

/**
 * The operator, 2026-09-24: *"the location for the stack causes the field to
 * change in size. this can never happen. the entire canvas must be fully
 * static at all times."*
 *
 * jsdom does not lay anything out, so this half of the proof is about the two
 * things a layout is made of that jsdom CAN see: the markup, which must not
 * gain or lose an element as a zone fills, and the stylesheet's tracks, which
 * must be named sizes rather than content. The other half — real boxes, in a
 * browser, on a live match at both window sizes — is
 * `e2e/table-fit.spec.ts`'s "the canvas is static" phase.
 */

const BOARD_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'board.css'), 'utf8');
const CARD_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'card.css'), 'utf8');
/** `CardTile`'s own sheet: every card the board draws is one. */
const TILE_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', '../components/CardTile.css'), 'utf8');

/**
 * A stylesheet with its comments taken out, so a grep for a rule cannot be
 * satisfied by PROSE about that rule — both files discuss `writing-mode` and
 * `rotate` at length.
 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const BOARD_RULES = withoutComments(BOARD_CSS);

/** The turn the cascade gives a card's own face — `rotate` or a `transform` carrying one. */
function turnOf(css: (el: Element, property: string) => string, boardCard: Element): string {
  const face = boardCard.querySelector(':scope > .board-card__face > .card')!;
  return `${css(face, 'rotate')} ${css(face, 'transform')}`;
}

/**
 * What the cascade gives a RENDERED element for `property`, with both
 * stylesheets on the document. jsdom matches selectors and resolves the
 * cascade but lays nothing out, so this answers "is it out of flow", "does it
 * take a click", "is it drawn at all" — never where a box lands, which is
 * `e2e/table-fit.spec.ts`'s. A test here reads a keyword or compares two
 * elements; it never pins a tuned value, so nudging a size needs no test edit.
 *
 * Per test, not file-wide: `card-size.ts` reads computed widths, and the rest
 * of this suite is written against a document with no stylesheet.
 */
function styled(): (el: Element, property: string) => string {
  const sheet = document.createElement('style');
  sheet.textContent = `${TILE_CSS}\n${BOARD_CSS}\n${CARD_CSS}`;
  document.head.append(sheet);
  onTestFinished(() => sheet.remove());
  return (el, property) => getComputedStyle(el).getPropertyValue(property).trim();
}

/** The fixture's own spell on the stack, repeated, so the only thing that varies is how many (a lone ABILITY draws on its source instead). */
function withStack(base: BoardView, n: number): BoardView {
  const seed = base.stack.find((item) => !item.isAbility) ?? base.stack[0]!;
  return { ...base, stack: Array.from({ length: n }, (_, i) => ({ ...seed, id: 9000 + i })) };
}

describe('the canvas is static', () => {
  const base = boardFromFixture(fixture);
  const counts = [0, 1, 5] as const;

  it('draws every other slot identically with 0, 1 and 5 items on the stack — the zone itself never grows a child', () => {
    const shots = counts.map((n) => {
      const { container } = renderBoard(withStack(base, n));
      const board = container.querySelector<HTMLElement>('.board')!;
      const stack = board.querySelector<HTMLElement>('[data-zone="stack"]')!;
      const overlay = board.querySelector<HTMLElement>('[data-board-overlay]')!;
      const shot = {
        // Everything outside the stack's own zone AND the overlay, byte for byte.
        // The overlay is `live/placed.ts`'s to vary — out of flow, so a track
        // never moves for it (the same exemption the inspector's panel and the
        // floating numbers already had).
        // Less each tile's faces key, a count of the tiles drawn so far.
        rest: board.outerHTML.replace(stack.outerHTML, '<!--stack-->').replace(overlay.outerHTML, '<!--overlay-->').replace(/ data-faces="[^"]*"/g, ''),
        // The viewer's battlefield on its own, because that is the box the
        // operator watched move.
        battlefield: board.querySelector<HTMLElement>('.seat[data-viewer] > [data-zone="battlefield"]')!.outerHTML.replace(/ data-faces="[^"]*"/g, ''),
        // The zone itself: always empty (§S — a non-visual anchor, never a row).
        slot: [...stack.children],
        // Every item really is drawn — just in the overlay, as a card at a point, not in this zone.
        items: overlay.querySelectorAll('[data-placed-spell]').length,
      };
      cleanup();
      return shot;
    });

    expect(shots.map((s) => s.items), 'the stack really did hold 0, 1 and 5').toEqual([0, 1, 5]);
    for (const i of [1, 2]) {
      expect(shots[i]!.rest, `everything but the stack and the overlay, with ${counts[i]} items`).toBe(shots[0]!.rest);
      expect(shots[i]!.battlefield, `the battlefield, with ${counts[i]} items`).toBe(shots[0]!.battlefield);
      expect(shots[i]!.slot, `the stack zone's own slot, with ${counts[i]} items`).toEqual(shots[0]!.slot);
    }
    // §S: the zone itself is a non-visual anchor now — no row, no label, no
    // children at all, at any count.
    expect(shots[0]!.slot).toEqual([]);
  });

  it('gives every zone its slot whether or not anything is in it', () => {
    const drained: BoardView = {
      ...base,
      stack: [],
      players: base.players.map((p) => ({
        ...p,
        battlefield: [],
        graveyard: [],
        exile: [],
        hand: p.hand === null ? null : [],
        handCount: 0,
      })),
    };
    const { container } = renderBoard(drained);
    const board = container.querySelector<HTMLElement>('.board')!;
    const zones = [...board.querySelectorAll<HTMLElement>('[data-zone]')];
    // 4 zones a seat, both seats, and the stack.
    expect(zones.map((z) => `${z.dataset.owner}/${z.dataset.zone}`)).toEqual([
      // Both piles are in `.seat__piles`, the REST of the seat's one left column
      // (wave 32 Q9) — so a seat's markup reads graveyard, exile, battlefield,
      // hand. The set is the same nine zones it has always been.
      'them/graveyard',
      'them/exile',
      'them/battlefield',
      'them/hand',
      'table/stack',
      'you/graveyard',
      'you/exile',
      'you/battlefield',
      'you/hand',
    ]);
    for (const z of zones) {
      // §S: the stack is a non-visual anchor now — no list, ever (`live/placed.ts` draws
      // every item elsewhere). Every other zone's list is its two tiers, under `.zone__tiers`,
      // for a default battlefield.
      if (z.dataset.zone !== 'stack') {
        expect(
          z.querySelector(':scope > ul, :scope > ol, :scope > .zone__tiers > ul'),
          `${z.dataset.owner} ${z.dataset.zone} still has its list`,
        ).not.toBeNull();
      }
      expect(z.dataset.count).toBe('0');
    }
  });

  it('draws everything that comes and goes mid-game out of flow, so no track moves for it', () => {
    const css = styled();
    const { container } = renderBoard({ ...base, missingCardIds: [4242] });
    for (const selector of ['.board__mid', '.board__warn', '.board__overlay']) {
      expect(css(container.querySelector(selector)!, 'position'), selector).toBe('absolute');
    }
  });
});

/* ── the table, blocked as the operator drew it (wave 26 §A) ─────────── */

/**
 * `docs/planning/board-layout-2026-09-27.md` is a spec the operator MADE, by
 * dragging the real regions on a 1280×800 canvas, and it is the thing this wave
 * builds to. jsdom does no layout, so what is checkable here is the markup and
 * the tracks; `e2e/table-fit.spec.ts` measures the boxes in a browser.
 */
describe('the table as the operator blocked it (§A)', () => {
  const view = boardFromFixture(fixture);

  /**
   * §A.1, and the only structural claim of the five that jsdom can settle: the
   * rows, top to bottom, with the HANDS OUTERMOST — read off the areas the
   * cascade gives the rendered board and seats, so the test says the order the
   * operator said and not the strings that produce it.
   */
  it('stacks four rows with each hand furthest from the middle', () => {
    const css = styled();
    const { container, seat } = renderBoard(view);
    const rowsOf = (el: Element): string[] =>
      css(el, 'grid-template-areas')
        .split(/["']/)
        .filter((part) => part.trim() !== '')
        .map((part) => part.trim());
    expect(rowsOf(container.querySelector('.board')!), 'the board: their seat, then ours').toEqual(['them', 'you']);
    // Which of the two CARD areas each row line holds, by name rather than by position.
    const cardRows = (el: Element): string[] =>
      rowsOf(el).map((line) => ['field', 'hand'].find((a) => line.split(/\s+/).includes(a)) ?? '?');
    expect([...cardRows(seat(1)).map((r) => `them/${r}`), ...cardRows(seat(0)).map((r) => `you/${r}`)]).toEqual([
      'them/hand',
      'them/field',
      'you/field',
      'you/hand',
    ]);
  });

  /**
   * §A.3. The operator, asked directly on 2026-09-27: *"yes drop the zone labels
   * too"*, and the panel chrome went with them.
   *
   * Two halves, because either alone would pass a board that still reads as a
   * stack of form fields: no zone on the TABLE may draw a head, and every zone
   * must still be findable — by its accessible name, by `data-zone` and by
   * `data-count`, which are what three e2e specs locate every card through.
   */
  it('draws no zone panel and no zone caption, and keeps every zone findable', () => {
    const { container, seat } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const tableZones = [...board.querySelectorAll<HTMLElement>('[data-zone]')].filter((z) => z.closest('.seat') !== null);
    expect(tableZones, 'four zones a seat, both seats').toHaveLength(8);
    for (const z of tableZones) {
      expect(z.querySelector('.zone__head'), `${z.dataset.owner}/${z.dataset.zone} draws no head`).toBeNull();
      expect(z.querySelector('.zone__gutter'), `${z.dataset.owner}/${z.dataset.zone} has no label column`).toBeNull();
      // Still named, still addressable: the identity moved out of the caption and
      // into the attributes and the accessibility tree.
      expect(z.getAttribute('aria-label'), `${z.dataset.zone} is named to a reader`).toMatch(
        /^.+ (Battlefield|Hand|Graveyard|Exile)$/,
      );
      expect(z.dataset.owner, `${z.dataset.zone} says whose it is`).toMatch(/^(you|them)$/);
      expect(z.dataset.count, `${z.dataset.zone} says how many`).toMatch(/^\d+$/);
    }
    // Nowhere in a seat, not one — and wave 46 X3 dropped the stack's own
    // `.zone__head` too (the approved demo and the "no explanatory text"
    // rule both go without it; `aria-label="Stack"` on the section carries
    // the accessible name that used to be the `<h3>`'s text).
    expect(seat(0).querySelectorAll('.zone__head')).toHaveLength(0);
    expect(seat(1).querySelectorAll('.zone__head')).toHaveLength(0);
    expect(board.querySelectorAll('.zone__head')).toHaveLength(0);
    expect(board.querySelector('[data-zone="stack"]')!.getAttribute('aria-label')).toBe('Stack');
    // And the four zone names are gone from the page's words entirely.
    for (const word of ['Battlefield', 'Graveyard', 'Exile']) {
      expect(board.textContent, `${word} is not written on the table`).not.toContain(word);
    }
  });

  /**
   * §A.5. The rail, the controls and the log button are PERMANENT overlays over
   * the right end of the board (`live/live.css`, lane B's), so a card may never
   * come to rest under them. `.board__bar { padding-right: 11rem }` was this trick
   * for the status line; the bar is deleted, so the reservation is on the rows.
   *
   * All four card rows, because a card can come to rest in any of them, and all
   * four the SAME, because four hand-written paddings is how three end up wrong.
   * How much is `e2e/table-fit.spec.ts`'s to measure against the real overlays.
   */
  it('reserves the same right end of every row for the permanent overlays, and none under the stack', () => {
    const css = styled();
    const { zone, container } = renderBoard(view);
    const reserved = [zone(0, 'battlefield'), zone(0, 'hand'), zone(1, 'battlefield'), zone(1, 'hand')].map((z) => css(z, 'padding-right'));
    expect(reserved[0], 'a row reserves something').not.toBe('');
    expect(new Set(reserved), 'and every row the same').toEqual(new Set([reserved[0]]));
    // A transient overlay reserves nothing: the stack and the question panel come
    // and go, so they cover what is under them (the operator, 2026-09-27).
    expect(css(container.querySelector('.board__mid')!, 'padding-right'), 'the stack reserves none of it').not.toBe(reserved[0]);
  });

  /**
   * §A.6. Nothing in this UI drew the mana pool at all before wave 26, which is
   * the defect behind the operator's report — Forge applies the pool to a cost
   * before it asks for the rest, so the mana worked and was simply invisible.
   *
   * Driven from the WIRE rather than a hand-typed view, because the mapping is
   * where this can go wrong: `PlayerView.updateMana` walks `ManaAtom.MANATYPES`,
   * whose colourless is 32 — `MagicColor.COLORLESS` is 0 and never appears — and
   * the committed capture's own keys are `{16, 32, 1, 2, 4, 8}`, all zero.
   */
  const withMana = (playerId: number, pool: [number, number][]): BoardView => {
    const state = new Map(foldPackets(loadPackets(fixture)).state);
    const key = deltaKey(DELTA_TYPE.player, playerId);
    const player = state.get(key)!;
    state.set(key, {
      ...player,
      Mana: { t: 'map', v: pool.map(([b, n]) => [{ t: 'byte', v: b }, { t: 'int', v: n }]) },
    } as WireObject);
    return toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId });
  };

  it('draws the floating mana a wire state carries, beside that seat’s own portrait', () => {
    // Two red, one white and one colourless, in ManaAtom's bytes and out of order.
    const { seat } = renderBoard(withMana(0, [[8, 2], [32, 1], [1, 1], [2, 0]]));
    const bar = seat(0).querySelector<HTMLElement>('[data-player-bar]')!;
    const pool = bar.querySelector<HTMLElement>('[data-mana-pool]')!;
    expect(pool, 'the pool is in the seat’s own bar').not.toBeNull();
    expect(pool.dataset.manaTotal).toBe('4');
    // WUBRG then colourless, ours and not the HashMap's; the zero is not a colour.
    expect([...pool.querySelectorAll<HTMLElement>('[data-mana]')].map((m) => [m.dataset.mana, m.dataset.manaCount])).toEqual([
      ['W', '1'],
      ['R', '2'],
      ['C', '1'],
    ]);
    expect(pool.textContent, 'the counts are drawn, not only coloured').toBe('121');
    // Each colour is the Mana font's own symbol, never its letter (operator, 2026-10-06).
    expect([...pool.querySelectorAll<HTMLElement>('[data-mana] i.ms')].map((i) => i.className)).toEqual([
      'ms ms-w ms-cost',
      'ms ms-r ms-cost',
      'ms ms-c ms-cost',
    ]);
    // Colour is never the only signal: the whole pool is in words to a reader.
    const mine = view.players.find((p) => p.isViewer)!.name;
    expect(pool.getAttribute('aria-label')).toBe(`${mine} mana pool: 1 white, 2 red, 1 colourless`);
    // It is against the portrait — one is the other's sibling in the bar — and it
    // is NOT a zone, so the set of zones on the board is untouched by it.
    expect(pool.parentElement!.querySelector(':scope > .seat__ident')).not.toBeNull();
    expect(pool.dataset.zone).toBeUndefined();
    // And the other seat, whose pool this state left empty, draws the same box
    // holding nothing: a pool arriving mid-turn may not move a track.
    const theirs = seat(1).querySelector<HTMLElement>('[data-mana-pool]')!;
    expect(theirs, 'every seat has the box').not.toBeNull();
    expect(theirs.dataset.manaTotal).toBe('0');
    expect(theirs.children).toHaveLength(0);
  });

  it('draws no pool at all from the committed capture, whose six colours are all zero', () => {
    // Read off the fixture, not assumed: every `Mana` in it is six zeroes, so six
    // pips would be six lies. The box is there; nothing is in it.
    const { seat } = renderBoard(view);
    for (const p of view.players) {
      expect(p.manaPool, `seat ${p.id}'s pool`).toEqual([]);
      const pool = seat(p.id).querySelector<HTMLElement>('[data-mana-pool]')!;
      expect(pool.dataset.manaTotal).toBe('0');
      expect(pool.children, `seat ${p.id} draws no pip`).toHaveLength(0);
    }
  });

  /**
   * R15 (wave 35): "the mana pool shows each colour as lands are tapped." The
   * pool itself already existed (§A.6, above); this is the one thing left to
   * prove given lane F's own change (the installed jar now offers a tap-only
   * mana ability at priority, so a land can be tapped before casting anything)
   * — that THIS component updates when the wire's `Mana` does, with no stale
   * cache or memo standing between them. Two renders of the SAME match, empty
   * then not — exactly the shape a tap produces over the real wire (`Mana`
   * arrives on the next `PlayerView`, nothing about the card that was tapped) —
   * proves it without needing a live Forge process in this suite: whether the
   * tap itself reaches the wire is lane F/S's own `lands.jvm.test.ts`.
   */
  it('updates reactively when a land is tapped mid-game: the pool goes from empty to coloured on the same seat', () => {
    const { container, rerender } = renderBoard(view);
    const seatOf = () => container.querySelector<HTMLElement>('[data-testid="player"][data-player-id="0"]')!;
    const poolOf = () => seatOf().querySelector<HTMLElement>('[data-mana-pool]')!;
    expect(poolOf().dataset.manaTotal, 'before: nothing tapped yet').toBe('0');
    expect(poolOf().children).toHaveLength(0);

    rerender(createElement(Board, { view: withMana(0, [[8, 1]]), boardLayout: 'type-separated' }));

    expect(poolOf().dataset.manaTotal, 'after: one land tapped for red').toBe('1');
    const pips = [...poolOf().querySelectorAll<HTMLElement>('[data-mana]')].map((m) => [m.dataset.mana, m.dataset.manaCount]);
    expect(pips).toEqual([['R', '1']]);

    // And tapping a second land grows the SAME pool rather than replacing it with a fresh one.
    rerender(createElement(Board, { view: withMana(0, [[8, 1], [1, 1]]), boardLayout: 'type-separated' }));
    expect(poolOf().dataset.manaTotal).toBe('2');
  });
});

/* ── no rotated text ─────────────────────────────────────────────────── */

/**
 * §C.1. The operator, 2026-09-26: *"vertical words are impossible to read, lets
 * try it differently"* — of `BATTLEFIELD`, `HAND` and `GRAVEYARD`, which were
 * set `writing-mode: vertical-rl`.
 *
 * Two halves, because either alone would pass a board that still reads
 * sideways: the stylesheets must set nothing on its side, and the labels must
 * actually still BE there, horizontal, with their counts.
 */
describe('no rotated text (operator, 2026-09-26)', () => {
  /** Anything that can turn text on its side, in a declaration. */
  const SIDEWAYS = /writing-mode\s*:|text-orientation\s*:|\brotate\s*:|\brotate\(/g;

  it('sets no text sideways in board.css, and rotates only a CARD in card.css', () => {
    expect(withoutComments(BOARD_CSS).match(SIDEWAYS), 'board.css turns nothing on its side').toBeNull();
    /*
     * card.css keeps exactly two kinds of rotation and neither is a word: a
     * flyer's tilt, a few degrees in depth as it loops (the operator,
     * 2026-10-15: "the card distortion should be a diagonal tilt") — its four
     * keyframes, each about the x or the y axis, never the screen's own — and
     * a tapped permanent turned a quarter inside a landscape box, which is the
     * operator's own affordance and stays. If a third one appears, this is the
     * test that says so.
     */
    const cards = withoutComments(CARD_CSS);
    const inCards = cards.match(SIDEWAYS) ?? [];
    expect(inCards, 'a flyer’s tilt, then the tapped card’s quarter turn ("marks tapped permanents by turning them")').toEqual(['rotate:', 'rotate:', 'rotate:', 'rotate:', 'rotate(']);
    for (const tilt of cards.match(/rotate:[^;]*/g) ?? []) expect(tilt, 'a tilt in depth, never a turn on the screen').toMatch(/rotate:\s*[xy]\s/);
  });

  it('draws the lane labels that are left horizontally, with their counts', () => {
    const { container, zone } = renderBoard();
    const board = container.querySelector<HTMLElement>('.board')!;
    /*
     * The ZONE captions the operator named are gone outright (§A.3) rather than
     * un-rotated, which is the stronger answer to the same complaint. What is left
     * is a battlefield's four LANE labels — a grouping this board invented — and
     * they read straight, label then count.
     */
    expect(
      [...zone(0, 'battlefield').querySelectorAll('.zone__row-head')].map((h) => h.textContent),
      'the battlefield’s four lane labels',
    ).toEqual(['Lands 4', 'Artifacts 0', 'Creatures 1', 'Other 0']);
    // And nothing anywhere on the board asks for a rotation inline either.
    for (const el of board.querySelectorAll<HTMLElement>('*')) {
      const style = el.getAttribute('style') ?? '';
      expect(style, `${el.className} rotates itself`).not.toMatch(/writing-mode|rotate/);
    }
  });
});

/* ── the seat's vertical bar ─────────────────────────────────────────── */

/**
 * §C.3. The operator, 2026-09-26: *"use a vertical bar for showing the players
 * health, avatar, name, hand, library. horizontal space is precious"*.
 *
 * All five live in one narrow column per seat, and ours stays distinguishable
 * from theirs — which in the new layout is the bar's OUTER track (the top of the
 * board for them, the bottom for us), the `(you)` beside our name, and
 * `data-viewer`. The boxes themselves are `e2e/table-fit.spec.ts`'s; what is
 * checkable here is that the markup and the tracks say it.
 */
describe('the seat’s vertical bar (#9)', () => {
  const view = boardFromFixture(fixture);

  it('holds the health, the avatar, the name, the hand count and the library count — all five, per seat', () => {
    const { seat } = renderBoard(view);
    for (const p of view.players) {
      const bar = seat(p.id).querySelector<HTMLElement>('[data-player-bar]')!;
      expect(bar, `seat ${p.id} has a bar`).not.toBeNull();
      // The avatar, drawn by us, with this seat's life on it and no image.
      const face = bar.querySelector<HTMLElement>('[data-player-face]')!;
      expect(Number(face.dataset.playerId)).toBe(p.id);
      expect(face.querySelector('svg')).not.toBeNull();
      expect(face.querySelector('img')).toBeNull();
      expect(within(bar).getByTestId('life').textContent).toBe(String(p.life));
      expect(bar.querySelector('.seat__name')!.textContent).toContain(p.name);
      // A symbol and a number since §A.10; the word is the accessible name.
      expect(within(bar).getByTestId('library-count').getAttribute('aria-label')).toBe(`library ${p.libraryCount}`);
      expect(within(bar).getByTestId('library-count').textContent).toBe(String(p.libraryCount));
      // One life total per seat, and it is the one on the avatar: the header
      // used to carry a second copy beside it.
      expect(seat(p.id).querySelectorAll('[data-testid="life"]')).toHaveLength(1);
      expect(face.contains(within(bar).getByTestId('life'))).toBe(true);
    }
  });

  it('is not a zone: the set of zones on this board is unchanged by it', () => {
    const { container } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    for (const bar of board.querySelectorAll<HTMLElement>('[data-player-bar]')) {
      expect(bar.dataset.zone, 'a bar is not a zone').toBeUndefined();
      /*
       * And it holds none either, since §A.2 gave the piles the left column's own
       * lower cell: wave 25 put the graveyard inside the bar to get it under the
       * portrait, and the operator's geometry gets it there without that.
       */
      expect([...bar.querySelectorAll<HTMLElement>('[data-zone]')].map((z) => z.dataset.zone)).toEqual([]);
    }
    expect([...board.querySelectorAll<HTMLElement>('[data-zone]')].map((z) => `${z.dataset.owner}/${z.dataset.zone}`)).toEqual([
      // The two piles of the left column, then the battlefield, then the hand —
      // and still the same nine zones.
      'them/graveyard',
      'them/exile',
      'them/battlefield',
      'them/hand',
      'table/stack',
      'you/graveyard',
      'you/exile',
      'you/battlefield',
      'you/hand',
    ]);
  });

  /**
   * Wave 32 Q9 (the operator: *"please place avatar, then the two counts, then the
   * rest of the space graveyard"*, and of any percentage *"honestly it's just a
   * guess"*). The seat's left column is ONE column, the seat's whole height: the
   * bar — avatar, counts, mana — in fixed tracks, then the piles with everything
   * that is left. It REVERSES wave 26 §A.2's two cells, so a graveyard confined to
   * the hand's rows is the regression this reads for.
   *
   * R3 (wave 35, the fourth ask): Q9's build put the mana pool BETWEEN the avatar
   * and the counts, which is not what the operator asked for ("avatar, [the]
   * counts, then the rest") — the counts were never actually next to the avatar.
   * The three elements' MARKUP order (asserted as a set below, not a sequence) is
   * unchanged; what changed is the `grid-row` each is given, asserted by the CSS
   * checks above and by the dedicated R3 test below, which is what decides the
   * order a player actually sees.
   */
  it('puts the piles in the REST of one left column: avatar, counts, then the graveyard takes the space', () => {
    const { seat } = renderBoard(view);
    for (const p of view.players) {
      const bar = seat(p.id).querySelector<HTMLElement>('[data-player-bar]')!;
      expect(bar.querySelector('[data-zone]'), `seat ${p.id}'s bar holds no zone`).toBeNull();
      expect(new Set([...bar.children].map((c) => c.className)), `seat ${p.id}'s bar holds exactly these four`).toEqual(
        new Set(['seat__ident', 'seat__status', 'seat__mana', 'seat__counts']),
      );
      const side = seat(p.id).querySelector<HTMLElement>(':scope > .seat__side')!;
      expect([...side.children].map((c) => c.className), `seat ${p.id}'s column: the bar, then the piles`).toEqual([
        'seat__who',
        'seat__piles',
      ]);
      const piles = side.querySelector<HTMLElement>('.seat__piles')!;
      expect(
        [...piles.querySelectorAll<HTMLElement>(':scope > [data-zone]')].map((z) => z.dataset.zone),
        `seat ${p.id}'s piles`,
      ).toEqual(['graveyard', 'exile']);
      expect(seat(p.id).querySelectorAll('[data-zone="graveyard"]'), 'one graveyard, not a copy').toHaveLength(1);
    }
  });

  /**
   * R3 (wave 35, the fourth ask): the operator's order, top to bottom, is
   * avatar, counts, then the rest — and the opponent's column is its vertical
   * mirror. Read off the rows the cascade gives each rendered element.
   */
  it('R3 / Q9: the viewer reads avatar, status, counts, mana down the column; the opponent reads it mirrored', () => {
    const css = styled();
    const { seat } = renderBoard(view);
    // The bar is a flex column in the markup's order; the opponent's runs it in reverse.
    const order = (id: number): string[] => {
      const bar = seat(id).querySelector<HTMLElement>('[data-player-bar]')!;
      const names = [...bar.children].map((el) => ['ident', 'status', 'counts', 'mana'].find((name) => el.classList.contains(`seat__${name}`))!);
      return css(bar, 'flex-direction') === 'column-reverse' ? names.reverse() : names;
    };
    expect(order(0), 'the viewer, top to bottom').toEqual(['ident', 'status', 'counts', 'mana']);
    expect(order(1), 'the opponent, top to bottom').toEqual(['mana', 'counts', 'status', 'ident']);
  });

  it('Q9: exile is drawn only while it holds a card', () => {
    const css = styled();
    const empty = renderBoard(view);
    expect(empty.zone(0, 'exile').dataset.count).toBe('0');
    expect(css(empty.zone(0, 'exile'), 'display'), 'an empty exile is not drawn').toBe('none');
    empty.unmount();
    const viewer = view.players.find((p) => p.isViewer)!;
    const exiled = { ...view, players: view.players.map((p) => (p.isViewer ? { ...p, exile: [viewer.battlefield[0]!] } : p)) };
    const { zone } = renderBoard(exiled);
    expect(css(zone(0, 'exile'), 'display'), 'one card, and it is').not.toBe('none');
  });

  it('marks a pile that holds a card Forge offers, however deep, and opens it with that card first', () => {
    // The operator, 2026-10-11, on Snapcaster Mage: "lets make sure that works smoothly even if the graveyard is very large."
    const viewer = view.players.find((p) => p.isViewer)!;
    const seed = viewer.battlefield[0]!;
    const yard = Array.from({ length: 60 }, (_, i) => ({ ...seed, id: 7000 + i }));
    const buried = 7020;
    const deep = { ...view, players: view.players.map((p) => (p.isViewer ? { ...p, graveyard: yard } : p)) };
    const idle = renderBoard(deep, spyInteraction([buried]).interaction);
    expect(idle.zone(viewer.id, 'graveyard').hasAttribute('data-can-act'), 'a selection naming it is not an offer to play').toBe(false);
    idle.unmount();
    const { zone, container } = renderBoard(deep, spyInteraction([buried], [], false, [buried]).interaction);
    const pile = zone(viewer.id, 'graveyard');
    expect(pile.hasAttribute('data-can-act')).toBe(true);
    expect(zone(viewer.id, 'exile').hasAttribute('data-can-act')).toBe(false);
    const css = styled();
    expect(css(pile, 'outline'), 'the offered pile is outlined').not.toBe(css(zone(viewer.id, 'exile'), 'outline'));
    fireEvent.click(pile.querySelector(`[data-board-card="${7059}"]`)!);
    const opened = [...container.querySelectorAll('[data-testid="pile-view"] [data-board-card]')].map((el) => Number(el.getAttribute('data-board-card')));
    expect(opened.length).toBe(60);
    expect(opened[0], 'the offered card first').toBe(buried);
    expect(opened[1], 'then newest first').toBe(7059);
  });

  it("draws a library's top card under its owner's avatar only while the seat may see it, never on the battlefield", () => {
    const hidden = renderBoard(view, undefined, 'single');
    expect(hidden.container.querySelector('[data-library-top]')).toBeNull();
    hidden.unmount();
    const owner = view.players[1]!;
    const top = { ...owner.battlefield[0]!, id: 8001 };
    const shown = renderBoard({ ...view, players: view.players.map((p, i) => (i === 1 ? { ...p, libraryTop: [top] } : p)) }, undefined, 'single');
    const library = shown.zone(owner.id, 'library');
    expect(library.querySelector('[data-board-card="8001"]')!.hasAttribute('data-library-top')).toBe(true);
    expect(library.parentElement!.classList.contains('seat__side'), 'in the seat column, with the avatar').toBe(true);
    const column = [...library.parentElement!.children];
    expect(column.indexOf(library), 'right after the avatar block').toBe(column.findIndex((el) => el.classList.contains('seat__who')) + 1);
    expect(shown.zone(owner.id, 'battlefield').querySelector('[data-board-card="8001"]'), 'not on the battlefield').toBeNull();
    expect(shown.zone(owner.id, 'battlefield').dataset.count, 'not counted as a permanent').toBe(String(owner.battlefield.length));
    shown.unmount();
    const under = { ...owner.battlefield[0]!, id: 8002, onlyViewer: true as const };
    const pile = renderBoard({ ...view, players: view.players.map((p, i) => (i === 1 ? { ...p, libraryTop: [top, under] } : p)) }, undefined, 'single');
    const cards = [...pile.zone(owner.id, 'library').querySelectorAll('[data-library-top]')];
    expect(cards.map((c) => c.getAttribute('data-board-card')), 'every known top card, top first').toEqual(['8001', '8002']);
    expect(cards.map((c) => c.hasAttribute('data-only-viewer')), 'marked when only this screen knows it').toEqual([false, true]);
  });

  it("sizes the library's top card from the column's height as well as its width, and the graveyard keeps a floor: the column fits at any UI scale", () => {
    const css = styled();
    const owner = view.players[1]!;
    const top = { ...owner.battlefield[0]!, id: 8001 };
    const { zone } = renderBoard({ ...view, players: view.players.map((p, i) => (i === 1 ? { ...p, libraryTop: [top] } : p)) }, undefined, 'single');
    const library = zone(owner.id, 'library');
    // At 125% on a 1280x800 window the avatar block and a whole top card are taller than the column (main's run: the graveyard at 832 in 800).
    expect(css(library, 'flex-shrink'), 'the top card gives way when the column is short').not.toBe('0');
    expect(css(library, 'min-height')).toBe('0px');
    expect(css(library.querySelector('.zone__cards')!, '--card-w'), 'drawn no taller than the box it is given').toMatch(/var\(--zone-h\)/);
    const piles = library.parentElement!.querySelector('.seat__piles')!;
    expect(css(piles, 'min-height'), 'the graveyard is never squeezed to nothing').not.toMatch(/^(0px|0|auto|)$/);
  });

  it("draws a card of someone else's hand this seat was shown face up in its place, and the rest as backs", () => {
    const them = view.players.find((p) => !p.isViewer)!;
    const known = { ...them.battlefield[0]!, id: 8101 };
    const { zone } = renderBoard({ ...view, players: view.players.map((p) => (p === them ? { ...p, handCount: 3, handShown: [null, known, null] } : p)) });
    const hand = zone(them.id, 'hand');
    const slots = [...hand.querySelectorAll('.card-backs > li')].map((li) => (li.hasAttribute('data-card-back') ? 'back' : li.getAttribute('data-board-card')));
    expect(slots).toEqual(['back', '8101', 'back']);
    expect(hand.querySelector('[data-board-card="8101"] .card__name')!.textContent).toBe(known.card.name);
  });

  it('tells ours from theirs: no visible (you); the seat says data-viewer and its accessible name says (you)', () => {
    const { container, seat } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const me = view.players.find((p) => p.isViewer)!;
    const them = view.players.find((p) => !p.isViewer)!;
    expect(seat(me.id).dataset.viewer).toBe('true');
    expect(seat(them.id).dataset.viewer).toBeUndefined();
    // §A.1 (P3): no text node anywhere in the seat reads `(you)`; the section's
    // accessible name is where it survives, for screen readers.
    expect(seat(me.id).querySelector('.seat__you')).toBeNull();
    expect(seat(me.id).textContent).not.toContain('(you)');
    expect(seat(me.id).getAttribute('aria-label')).toBe(`${me.name} (you)`);
    expect(seat(them.id).getAttribute('aria-label')).toBe(them.name);
    // The face carries it too, which is the hook `board.css` and the e2e spec
    // both select on (`[data-player-face][data-viewer]`).
    expect(board.querySelector<HTMLElement>('[data-player-face][data-viewer]')!.dataset.playerId).toBe(String(me.id));
    expect(board.querySelector<HTMLElement>('[data-player-face]:not([data-viewer])')!.dataset.playerId).toBe(String(them.id));
  });

  it('draws no word for whose turn it is, who holds priority or who lost', () => {
    const flagged: BoardView = {
      ...view,
      players: view.players.map((p) => ({ ...p, isActive: true, hasPriority: true, hasLost: true })),
    };
    const { seat } = renderBoard(flagged);
    // The name's mark and the avatar's ring say the first two; the result screen says the last (the operator, 2026-10-17: "weird [lost] text appears, we dont need that").
    for (const p of view.players) {
      const bar = seat(p.id).querySelector<HTMLElement>('[data-player-bar]')!;
      expect(bar.textContent, `seat ${p.id}'s bar`).not.toMatch(/\b(lost|priority)\b/i);
    }
  });
});

/* ── no prose ─────────────────────────────────────────────────────────── */

describe('no prose (operator, 2026-09-24)', () => {
  it('has no empty-state text, no hidden-hand sentence and no hint anywhere', () => {
    for (const view of [boardFromFixture(fixture), withStack(boardFromFixture(fixture), 0)]) {
      const { container } = renderBoard(view);
      const board = container.querySelector<HTMLElement>('.board')!;
      expect(board.querySelectorAll('.zone__empty, .zone__hidden, .stack__hint')).toHaveLength(0);
      expect(board.textContent).not.toMatch(/\bempty\b|\bhidden\b|top first/i);
      cleanup();
    }
  });
});

/* ── the DOM contract other lanes read ────────────────────────────────── */

describe('the DOM contract', () => {
  const view = boardFromFixture(fixture);

  it('gives every card a unique data-card-id, and keeps data-board-card beside it', () => {
    const { container } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const cards = [...board.querySelectorAll<HTMLElement>('.board-card')];
    // 5 + 8 battlefield, 3 + 3 graveyard, 5 in hand.
    expect(cards).toHaveLength(24);
    const ids = cards.map((c) => c.dataset.cardId);
    expect(ids.every((id) => id !== undefined && id !== '')).toBe(true);
    expect(cards.map((c) => c.dataset.boardCard)).toEqual(ids);
    expect(new Set(ids).size, 'no id twice').toBe(ids.length);
    // `[data-card-id="<id>"]` names exactly one thing — `CardTile` draws its
    // own `data-card-id`, in the draft's `w<id>` namespace, on the tile inside.
    for (const id of ids) expect(board.querySelectorAll(`[data-card-id="${id}"]`), `card ${id}`).toHaveLength(1);
    expect(board.querySelector(`[data-card-id="${ids[0]}"]`)!.className).toBe('board-card');
    expect(board.querySelector(`[data-card-id="w${ids[0]}"]`)!.getAttribute('data-testid')).toBe('card');
  });

  it('gives every player a face, and leaves the seat its own id and its clickable name', () => {
    const { container, seat } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const faces = [...board.querySelectorAll<HTMLElement>('[data-player-face]')];
    expect(faces.map((f) => Number(f.dataset.playerId))).toEqual([1, 0]);
    // Each face is in its own seat's vertical bar, which `board.css` anchors at
    // that seat's outer edge — the top of the board for them, the bottom for us.
    for (const f of faces) {
      const inSeat = f.closest('.seat');
      expect(inSeat, 'a face is in a seat').not.toBeNull();
      expect(f.closest('[data-player-bar]'), 'a face is in its seat’s vertical bar').not.toBeNull();
      expect(Number(inSeat!.getAttribute('data-player-id')), 'a face is in ITS OWN seat').toBe(Number(f.dataset.playerId));
    }
    expect(board.querySelector('.board__mid [data-player-face]'), 'no face is left in the centre band').toBeNull();
    for (const p of view.players) {
      const face = board.querySelector<HTMLElement>(`[data-player-face][data-player-id="${p.id}"]`)!;
      expect(within(face).getByTestId('life').textContent, `${p.name}'s life is on their face`).toBe(String(p.life));
      // Drawn, not fetched: shapes we own, no image, no asset.
      expect(face.querySelector('svg')).not.toBeNull();
      expect(face.querySelector('img')).toBeNull();
      // And the seat still answers to the same id, for the suites that query it.
      expect(seat(p.id).dataset.playerId).toBe(String(p.id));
    }
  });

  it('gives every zone a zone name and a side', () => {
    const { container, seat } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    for (const z of board.querySelectorAll<HTMLElement>('[data-zone]')) {
      expect(['you', 'them', 'table'], `${z.dataset.zone} has a side`).toContain(z.dataset.owner);
      const inSeat = z.closest('.seat');
      if (inSeat === null) expect(z.dataset.owner).toBe('table');
      else expect(z.dataset.owner).toBe(inSeat === seat(0) ? 'you' : 'them');
    }
    expect(board.querySelector('[data-zone="stack"]')!.getAttribute('data-owner')).toBe('table');
  });

  it('puts a positioned overlay root at the board’s top level, drawn in only by live/placed.ts (§S)', () => {
    const { container } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const overlays = [...board.querySelectorAll<HTMLElement>('[data-board-overlay]')];
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.parentElement).toBe(board);
    expect(overlays[0]!.className).toBe('board__overlay');
    // This lane's own JSX renders nothing into it and hangs no handler on it
    // — `live/placed.ts`, booted imperatively the same way the inspector and
    // the floating numbers are, draws the fixture's own two stack items here.
    for (const el of overlays[0]!.children) {
      expect(['placed', 'placed__arrow', 'placed__defs'].some((c) => el.classList.contains(c)), 'live/placed.ts’s own class, never another lane’s').toBe(true);
    }
    expect(overlays[0]!.querySelectorAll('[data-placed-spell]'), 'the fixture’s own two stack items').toHaveLength(2);
  });
});

/* ── the battlefield reads like a table ───────────────────────────────── */

/**
 * The operator, 2026-09-25: the battlefield's *"ordering random"*, and they
 * want lands, artifacts and creatures apart. The fixture is the case that
 * matters: seat 1 holds four Mountains, two Great Furnaces (`Artifact Land`)
 * and a Goblin Replica (`Artifact Creature`), so it proves the overlap rule as
 * well as the grouping — a land you tap is a land, an artifact that attacks is
 * a creature.
 */
describe('the battlefield’s rows (#10)', () => {
  const ROWS = ['lands', 'artifacts', 'creatures', 'other'];

  it('draws all four rows, labelled and counted, on YOUR side — the opponent’s is always the default board (Q15c)', () => {
    const { seat, zone } = renderBoard();
    expect(seat(1).querySelectorAll('[data-board-row]'), 'the layout preference is mine only').toHaveLength(0);
    for (const id of [0]) {
      const rows = [...zone(id, 'battlefield').querySelectorAll<HTMLElement>('[data-board-row]')];
      expect(rows.map((r) => r.dataset.boardRow), `seat ${id}'s rows, in order`).toEqual(ROWS);
      // A lane reports its PILES, one `<li>` each, not every card in them, and
      // `board.css` turns that into the lane's share of the width (`--cols`
      // divided by the zone's row count). Nothing is stacked in the fixture, so
      // here the two numbers agree; the stacking tests below are where they part.
      expect(
        rows.map((r) => r.style.getPropertyValue('--cols')),
        `seat ${id}'s lanes report the columns they draw`,
      ).toEqual(rows.map((r) => String(r.querySelectorAll(':scope > ul.zone__cards > li.board-card').length)));
      // And the zone reports the whole battlefield, because the row count is one
      // decision for all four lanes and no selector can sum across them.
      const list = zone(id, 'battlefield').querySelector<HTMLElement>(':scope > ul.zone__rows')!;
      expect(list.style.getPropertyValue('--cols'), `seat ${id}'s battlefield reports every column`).toBe(
        String(rows.reduce((n, r) => n + r.querySelectorAll(':scope > ul.zone__cards > li.board-card').length, 0)),
      );
      for (const r of rows) {
        const head = r.querySelector('.zone__row-head')!;
        const cards = r.querySelectorAll('.board-card').length;
        expect(head.textContent, `seat ${id}'s ${r.dataset.boardRow} is labelled and counted`).toBe(
          `${r.dataset.boardRow![0]!.toUpperCase()}${r.dataset.boardRow!.slice(1)} ${cards}`,
        );
        // An empty row says so in an attribute, not by disappearing: the four
        // rows are four tracks and the first artifact must not add one.
        expect(r.dataset.empty, `seat ${id}'s ${r.dataset.boardRow} marks empty`).toBe(cards === 0 ? 'true' : undefined);
      }
      expect(seat(id).querySelectorAll('[data-board-row]')).toHaveLength(4);
    }
  });

  it('puts each permanent in the row its own type line asks for', () => {
    const { rowIds, view } = renderBoard();
    // Seat 0: four lands (two gates, two islands) and one creature.
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    expect(rowIds(0, 'creatures')).toEqual([21]);
    expect(rowIds(0, 'artifacts')).toEqual([]);
    expect(rowIds(0, 'other')).toEqual([]);
    // Seat 1 is drawn in the default layout whatever mine is (Q15c), where an
    // `Artifact Land` is a land (the back row) and an `Artifact Creature` is not.
    const them = view.players.find((p) => p.id === 1)!;
    expect(them.battlefield.find((c) => c.id === 116)!.card.typeLine).toBe('Artifact Land');
    expect(them.battlefield.find((c) => c.id === 67)!.card.typeLine).toBe('Artifact Creature — Goblin');
  });

  it('files a plain artifact, an enchantment and a planeswalker where they belong', () => {
    const base = boardFromFixture(fixture);
    const me = base.players.find((p) => p.isViewer)!;
    const seed = me.battlefield[0]!;
    const typed = (id: number, typeLine: string) => ({ ...seed, id, card: { ...seed.card, cardId: `w${id}`, typeLine } });
    const view: BoardView = {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              battlefield: [
                typed(901, 'Artifact — Equipment'),
                typed(902, 'Enchantment — Aura'),
                typed(903, 'Legendary Planeswalker — Jace'),
                typed(904, 'Legendary Artifact Creature — Golem'),
                typed(905, 'Snow Land'),
              ],
            },
      ),
    };
    const { rowIds } = renderBoard(view);
    expect(rowIds(0, 'lands')).toEqual([905]);
    expect(rowIds(0, 'artifacts')).toEqual([901]);
    expect(rowIds(0, 'creatures')).toEqual([904]);
    expect(rowIds(0, 'other')).toEqual([902, 903]);
  });
});

/* ── the arrangement is the player's, and it outlives a resync ────────── */

/**
 * §A.2: *"a player drags a permanent within and between rows. The arrangement
 * is THEIRS — persisted per match in the client, keyed by card id, and it
 * survives a resync. It sends NOTHING to the engine."*
 *
 * The drag is a pointer drag (wave 32 Q4b), so these tests press, move and
 * release real pointer events on a fake layout (`dragCard`, above) — there is no
 * `dragstart` any more.
 */
describe('drag to arrange (#10)', () => {
  /** Drag a card in front of another card, or onto a row's own box. */
  function drag(container: HTMLElement, cardId: number, onto: { card: number } | { row: string }) {
    dragCard(container, cardId, 'card' in onto ? { card: onto.card, at: 'before' } : { slot: onto.row });
  }

  it('reorders within a row', () => {
    const { container, rowIds } = renderBoard();
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    drag(container, 25, { card: 24 });
    expect(rowIds(0, 'lands')).toEqual([8, 25, 24, 6]);
    // And the count on the zone and the row are still the truth.
    expect(container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"]')!.dataset.count).toBe('5');
    expect(container.querySelector('.seat[data-viewer] [data-board-row="lands"] .zone__row-head')!.textContent).toBe('Lands 4');
  });

  it('moves a permanent into another row, dropped on the row itself', () => {
    const { container, rowIds } = renderBoard();
    drag(container, 8, { row: 'other' });
    expect(rowIds(0, 'lands')).toEqual([24, 6, 25]);
    expect(rowIds(0, 'other')).toEqual([8]);
    expect(container.querySelector<HTMLElement>('.seat[data-viewer] [data-board-row="other"]')!.dataset.empty).toBeUndefined();
    // Every card is still on the board exactly once — three lanes read
    // `data-card-id` and uniqueness is the property they need.
    const ids = [...container.querySelectorAll<HTMLElement>('.board-card')].map((c) => c.dataset.cardId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(24);
  });

  it('tells `onOwnArrangement` of each drop — the viewer’s rows, never the hand — and `applyTheirArrangement` draws the OTHER side in its owner’s piles', () => {
    // The operator, 2026-10-08: the opponent's board must show a card where they actually put it.
    const { container } = renderBoard();
    const told: Parameters<OwnArrangementListener>[0][] = [];
    const stop = onOwnArrangement((change) => told.push(change));
    drag(container, 8, { row: 'other' });
    stop();
    expect(told).toHaveLength(1);
    expect(told[0]!.playerId).toBe(0);
    expect(told[0]!.rows.other).toEqual([[8]]);
    expect(Object.keys(told[0]!.rows)).not.toContain('hand');
    expect(told[0]!.rows.lands?.flat()).toEqual([24, 6, 25]);

    // Their side, in their order: the view's lands reversed, as they placed them.
  });

  it('`expectPlacement` reserves a real gap in the OTHER side’s row at once, and the card it names is drawn in it when it arrives — never at the row’s end first', () => {
    // The operator, 2026-10-08, watching from the opponent's seat: "i first briefly see it flash to the
    // default position, then correct itself to where it was actually placed."
    const first = renderBoard(undefined, undefined, 'single');
    const them = first.view.players.find((p) => !p.isViewer)!;
    const tierIds = (c: HTMLElement, tier: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="player"][data-player-id="${them.id}"] [data-zone="battlefield"] [data-tier="${tier}"] > li`)].map((li) => (li.classList.contains('zone__gap') ? (li.hasAttribute('data-expected') ? 'GAP*' : 'gap') : String(li.dataset.cardId)));
    const before = tierIds(first.container, 'back');
    expect(before.length).toBeGreaterThan(1);
    act(() => expectPlacement(them.id, 'back', { kind: 'before', id: Number(before[1]) }, 9901));
    expect(tierIds(first.container, 'back'), 'a reserved gap, before the second card, the moment it is expected').toEqual([before[0], 'GAP*', ...before.slice(1)]);
    // Their card arrives: it is drawn where the gap was, in the same render.
    const arrived = { ...them.battlefield[0]!, id: 9901, name: 'Arrival' };
    const next = { ...first.view, players: first.view.players.map((p) => (p.id === them.id ? { ...p, battlefield: [...p.battlefield, arrived] } : p)) } as typeof first.view;
    first.rerender(createElement(Board, { view: next, boardLayout: 'single' }));
    expect(tierIds(first.container, 'back'), 'the arrival took the gap').toEqual([before[0], '9901', ...before.slice(1)]);
    expect(pendingPlacementFor(them.id), 'and nothing is left waiting').toBeNull();
  });

  it('`applyTheirArrangement` before the first render of a reloaded tab keeps the viewer’s own arrangement from sessionStorage (T10)', () => {
    // Forge run 37719372048 on main: a reload restored the viewer's rows from sessionStorage only when
    // nothing had written the store first; the opponent's replayed arrangement had.
    const first = renderBoard();
    const them = first.view.players.find((p) => !p.isViewer)!.id;
    // The viewer tidies (a real drop: persisted to sessionStorage, as `survives a resync` proves).
    drag(first.container, 25, { card: 8 });
    expect(first.rowIds(0, 'lands')).toEqual([25, 8, 24, 6]);
    // Their side is drawn as mirrored tiers whatever the layout: their rows are `back` / `front`.
    const theirBack = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(`[data-testid="player"][data-player-id="${them}"] [data-zone="battlefield"] [data-tier="back"] li.board-card`)].map((li) => Number(li.dataset.cardId));
    const theirs = theirBack(first.container);
    expect(theirs.length).toBeGreaterThan(1);
    first.unmount();
    forgetArrangements();
    // A reload: the store is empty; their replayed arrangement lands BEFORE the board's first render.
    act(() => applyTheirArrangement(first.view, them, { back: [...theirs].reverse().map((id) => [id]) }));
    const second = renderBoard(first.view);
    expect(second.rowIds(0, 'lands'), 'the viewer’s own rows came back from sessionStorage').toEqual([25, 8, 24, 6]);
    expect(theirBack(second.container), 'and theirs are as replayed').toEqual([...theirs].reverse());
  });

  it('`applyTheirArrangement` draws the OTHER side in its owner’s piles, under their player id, touching nothing of the viewer’s', () => {
    const { view, zone } = renderBoard(undefined, undefined, 'single');
    const them = view.players.find((p) => !p.isViewer)!.id;
    const tierIds = (id: number, tier: string) => [...zone(id, 'battlefield').querySelectorAll<HTMLElement>(`[data-tier="${tier}"] li.board-card`)].map((c) => Number(c.dataset.cardId));
    const theirs = tierIds(them, 'back');
    const theirFront = tierIds(them, 'front');
    const mine = tierIds(0, 'back');
    expect(theirs.length).toBeGreaterThan(1);
    const reversed = [...theirs].reverse();
    act(() => applyTheirArrangement(view, them, { back: reversed.map((id) => [id]) }));
    expect(tierIds(them, 'back'), 'their back tier is in THEIR order now').toEqual(reversed);
    expect(tierIds(them, 'front'), 'a tier they did not name keeps the view’s order').toEqual(theirFront);
    expect(tierIds(0, 'back'), 'the viewer’s own side is untouched').toEqual(mine);
  });

  it('drops in front of the card it was dropped on, in another row', () => {
    const { container, rowIds } = renderBoard();
    drag(container, 24, { card: 21 });
    expect(rowIds(0, 'creatures')).toEqual([24, 21]);
    expect(rowIds(0, 'lands')).toEqual([8, 6, 25]);
  });

  it('survives a resync: a new view, a remount, or both', () => {
    const first = renderBoard();
    drag(first.container, 25, { card: 8 });
    expect(first.rowIds(0, 'lands')).toEqual([25, 8, 24, 6]);

    // A resync replaces the whole view — a new `seq`, every object again — and
    // may remount the board. The arrangement is neither in the view nor in
    // React's state, so both survive it.
    cleanup();
    const resynced: BoardView = { ...boardFromFixture(fixture), seq: 4242 };
    const after = renderBoard(resynced);
    expect(after.rowIds(0, 'lands')).toEqual([25, 8, 24, 6]);

    // A permanent that arrives after the arrangement joins the end of its row
    // rather than the middle of an order the player chose.
    cleanup();
    const seed = resynced.players.find((p) => p.isViewer)!.battlefield[0]!;
    const withNewLand: BoardView = {
      ...resynced,
      players: resynced.players.map((p) =>
        !p.isViewer ? p : { ...p, battlefield: [{ ...seed, id: 777, card: { ...seed.card, cardId: 'w777' } }, ...p.battlefield] },
      ),
    };
    const grown = renderBoard(withNewLand);
    expect(grown.rowIds(0, 'lands')).toEqual([25, 8, 24, 6, 777]);
  });

  it('is per match: another match starts from the default grouping', () => {
    const { container, rowIds } = renderBoard();
    drag(container, 25, { card: 8 });
    expect(rowIds(0, 'lands')).toEqual([25, 8, 24, 6]);
    cleanup();
    const elsewhere = renderBoard({ ...boardFromFixture(fixture), title: 'another match entirely' });
    expect(elsewhere.rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
  });

  it('sends nothing to the engine: no selection, no reply, only the view moved', () => {
    const view = boardFromFixture(fixture);
    /*
     * The senders are armed on the very cards being dragged — Forge's ACTIONABLE
     * set, which is the state at priority and the one the arrangement now stays
     * alive through — plus both players. So a stray call would land on exactly
     * the ids under the drag, and the drag still happens.
     */
    const { interaction, onSelectCard, onSelectPlayer } = spyInteraction([8, 24], [0, 1]);
    const { container, rowIds } = renderBoard(view, interaction);
    expect(container.querySelector<HTMLElement>('[data-card-id="8"]')!.dataset.selectable, 'armed on 8').toBe('true');
    expect(container.querySelector<HTMLElement>('[data-card-id="8"]')!.hasAttribute('data-arrange-card'), 'and still draggable').toBe(true);
    drag(container, 8, { card: 24 });
    drag(container, 24, { row: 'artifacts' });
    expect(rowIds(0, 'artifacts')).toEqual([24]);
    expect(onSelectCard).not.toHaveBeenCalled();
    expect(onSelectPlayer).not.toHaveBeenCalled();
    // And the view the board was handed is untouched: the arrangement is ours.
    expect(view.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id)).toEqual([8, 24, 21, 6, 25]);
  });

  it('is the viewer’s own battlefield only, and there is no reset control', () => {
    const { container, seat } = renderBoard();
    // Five permanents. The hand is never this component's own drag, whatever
    // `interaction` says — see `describe('a hand card is never this component’s own drag')`.
    expect(seat(0).querySelectorAll('[data-zone="battlefield"] .board-card[data-arrange-card]')).toHaveLength(5);
    expect(seat(0).querySelectorAll('[data-zone="hand"] .board-card[data-arrange-card]')).toHaveLength(0);
    expect(seat(0).querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(5);
    // A pile is Forge's own order, never the player's.
    expect(seat(0).querySelectorAll('[data-zone="graveyard"] .board-card[data-arrange-card]')).toHaveLength(0);
    expect(seat(0).querySelectorAll('[data-zone="exile"] .board-card[data-arrange-card]')).toHaveLength(0);
    // The opponent's side is theirs to arrange, on their own screen.
    expect(seat(1).querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-arrange-reset]'), 'Regroup is gone (§A.3)').toHaveLength(0);
  });

  it('a card let go over the opponent’s battlefield stays where it was', () => {
    const { container, rowIds, zone } = renderBoard();
    // Far from every slot of ours: nowhere to snap, so nothing moves.
    dragCard(container, 8, { point: { x: 500, y: -1500 } });
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    const tier = (name: string) =>
      [...zone(1, 'battlefield').querySelectorAll<HTMLElement>(`[data-tier="${name}"] > .board-card`)].map((c) => Number(c.dataset.cardId));
    expect(tier('back'), 'their lands are exactly as the engine sent them').toEqual([87, 78, 93, 83, 116, 118]);
    expect(tier('front')).toEqual([99, 67]);
  });
});

/* ── stacking: deliberate as well as free ─────────────────────────────── */

/**
 * §A.1 / §A.5. The operator, 2026-09-27: *"i dont want these snapping zones…
 * put cards wherever they want… snap above/below each other in any order"*.
 *
 * Which THIRD of a card's box a drop lands in is the whole gesture, so every
 * test here has to give the element a box: jsdom lays nothing out and every
 * `getBoundingClientRect` is zeros, which `Board.tsx` reads as "no geometry" and
 * treats as the old reorder. That fallback is why the drag tests above still
 * pass unchanged, and it is not the behaviour a browser gets.
 */
describe('drag to stack (#1, #19)', () => {
  /**
   * Drop `cardId` on `ontoId`: `top`/`bottom` land in the big stacking region
   * (upper/lower half, away from either edge); `edge` lands in the thin
   * reorder strip at the card's left edge — most of the card stacks, not
   * just its top and bottom thirds.
   */
  function dragOnto(container: HTMLElement, cardId: number, ontoId: number, where: 'top' | 'edge' | 'bottom') {
    dragCard(container, cardId, { card: ontoId, at: where === 'edge' ? 'before' : where });
  }

  /** The viewer's lands lane, as columns of piles: each column bottom card first. */
  function columns(container: HTMLElement, row = 'lands'): number[][] {
    const lane = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-board-row="${row}"]`)!;
    return [...lane.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li.board-card')].map((base) => [
      Number(base.dataset.cardId),
      ...[...base.querySelectorAll<HTMLElement>(':scope > ul.board-card__pile > li.board-card')].map((m) => Number(m.dataset.cardId)),
    ]);
  }

  it('stacks ON TOP when the drop lands in the upper half, away from the edges', () => {
    const { container, rowIds } = renderBoard();
    dragOnto(container, 25, 8, 'top');
    expect(columns(container), '25 is on 8, and the lane is one column shorter').toEqual([[8, 25], [24], [6]]);
    // Every card is still drawn, still once, and still in its lane.
    expect(rowIds(0, 'lands')).toEqual([8, 25, 24, 6]);
  });

  it('stacks UNDERNEATH when the drop lands in the lower half, away from the edges', () => {
    const { container } = renderBoard();
    dragOnto(container, 25, 8, 'bottom');
    expect(columns(container), '25 is under 8').toEqual([[25, 8], [24], [6]]);
  });

  it('still reorders when the drop lands in the thin edge strip (W7)', () => {
    const { container } = renderBoard();
    dragOnto(container, 25, 24, 'edge');
    expect(columns(container), 'four columns, nothing stacked').toEqual([[8], [25], [24], [6]]);
  });

  it('W7: stacks even dead centre, at the card’s vertical middle — the old middle-third reorder band is gone', () => {
    const { container } = renderBoard();
    layOut(container);
    const box = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"]')!.getBoundingClientRect();
    // Dead centre horizontally, and at the card's own vertical middle — under
    // the old thirds rule this fell in the reorder band and did not stack at all.
    dragCard(container, 25, { point: { x: (box.left + box.right) / 2, y: box.top + box.height * 0.4 } });
    expect(columns(container), '25 stacks on 8 from a drop at its dead centre').toEqual([[8, 25], [24], [6]]);
  });

  it('builds a pile of three and lets the player choose the order inside it', () => {
    const { container } = renderBoard();
    // A pile is targeted through its base card (the one the others fan from), so
    // the order inside it is chosen by which side of the base each card is put on.
    dragOnto(container, 24, 8, 'top');
    dragOnto(container, 6, 8, 'top');
    expect(columns(container)).toEqual([[8, 6, 24], [25]]);
    // And a member of the pile can be re-stacked UNDER the base.
    dragOnto(container, 6, 8, 'bottom');
    expect(columns(container)).toEqual([[6, 8, 24], [25]]);
  });

  it('a pile is one column: the lane asks for one card of width per pile', () => {
    const { container } = renderBoard();
    dragOnto(container, 25, 8, 'top');
    const lane = container.querySelector<HTMLElement>('.seat[data-viewer] [data-board-row="lands"]')!;
    // Three columns, four cards — this is exactly where the two numbers part.
    expect(lane.style.getPropertyValue('--cols'), 'the lane asks for its columns').toBe('3');
    expect(lane.querySelectorAll(':scope > ul.zone__cards > li.board-card')).toHaveLength(3);
    expect(lane.querySelectorAll('.board-card')).toHaveLength(4);
    // The lane's own label still counts CARDS, which is what is on the board.
    expect(lane.querySelector('.zone__row-head')!.textContent).toBe('Lands 4');
    expect(container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"]')!.dataset.count).toBe('5');
  });

  /**
   * `card.css`'s own `--pile-fan` cascade only ever reached the BASE card —
   * the default rule `.board-card { --pile-fan: 0px }` matches every nested
   * pile member too and wins there, so a fanned member drew at its full,
   * un-narrowed width while the base (the one actually visible) drew
   * narrowed by the whole fan: one card in the pile really was smaller than
   * the rest. Fixed by setting `--pile-fan` inline, from the pile's own
   * size, on every card of it — this is the proof, at the DOM level: base
   * and every member carry the identical value, growing with depth and
   * capping at Forge's own `UI_MAX_STACK_DEPTH` (a pile of 8 fans no further
   * than a pile of 4) — `stacking.spec.ts` proves the on-screen pixels
   * agree, in a real browser.
   */
  it('every card in a pile shares the same --pile-fan, from 2 cards to 8, base and members alike (W12)', () => {
    const base = boardFromFixture(fixture);
    const me = base.players.find((p) => p.isViewer)!;
    const seed = me.battlefield.find((c) => c.id === 8)!;
    // Four more lands beyond the fixture's own 25/24/6, so the pile can reach 8.
    const extra = [701, 702, 703, 704].map((id) => ({ ...seed, id, card: { ...seed.card, cardId: `w${id}` } }));
    const view: BoardView = {
      ...base,
      players: base.players.map((p) => (p.isViewer ? { ...p, battlefield: [...p.battlefield, ...extra] } : p)),
    };
    const { container } = renderBoard(view);
    const fanOf = (id: number) => container.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!.style.getPropertyValue('--pile-fan');
    // A lone card sets no inline fan at all — the lone-card markup is unchanged.
    expect(fanOf(8)).toBe('');
    // Pile sizes 2, 3, 4: the fan grows by one `--stack-step` (8px) each time.
    const growth = [
      [25, '8px'],
      [24, '16px'],
      [6, '24px'],
    ] as const;
    for (const [id, expected] of growth) {
      dragOnto(container, id, 8, 'top');
      expect(fanOf(8), `pile of this size`).toBe(expected);
    }
    // Pile sizes 5 through 8: capped at 24px — Forge's own `UI_MAX_STACK_DEPTH`
    // (4 cards: the base plus 3 fanned), so a pile of nine fans no further
    // than a pile of four and stays legible.
    for (const id of [701, 702, 703, 704]) {
      dragOnto(container, id, 8, 'top');
      expect(fanOf(8), 'capped past Forge’s own stack-depth limit').toBe('24px');
    }
    const base8 = container.querySelector<HTMLElement>('[data-card-id="8"]')!;
    expect(base8.dataset.pileSize).toBe('8');
    const fan = fanOf(8);
    const members = [...base8.querySelectorAll<HTMLElement>(':scope > ul.board-card__pile > li.board-card')];
    expect(members, 'seven cards fanned on the base, eight total').toHaveLength(7);
    for (const m of members) {
      expect(fanOf(Number(m.dataset.cardId)), `member ${m.dataset.cardId} gets the pile’s own fan, not card.css’s un-narrowed default`).toBe(
        fan,
      );
    }
  });

  it('keeps every card’s own data-card-id, unique across the board, at every depth', () => {
    const { container } = renderBoard();
    dragOnto(container, 24, 8, 'top');
    dragOnto(container, 6, 8, 'top');
    const board = container.querySelector<HTMLElement>('.board')!;
    const ids = [...board.querySelectorAll<HTMLElement>('.board-card')].map((c) => c.dataset.cardId);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size, 'no id twice, pile or not').toBe(24);
    for (const id of ids) expect(board.querySelectorAll(`[data-card-id="${id}"]`), `card ${id}`).toHaveLength(1);
    // The pile marks its own depth, which is what `card.css` fans on.
    const base = container.querySelector<HTMLElement>('[data-card-id="8"]')!;
    expect(base.dataset.pileSize).toBe('3');
    expect(base.dataset.pileDepth, 'the bottom of a pile is depth 0 and says nothing').toBeUndefined();
    expect(
      [...base.querySelectorAll<HTMLElement>(':scope > ul.board-card__pile > li')].map((m) => m.dataset.pileDepth),
    ).toEqual(['1', '2']);
    // A lone card is a pile of one and carries neither attribute.
    const alone = container.querySelector<HTMLElement>('[data-card-id="25"]')!;
    expect(alone.dataset.pileSize).toBeUndefined();
    expect(alone.querySelector('.board-card__pile')).toBeNull();
  });

  it('unstacks a card dropped on the row’s own box', () => {
    const { container } = renderBoard();
    dragOnto(container, 25, 8, 'top');
    expect(columns(container)).toEqual([[8, 25], [24], [6]]);
    dragCard(container, 25, { slot: 'lands' });
    expect(columns(container), '25 is its own column again, at the row’s end').toEqual([[8], [24], [6], [25]]);
  });

  /** The viewer's battlefield with `n` more copies of land 8, ids 801…, so a pile of copies can be made. */
  function withCopiesOf8(n: number): BoardView {
    const base = boardFromFixture(fixture);
    const seed = base.players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === 8)!;
    const extra = Array.from({ length: n }, (_, i) => ({ ...seed, id: 801 + i }));
    return { ...base, players: base.players.map((p) => (p.isViewer ? { ...p, battlefield: [...p.battlefield, ...extra] } : p)) };
  }
  const countOn = (container: HTMLElement, id: number) =>
    container.querySelector<HTMLElement>(`[data-card-id="${id}"] > .board-card__copies`)?.textContent ?? null;

  it('a pile of copies wears ×N on its base, and the count follows cards joining and leaving it', () => {
    const { container } = renderBoard(withCopiesOf8(2));
    expect(container.querySelectorAll('.board-card__copies'), 'nothing stacked, nothing counted').toHaveLength(0);
    dragOnto(container, 801, 8, 'top');
    expect(countOn(container, 8)).toBe('×2');
    dragOnto(container, 802, 8, 'top');
    expect(countOn(container, 8)).toBe('×3');
    expect(container.querySelectorAll('.board-card__copies'), 'one count per pile, never on its members').toHaveLength(1);
    dragCard(container, 802, { slot: 'lands' });
    expect(countOn(container, 8), 'one left the pile').toBe('×2');
    dragCard(container, 801, { slot: 'lands' });
    expect(countOn(container, 8), 'a lone card has no count').toBeNull();
  });

  /*
   * The operator, 2026-10-20: "notice the extra 1/1 below the stacks of tokens causing a new row? …
   * the stacks of tokens have become very small and cannot fit both the 2x and the 1/1". A crowded
   * row squeezes its columns under `--card-w` (the grid's `minmax`), so anything sized from
   * `--card-w` is sized for a card wider than the one drawn: the pile's `<li>` stood taller than
   * its face and the P/T hung below the stack. jsdom lays nothing out, so this pins the rules;
   * `zone-box.ts` measures the drawn width and `e2e/bd-pile-pills.spec.ts` the result in a real browser.
   */
  it('a pile is sized from the width it is drawn at, never the column ceiling, and its count stacks clear of the P/T', () => {
    const rules = (css: string, selector: RegExp) =>
      [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => selector.test(sel!)).map(([, sel, body]) => `${sel!.trim()} { ${body!.trim()} }`);
    const pileRules = rules(BOARD_CSS, /\.board-card\[data-pile-size\]/);
    expect(pileRules.length, 'board.css sizes a pile').toBeGreaterThan(0);
    for (const rule of pileRules) expect(rule, 'a pile’s box never reads the column ceiling').not.toMatch(/--card-w/);
    expect(pileRules.join('\n'), 'the fan is added below the face, which is as tall as the card drawn').toMatch(/padding-bottom:\s*var\(--pile-fan\)/);
    const sized = rules(CARD_CSS, /^\s*\.board-card\[data-pile-size\],\s*\.board-card__pile > \.board-card\s*$/).join('\n');
    expect(sized, 'every card of a pile measures the face it draws, from the width it was drawn at').toMatch(/--face-w:\s*calc\(var\(--card-drawn-w/);
    expect(sized, 'the credit strip is a tenth of that face').toMatch(/--credit-strip:\s*calc\(var\(--face-w\)/);
    const count = rules(CARD_CSS, /\.board-card\[data-pile-size\]\s*>\s*\.board-card__copies\s*$/).join('\n');
    expect(count, 'the count stops above the P/T badge').toMatch(/var\(--pt-h\)/);
  });

  it('what a combat-ready card wears rises with its face, a flyer’s on top of its loop', () => {
    const css = CARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const lift = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(lift('.board-card[data-combat-ready] > .board-card__face'), 'the face rises 4px').toMatch(/translate:\s*0 -4px/);
    expect(lift('.board-card[data-combat-ready] > :not(.board-card__face, .board-card__pile)'), 'and its badges with it').toMatch(/translate:\s*0 -4px/);
    const flyer = lift('.board-card[data-flying][data-combat-ready] > :not(.board-card__face, .board-card__pile)');
    expect(flyer, 'a flyer’s rests 4px over its own rest').toMatch(/translate:\s*0 -7px/);
    const riding = lift('.board-card[data-flying] > .board-card__face > .card,\n.board-card[data-flying] > :not(.board-card__face, .board-card__pile)');
    expect(riding, 'and rides its loop on top of that rest').toContain('--fly-path');
    expect(riding, 'added to the rest, not in place of it').toMatch(/animation-composition:\s*add/);
  });

  /**
   * Wave 76 §C. The operator, 2026-10-26: *"red attacking outline should hover with flying
   * creatures"*. `outline` paints along `.board-card__face`'s own box, which the flight loop never
   * moves (each part — the art, the protection layer, the shadow — runs its OWN `fly-*` animation
   * instead of the face moving and its children inheriting that move, `flight.ts`'s module header);
   * so a static `outline` sat still while the art floated inside it. The fix: while flying AND
   * attacking, the static outline is OFF, replaced by a `::before` ring with its own `--fly-path`
   * animation — the same two declarations `.board-card__protection` already carries, just above it
   * in the file, for the identical reason. Grounded attackers (no `[data-flying]`) are untouched:
   * `Board.test.ts`'s own "whether or not it is vigilant" case above this one still reads the plain
   * static outline. `e2e/fly-jump.spec.ts` is the real-browser proof (both engines); this is the fast,
   * local one.
   */
  it('the attacking outline is a floating layer while flying, never the static one', () => {
    const css = withoutComments(CARD_CSS);
    const lift = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(lift('.board-card[data-flying][data-attacking] > .board-card__face'), 'the static outline is off while flying').toMatch(/outline:\s*none/);
    // The SAME selector also names this `::before` in the reduced-motion exclusion list below, so every
    // match is taken and the real rule (it draws something — `content:`) is picked out from the dummy one.
    const beforeRule = new RegExp(`${'.board-card[data-flying][data-attacking] > .board-card__face::before'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    const ring = [...css.matchAll(beforeRule)].map((m) => m[1]!).find((body) => /content:/.test(body)) ?? '';
    expect(ring, 'the ring rule was found at all').not.toBe('');
    expect(ring, 'a ring in the same danger token the grounded outline uses').toContain('var(--danger)');
    expect(ring, 'rides the SAME loop the art does').toContain('--fly-path');
    expect(ring, 'added to its own base offset, not in place of it').toMatch(/animation-composition:\s*add/);
    // Reduced motion stops the ring looping too, same as every other part of a flyer.
    expect(css, 'reduced motion turns the ring off along with everything else it flies').toMatch(
      /prefers-reduced-motion: reduce\) \{[^@]*\[data-flying\]\[data-attacking\][^}]*board-card__face::before[^}]*\{\s*animation: none;/,
    );
  });

  it('a pile that mixes cards has no count', () => {
    const view = withCopiesOf8(1);
    const { container } = renderBoard(view);
    const name = (id: number) => view.players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === id)!.card.name;
    expect(name(25), 'the fixture’s 25 is a different card from 8').not.toBe(name(8));
    dragOnto(container, 801, 8, 'top');
    expect(countOn(container, 8)).toBe('×2');
    dragOnto(container, 25, 8, 'top');
    expect(container.querySelector<HTMLElement>('[data-card-id="8"]')!.dataset.pileSize, 'three cards in the pile').toBe('3');
    expect(countOn(container, 8), 'two copies and another card are not copies').toBeNull();
  });

  it('the other seat’s pile of copies wears the same count', () => {
    const base = boardFromFixture(fixture);
    const them = base.players.find((p) => !p.isViewer)!;
    const seed = them.battlefield[0]!;
    const view: BoardView = {
      ...base,
      players: base.players.map((p) => (p.id === them.id ? { ...p, battlefield: [...p.battlefield, { ...seed, id: 901 }, { ...seed, id: 902 }] } : p)),
    };
    const { container } = renderBoard(view, undefined, 'single');
    const tier = container.querySelector<HTMLElement>(`[data-card-id="${seed.id}"]`)!.closest<HTMLElement>('[data-tier]')!.dataset.tier!;
    act(() => applyTheirArrangement(view, them.id, { [tier]: [[seed.id, 901, 902]] }));
    expect(countOn(container, seed.id)).toBe('×3');
    act(() => applyTheirArrangement(view, them.id, { [tier]: [[seed.id, 901], [902]] }));
    expect(countOn(container, seed.id), 'one left their pile').toBe('×2');
  });

  it('survives a resync, piles and all', () => {
    const first = renderBoard();
    dragOnto(first.container, 24, 8, 'top');
    expect(columns(first.container)).toEqual([[8, 24], [6], [25]]);
    cleanup();
    const after = renderBoard({ ...boardFromFixture(fixture), seq: 9999 });
    expect(columns(after.container), 'a new view and a new mount draw the same piles').toEqual([[8, 24], [6], [25]]);
  });

  it('a card dropped on ITSELF changes nothing', () => {
    const { container } = renderBoard();
    dragOnto(container, 8, 8, 'top');
    expect(columns(container)).toEqual([[8], [24], [6], [25]]);
  });

  /* ── a. the arrangement sends NOTHING to the engine ─────────────────── */

  /**
   * The safety control: a rearrange is invisible to Forge. Every sender the
   * board has is counted, across every gesture this lane owns — reorder, stack
   * above, stack below, unstack — with every card and both players
   * declared selectable, which is the state in which a stray click WOULD send.
   */
  it('sends nothing to the engine: no sender is called by any arrangement gesture', () => {
    const view = boardFromFixture(fixture);
    const me = view.players.find((p) => p.isViewer)!;
    /*
     * Armed on every card of the viewer's own battlefield — Forge's ACTIONABLE
     * set, no selection open, which is the state at priority — and both players.
     * So every id under every gesture below is one a stray sender call would
     * land on, and every one of them is still draggable.
     */
    const { interaction, onSelectCard, onSelectPlayer } = spyInteraction(
      me.battlefield.map((c) => c.id),
      view.players.map((p) => p.id),
    );
    const { container } = renderBoard(view, interaction);
    expect(container.querySelectorAll('.board-card[data-selectable]').length, 'the senders really are armed').toBe(5);
    expect(
      container.querySelectorAll('.seat[data-viewer] [data-zone="battlefield"] .board-card[data-arrange-card]'),
      'and all of them draggable',
    ).toHaveLength(5);
    dragOnto(container, 24, 8, 'top');
    dragOnto(container, 6, 8, 'bottom');
    dragOnto(container, 25, 24, 'edge');
    dragCard(container, 24, { slot: 'other' });

    // The board really did move — so the zero below is not "nothing happened".
    expect(container.querySelector('.seat[data-viewer] [data-board-row="other"]')!.querySelectorAll('.board-card')).toHaveLength(1);
    expect(onSelectCard, 'no card was selected by a drag').not.toHaveBeenCalled();
    expect(onSelectPlayer, 'no player was selected by a drag').not.toHaveBeenCalled();
    expect(onSelectCard.mock.calls.length + onSelectPlayer.mock.calls.length, 'zero senders invoked').toBe(0);
    // And the view the board was handed is untouched: the arrangement is ours.
    expect(view.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id)).toEqual([8, 24, 21, 6, 25]);
  });

  /* ── b. only the viewer's own battlefield is arrangeable ────────────── */

  it('rejects the gesture on an opponent’s battlefield — no drag, no drop, no pile', () => {
    const { container, seat } = renderBoard();
    // Nothing on their side is draggable or a drop target in the first place.
    expect(seat(1).querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(0);

    // Their own card: a press on it starts nothing, so there is no ghost.
    const theirCard = container.querySelector<HTMLElement>('.seat:not([data-viewer]) [data-card-id="78"]')!;
    fireEvent.pointerDown(theirCard, { ...POINTER, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { ...POINTER, clientX: 80, clientY: 80 });
    expect(container.querySelector('[data-arrange-ghost]'), 'nothing of theirs is picked up').toBeNull();
    fireEvent.pointerUp(window, { ...POINTER, clientX: 80, clientY: 80 });
    // And one of OURS let go over theirs, which is the drag they might do by
    // accident: their side may not become a place we arrange.
    dragCard(container, 8, { point: { x: 500, y: -1500 } });

    const theirLane = container.querySelector<HTMLElement>('.seat:not([data-viewer]) [data-tier="back"]')!;
    expect(
      [...theirLane.querySelectorAll<HTMLElement>(':scope > li.board-card')].map((c) => Number(c.dataset.cardId)),
      'their lands are exactly as the engine sent them',
    ).toEqual([87, 78, 93, 83, 116, 118]);
    expect(theirLane.querySelectorAll('.board-card__pile'), 'nothing on their side is a pile').toHaveLength(0);
    // Ours did not move either — the drag went nowhere at all.
    expect(columns(container)).toEqual([[8], [24], [6], [25]]);
  });

  /* ── c. Forge's attachment truth survives a rearrange ───────────────── */

  /**
   * §A.2 (#11). `AttachedCards` is Forge's answer about the board, so an
   * equipped creature and its gear are one stack whatever the player does with
   * the arrangement — including dragging the gear away.
   */
  describe('an equipped creature and its gear are one stack (#11)', () => {
    /** The fixture, with an Equipment attached to the viewer's Fire Urchin (21). */
    function equipped(): BoardView {
      const base = boardFromFixture(fixture);
      const me = base.players.find((p) => p.isViewer)!;
      const seed = me.battlefield[0]!;
      const gear: BoardCard = {
        ...seed,
        id: 901,
        card: { ...seed.card, cardId: 'w901', name: 'Bonesplitter', typeLine: 'Artifact — Equipment' },
        attachedToId: 21,
        attachedCardIds: [],
      };
      return {
        ...base,
        players: base.players.map((p) =>
          !p.isViewer
            ? p
            : {
                ...p,
                battlefield: [
                  ...p.battlefield.map((c) => (c.id === 21 ? { ...c, attachedCardIds: [901] } : c)),
                  gear,
                ],
              },
        ),
      };
    }

    it('draws them as one stack, with the creature at the bottom of the pile', () => {
      const { container } = renderBoard(equipped());
      expect(columns(container, 'creatures'), 'the gear is in the creature’s pile').toEqual([[21, 901]]);
      // And NOT in the artifacts lane its own type line would have put it in.
      expect(columns(container, 'artifacts')).toEqual([]);
      const gear = container.querySelector<HTMLElement>('[data-card-id="901"]')!;
      expect(gear.dataset.pileDepth, 'the gear sits above the creature').toBe('1');
      expect(gear.dataset.attached, 'and says Forge attached it — not the player').toBe('true');
      expect(container.querySelector<HTMLElement>('[data-card-id="21"]')!.dataset.pileSize).toBe('2');
    });

    it('holds after the player rearranges, moves the host, and stacks something else on it', () => {
      const { container } = renderBoard(equipped());
      // Move the host into another lane, twice, and stack a land on it.
      dragCard(container, 21, { slot: 'other' });
      expect(columns(container, 'other'), 'the gear went with its creature').toEqual([[21, 901]]);
      dragOnto(container, 8, 21, 'top');
      expect(columns(container, 'other'), 'the land is on the pile and the gear is still in it').toEqual([[21, 901, 8]]);
      expect(columns(container, 'creatures')).toEqual([]);
    });

    it('cannot be pulled apart: dragging the gear out puts it straight back', () => {
      const { container } = renderBoard(equipped());
      dragCard(container, 901, { slot: 'lands' });
      expect(columns(container, 'lands'), 'the gear is not a card of the lands lane').toEqual([[8], [24], [6], [25]]);
      expect(columns(container, 'creatures'), 'it is back on its creature').toEqual([[21, 901]]);
      // Nor by stacking it onto an unrelated card.
      dragOnto(container, 901, 8, 'top');
      expect(columns(container, 'lands')).toEqual([[8], [24], [6], [25]]);
      expect(columns(container, 'creatures')).toEqual([[21, 901]]);
    });

    it('attachedToId never builds a stack by itself — only a host’s attachedCardIds does', () => {
      // Card 21's own attachedCardIds is still the claim, so it still stacks whatever this
      // decoy attachedToId says — the HOST's `AttachedCards` is the one authority.
      const base = equipped();
      const view: BoardView = {
        ...base,
        players: base.players.map((p) =>
          !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === 901 ? { ...c, attachedToId: 99999 } : c)) },
        ),
      };
      const { container } = renderBoard(view);
      expect(columns(container, 'creatures')).toEqual([[21, 901]]);
      cleanup();
      forgetArrangements();
      // With the claim gone, it is its own column again, in its own lane.
      const unclaimed: BoardView = {
        ...view,
        players: view.players.map((p) =>
          !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === 21 ? { ...c, attachedCardIds: [] } : c)) },
        ),
      };
      const after = renderBoard(unclaimed);
      expect(columns(after.container, 'creatures')).toEqual([[21]]);
      expect(columns(after.container, 'artifacts')).toEqual([[901]]);
    });
  });

  /**
   * Item 6 (playtest 2026-10-24, m-32b7a3ef1a95): the new player put Spreading Seas on the
   * opponent's Inkmoth Nexus; afterwards the aura sat in the new player's OWN back row, unfolded,
   * because `withAttachments` only ever looked at the attaching player's own `battlefield` array —
   * the host, on the other seat's battlefield, was invisible to it. The fault was CONTROL (whose
   * card the attachment is), not land-vs-creature, so both an aura and an equipment reproduce it,
   * and the fix is the same for any attachment kind: it follows its host, wherever on the table
   * that host actually is.
   */
  describe('an attachment follows its HOST, whoever controls the attachment (item 6)', () => {
    const base = boardFromFixture(fixture);
    const me = base.players.find((p) => p.isViewer)!;
    const them = base.players.find((p) => !p.isViewer)!;

    /** `hostId`, on the OPPONENT's battlefield, claims a new attachment the VIEWER controls. */
    function crossControlled(hostId: number, attachmentId: number, typeLine: string): BoardView {
      const seed = me.battlefield[0]!;
      const attachment: BoardCard = {
        ...seed,
        id: attachmentId,
        card: { ...seed.card, cardId: `w${attachmentId}`, name: `Cross-controlled ${attachmentId}`, typeLine },
        attachedCardIds: [],
        attachedToId: hostId,
      };
      return {
        ...base,
        players: base.players.map((p) => {
          if (p.id === them.id) return { ...p, battlefield: p.battlefield.map((c) => (c.id === hostId ? { ...c, attachedCardIds: [attachmentId] } : c)) };
          if (p.id === me.id) return { ...p, battlefield: [...p.battlefield, attachment] };
          return p;
        }),
      };
    }

    /**
     * A seat's piles for one row, by player id rather than `[data-viewer]` — both sides. The
     * opponent's own board is always `single` (Q15c), whose rows are a `ul[data-tier]` with no
     * `[data-board-row]` wrapper at all, so both markups are tried.
     */
    function pilesOf(container: HTMLElement, playerId: number, row: string): number[][] {
      const seat = container.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${playerId}"]`)!;
      const lane =
        seat.querySelector<HTMLElement>(`[data-board-row="${row}"] > ul.zone__cards`) ??
        seat.querySelector<HTMLElement>(`ul.zone__cards[data-tier="${row}"]`);
      if (lane === null) return [];
      return [...lane.querySelectorAll<HTMLElement>(':scope > li.board-card')].map((el) => [
        Number(el.dataset.cardId),
        ...[...el.querySelectorAll<HTMLElement>(':scope > ul.board-card__pile > li.board-card')].map((m) => Number(m.dataset.cardId)),
      ]);
    }

    // The opponent's own board is always `single` (Q15c) whatever layout the viewer picked —
    // one lane of lands in `back`, everything else in `front` — never the type-separated lanes.
    it('my aura on their land draws in THEIR pile, not mine', () => {
      const mountain = them.battlefield.find((c) => c.card.name === 'Mountain')!;
      const { container } = renderBoard(crossControlled(mountain.id, 902, 'Enchantment — Aura'));
      expect(pilesOf(container, them.id, 'back'), 'the host’s pile, on their board').toContainEqual([mountain.id, 902]);
      expect(pilesOf(container, me.id, 'lands').flat(), 'not drawn on my own board at all').not.toContain(902);
      expect(pilesOf(container, me.id, 'other').flat(), 'nor dumped in an unmanaged lane of mine').not.toContain(902);
      const gear = container.querySelector<HTMLElement>('[data-card-id="902"]')!;
      expect(gear.dataset.attached, 'still Forge’s attachment, not the player’s').toBe('true');
    });

    it('my equipment on their creature draws in THEIR pile, not mine', () => {
      const boar = them.battlefield.find((c) => c.card.name === 'Vulshok War Boar')!;
      const { container } = renderBoard(crossControlled(boar.id, 903, 'Artifact — Equipment'));
      expect(pilesOf(container, them.id, 'front'), 'the host’s pile, on their board').toContainEqual([boar.id, 903]);
      expect(pilesOf(container, me.id, 'artifacts').flat(), 'not drawn on my own board at all').not.toContain(903);
      expect(pilesOf(container, me.id, 'other').flat()).not.toContain(903);
    });
  });
});

/* ── a card Forge is ASKING ABOUT belongs to Forge, not to the arrangement ── */

/**
 * The two gestures on this board must not both fire on one press, and the line
 * between them is an OPEN SELECTION — not Forge's actionable set.
 *
 * The interaction lane starts its targeter drag on `pointerdown` over a card in
 * `interaction.selectable`; a `data-arrange-card` element starts `useArrangeDrag`
 * from the same press, so a card that was both would rearrange the board and
 * send a `selectCard` from one gesture.
 *
 * The first cut at this gated on `selectable` alone and was wrong, which the real
 * e2e caught: `selectable` also carries `setWeaklySelectable`, Forge's
 * ACTIONABLE set, which on your own turn is most of your own permanents — so
 * arranging was dead for most of a game and `e2e/table-fit.spec.ts` red with a
 * permanent that would not move between rows. `selectionOpen` is the narrow
 * fact, and every assertion below is on the ATTRIBUTE because that is what both
 * gestures read.
 */
describe('an OPEN SELECTION stands the arrangement down; merely actionable does not', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const lands = [8, 24, 6, 25];
  const card = (container: HTMLElement, id: number) =>
    container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${id}"]`)!;

  /*
   * The distinction this whole block exists for, and it is Forge's own:
   *
   *   - `setSelectables` — **exactly two call sites in all of Forge**, both
   *     selection inputs (`InputSelectEntitiesFromList.java:57`,
   *     `InputSelectTargets.java:68`). Forge is ASKING.
   *   - `setWeaklySelectable` — priority, mana payment, declare attackers,
   *     declare blockers (`PlayerControllerHuman.pushActionableCards`). Forge is
   *     saying you COULD. On your own turn that is most of your own permanents.
   *
   * Both reach the board in `interaction.selectable`; only the first sets
   * `selectionOpen`. Gating the arrangement on the second killed free placement
   * for most of a game, and `e2e/table-fit.spec.ts` red on exactly that.
   */

  it('an ACTIONABLE card on your own battlefield is still draggable — the e2e red', () => {
    // Forge's actionable set at priority: every permanent with something to do.
    // No selection is open, so `selectionOpen` is false, which is its default.
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id));
    const { container, zone } = renderBoard(view, interaction);
    expect(container.querySelectorAll('.board-card[data-selectable]').length, 'Forge really did offer them').toBe(5);
    expect(
      zone(0, 'battlefield').querySelectorAll('.board-card[data-arrange-card]'),
      'all five stay arrangeable: actionable is not a question',
    ).toHaveLength(5);
    // And the drag really works, which is what the e2e was asserting.
    const { rowIds } = renderBoard(view, interaction);
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
  });

  it('a card in an OPEN SELECTION is NOT draggable; the rest of the board still is', () => {
    const chosen = [8, 6];
    const { interaction } = spyInteraction(chosen, [], true);
    const { container } = renderBoard(view, interaction);

    for (const id of chosen) {
      expect(card(container, id).dataset.selectable, `card ${id} is what Forge is asking about`).toBe('true');
      expect(card(container, id).hasAttribute('data-arrange-card'), `card ${id} is Forge’s while it asks`).toBe(false);
    }
    for (const id of lands.filter((l) => !chosen.includes(l))) {
      expect(card(container, id).dataset.selectable, `card ${id} is not in the selection`).toBeUndefined();
      expect(card(container, id).hasAttribute('data-arrange-card'), `card ${id} is still yours to arrange`).toBe(true);
    }
    expect(card(container, 21).hasAttribute('data-arrange-card'), 'and the creature').toBe(true);
    // No card is ever both, however it got there.
    for (const el of container.querySelectorAll<HTMLElement>('.board-card')) {
      expect(
        el.hasAttribute('data-arrange-card') && el.hasAttribute('data-selectable'),
        `card ${el.dataset.cardId} is both draggable and in the selection`,
      ).toBe(false);
    }
  });

  it('with a selection open over the whole battlefield, nothing is draggable', () => {
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id), [], true);
    const { container } = renderBoard(view, interaction);
    expect(container.querySelectorAll('.board-card[data-arrange-card]'), 'the whole board is Forge’s while it asks').toHaveLength(0);
  });

  it('defaults to no selection open when the field is absent', () => {
    // The safe default, and the state every fixture and `live/parity.test.ts`
    // render in: an interaction that never mentions `selectionOpen` leaves the
    // board fully arrangeable.
    const interaction: BoardInteraction = {
      selectable: new Set(me.battlefield.map((c) => c.id)),
      selectablePlayers: new Set(),
      onSelectCard: () => undefined,
      onSelectPlayer: () => undefined,
    };
    expect('selectionOpen' in interaction, 'the field really is absent').toBe(false);
    const { zone } = renderBoard(view, interaction);
    expect(zone(0, 'battlefield').querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(5);
  });

  it('with nothing offered at all, every card of your own battlefield is draggable — the hand never is', () => {
    const { interaction } = spyInteraction([]);
    const { container, seat, zone } = renderBoard(view, interaction);
    expect(zone(0, 'battlefield').querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(5);
    expect(zone(0, 'hand').querySelectorAll('.board-card[data-arrange-card]'), 'no hand card is ever this component’s own drag').toHaveLength(0);
    expect(seat(1).querySelectorAll('.board-card[data-arrange-card]'), 'still never theirs').toHaveLength(0);
    expect(container.querySelectorAll('[data-selectable]')).toHaveLength(0);
  });

  it('holds for a card inside a pile: the selected member is not draggable, the base is', () => {
    /*
     * The pile is built FIRST, with no selection open — a card an open selection
     * holds cannot be dragged onto anything, which is the rule under test. Then
     * Forge asks about the member and the board is re-rendered: the arrangement
     * is in the module store and survives the remount, so the same pile is
     * redrawn.
     */
    const built = renderBoard(view);
    dragCard(built.container, 24, { card: 8, at: 'top' });
    expect(
      built.container.querySelector('[data-card-id="8"] > .board-card__pile > [data-card-id="24"]'),
      '24 is stacked on 8',
    ).not.toBeNull();

    cleanup();
    const { interaction } = spyInteraction([24], [], true);
    const { container } = renderBoard(view, interaction);
    const stacked = container.querySelector<HTMLElement>('[data-card-id="8"]')!;
    const member = container.querySelector<HTMLElement>('[data-card-id="8"] > .board-card__pile > [data-card-id="24"]');
    expect(member, 'the pile survived the remount').not.toBeNull();
    expect(member!.dataset.selectable, 'and Forge is asking about the member').toBe('true');
    expect(member!.hasAttribute('data-arrange-card'), 'so it is not draggable, pile or no pile').toBe(false);
    expect(stacked.dataset.selectable, 'the base is not in the selection').toBeUndefined();
    expect(stacked.hasAttribute('data-arrange-card'), 'and stays draggable').toBe(true);
  });

  /*
   * The other half, and it is NOT covered by `selectionOpen` — established from
   * Forge rather than assumed. `setSelectables` has exactly two call sites in all
   * of Forge, both selection inputs; `InputAttack` publishes none of them (it
   * calls `updateButtons` and `clearActionableCards`, `InputAttack.java:87-101`).
   * So during declare-attackers the seat's creatures arrive as Forge's ACTIONABLE
   * set with NO selection open — and the interaction lane's pointer layer stands
   * down on any `data-arrange-card` element, so an arrangeable creature here means
   * you cannot attack with it.
   */
  it('stands down on your own CREATURES while you are declaring attackers, and on nothing else', () => {
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id));
    interaction.declaringAttackers = true;
    const { container, seat } = renderBoard(view, interaction);
    // The creature is the attack gesture's; the four lands are still yours.
    expect(card(container, 21).hasAttribute('data-arrange-card'), 'the creature is the attack gesture’s').toBe(false);
    for (const id of lands) {
      expect(card(container, id).hasAttribute('data-arrange-card'), `land ${id} is still arrangeable`).toBe(true);
    }
    expect(seat(0).querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(4);
    // Forge is still offering the creature — the stand-down is about the
    // gesture, not about what may be clicked.
    expect(card(container, 21).dataset.selectable).toBe('true');
  });

  it('is by the creature’s own type line, not by the lane the player dragged it into', () => {
    // A creature the player has moved into the lands lane is still a creature,
    // and still the attack gesture's while attackers are being declared.
    const built = renderBoard(view);
    dragCard(built.container, 21, { slot: 'lands' });
    expect(built.rowIds(0, 'lands'), 'the creature is in the lands lane now').toEqual([8, 24, 6, 25, 21]);

    cleanup();
    const { interaction } = spyInteraction([]);
    interaction.declaringAttackers = true;
    const { container } = renderBoard(view, interaction);
    expect(card(container, 21).hasAttribute('data-arrange-card'), 'still the attack gesture’s').toBe(false);
    expect(card(container, 8).hasAttribute('data-arrange-card'), 'the lands beside it are not').toBe(true);
  });

  it('defaults to not declaring attackers when the field is absent', () => {
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id));
    expect(interaction.declaringAttackers, 'the field really is absent').toBeUndefined();
    const { zone } = renderBoard(view, interaction);
    expect(
      zone(0, 'battlefield').querySelectorAll('.board-card[data-arrange-card]'),
      'every permanent, creature included',
    ).toHaveLength(5);
  });

  it('an actionable card is still draggable even while a selection is open elsewhere', () => {
    // `boardInteraction`'s contract: with a selection open, `selectable` IS the
    // selection and the actionable set is not in it. So a card outside the
    // selection is arrangeable even mid-question — the arrangement never leaves
    // the browser, so there is no reason it should not be.
    const { interaction } = spyInteraction([8], [], true);
    const { container } = renderBoard(view, interaction);
    expect(card(container, 8).hasAttribute('data-arrange-card')).toBe(false);
    expect(container.querySelectorAll('.board-card[data-arrange-card]')).toHaveLength(4);
  });
});

/* ── the hand is the player's to arrange, but not by this component's own drag ── */

/**
 * The operator: they could not reorder their own hand at all, and then
 * (once the hand reached the same free-placement gesture a battlefield row
 * has) that the reorder needed a smoother animation and to be visible to
 * the opponent. Answering that moved the hand's own press to the
 * interaction lane (`live/gestures/hand.ts`, `install.ts`) entirely — a
 * press on a hand card, Forge-offered or not, is never this component's own
 * `useArrangeDrag`, because dragging a card out of hand onto the
 * battlefield is how it is PLAYED (`e2e/play.spec.ts`), not how it is
 * tidied, and that lane already decides which one a press is. The reorder
 * itself (the store, the order surviving a re-render, nothing ever reaching
 * Forge) is pinned above, in `describe('commitHandMove hands a hand reorder
 * to Board')`, through the seam that lane writes with. What is left here is
 * the boundary: no hand card is ever this component's own drag, in any
 * state, and a battlefield permanent dropped on the hand still lands
 * nowhere.
 */
describe('a hand card is never this component’s own drag', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const hand = me.hand!.map((c) => c.id);

  const handOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"]')!;
  const handIds = (container: HTMLElement): number[] =>
    [...handOf(container).querySelectorAll<HTMLElement>('.board-card')].map((c) => Number(c.dataset.cardId));
  const draggableInHand = (container: HTMLElement) => handOf(container).querySelectorAll('.board-card[data-arrange-card]');

  it('never carries data-arrange-card, Forge-offered or not', () => {
    const { interaction } = spyInteraction([hand[0]!, hand[1]!]);
    const { container } = renderBoard(view, interaction);
    for (const id of hand) {
      const el = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${id}"]`)!;
      expect(el.hasAttribute('data-arrange-card'), `hand card ${id}`).toBe(false);
    }
    expect(draggableInHand(container)).toHaveLength(0);
  });

  it('stays undraggable while Forge is ASKING and while combat is declared — the same as every other state', () => {
    const asking = spyInteraction(me.battlefield.map((c) => c.id), [], true).interaction;
    expect(draggableInHand(renderBoard(view, asking).container), 'while Forge asks').toHaveLength(0);
    cleanup();
    const declaring: BoardInteraction = { ...spyInteraction([]).interaction, declaringAttackers: true };
    expect(draggableInHand(renderBoard(view, declaring).container), 'while attackers are declared').toHaveLength(0);
  });

  it('never takes a permanent dropped on it, and never touches the opponent’s hand', () => {
    const { container, rowIds, seat } = renderBoard(view);
    // A permanent dragged onto the hand's own list: the hand's own slot still
    // exists (a cast's placement preview needs it), but the snap only ever
    // offers a card's own zone, so this lands nowhere.
    dragCard(container, 8, { slot: 'hand' });
    expect(handIds(container), 'the hand did not take a permanent').toEqual(hand);
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    // The opponent's hand is backs, and none of them is draggable either.
    expect(seat(1).querySelectorAll('[data-zone="hand"] .board-card')).toHaveLength(0);
    expect(seat(1).querySelectorAll('[data-arrange-card]'), 'nothing of theirs is ours to drag').toHaveLength(0);
  });
});

/* ── a press on a card is a gesture, not a text selection ─────────────── */

/**
 * §E.2. The operator, 2026-09-27: dragging highlighted the words the pointer
 * crossed.
 *
 * It is STATIC and it is on the card, which is the only place it can be: the
 * gesture layer's own rule lands on the canvas after the press passes the slop
 * (`live/gestures/gestures.css`), and the arrangement's press is a native HTML5
 * drag that no `preventDefault` may cancel.
 */
describe('a card selects no text (#2)', () => {
  it('is on a card the player can drag and on the opponent’s, and not on a card outside the seats', () => {
    const css = styled();
    const { container, seat } = renderBoard();
    for (const el of [
      container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"] .board-card')!,
      container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] .board-card')!,
      seat(1).querySelector<HTMLElement>('[data-zone="battlefield"] .board-card')!,
    ]) {
      expect(css(el, 'user-select'), `${el.dataset.cardId} selects no text`).toBe('none');
    }
    // `card.css` and `prompts/prompts.css` style `.board-card` too, and a card in a prompt is read, not dragged.
    const loose = document.body.appendChild(document.createElement('div'));
    loose.className = 'board-card';
    onTestFinished(() => loose.remove());
    expect(css(loose, 'user-select'), 'a card outside a seat').not.toBe('none');
  });
});

/* ── P/T tells the truth ──────────────────────────────────────────────── */

/**
 * §A.3 (#12, #18). The operator's spec: *a 1/2 with +2/+2 that has taken 3 shows
 * 3 (blue) / 1 (red)*.
 *
 * And settled at dispatch: **colour may not be the only signal**. So each
 * assertion here checks the state attribute (which carries the ink), the marker
 * glyph, and the accessible name — a reader with no colour at all gets the same
 * answer.
 */
describe('power and toughness on the board (#12, #18)', () => {
  /** The badge on one card: the two numbers, their states, and what it says. */
  function badge(container: HTMLElement, id: number) {
    const el = container.querySelector<HTMLElement>(`[data-card-id="${id}"] > .board-card__pt`);
    if (el === null) return null;
    const parts = [...el.querySelectorAll<HTMLElement>('.board-card__pt-n')];
    return {
      text: el.textContent,
      label: el.getAttribute('aria-label'),
      tip: el.dataset.tip,
      of: parts.map((p) => p.dataset.ptOf),
      states: parts.map((p) => p.dataset.ptState),
    };
  }

  /** The fixture's Fire Urchin (21), with a printed base, a buff and damage. */
  function urchin(power: number, toughness: number, damage: number, printed: { power: number; toughness: number } | null) {
    const base = boardFromFixture(fixture);
    return {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              battlefield: p.battlefield.map((c) =>
                c.id !== 21
                  ? c
                  : { ...c, damage, printed, card: { ...c.card, power: String(power), toughness: String(toughness) } },
              ),
            },
      ),
    } as BoardView;
  }

  it('draws the operator’s case: a 1/2 with +2/+2 that has taken 3 reads 3 / 1', () => {
    const { container } = renderBoard(urchin(3, 4, 3, { power: 1, toughness: 2 }));
    expect(badge(container, 21)).toEqual({
      text: '3/1',
      label: 'power 3, up from 1, toughness 4, 3 damage marked',
      tip: 'Power 3, up from 1, toughness 4, 3 damage marked',
      of: ['power', 'toughness'],
      states: ['buffed', 'damaged'],
    });
  });

  /**
   * The operator, 2026-10-27: hovering a plain Wurmcoil Engine's badge popped
   * up "Power 15, toughness 15" — a tip that read back the two numbers
   * already sitting right there. A plain/plain badge now carries no tip at
   * all; `aria-label` still says it, for the one reader that never sees the
   * numbers drawn.
   */
  it('draws a plain creature plain — no ink, no marker, no claim, and no tooltip', () => {
    const { container } = renderBoard(urchin(1, 2, 0, { power: 1, toughness: 2 }));
    expect(badge(container, 21)).toEqual({
      text: '1/2',
      label: 'power 1, toughness 2',
      tip: undefined,
      of: ['power', 'toughness'],
      states: [undefined, undefined],
    });
  });

  it('draws a creature whose printed base we do not know as plain, never as buffed', () => {
    // This is the fixture as captured: Forge precon decks, no card of which our
    // card data has ever heard. The numbers are still right; the STATE is not
    // guessed at.
    const { container, view } = renderBoard();
    expect(view.players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === 21)!.printed, 'no printed base').toBeNull();
    expect(badge(container, 21)).toEqual({
      text: '1/3',
      label: 'power 1, toughness 3',
      tip: undefined,
      of: ['power', 'toughness'],
      states: [undefined, undefined],
    });
    // A 5/5 with a big base and no knowledge of it is plain too, not blue.
    expect(badge(container, 99)!.states).toEqual([undefined, undefined]);
  });

  it('marks a shrunk creature hurt, and a damaged one damaged without a base at all', () => {
    const shrunk = renderBoard(urchin(0, 1, 0, { power: 1, toughness: 2 }));
    expect(badge(shrunk.container, 21)!.states).toEqual(['hurt', 'hurt']);
    expect(badge(shrunk.container, 21)!.text).toBe('0/1');
    expect(badge(shrunk.container, 21)!.label).toBe('power 0, down, toughness 1, down');
    cleanup();
    const hurt = renderBoard(urchin(1, 3, 2, null));
    expect(badge(hurt.container, 21), 'damage alone is enough: it needs no printed base').toEqual({
      text: '1/1',
      label: 'power 1, toughness 3, 2 damage marked',
      tip: 'Power 1, toughness 3, 2 damage marked',
      of: ['power', 'toughness'],
      states: [undefined, 'damaged'],
    });
  });

  it('draws the operator’s Tarmogoyf: a 4/5 dealt 3 reads 4/2, the 2 red and unmarked (printed */1+* is no base)', () => {
    const { container } = renderBoard(urchin(4, 5, 3, null));
    expect(badge(container, 21)).toEqual({
      text: '4/2',
      label: 'power 4, toughness 5, 3 damage marked',
      tip: 'Power 4, toughness 5, 3 damage marked',
      of: ['power', 'toughness'],
      states: [undefined, 'damaged'],
    });
  });

  it('never double-marks damage on a creature also shrunk below its printed base: damaged wins, unmarked', () => {
    // A printed 1/3 at -0/-1 (1/2) with 1 damage: what is left is 1, drawn once, as damage.
    const { container } = renderBoard(urchin(1, 2, 1, { power: 1, toughness: 3 }));
    expect(badge(container, 21)).toMatchObject({ text: '1/1', states: [undefined, 'damaged'] });
  });

  it('says the damage in the badge instead of a second time in a chip', () => {
    const { container } = renderBoard(urchin(1, 3, 2, null));
    const card = container.querySelector<HTMLElement>('[data-card-id="21"]')!;
    expect([...card.querySelectorAll(':scope > .board-card__chips > .board-card__chip')].map((c) => c.textContent)).not.toContain(
      '2 damage',
    );
    expect(badge(container, 21)!.label).toContain('2 damage marked');
  });

  it('draws no badge on a land, in a hand, in a graveyard or on the stack', () => {
    const { container, zone } = renderBoard(urchin(3, 4, 3, { power: 1, toughness: 2 }));
    expect(badge(container, 8), 'a land has no P/T').toBeNull();
    expect(zone(0, 'hand').querySelectorAll('.board-card__pt'), 'a hand is not a battlefield').toHaveLength(0);
    expect(zone(0, 'graveyard').querySelectorAll('.board-card__pt')).toHaveLength(0);
    expect(container.querySelectorAll('.stack__item .board-card__pt')).toHaveLength(0);
    // Exactly the creatures on the two battlefields, and nothing else.
    expect(container.querySelectorAll('.board-card__pt')).toHaveLength(3);
  });

  it('draws a state as its number alone — no marker glyph — with the words in its name and damage on the badge', () => {
    const { container } = renderBoard(urchin(3, 4, 3, { power: 1, toughness: 2 }));
    for (const n of container.querySelectorAll<HTMLElement>('[data-card-id="21"] > .board-card__pt .board-card__pt-n')) {
      const state = n.dataset.ptState;
      if (state === undefined) continue;
      if (state === 'damaged') {
        expect(n.closest<HTMLElement>('.board-card__pt')!.dataset.damage, 'damaged: the whole badge wears the damage rule').toBe('3');
        continue;
      }
      expect(n.querySelector('[aria-hidden="true"]'), `${state}: no marker glyph`).toBeNull();
      expect(n.textContent, `${state}: the number alone`).toMatch(/^\d+$/);
    }
    expect(container.querySelector('[data-card-id="21"] > .board-card__pt')!.getAttribute('aria-label')).toContain('up from 1');
  });

  it('sets every state in a heavier weight than a plain number, so the states differ without a colour too', () => {
    const css = styled();
    const numbers = (view: BoardView) => [...renderBoard(view).container.querySelectorAll<HTMLElement>('[data-card-id="21"] .board-card__pt-n')];
    const plain = numbers(urchin(1, 2, 0, { power: 1, toughness: 2 }))[0]!;
    const stated = [...numbers(urchin(3, 4, 3, { power: 1, toughness: 2 })), ...numbers(urchin(0, 1, 0, { power: 1, toughness: 2 }))];
    expect(new Set(stated.map((n) => n.dataset.ptState))).toEqual(new Set(['buffed', 'damaged', 'hurt']));
    for (const n of stated) expect(css(n, 'font-weight'), n.dataset.ptState).not.toBe(css(plain, 'font-weight'));
  });

  it('is out of flow and takes no click: it may not move a card or eat a selection', () => {
    const css = styled();
    const { container } = renderBoard(urchin(3, 4, 3, { power: 1, toughness: 2 }));
    const pt = container.querySelector('[data-card-id="21"] > .board-card__pt')!;
    expect(css(pt, 'position')).toBe('absolute');
    expect(css(pt, 'pointer-events')).toBe('none');
  });
});

/*
 * A planeswalker's loyalty reuses `PowerToughness`'s own badge wholesale
 * (`.board-card__pt`/`.board-card__pt-n`, no new class). `adapter.ts` already
 * keeps `card.loyalty` CURRENT (a loyalty counter once the battlefield has
 * one); this is the draw, not the computation.
 */
describe('a planeswalker’s loyalty on the board (W15)', () => {
  /** The fixture's Fire Urchin (21), reshaped into a planeswalker at the given loyalty. */
  function planeswalker(loyalty: number): BoardView {
    const base = boardFromFixture(fixture);
    return {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              battlefield: p.battlefield.map((c) =>
                c.id !== 21
                  ? c
                  : {
                      ...c,
                      card: {
                        ...c.card,
                        power: undefined,
                        toughness: undefined,
                        loyalty: String(loyalty),
                        typeLine: 'Legendary Planeswalker — Gideon',
                      },
                    },
              ),
            },
      ),
    } as BoardView;
  }

  it('shows the current loyalty in the SAME badge a creature’s P/T draws in', () => {
    const { container } = renderBoard(planeswalker(5));
    const badges = container.querySelectorAll('[data-card-id="21"] > .board-card__pt');
    expect(badges, 'one badge, not a P/T badge AND a loyalty one').toHaveLength(1);
    const el = badges[0]!;
    expect(el.textContent).toBe('5');
    expect(el.getAttribute('aria-label')).toBe('loyalty 5');
    expect(el.querySelector<HTMLElement>('.board-card__pt-n')!.dataset.ptOf).toBe('loyalty');
  });

  it('updates on the board when the loyalty does — activating an ability, in the fixture’s own scenario proof, moves this number', () => {
    const five = renderBoard(planeswalker(5));
    expect(five.container.querySelector('[data-card-id="21"] > .board-card__pt')!.textContent).toBe('5');
    cleanup();
    const seven = renderBoard(planeswalker(7));
    expect(seven.container.querySelector('[data-card-id="21"] > .board-card__pt')!.textContent, 'the number on the board changed with it').toBe('7');
  });

  it('draws an ordinary P/T badge, not a loyalty one, for a creature whose card carries no loyalty at all', () => {
    // The fixture's other creatures are untouched: card 99's own badge is still power/toughness.
    const { container } = renderBoard(planeswalker(5));
    const of = [...container.querySelectorAll<HTMLElement>('[data-card-id="99"] > .board-card__pt .board-card__pt-n')].map(
      (n) => n.dataset.ptOf,
    );
    expect(of).toEqual(['power', 'toughness']);
  });
});

describe('a planeswalker that is a creature too (Gideon on his own turn)', () => {
  /** The fixture's Fire Urchin (21) as a planeswalker creature: a 4/4 at loyalty 4. */
  function gideon(): BoardView {
    const base = boardFromFixture(fixture);
    return {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              battlefield: p.battlefield.map((c) =>
                c.id !== 21
                  ? c
                  : {
                      ...c,
                      printed: null,
                      card: { ...c.card, power: '4', toughness: '4', loyalty: '4', typeLine: 'Legendary Planeswalker Creature — Gideon Human Soldier' },
                    },
              ),
            },
      ),
    } as BoardView;
  }

  it('draws its loyalty AND its power and toughness', () => {
    const { container } = renderBoard(gideon());
    const badges = [...container.querySelectorAll<HTMLElement>('[data-card-id="21"] > .board-card__pt')];
    expect(badges.map((b) => [b.dataset.pt, b.textContent])).toEqual([
      ['loyalty', '4'],
      ['', '4/4'],
    ]);
  });

  it('stacks the loyalty above the P/T badge rather than on it', () => {
    const css = styled();
    const { container } = renderBoard(gideon());
    const [loyalty, pt] = [...container.querySelectorAll('[data-card-id="21"] > .board-card__pt')];
    expect(css(loyalty!, 'bottom'), 'not at the P/T badge’s height').not.toBe(css(pt!, 'bottom'));
  });
});

describe('keyword tags and the flyer’s float', () => {
  /** The fixture's card 99 (the opponent's) with these keywords, as Forge's current face would carry them. */
  function withKeywords(keywords: string[]): BoardView {
    const base = boardFromFixture(fixture);
    return {
      ...base,
      players: base.players.map((p) => ({ ...p, battlefield: p.battlefield.map((c) => (c.id !== 99 ? c : { ...c, keywords })) })),
    } as BoardView;
  }
  const tagsOf = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-card-id="99"] > .board-card__tags > [data-keyword]')].map((t) => t.textContent);

  it('tags each evergreen keyword in Forge’s own word, in a fixed order, and sways a flyer from its own phase', () => {
    const { container } = renderBoard(withKeywords(['Lifelink', 'Flying', 'Affinity:Mountain', 'Hexproof:Card.Black:black']));
    expect(tagsOf(container)).toEqual(['Flying', 'Lifelink']);
    const li = container.querySelector<HTMLElement>('[data-card-id="99"]')!;
    expect(li.hasAttribute('data-flying')).toBe(true);
    expect(li.style.getPropertyValue('--fly-phase')).toBe(((99 * 0.618034) % 1).toFixed(4));
  });

  it('draws no tag and no sway when the keyword goes', () => {
    const { container } = renderBoard(withKeywords([]));
    expect(tagsOf(container)).toEqual([]);
    const li = container.querySelector<HTMLElement>('[data-card-id="99"]')!;
    expect(li.hasAttribute('data-flying')).toBe(false);
    expect(li.style.getPropertyValue('--fly-phase')).toBe('');
  });

  it('the sway and its shadow stand still for reduced motion', () => {
    // jsdom evaluates no media query, so this one reads the rule.
    expect(withoutComments(CARD_CSS)).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*\[data-flying\][^}]*\{\s*animation: none;/);
  });

  const protectionOf = (container: HTMLElement) => {
    const li = container.querySelector<HTMLElement>('[data-card-id="99"]')!;
    return { kind: li.dataset.protection, overlays: li.querySelectorAll('.board-card__face > .board-card__protection').length };
  };

  it.each([
    [['Ward:1'], 'ward'],
    [['Ward:PayLife<3>'], 'ward'],
    [['Hexproof'], 'hexproof'],
    [['Hexproof:Card.Black:black'], 'hexproof'],
    [['Shroud'], 'shroud'],
    // One effect a card: the widest protection it has.
    [['Ward:2', 'Hexproof'], 'hexproof'],
    [['Hexproof', 'Shroud'], 'shroud'],
  ])('wears one protection effect for %j, by Forge’s current keywords', (keywords, kind) => {
    const { container } = renderBoard(withKeywords(keywords));
    expect(protectionOf(container)).toEqual({ kind, overlays: 1 });
  });

  it('wears none when the keyword goes', () => {
    const { container } = renderBoard(withKeywords(['Flying']));
    expect(protectionOf(container)).toEqual({ kind: undefined, overlays: 0 });
  });

  it('the protection effects stand still for reduced motion', () => {
    expect(withoutComments(CARD_CSS)).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*\.board-card__protection[^}]*\{\s*animation: none;/);
  });
});

describe('combat-ready: the creatures that can attack or block right now', () => {
  it('marks exactly the battlefield cards in `combatReady`', () => {
    const view = boardFromFixture(fixture);
    const me = view.players.find((p) => p.isViewer)!;
    const ready = me.battlefield[0]!.id;
    const { interaction } = spyInteraction([]);
    const { container } = renderBoard(view, { ...interaction, combatReady: new Set([ready, me.hand![0]!.id]) });
    expect([...container.querySelectorAll<HTMLElement>('[data-combat-ready]')].map((el) => Number(el.dataset.cardId))).toEqual([ready]);
  });

  it('grows from the bottom edge, so the extra size never runs down out of the battlefield', () => {
    const css = styled();
    const view = boardFromFixture(fixture);
    const ready = view.players.find((p) => p.isViewer)!.battlefield[0]!.id;
    const { container } = renderBoard(view, { ...spyInteraction([]).interaction, combatReady: new Set([ready]) });
    expect(css(container.querySelector(`[data-card-id="${ready}"] > .board-card__face`)!, 'transform-origin')).toMatch(/(100%|bottom)$/);
  });
});

/*
 * The operator, 2026-10-24: *"a 'saturation and focus lighting' effect … during declare blockers/attacks
 * focus on only cards that can actually be clicked … any time you are drawing a targeting arrow, apply
 * the filter over everything else that cannot be targeted"*, for every card pick, over the whole table.
 * Hovering still shows the normal enlargement: the inspector draws a clone in the top layer, outside
 * `.board`, so nothing scoped to `.board[data-focus]` reaches it.
 */
describe('focus lighting: while a pick is open, only what can be picked stays lit', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const focus = (container: HTMLElement) => container.querySelector('.board')!.hasAttribute('data-focus');

  it('is on while Forge asks for a pick (a target, a sacrifice, a discard: an open selection)', () => {
    const { container } = renderBoard(view, spyInteraction([me.battlefield[0]!.id], [], true).interaction);
    expect(focus(container)).toBe(true);
  });

  it('is on while this seat declares attackers or blockers', () => {
    const { container } = renderBoard(view, { ...spyInteraction([]).interaction, combatReady: new Set([me.battlefield[0]!.id]) });
    expect(focus(container)).toBe(true);
  });

  it('is off at an ordinary priority stop, where castable cards are merely clickable, and with nothing asked', () => {
    const clickable = renderBoard(view, spyInteraction([me.battlefield[0]!.id], [], false, [me.battlefield[0]!.id]).interaction);
    expect(focus(clickable.container), 'actionable is not asking').toBe(false);
    cleanup();
    expect(focus(renderBoard(view).container), 'no interaction').toBe(false);
    cleanup();
    expect(focus(renderBoard(view, { ...spyInteraction([]).interaction, combatReady: new Set() }).container), 'an empty combat set').toBe(false);
  });

  it('darkens the whole table with ONE layer, and lifts what can be picked over it', () => {
    const css = withoutComments(BOARD_CSS);
    expect(css, 'one layer over the table, faded in by data-focus').toMatch(/\.board::after\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*z-index: var\(--z-focus, 10\);[^}]*opacity: 0;/);
    expect(css).toMatch(/\.board\[data-focus\]::after\s*\{[^}]*opacity: 1;/);
    expect(css, 'the picks rise over the layer').toContain(
      [
        '.board[data-focus] .board-card:is([data-selectable], [data-combat-ready], [data-attacking]),',
        '.board[data-focus] .staging .board-card,',
        '.board[data-focus] .seat[data-selectable] .face {',
        '  z-index: calc(var(--z-focus, 10) + 1);',
      ].join('\n'),
    );
  });

  it('never filters a card or a surface: no second effect, and no colour-shifted art', () => {
    for (const css of [withoutComments(BOARD_CSS), withoutComments(CARD_CSS)]) {
      expect(css).not.toMatch(/\[data-focus\][^{]*\{[^}]*filter:/);
      expect(css).not.toMatch(/--focus-shade|--focus-step/);
    }
  });
});

/* ── haste is not summoning sickness ──────────────────────────────────── */

describe('a hasty creature does not claim to be summoning sick (#17)', () => {
  /** The state marks one card wears, by name. */
  const marksOf = (container: HTMLElement, id: number) =>
    [...container.querySelectorAll<HTMLElement>(`[data-card-id="${id}"] > .board-card__marks > .board-card__mark`)].map(
      (m) => m.dataset.mark,
    );

  it('draws the mark from summoningSick, not from Forge’s raw Sickness', () => {
    const base = boardFromFixture(fixture);
    const view: BoardView = {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              battlefield: p.battlefield.map((c) =>
                c.id !== 21 ? c : { ...c, arrivedThisTurn: true, summoningSick: false, keywords: ['Haste'] },
              ),
            },
      ),
    };
    const { container } = renderBoard(view);
    expect(marksOf(container, 21), 'it arrived this turn and it can still act').not.toContain('sick');
    cleanup();
    const sick = renderBoard({
      ...base,
      players: base.players.map((p) =>
        !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id !== 21 ? c : { ...c, summoningSick: true })) },
      ),
    });
    expect(marksOf(sick.container, 21), 'and a creature that cannot act still says so').toContain('sick');
  });
});

/* ── the inspector, booted (lane D) ───────────────────────────────────── */

/**
 * The whole of this file's involvement with the inspector: boot it on the
 * board's root, dispose it on unmount. It attaches its own listeners by
 * delegation and draws into the overlay root; nothing here is a handler, a
 * prop or a piece of markup for it.
 */
describe('the inspector', () => {
  it('is booted on the board root, draws into the zoom layer, and is disposed on unmount', () => {
    inspector.mounts.length = 0;
    const { container, unmount } = renderBoard();
    const board = container.querySelector<HTMLElement>('.board')!;
    expect(inspector.mounts).toHaveLength(1);
    expect(inspector.mounts[0]!.root, 'booted on the board itself').toBe(board);
    expect(inspector.mounts[0]!.disposed).toBe(false);

    // Live, and drawing where the contract says: hovering a card enlarges it
    // into the zoom layer — the board's top layer, a sibling of the overlay
    // root — and nowhere else on the board.
    const zoom = board.querySelector<HTMLElement>('[data-board-zoom]')!;
    expect(zoom.parentElement, 'at the board’s top level').toBe(board);
    expect(zoom.className).toBe('top-layer');
    expect(zoom.querySelectorAll('[data-inspect]')).toHaveLength(0);
    fireEvent.pointerOver(board.querySelector<HTMLElement>('[data-card-id="8"]')!, { pointerType: 'mouse' });
    expect(zoom.querySelectorAll('[data-inspect]'), 'the enlargement is in the zoom layer').toHaveLength(1);
    expect(board.querySelectorAll('[data-inspect]'), 'and nowhere else').toHaveLength(1);

    unmount();
    expect(inspector.mounts[0]!.disposed, 'the mount effect disposed it').toBe(true);
    expect(inspector.mounts, 'booted once, not once a render').toHaveLength(1);
  });
});

/* ── the faces are real click targets ─────────────────────────────────── */

describe('the player faces', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const them = view.players.find((p) => !p.isViewer)!;
  const face = (root: HTMLElement, id: number) => root.querySelector<HTMLElement>(`[data-player-face][data-player-id="${id}"]`)!;

  it('is a button exactly when Forge says that player may be chosen', () => {
    const { interaction, onSelectPlayer, onSelectCard } = spyInteraction([], [them.id]);
    const { container } = renderBoard(view, interaction);
    const board = container.querySelector<HTMLElement>('.board')!;

    expect(face(board, them.id).dataset.selectable).toBe('true');
    expect(face(board, me.id).dataset.selectable).toBeUndefined();
    expect(face(board, me.id).querySelector('button')).toBeNull();

    const hit = face(board, them.id).querySelector<HTMLElement>('.face__hit')!;
    expect(hit.tagName).toBe('BUTTON');
    expect(hit.tabIndex).toBe(0);
    fireEvent.click(hit);
    expect(onSelectPlayer.mock.calls).toEqual([[them.id]]);
    expect(onSelectCard).not.toHaveBeenCalled();
  });

  it('with no interaction at all, no face is a button', () => {
    const { container } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    for (const p of view.players) expect(face(board, p.id).querySelector('button')).toBeNull();
  });
});

/* ── the stack draws its cards ────────────────────────────────────────── */

describe('the stack’s art (#10)', () => {
  it('draws each item’s source card through the resolver, not a host of its own', () => {
    const { container } = renderBoard(viewWithArt());
    const items = [...container.querySelectorAll<HTMLElement>('[data-placed-spell]')];
    expect(items).toHaveLength(2);
    let spells = 0;
    for (const item of items) {
      // A spell draws its card; an ability its chip (AE29) — either names the source. A chip draws its
      // art only once it can credit it (`placed.test.ts`), and these ids are synthetic, so it is spells only.
      if (item.querySelector('[data-ability-chip]') !== null) continue;
      spells += 1;
      const name = item.querySelector('.card__name')!.textContent!;
      const img = item.querySelector('img');
      expect(img, `${name} on the stack has art`).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(cardImageUrl(TEST_IDS.get(name)));
      expect(ALLOWED_ART_HOSTS).toContain(new URL(img!.getAttribute('src')!).origin);
    }
    expect(spells, 'at least one spell on the stack').toBeGreaterThan(0);
    expect(container.innerHTML).not.toMatch(/url\(/);
  });

  it('draws no art for an item that names no card, and still draws the item — the honest text fallback (§S)', () => {
    const view = boardFromFixture(fixture);
    const bare: BoardView = {
      ...view,
      stack: [{ ...view.stack[0]!, sourceCard: null, sourceCardId: null, sourceName: null }],
    };
    const { container } = renderBoard(bare);
    const item = container.querySelector<HTMLElement>(`[data-placed-spell="${view.stack[0]!.id}"]`)!;
    expect(item, 'drawn, at the default spot (no sourceCardId to draw beside)').not.toBeNull();
    expect(item.querySelector('img')).toBeNull();
    // `live/placed.ts`'s own fallback: the description, never a guessed name or a drawn `.stack__art` —
    // in the ability chip's text when the item is an ability (AE29; `RulesText`, which sets
    // parenthesised reminder text apart), the bare text box otherwise.
    expect(item.querySelector('.placed__text, .placed__chip-text')?.textContent).toContain(view.stack[0]!.description.split('.')[0]!);
  });
});



/* ── wave 27 §A: the table fits 960, and cards find their place ───────── */

/**
 * The operator, 2026-09-27: *"a system that by default snaps to the next
 * avaliable space, but also allows stacking cards with slight off-set similar to
 * how enchantments/equipped artifacts are already represented"*.
 *
 * Two behaviours and one model, and the second half is the operator's own
 * comparison, so it is the SAME rendering an attachment gets rather than a
 * second overlap style.
 */
describe('cards find their place (§A.3, §A.4)', () => {
  /** The viewer's lands lane, as columns of piles: each column bottom card first. */
  const lanes = (container: HTMLElement, row: string): number[][] => {
    const lane = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-board-row="${row}"]`)!;
    return [...lane.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li.board-card')].map((base) => [
      Number(base.dataset.cardId),
      ...[...base.querySelectorAll<HTMLElement>(':scope > ul.board-card__pile > li.board-card')].map((m) => Number(m.dataset.cardId)),
    ]);
  };

  /** The fixture with one more land on the viewer's battlefield, as Forge would send it. */
  function withNewLand(base: BoardView, id: number): BoardView {
    const me = base.players.find((p) => p.isViewer)!;
    const seed = me.battlefield.find((c) => c.card.typeLine.includes('Land'))!;
    return {
      ...base,
      seq: base.seq + 1,
      players: base.players.map((p) =>
        !p.isViewer ? p : { ...p, battlefield: [...p.battlefield, { ...seed, id, card: { ...seed.card, cardId: `w${id}`, name: `Wastes ${id}` } }] },
      ),
    };
  }

  it('a card entering a zone takes the NEXT FREE SLOT — its own, at the end of its lane', () => {
    // With no arrangement at all first: the default order is the view's, and a
    // permanent that arrives joins the end of the lane it belongs to.
    const bare = renderBoard();
    expect(lanes(bare.container, 'lands')).toEqual([[8], [24], [6], [25]]);
    cleanup();
    const arrived = renderBoard(withNewLand(boardFromFixture(fixture), 777));
    expect(lanes(arrived.container, 'lands'), 'the new land is the last column, on its own').toEqual([[8], [24], [6], [25], [777]]);
    cleanup();

    // And with an arrangement standing — the case that matters, because the
    // arrangement names every card the player has touched and the newcomer is
    // in none of its piles. It must not land in the middle of an order they
    // chose, and it must not join a pile.
    const before = renderBoard();
    const drag = (cardId: number, ontoId: number) => dragCard(before.container, cardId, { card: ontoId, at: 'before' });
    drag(25, 8);
    expect(lanes(before.container, 'lands')).toEqual([[25], [8], [24], [6]]);
    cleanup();
    const after = renderBoard(withNewLand(boardFromFixture(fixture), 778));
    expect(lanes(after.container, 'lands'), 'the arrangement stands and the newcomer is last').toEqual([[25], [8], [24], [6], [778]]);
    // Nothing overlaps unless the player asked for it: every column is a pile of
    // one, and no card on the board carries the pile marks.
    for (const column of lanes(after.container, 'lands')) expect(column).toHaveLength(1);
    expect(
      after.container.querySelectorAll('.seat[data-viewer] [data-zone="battlefield"] .board-card[data-pile-size]'),
      'nothing stacked itself',
    ).toHaveLength(0);
  });

  it('a card dropped ON a card stacks with an offset, drawn exactly as an attachment is', () => {
    const { container } = renderBoard();
    dragCard(container, 25, { card: 8, at: 'top' });

    expect(lanes(container, 'lands'), '25 is stacked on 8, and the lane is a column shorter').toEqual([[8, 25], [24], [6]]);
    // The MARKUP is the attachment's markup: a `ul.board-card__pile` inside the
    // base card's own `<li>`, `data-pile-size` on the base and `data-pile-depth`
    // on each member. `Board.tsx` builds the player's piles and Forge's
    // attachments with the same `Pile`, which is why there is one of these.
    const base = container.querySelector<HTMLElement>('[data-card-id="8"]')!;
    const member = container.querySelector<HTMLElement>('[data-card-id="25"]')!;
    expect(base.dataset.pileSize, 'the base says how deep the pile is').toBe('2');
    expect(member.parentElement!.className).toBe('board-card__pile');
    expect(member.dataset.pileDepth, 'and the member says where in it it sits').toBe('1');
    // A player's stack is NOT marked as Forge's — that attribute is the engine's
    // claim, and the player making a pile must not be able to forge it.
    expect(member.dataset.attached, 'the player stacked it; Forge did not').toBeUndefined();
  });
});

/* ── §A.15 — a card's state is DRAWN, not written ─────────────────────── */

/**
 * Wave 28's headline. The operator, 2026-09-28: *"+1/+1 looks really ugly, we
 * need a better way to show that. actually all the text you have written
 * on the card looks ugly, we need to find a way to handle all of that with
 * effects."*
 *
 * One case per visual claim, each failing on its own when the treatment it names
 * is reverted. The committed fixture's board carries NONE of these states — no
 * card in the captured game is sick, attacking, blocking, damaged, a token or
 * carrying a counter — so every case here builds the state it is about onto the
 * viewer's own battlefield and leaves the rest of the board alone.
 */
describe('§A.15 — a card’s state is drawn', () => {
  const base = boardFromFixture(fixture);
  /** The viewer's first creature, given some state. Everything else is the fixture's. */
  const withState = (state: Partial<BoardCard>, cardId = 21): BoardView => ({
    ...base,
    players: base.players.map((p) =>
      !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === cardId ? { ...c, ...state } : c)) },
    ),
  });
  const card = (container: HTMLElement, id = 21) => container.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;

  it('no card on the board writes its state in words any more', () => {
    const { container } = renderBoard(
      withState({ tapped: true, summoningSick: true, attacking: true, blocking: true, token: true, damage: 2, counters: [{ name: '+1/+1', count: 3 }] }),
    );
    const text = container.querySelector<HTMLElement>('[data-zone="battlefield"]')!.textContent ?? '';
    for (const word of ['tapped', 'summoning sick', 'attacking', 'blocking', 'token', '3 +1/+1', '2 damage']) {
      expect(text, `the board still writes "${word}"`).not.toContain(word);
    }
    // And there is no chip list left anywhere to write one into.
    expect(container.querySelectorAll('.board-card__chips, .board-card__chip')).toHaveLength(0);
  });

  it('an ATTACKING creature draws turned, exactly as a tapped one does (item 6)', () => {
    const css = styled();
    const { container } = renderBoard(withState({ attacking: true, tapped: false }));
    expect(card(container).getAttribute('data-attacking')).toBe('true');
    expect(card(container).hasAttribute('data-tapped'), 'and Forge’s own tapped is untouched').toBe(false);
    expect(turnOf(css, card(container)), 'turned').toContain('90deg');
  });

  it('a creature with vigilance attacks upright: it is attacking, and the rule that turns an attacker leaves it out', () => {
    const { container } = renderBoard(withState({ attacking: true, tapped: false, keywords: ['Flying', 'Vigilance', 'Haste'] }));
    expect(card(container).getAttribute('data-attacking'), 'still attacking, for everything that reads it').toBe('true');
    expect(card(container).getAttribute('data-vigilant')).toBe('true');
    expect(renderBoard(withState({ attacking: true, tapped: false, keywords: ['Flying'] })).container.querySelector('[data-vigilant]')).toBeNull();
    // Upright while attacking; a TAPPED vigilant creature still turns.
    const css = styled();
    expect(turnOf(css, card(container)), 'a vigilant attacker stands').not.toContain('90deg');
    const tapped = renderBoard(withState({ attacking: true, tapped: true, keywords: ['Vigilance'] })).container;
    expect(turnOf(css, card(tapped)), 'a tapped one turns, vigilance or not').toContain('90deg');
  });

  /**
   * The operator: *"after declaring attackers there is no visible change
   * (Lightning Angel has vigilance, so nothing turns); mark committed
   * attackers, e.g. a red border."* The turn rule above leaves a vigilant
   * attacker exactly as it was on purpose — this is the SECOND, independent
   * mark the vigilant case still needs: an outline in the danger token, on
   * `[data-attacking]` alone, with no `:not([data-vigilant])` anywhere on it.
   */
  it('a committed attacker gets a danger-token outline whether or not it is vigilant', () => {
    const vigilant = renderBoard(withState({ attacking: true, tapped: false, keywords: ['Vigilance'] })).container;
    const ordinary = renderBoard(withState({ attacking: true, tapped: false })).container;
    expect(card(vigilant).getAttribute('data-attacking')).toBe('true');
    expect(card(ordinary).getAttribute('data-attacking')).toBe('true');

    const css = styled();
    const outline = (c: HTMLElement) => css(card(c).querySelector(':scope > .board-card__face')!, 'outline');
    expect(outline(ordinary), 'the attacker mark').not.toMatch(/^(none)?$/);
    expect(outline(vigilant), 'the same mark on a vigilant attacker').toBe(outline(ordinary));
    // Never the accent — that ring already means "Forge is offering this".
    expect(outline(ordinary)).not.toContain('var(--accent)');
  });

  it('a card in a graveyard or exile pile is not raised under the pointer: the cards below it stay readable', () => {
    for (const rule of withoutComments(BOARD_CSS).matchAll(/([^{}]*zone--(?:graveyard|exile)[^{}]*:hover[^{}]*)\{([^{}]*)\}/g)) {
      expect(rule[2], `${rule[1]!.trim()} must not restack the pile`).not.toMatch(/z-index|translate|transform|scale/);
    }
  });

  it('summoning sickness is a drawn corner mark, and nothing is laid over the art', () => {
    const { container } = renderBoard(withState({ summoningSick: true }));
    const mark = card(container).querySelector<HTMLElement>('.board-card__mark[data-mark="sick"]')!;
    expect(mark, 'a mark of its own').not.toBeNull();
    expect(mark.querySelector('svg.board-card__mark-art'), 'drawn, not a glyph a font might not have').not.toBeNull();
    expect(mark.textContent, 'and the word is still said, for anything that cannot see it').toBe('summoning sick');
    // The operator, 2026-10-15: "let's drop the dashed summoning sickness on the art, not needed".
    expect(card(container).hasAttribute('data-sick'), 'no attribute for a layer to hang off').toBe(false);
    expect(withoutComments(CARD_CSS), 'no rule draws over a sick card').not.toMatch(/sick/);
  });

  it('blocking is a corner mark and is not drawn in the accent; a token wears no mark at all', () => {
    const { container } = renderBoard(withState({ blocking: true, token: true }));
    const marks = [...card(container).querySelectorAll<HTMLElement>('.board-card__mark')].map((m) => m.dataset.mark);
    // The operator, 2026-10-14: "let's just get rid of the token indicator, its noise."
    expect(marks).toEqual(['blocking']);
    expect(card(container).hasAttribute('data-token')).toBe(false);
    // The three outlines a card can already wear belong to the two gesture states
    // and nothing here may add a fourth colour to that conversation. `--accent-ink`
    // (R15's own `changed` mark, below) is a different, legitimate token, so only
    // the raw `--accent` itself is checked for.
    const layer = withoutComments(CARD_CSS).slice(withoutComments(CARD_CSS).indexOf('.board-card__marks {'));
    expect(layer, 'the state layer never draws in the accent').not.toMatch(/\.board-card__mark[^}]*--accent(?!-)/);
  });

  /*
   * The operator, 2026-10-15: "in hearthstone the card turns orange when its conditional effect is
   * 'active'. how can we indicate it?" The tile itself glows inward, in the hand and on the table,
   * and the ability word that names the condition is tinted in the tile's rules text.
   */
  it('a card whose condition is on glows inward on its own tile, in hand and on the table, and its ability word is tinted', () => {
    const metalcraft = 'Metalcraft — CARDNAME gets +2/+2 as long as you control three or more artifacts.';
    const lit = withState({ conditionMet: true });
    const view: BoardView = {
      ...lit,
      players: lit.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              battlefield: p.battlefield.map((c) => (c.id === 21 ? { ...c, abilityText: metalcraft, card: { ...c.card, oracleText: metalcraft } } : c)),
              hand: p.hand!.map((c, i) => (i === 0 ? { ...c, conditionMet: true as const } : c)),
            },
      ),
    };
    const css = styled();
    const { container } = renderBoard(view);
    const tile = card(container).querySelector<HTMLElement>(':scope > .board-card__face > .card')!;
    expect(tile.hasAttribute('data-condition-met'), 'the battlefield card’s tile').toBe(true);
    const handId = view.players.find((p) => p.isViewer)!.hand![0]!.id;
    expect(card(container, handId).querySelector('.card')!.hasAttribute('data-condition-met'), 'the held card’s tile').toBe(true);
    expect(tile.querySelector('.card__ability-word')?.textContent, 'the clause’s ability word').toBe('Metalcraft');
    expect(tile.querySelector('.card__rules-line')?.textContent).toBe(metalcraft);
    expect(css(tile, 'isolation'), 'the glow stays inside the tile, under the face’s badges').toBe('isolate');
    // Inward, on a layer of its own: every other card state draws OUTSIDE the tile (the offered
    // ring and the can-act blur are the tile's box-shadow, combat rings the face's outline), so
    // this rule may set neither, and an offered card that is also met shows both.
    const rules = withoutComments(TILE_CSS);
    for (const rule of rules.matchAll(/([^{}]*data-condition-met[^{}]*)\{([^{}]*)\}/g)) {
      if (rule[1]!.includes('::after')) expect(rule[2], 'drawn inward').toMatch(/box-shadow:[^;]*inset/);
      else expect(rule[2], `${rule[1]!.trim()} leaves the tile's own rings alone`).not.toMatch(/(^|[^-])(box-shadow|outline)\s*:/);
    }
    cleanup();
    const plain = renderBoard(withState({})).container;
    expect(plain.querySelectorAll('.card[data-condition-met]'), 'a card whose condition is off glows nowhere').toHaveLength(0);
    expect(plain.querySelectorAll('.card__ability-word'), 'and no word is singled out').toHaveLength(0);
  });

  // The operator, 2026-10-21: "yeah show the anger glow in the gy".
  it('a graveyard card whose condition is on glows on the pile’s top card and in the pile’s view; the card under it does not', () => {
    const viewer = base.players.find((p) => p.isViewer)!;
    const seed = viewer.battlefield[0]!;
    const under = { ...seed, id: 7100 };
    const anger = { ...seed, id: 7101, conditionMet: true as const };
    const view: BoardView = { ...base, players: base.players.map((p) => (p.isViewer ? { ...p, graveyard: [under, anger] } : p)) };
    const { container, zone } = renderBoard(view);
    const pile = zone(viewer.id, 'graveyard');
    const tile = (root: ParentNode, id: number) => root.querySelector<HTMLElement>(`[data-board-card="${id}"] .card`)!;
    expect(tile(pile, anger.id).hasAttribute('data-condition-met'), 'the pile’s top card').toBe(true);
    expect(tile(pile, under.id).hasAttribute('data-condition-met'), 'the card under it').toBe(false);
    fireEvent.click(pile.querySelector(`[data-board-card="${anger.id}"]`)!);
    const opened = container.querySelector<HTMLElement>('[data-testid="pile-view"]')!;
    expect(tile(opened, anger.id).hasAttribute('data-condition-met'), 'its entry in the pile’s view').toBe(true);
    expect(tile(opened, under.id).hasAttribute('data-condition-met'), 'the other entry').toBe(false);
  });

  it('a creature that can’t block wears its own corner mark — a struck shield, said in words — and keeps it when it turns', () => {
    const { container } = renderBoard(withState({ cantBlock: true, summoningSick: true }));
    const marks = [...card(container).querySelectorAll<HTMLElement>(':scope > .board-card__marks > .board-card__mark')];
    expect(marks.map((m) => m.dataset.mark), 'in the fixed order').toEqual(['sick', 'cantBlock']);
    const mark = marks[1]!;
    expect(mark.querySelector('svg.board-card__mark-art path')?.getAttribute('d'), 'drawn, and not the blocking shield').not.toBe(
      renderBoard(withState({ blocking: true })).container.querySelector('[data-card-id="21"] [data-mark="blocking"] path')?.getAttribute('d'),
    );
    expect(mark.textContent, 'the word, for anything that cannot see it').toBe("can't block");
    expect(mark.dataset.tip).toBe("Can't block");
    cleanup();
    // Tapped, the mark is still a child of the card the quarter turn is applied to, so it turns with it.
    const turned = renderBoard(withState({ cantBlock: true, tapped: true })).container;
    expect(card(turned).hasAttribute('data-tapped')).toBe(true);
    expect(card(turned).querySelector(':scope > .board-card__marks > [data-mark="cantBlock"]'), 'on the turned card').not.toBeNull();
    cleanup();
    expect(renderBoard(withState({})).container.querySelector('[data-mark="cantBlock"]'), 'a creature that can block wears none').toBeNull();
  });

  it('an attacker wears crossed swords, said in words, upright on top of its quarter turn — vigilant or not — and none once it is not attacking', () => {
    const css = styled();
    const { container } = renderBoard(withState({ attacking: true, tapped: false, summoningSick: true }));
    const marks = [...card(container).querySelectorAll<HTMLElement>(':scope > .board-card__marks > .board-card__mark')];
    expect(marks.map((m) => m.dataset.mark), 'in the fixed order').toEqual(['sick', 'attacking']);
    const mark = marks[1]!;
    const shapes = (
      [
        ['sick', { summoningSick: true }],
        ['cantBlock', { cantBlock: true }],
        ['blocking', { blocking: true }],
      ] as const
    ).map(([other, state]) => renderBoard(withState(state)).container.querySelector(`[data-card-id="21"] [data-mark="${other}"] path`)?.getAttribute('d'));
    expect(shapes.every((d) => typeof d === 'string'), 'the other marks were drawn to compare against').toBe(true);
    expect(shapes, 'drawn, and not any other mark').not.toContain(mark.querySelector('svg.board-card__mark-art path')?.getAttribute('d'));
    expect(mark.textContent, 'the word, for anything that cannot see it').toBe('attacking');
    expect(mark.dataset.tip).toBe('Attacking');
    // The quarter turn is on the art inside the face; the marks are the <li>'s own, so they stay upright.
    expect(turnOf(css, card(container)), 'the attacker is turned').toContain('90deg');
    expect(mark.closest('.board-card__face'), 'and the mark is not inside what turns').toBeNull();
    expect(css(card(container).querySelector(':scope > .board-card__marks')!, 'transform'), 'nor turned itself').toMatch(/^(none)?$/);
    const shield = renderBoard(withState({ blocking: true })).container.querySelector('[data-card-id="21"] [data-mark="blocking"]')!;
    expect(css(mark, 'color'), 'in the same ink as the blocking shield').toBe(css(shield, 'color'));
    cleanup();
    const vigilant = renderBoard(withState({ attacking: true, tapped: false, keywords: ['Vigilance'] })).container;
    expect(card(vigilant).querySelector(':scope > .board-card__marks > [data-mark="attacking"]'), 'a vigilant attacker, which never turns, wears it too').not.toBeNull();
    cleanup();
    expect(renderBoard(withState({ tapped: true })).container.querySelector('[data-mark="attacking"]'), 'tapped is not attacking').toBeNull();
  });

  /**
   * R15 (wave 53 T), the operator, Playtest 9: *"cards like 'Magus of the
   * moon' and 'Urborg tomb of yawgmoth' change the types of cards … put one
   * of our overlay pills over the type bar."* Replaces wave 35's corner mark
   * (same fact, a pill now): the pill's own visible text is the CURRENT type
   * line, and its `data-tip` — the board's one tooltip (`tip/index.ts`) —
   * carries the PRINTED one.
   */
  it('a changed permanent (R15) wears a pill over the type bar: current type visible, printed type on hover', () => {
    const { container } = renderBoard(withState({ changedFrom: { name: 'Wasteland', printed: 'Land', current: 'Land — Mountain' } }));
    const pill = card(container).querySelector<HTMLElement>('.board-card__type-pill')!;
    expect(pill, 'the pill is drawn').not.toBeNull();
    expect(pill.textContent, 'the visible text is the CURRENT type line').toBe('Land — Mountain');
    expect(pill.dataset.tip, 'the printed line is in the tooltip').toBe('Printed as Land');
    // No corner mark duplicates the same fact any more (wave 35's was dropped
    // in favour of this pill).
    expect(
      card(container).querySelector('.board-card__mark[data-mark="changed"]'),
      'wave 35’s corner mark is gone, not doubled up with the pill',
    ).toBeNull();
  });

  it('an unchanged permanent (the common case) wears no type pill at all', () => {
    const { container } = renderBoard(withState({ changedFrom: null }));
    expect(card(container).querySelector('.board-card__type-pill')).toBeNull();
  });

  /**
   * R15, the ADAPTER's own half: `toBoardCard` reading Forge's `printedTypes` (`PlayBridge.java`)
   * onto `changedFrom`. The fixture's Izzet Guildgate (id 8, current type line "Land — Gate") stands
   * in for a changed permanent: the printed line is whatever the bridge names for its id.
   */
  it("R15: the adapter sets changedFrom from Forge's printed type when it disagrees with the current one", () => {
    const state = foldPackets(loadPackets(fixture)).state;
    const guildgateId = 8;
    const land = (v: BoardView) => v.players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === guildgateId)!;
    const printed = (sub: string[], token = false) => new Map([[guildgateId, { type: { t: 'cardtype' as const, sup: [], core: ['Land'], sub, all: false, exc: [] }, token }]]);

    const unnamed = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId });
    expect(land(unnamed).card.typeLine, 'a precondition: this is really the wire’s current type line').toBe('Land — Gate');
    expect(land(unnamed).changedFrom, 'Forge names no printed type: nothing changed').toBeNull();

    const changed = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, printedTypes: printed([]) });
    expect(land(changed).changedFrom, 'a printed line that differs sets it, naming the card and carrying both lines').toEqual({
      name: 'Izzet Guildgate',
      printed: 'Land',
      current: 'Land — Gate',
    });

    const same = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, printedTypes: printed(['Gate']) });
    expect(land(same).changedFrom, 'a printed line equal to the current one is no change').toBeNull();

    // A token copy of a card: the same types, but a token printed as a card — Vaultborn Tyrant's death copy,
    // a Cackling Counterpart copy. Drawn with the card's own art, so the pill says what the art does not.
    const asToken = new Map(state);
    const view = deltaKey(DELTA_TYPE.card, guildgateId);
    asToken.set(view, { ...asToken.get(view)!, Token: { t: 'bool', v: true } } as WireObject);
    const copy = land(toBoardView(asToken, 27, { viewerPlayerId: fixture.viewerPlayerId, printedTypes: printed(['Gate']) }));
    expect(copy.token).toBe(true);
    expect(copy.changedFrom, 'a token printed as a card is a change, its line led by Token').toEqual({
      name: 'Izzet Guildgate',
      printed: 'Land — Gate',
      current: 'Token Land — Gate',
    });
    const tokenPrinted = land(toBoardView(asToken, 27, { viewerPlayerId: fixture.viewerPlayerId, printedTypes: printed(['Gate'], true) }));
    expect(tokenPrinted.changedFrom, 'a token printed as a token, types unchanged, is no change').toBeNull();

    // Off the battlefield a printed type is never read: Fire Urchin (id 20) is this fixture's graveyard card.
    const grave = new Map([[20, { type: { t: 'cardtype' as const, sup: [], core: ['Creature'], sub: ['Something'], all: false, exc: [] }, token: false }]]);
    const fireUrchin = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, printedTypes: grave })
      .players.find((p) => p.isViewer)!
      .graveyard.find((c) => c.id === 20)!;
    expect(fireUrchin.changedFrom, 'a graveyard card is never "changed"').toBeNull();
  });

  /**
   * AF74: Maskwood Nexus gives a creature every creature type, which crosses as the cardtype's `all`
   * flag rather than a list. The type line reads it as Forge does (`(All)`), so it disagrees with the
   * printed line and the pill shows. (A changeling's own every-type is printed: Forge's bridge counts
   * characteristic-defining abilities as printed, so it never names one.)
   */
  it('AF74: a creature given every creature type is changed', () => {
    const gateId = 8;
    const printedTypes = new Map([[gateId, { type: { t: 'cardtype' as const, sup: [], core: ['Creature'], sub: ['Elemental'], all: false, exc: [] }, token: false }]]);
    const state = new Map(foldPackets(loadPackets(fixture)).state);
    const key = cardStateKey(gateId, 0);
    state.set(key, { ...state.get(key)!, Type: { t: 'cardtype', sup: [], core: ['Creature'], sub: ['Elemental'], all: true, exc: [] } } as WireObject);
    const nexus = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, printedTypes }).players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === gateId)!;

    expect(nexus.card.typeLine).toBe('Creature — Elemental (All)');
    expect(nexus.changedFrom).toEqual({ name: 'Izzet Guildgate', printed: 'Creature — Elemental', current: 'Creature — Elemental (All)' });
    const { container } = renderBoard(withState({ card: nexus.card, changedFrom: nexus.changedFrom }));
    expect(card(container).querySelector('.board-card__type-pill')?.textContent).toBe('Creature — Elemental (All)');
  });

  it('counters are a badge with a number: +1/+1 is compact, a named counter falls back to its name', () => {
    const { container } = renderBoard(
      withState({ counters: [{ name: '+1/+1', count: 3 }, { name: '-1/-1', count: 1 }, { name: 'charge', count: 2 }] }),
    );
    const badges = [...card(container).querySelectorAll<HTMLElement>('.board-card__counter')];
    expect(badges.map((b) => b.textContent)).toEqual(['+3', '−1', '2 charge']);
    expect(badges.map((b) => b.dataset.counter)).toEqual(['plus', 'minus', 'named']);
    expect(
      card(container).querySelector('.board-card__counters')!.getAttribute('aria-label'),
      'and the whole of it is still said in words',
    ).toBe('Fire Urchin counters: 3 +1/+1, 1 -1/-1, 2 charge');
  });

  it('damage is on the P/T badge — and is the badge itself when a card has no P/T', () => {
    const hit = renderBoard(withState({ damage: 2 }));
    const badge = card(hit.container).querySelector<HTMLElement>('.board-card__pt')!;
    expect(badge.dataset.damage, 'the badge says it was hit').toBe('2');
    expect(badge.querySelector('[data-pt-of="toughness"]')!.getAttribute('data-pt-state')).toBe('damaged');
    cleanup();
    // A land: no power, no toughness, and damage marked on it anyway.
    const land = renderBoard(withState({ damage: 3 }, 25));
    const only = card(land.container, 25).querySelector<HTMLElement>('.board-card__pt')!;
    expect(only, 'a card with no P/T still shows its damage').not.toBeNull();
    expect(only.dataset.damage).toBe('3');
    expect(only.getAttribute('aria-label')).toBe('3 damage marked');
    expect(only.textContent, 'the number, not the word').toBe('3');
  });

  it('nothing the state layer draws can change a card’s box', () => {
    const css = styled();
    const { container } = renderBoard(withState({ blocking: true, token: true, counters: [{ name: '+1/+1', count: 1 }] }));
    for (const sel of ['.board-card__marks', '.board-card__counters']) {
      const layer = card(container).querySelector(sel)!;
      expect(css(layer, 'position'), `${sel} is out of flow`).toBe('absolute');
      expect(css(layer, 'pointer-events'), `${sel} eats no click`).toBe('none');
    }
  });

  it('the state layer is drawn on the battlefield, and ONLY its counters also in an exile pile', () => {
    const view = withState({ summoningSick: true, token: true, counters: [{ name: '+1/+1', count: 1 }] });
    const sicken = (cards: BoardCard[]) => cards.map((c) => ({ ...c, summoningSick: true, token: true, counters: [{ name: '+1/+1', count: 1 }] }));
    // The committed fixture's exile is empty (this file's own header above),
    // so a card with the SAME marks-and-counters shape has to be put there to
    // ask the question at all — reusing a graveyard card's own shape, the way
    // every other case in this describe block builds its state onto the
    // fixture rather than inventing one from scratch.
    const { zone } = renderBoard({
      ...view,
      players: view.players.map((p) =>
        !p.isViewer
          ? p
          : {
              ...p,
              hand: p.hand === null ? null : sicken(p.hand),
              graveyard: sicken(p.graveyard),
              exile: p.graveyard.length > 0 ? [sicken(p.graveyard)[0]!] : p.exile,
            },
      ),
    });
    expect(zone(0, 'battlefield').querySelectorAll('.board-card__marks').length).toBeGreaterThan(0);
    expect(zone(0, 'battlefield').querySelectorAll('.board-card__counters').length).toBeGreaterThan(0);
    for (const where of ['hand', 'graveyard'] as const) {
      expect(zone(0, where).querySelectorAll('.board-card__marks, .board-card__counters'), where).toHaveLength(0);
    }
    // Exile is the one off-battlefield zone that draws counters (a suspended
    // card's time counters) — marks (summoning sick, a token) still mean
    // nothing there, so those stay undrawn.
    expect(zone(0, 'exile').querySelectorAll('.board-card__marks'), 'exile marks').toHaveLength(0);
    expect(zone(0, 'exile').querySelectorAll('.board-card__counters').length, 'exile counters').toBeGreaterThan(0);
  });

  it('a card this seat may not see is its back, named "Hidden card" — in exile and on the battlefield, never a text tile', () => {
    const view = boardFromFixture(fixture);
    const hide = (c: BoardCard): BoardCard => ({ ...c, hidden: true, card: { ...c.card, name: 'Hidden card', scryfallId: undefined } });
    const theirs = view.players.find((p) => !p.isViewer)!;
    const exiled = hide(theirs.graveyard[0]!);
    const faceDown = hide(theirs.battlefield[0]!);
    const { zone } = renderBoard({
      ...view,
      players: view.players.map((p) =>
        p !== theirs ? p : { ...p, exile: [exiled], battlefield: p.battlefield.map((c) => (c.id === faceDown.id ? faceDown : c)) },
      ),
    });
    for (const [where, id] of [['exile', exiled.id], ['battlefield', faceDown.id]] as const) {
      const li = zone(theirs.id, where).querySelector<HTMLElement>(`li[data-card-id="${id}"]`)!;
      const back = li.querySelector('.board-card__face > [data-card-back]');
      expect(back, `${where}: a back`).not.toBeNull();
      expect(back!.getAttribute('aria-label'), where).toBe('Hidden card');
      // The inspector enlarges a `.card` carrying the tile's own id: the back is that element.
      expect(back!.matches(`.card[data-card-id="w${id}"]`), where).toBe(true);
      expect(li.querySelector('.card__name, img'), `${where}: no text tile, no art`).toBeNull();
    }
  });

  it('a suspended card’s Time counter leads in an exile pile — Forge’s own order everywhere else', () => {
    // 'charge' before 'Time' in the INPUT, deliberately: a suspended card is
    // never only suspended (Ancestral Vision's own case has nothing else),
    // but the rule has to hold for one that is, and the only way to tell
    // "reordered" from "happened to already be in order" is to start in the
    // wrong one.
    const mixed = [{ name: 'charge', count: 2 }, { name: 'Time', count: 5 }];
    const view = withState({ counters: mixed });
    const { zone } = renderBoard({
      ...view,
      players: view.players.map((p) => (!p.isViewer ? p : { ...p, exile: p.graveyard.length > 0 ? [{ ...p.graveyard[0]!, counters: mixed }] : p.exile })),
    });
    const faces = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.board-card__counter')].map((b) => b.textContent);
    expect(faces(zone(0, 'exile')), 'exile: Time first, moved ahead of charge').toEqual(['5 Time', '2 charge']);
    expect(
      zone(0, 'exile').querySelector('.board-card__counters')!.getAttribute('aria-label'),
      'the accessible name follows the same, reordered list',
    ).toContain('5 Time, 2 charge');
    expect(faces(zone(0, 'battlefield')), 'the battlefield keeps Forge’s own order, unsorted').toEqual(['2 charge', '5 Time']);
  });
});

/* ── §A.7 / §A.13 — the stack, and §A.9 — the graveyard ──────────────── */

describe('§A.7 / §A.13 — the stack is hidden at zero and roomy unless a question is open', () => {
  const base = boardFromFixture(fixture);
  const noInteraction = (over: Partial<BoardInteraction> = {}): BoardInteraction => ({
    selectable: new Set<number>(),
    selectablePlayers: new Set<number>(),
    onSelectCard: () => {},
    onSelectPlayer: () => {},
    ...over,
  });

  it('draws nothing when the stack is empty — and the zone itself never draws anything, whatever it holds (§S)', () => {
    // The operator: *"the stack doesn't need to show if its empty."* — now
    // true unconditionally: wave 59 §S deleted the row, so there is no
    // CONDITION left to key on. `.stack`'s own rule simply hides it, full
    // stop (`visibility`, not `display` — the BOX has to stay the box, the
    // older *"the entire canvas must be fully static at all times"* rule,
    // which `e2e/table-fit.spec.ts` still measures).
    const css = styled();
    const { container } = renderBoard({ ...base, stack: [] });
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.children).toHaveLength(0);
    expect(css(stack, 'visibility')).toBe('hidden');
    expect(css(stack, 'display'), 'the slot is not taken away').not.toBe('none');
  });

  it('is roomy by default and compact while a question is open', () => {
    // *"the stack should allow to be bigger unless there is a decision waiting"*.
    const css = styled();
    const board = renderBoard(base).container.querySelector('.board')!;
    expect(Number.parseFloat(css(board, '--mid-h')), 'the roomy band is the bigger one').toBeGreaterThan(Number.parseFloat(css(board, '--mid-h-asked')));
    cleanup();

    const quiet = renderBoard(base, noInteraction());
    expect(quiet.container.querySelector<HTMLElement>('.board__mid')!.hasAttribute('data-question')).toBe(false);
    cleanup();
    const asking = renderBoard(base, noInteraction({ questionOpen: true }));
    expect(asking.container.querySelector<HTMLElement>('.board__mid')!.getAttribute('data-question')).toBe('true');
  });
});

/*
 * ── item 11 — one board by default, four lanes as the alternate ─────────
 *
 * *"i said this should be an alternate ui and the real ui should just be a
 * single board, no seperators."* `renderBoard`'s own default keeps every
 * OTHER test above exercising the alternate (it always did, before this prop
 * existed) — these cases are the ones that render `<Board>` with no
 * `boardLayout` prop at all, which is the only way to prove what a caller who
 * supplies none actually gets.
 */
describe('item 11 — one board by default, four lanes as the alternate', () => {
  afterEach(() => {
    cleanup();
    forgetArrangements();
  });

  it('the default — no boardLayout prop at all — draws no type sections anywhere on the board', () => {
    const view = boardFromFixture(fixture);
    const { container } = render(createElement(Board, { view }));
    expect(container.querySelectorAll('[data-board-row]'), 'not one row, on either seat').toHaveLength(0);
    expect(container.querySelectorAll('.zone__rows'), 'not the rows wrapper either').toHaveLength(0);
    expect(container.querySelectorAll('.zone__row-head'), 'nor a lane label').toHaveLength(0);
  });

  it('every permanent is still on the board, in ONE flat list per battlefield, in the view’s own order', () => {
    const view = boardFromFixture(fixture);
    const me = view.players.find((p) => p.isViewer)!;
    const them = view.players.find((p) => !p.isViewer)!;
    const { container } = render(createElement(Board, { view }));
    /** The ids a tier draws, in order. A tier is a list directly under `.zone__tiers`; no row wrapper. */
    const tierIds = (playerId: number, tier: 'front' | 'back') => {
      const zone = container.querySelector<HTMLElement>(
        `[data-testid="player"][data-player-id="${playerId}"] [data-zone="battlefield"]`,
      )!;
      const list = zone.querySelector<HTMLElement>(`:scope > .zone__tiers > ul.zone__cards[data-tier="${tier}"]`)!;
      expect(list, 'a tier list directly under the zone’s tiers, no row wrapper between').not.toBeNull();
      return [...list.querySelectorAll<HTMLElement>(':scope > li.board-card')].map((c) => Number(c.dataset.cardId));
    };
    // Q4a: lands in the BACK row, everything else in the FRONT row, each in the
    // view's own order — nothing lost, nothing duplicated.
    for (const player of [me, them]) {
      const lands = player.battlefield.filter((c) => /\bLand\b/.test(c.card.typeLine.split('—')[0]!)).map((c) => c.id);
      const rest = player.battlefield.filter((c) => !lands.includes(c.id)).map((c) => c.id);
      expect(tierIds(player.id, 'back'), `seat ${player.id}'s back row is its lands`).toEqual(lands);
      expect(tierIds(player.id, 'front'), `seat ${player.id}'s front row is everything else`).toEqual(rest);
    }
    expect(tierIds(me.id, 'back').length + tierIds(me.id, 'front').length, 'a real mix of types is on this seat’s board').toBeGreaterThan(1);
    expect(container.querySelectorAll('[data-board-row]'), 'no type sections in the default').toHaveLength(0);
  });

  it('Q4a: the viewer’s front row is the upper one and the opponent’s is the mirror — back row on top', () => {
    const view = boardFromFixture(fixture);
    const { container } = render(createElement(Board, { view }));
    const order = (id: number) =>
      [...container.querySelectorAll<HTMLElement>(`[data-testid="player"][data-player-id="${id}"] .zone__tiers > ul`)].map((u) => u.dataset.tier);
    expect(order(view.players.find((p) => p.isViewer)!.id), 'towards the centre line first').toEqual(['front', 'back']);
    expect(order(view.players.find((p) => !p.isViewer)!.id), 'their front row is the one nearest the centre').toEqual(['back', 'front']);
  });

  /*
   * The manager's read of `A-board-1280x800.png` caught a real regression in
   * `5b6c73e`: the single list's own selector (`.seat > .zone--battlefield >
   * .zone__cards`) had been added to the `--rows` CALC block but not to the
   * SHARED GRID block that actually gives a battlefield card its size — so the
   * single layout's list fell through to no grid at all, `<li>`s flowed as
   * plain full-width blocks one under another, and a pile's own fan (which
   * still applied — `.board-card__pile` is `position: absolute` and scoped to
   * no layout) had nothing but that oversized block to fan inside, clipping
   * at the lane's bottom the moment a pile or a tenth card needed the row
   * budget `--rows` exists to find.
   *
   * `--card-max` is the SAME token both layouts read (`.seat >
   * .zone--battlefield`'s own `7.5rem`, inherited into whichever child list
   * is actually mounted) — that part was already correct in `5b6c73e` and
   * stays asserted here as the reason a shared cap is enough once the list
   * is actually IN the grid this pins.
   */
  it('the single list is laid out in the lanes’ own grid, not flowed as blocks', () => {
    const css = styled();
    const view = boardFromFixture(fixture);
    const grid = (container: HTMLElement, list: string) => {
      const el = container.querySelector(`.seat[data-viewer] [data-zone="battlefield"] ${list}`)!;
      return [css(el, 'display'), css(el, 'grid-auto-flow'), css(el, '--card-w')];
    };
    const lane = grid(render(createElement(Board, { view, boardLayout: 'type-separated' })).container, '.zone__row > .zone__cards');
    cleanup();
    const tier = grid(render(createElement(Board, { view })).container, '.zone__tiers > .zone__cards');
    expect(lane[0], 'a lane is a grid').toBe('grid');
    expect(tier, 'and the single list is the same grid, sized the same way').toEqual(lane);
  });

  it('boardLayout="type-separated" still renders the four labelled lanes — the alternate is not deleted', () => {
    const view = boardFromFixture(fixture);
    const { container } = render(createElement(Board, { view, boardLayout: 'type-separated' }));
    const rows = [...container.querySelectorAll<HTMLElement>('[data-board-row]')];
    expect(rows.map((r) => r.dataset.boardRow)).toEqual(
      expect.arrayContaining(['lands', 'artifacts', 'creatures', 'other']),
    );
    // Four lanes on YOUR seat; the opponent's board is always the default one (Q15c).
    expect(container.querySelectorAll('.seat[data-viewer] [data-board-row]')).toHaveLength(4);
    expect(container.querySelectorAll('.seat:not([data-viewer]) [data-board-row]')).toHaveLength(0);
    expect(container.querySelectorAll('.seat:not([data-viewer]) .zone__tiers')).toHaveLength(1);
  });

  it('wave 24’s placement model is not replaced by the default — a drop still stacks, reorders and joins the end, in the one lane', () => {
    const { container } = renderBoard(boardFromFixture(fixture), undefined, 'single');
    const me = boardFromFixture(fixture).players.find((p) => p.isViewer)!;
    const cardEl = (id: number) => container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${id}"]`)!;
    const tier = (name: string) => {
      const list = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"]`)!;
      return [...list.querySelectorAll<HTMLElement>(':scope > li.board-card')].map((c) => Number(c.dataset.cardId));
    };

    // 8, 24, 6, 25 are lands (the back row); 21 is the creature (the front row).
    const [first, second, third] = [8, 24, 21];
    expect(me.battlefield.map((c) => c.id)).toEqual(expect.arrayContaining([first, second, third]));
    expect(tier('back')).toEqual([8, 24, 6, 25]);
    expect(tier('front')).toEqual([21]);

    // Stack ON TOP: `second` dropped on the upper third of `first`.
    dragCard(container, second, { card: first, at: 'top' });
    expect(cardEl(first).querySelector('.board-card__pile'), 'a pile, inside the one tier').not.toBeNull();
    expect(tier('back'), 'one column fewer — second joined first’s pile').toEqual([8, 6, 25]);

    // Complete freedom (Q4b): the creature goes into the BACK row, in front of `first` —
    // there is no bucket a card is confined to.
    dragCard(container, third, { card: first, at: 'before' });
    expect(tier('back')[0]).toBe(third);
    expect(tier('front'), 'and the front row is an empty slot now').toEqual([]);
    expect(container.querySelectorAll('[data-board-row]'), 'still no type sections').toHaveLength(0);

    // And back into the EMPTY front row, which is a slot like any other.
    dragCard(container, third, { slot: 'front' });
    expect(tier('front')).toEqual([third]);
    expect(tier('back')).toEqual([8, 6, 25]);
  });
});

/**
 * Wave 31 §A — the board surface after the operator's second play test. One case
 * per item, each reading the thing that item changed rather than a neighbour.
 */
describe('wave 31 §A: the seat, the left column and the stack', () => {

  it('P3: no text node says (you), the life sits under the mark, and the name is the seat’s own', () => {
    const { container, seat, view } = renderBoard();
    const me = view.players.find((p) => p.isViewer)!;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      expect(n.textContent, 'no visible (you) anywhere on the board').not.toContain('(you)');
    }
    // Still there for a screen reader.
    expect(seat(me.id).getAttribute('aria-label')).toBe(`${me.name} (you)`);
    // The life is on the face's last line after the mark, in flow: the card.css rule
    // that used to lay it over the avatar is overridden to `static` in the seat.
    const hit = seat(me.id).querySelector('.face__hit')!;
    // Wave 33 shape 3 inserted `.seat__ring` between the mark and the life
    // badge — decorative, `aria-hidden`, and absolutely positioned, so it
    // changes none of this test's own claims about the other two. The life's
    // line is `.face__vitals`, which poison shares while the seat has any.
    expect([...hit.children].map((c) => (c.getAttribute('class') ?? '').split(' ')[0])).toEqual([
      'face__art',
      'seat__ring',
      'face__vitals',
    ]);
    expect([...hit.querySelector('.face__vitals')!.children].map((c) => c.className)).toEqual(['face__life']);
    expect(styled()(hit.querySelector('.face__life')!, 'position'), 'in flow under the mark, not laid over it').toBe('static');
  });

  it('P3: the adapter takes the seat’s name from identity.name, and falls back to Forge’s when it is blank or absent', () => {
    const state = foldPackets(loadPackets(fixture)).state;
    const base = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
    const ids = base.players.map((p) => p.id);
    const named = toBoardView(state, 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      artIds: TEST_ART_IDS,
      nameByPlayerId: new Map([
        [ids[0]!, 'Hadoku'],
        [ids[1]!, '   '],
      ]),
    });
    const nameOf = (v: BoardView, id: number) => v.players.find((p) => p.id === id)!.name;
    expect(nameOf(named, ids[0]!)).toBe('Hadoku');
    expect(nameOf(named, ids[1]!), 'blank falls back to what Forge calls them').toBe(nameOf(base, ids[1]!));
    expect(nameOf(base, ids[0]!), 'and no map at all is what it always was').not.toBe('Hadoku');
  });

  it('P2 / Q9: no share of the column is written for the graveyard — it takes what the avatar and counts leave', () => {
    // The count spends none of it: it is in the bar, in its own track.
    const { seat } = renderBoard();
    expect(seat(0).querySelector('.seat__piles [data-testid="library-count"]')).toBeNull();
  });

  it('P5: Regroup is gone from the board', () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-arrange-reset], .seat__regroup')).toBeNull();
    expect(container.textContent).not.toMatch(/Regroup/i);
  });

  it('P6: the canvas has no outer border or inset shadow, and board.css has no hex literal', () => {
    const css = styled();
    const { zone } = renderBoard();
    for (const id of [0, 1]) {
      expect(css(zone(id, 'battlefield'), 'border-style'), 'no border').toMatch(/^(none)?$/);
      expect(css(zone(id, 'battlefield'), 'box-shadow'), 'no inset shadow').toMatch(/^(none)?$/);
    }
    expect(BOARD_RULES.match(/#[0-9a-fA-F]{3,8}\b/g), 'every colour comes off a theme token').toBeNull();
  });
});

/* ── wave 32 lane B: the board surface, and a drag that is ours ───────── */

describe('wave 32 §B — the surface: Q2, Q13, Q1b, Q16, the stack', () => {
  const view = boardFromFixture(fixture);

  it('Q2: the opponent’s hand is drawn at the card size of yours, from the same tokens', () => {
    const css = styled();
    const { zone } = renderBoard(view);
    const theirs = zone(1, 'hand').querySelector(':scope > .card-backs')!;
    const mine = zone(0, 'hand').querySelector(':scope > .zone__cards')!;
    // T6 (wave 36): neither side caps a hand card below what its own row allows.
    expect(css(theirs, '--card-max'), 'no ceiling on theirs').toBe('');
    expect(css(mine, '--card-max'), 'nor on yours').toBe('');
    expect(css(theirs, '--card-slack'), 'the same slack as yours').toBe(css(mine, '--card-slack'));
  });

  it('Q2: the strip tells the stylesheet how many backs it holds, as a hand of faces does', () => {
    const { zone } = renderBoard(view);
    const backs = zone(1, 'hand').querySelector<HTMLElement>('ul.card-backs')!;
    const them = view.players.find((p) => !p.isViewer)!;
    expect(backs.style.getPropertyValue('--cols')).toBe(String(them.handCount));
    expect(backs.querySelectorAll('[data-card-back]')).toHaveLength(them.handCount);
  });

  it('a hidden hand on the VIEWER’s side (a watcher’s perspective seat, 2026-10-12) is the viewer’s strip, sized by the same rule as the top one', () => {
    const css = styled();
    const watched = { ...view, players: view.players.map((p) => (p.isViewer ? { ...p, hand: null, handCount: 7 } : p)) };
    const { zone } = renderBoard(watched);
    const bottom = zone(0, 'hand');
    const top = zone(1, 'hand');
    expect(bottom.getAttribute('data-owner'), 'the viewer side’s, like the rest of that seat').toBe('you');
    expect(top.getAttribute('data-owner')).toBe('them');
    expect(bottom.classList.contains('zone--backs') && top.classList.contains('zone--backs'), 'both strips are keyed for the stylesheet').toBe(true);
    expect(bottom.querySelectorAll('[data-card-back]')).toHaveLength(7);
    expect(css(bottom.querySelector(':scope > ul.card-backs')!, '--card-slack'), 'the same slack as the top strip').toBe(css(top.querySelector(':scope > ul.card-backs')!, '--card-slack'));
    expect(css(bottom.querySelector(':scope > ul.card-backs')!, 'display'), 'the same grid as the top strip').toBe(css(top.querySelector(':scope > ul.card-backs')!, 'display'));
  });

  it('Q13: power/toughness sits in the card’s BOTTOM-right corner, clear of the counters and the marks', () => {
    const css = styled();
    const urchin = { ...view, players: view.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id !== 21 ? c : { ...c, blocking: true, counters: [{ name: '+1/+1', count: 1 }] })) })) };
    const card = renderBoard(urchin).container.querySelector('[data-card-id="21"]')!;
    const anchors = (sel: string) => ['top', 'right', 'bottom', 'left'].filter((side) => !/^(auto)?$/.test(css(card.querySelector(`:scope > ${sel}`)!, side)));
    expect(anchors('.board-card__pt'), 'P/T: the bottom-right corner').toEqual(['right', 'bottom']);
    expect(anchors('.board-card__counters'), 'counters: the left edge').toContain('left');
    expect(anchors('.board-card__marks'), 'marks: the top edge').toContain('top');
  });

  it('the ring round the avatar is the seat Forge is waiting on; the active player’s side is lit and the other shaded, not by a ring or the name', () => {
    // Seat 0 is the active player, seat 1 is asked: the two marks part.
    const parted: BoardView = { ...view, players: view.players.map((p, i) => ({ ...p, isActive: i === 0, hasPriority: i === 1 })) };
    const { container, seat } = renderBoard(parted);
    const [active, asked] = [parted.players[0]!, parted.players[1]!];
    const css = styled();
    expect(seat(active.id).dataset.active).toBe('true');
    expect(seat(asked.id).dataset.active).toBeUndefined();
    expect(seat(asked.id).dataset.priority).toBe('true');
    expect(seat(active.id).dataset.priority).toBeUndefined();
    // Every seat draws its ring element, lit or not, inside the section the hook is on.
    for (const p of parted.players) {
      const ring = seat(p.id).querySelector('.seat__ring');
      expect(ring?.closest('[data-testid="player"]'), `seat ${p.id} has a ring element in its own section`).toBe(seat(p.id));
    }
    const ringOf = (id: number) => seat(id).querySelector('.seat__ring')!;
    const nameOf = (id: number) => seat(id).querySelector('.seat__name')!;
    expect(css(ringOf(asked.id), 'box-shadow'), 'the asked seat’s ring is drawn').not.toMatch(/^(none)?$/);
    expect(css(ringOf(active.id), 'box-shadow'), 'the active seat’s is not').toMatch(/^(none)?$/);
    // Whose turn it is is the seat's own light and shade (`board.css`), keyed off the section's `data-active`.
    expect(css(seat(active.id), '--turn-lit'), 'the active side wears the edge light').toBe('1');
    expect(css(seat(asked.id), '--turn-lit'), 'the other does not').toBe('0');
    expect(css(seat(asked.id), '--turn-shade'), 'the other side sits in the shade').toBe('1');
    expect(css(seat(active.id), '--turn-shade'), 'the active side does not').toBe('0');
    for (const p of parted.players) {
      expect(css(nameOf(p.id), 'box-shadow'), `seat ${p.id}'s name carries no mark`).toMatch(/^(none)?$/);
      expect(css(nameOf(p.id), 'font-weight'), `seat ${p.id}'s name is not bolded`).not.toBe('700');
    }
    // A 50% radius is a circle only on a square box (the operator saw an oval, 2026-10-03).
    const lit = ringOf(asked.id);
    expect(css(lit, 'border-radius')).toBe('50%');
    expect(css(lit, 'width'), 'a square box').toBe(css(lit, 'height'));
    expect(container.textContent).not.toMatch(/their turn|priority/i);
  });

  it('Q16: card badges sit on one rung of the shared scale, inside a stacking context of the card’s own', () => {
    const css = styled();
    const urchin = { ...view, players: view.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id !== 21 ? c : { ...c, blocking: true, counters: [{ name: '+1/+1', count: 1 }] })) })) };
    const card = renderBoard(urchin).container.querySelector('[data-card-id="21"]')!;
    const rungs = ['.board-card__pt', '.board-card__marks', '.board-card__counters'].map((sel) => css(card.querySelector(`:scope > ${sel}`)!, 'z-index'));
    expect(rungs[0], 'a badge is on the scale').toContain('--z-card-badge');
    expect(new Set(rungs), 'and every badge on the same rung').toEqual(new Set([rungs[0]]));
    expect(css(card, 'isolation')).toBe('isolate');
    // No literal that outranks the scale survives in the card's own sheet.
    expect(withoutComments(CARD_CSS)).not.toMatch(/z-index:\s*(?:[2-9]|\d\d+)\s*;/);
  });

  it('stack: a question moves the band, and the band is sized by state alone', () => {
    const css = styled();
    const band = (n: number, questionOpen: boolean) => {
      const mid = renderBoard(withStack(view, n), { ...spyInteraction([]).interaction, questionOpen }).container.querySelector('[data-testid="board-mid"]')!;
      const got = { question: mid.hasAttribute('data-question'), top: css(mid, 'top'), height: css(mid, 'height') };
      cleanup();
      return got;
    };
    const asked = band(5, true);
    expect(asked.question).toBe(true);
    expect(asked.top, 'the question moves the band').not.toBe(band(5, false).top);
    // The band's size never reads how many items there are.
    expect(band(1, true)).toEqual(asked);
    expect(band(1, false)).toEqual(band(5, false));
  });
});

describe('wave 32 §B — Q4a: where a permanent goes by default', () => {
  /** The viewer's two tiers' ids, in the order they draw them. */
  const tiers = (container: HTMLElement) => {
    const ids = (name: string) =>
      [...container.querySelectorAll<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"] > li.board-card`)].map((c) => Number(c.dataset.cardId));
    return { back: ids('back'), front: ids('front') };
  };

  /** The fixture with one more permanent of the given type, as Forge would send it. */
  function withPermanent(base: BoardView, id: number, typeLine: string): BoardView {
    const me = base.players.find((p) => p.isViewer)!;
    const seed = me.battlefield[0]!;
    return {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer ? p : { ...p, battlefield: [...p.battlefield, { ...seed, id, card: { ...seed.card, cardId: `w${id}`, typeLine } }] },
      ),
    };
  }

  it('a land joins the end of the BACK row and anything else the end of the FRONT row, left to right', () => {
    const base = boardFromFixture(fixture);
    const { container } = renderBoard(withPermanent(withPermanent(base, 701, 'Basic Land — Island'), 702, 'Artifact — Equipment'), undefined, 'single');
    expect(tiers(container)).toEqual({ back: [8, 24, 6, 25, 701], front: [21, 702] });
  });

  it('reads every row left to right', () => {
    const css = styled();
    const { container } = renderBoard(boardFromFixture(fixture), undefined, 'single');
    for (const row of container.querySelectorAll('.seat [data-zone="battlefield"] .zone__tiers > .zone__cards')) {
      expect(css(row, 'direction')).not.toBe('rtl');
      expect(css(row, 'flex-direction')).not.toMatch(/reverse/);
      expect(css(row, 'justify-content')).not.toMatch(/end/);
    }
  });

  it('the tiers are slots even while empty, so a card can be put in either', () => {
    const base = boardFromFixture(fixture);
    const bare: BoardView = {
      ...base,
      players: base.players.map((p) => (p.isViewer ? { ...p, battlefield: [] } : p)),
    };
    const { container } = renderBoard(bare, undefined, 'single');
    for (const name of ['front', 'back']) {
      expect(container.querySelector(`.seat[data-viewer] [data-arrange-slot="${name}"]`), `an empty ${name} row is a slot`).not.toBeNull();
    }
    // The opponent's board is not ours to arrange: no slot on it.
    expect(container.querySelector('.seat:not([data-viewer]) [data-arrange-slot]')).toBeNull();
  });
});

describe('wave 32 §B — Q4b: the drag that is ours', () => {
  const view = boardFromFixture(fixture);
  const boardOf = (c: HTMLElement) => c.querySelector<HTMLElement>('.board')!;

  /** A bare layout for the pure snap: two slots, the first holding two piles, the second empty. */
  const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });
  const slots = [
    { slot: 'front' as const, box: box(0, 0, 400, 100), piles: [{ id: 1, box: box(10, 8, 60, 84) }, { id: 2, box: box(80, 8, 60, 84) }] },
    { slot: 'back' as const, box: box(0, 200, 400, 100), piles: [] },
  ];

  it('snapTo: a lone card at the row\'s last column — the operator\'s screenshot — is offered EVERY column of the row, left and right (AE19)', () => {
    // 2026-10-09 05:15Z: an Island at column 6 after six empty columns; dragging it right drew outlines only to its left.
    // Pitch 70, the row 1000 wide: columns 0–13 fit. `withColumnsToWidth` is what the readers apply.
    const gap = (i: number) => ({ id: null, box: box(10 + i * 70, 8, 60, 84) });
    const lone = withColumnsToWidth({ slot: 'front' as const, box: box(0, 0, 1000, 100), piles: [gap(0), gap(1), gap(2), gap(3), gap(4), gap(5), { id: 6, box: box(430, 8, 60, 84) }], step: 70 });
    expect(lone.piles.length, 'every column that starts inside the row').toBe(15);
    expect(snapTo([lone], 530, 50, 6)?.target, 'just right of it: column 7').toEqual({ kind: 'at', column: 7 });
    expect(snapTo([lone], 600, 50, 6)?.target, 'a pitch further: column 8').toEqual({ kind: 'at', column: 8 });
    expect(snapTo([lone], 950, 50, 6)?.target, 'at the row\'s right edge: the last column that fits').toEqual({ kind: 'at', column: 13 });
    expect(snapTo([lone], 100, 50, 6)?.target, 'left, over a gap: that gap').toEqual({ kind: 'at', column: 1 });
    expect(snapTo([lone], 460, 50, 6)?.target, 'on itself: it stays').toEqual({ kind: 'before', id: 6 });
    // An EMPTY row has every column too (the first permanent of a game, AE25): the column under the pointer.
    const empty = withColumnsToWidth({ slot: 'back' as const, box: box(0, 200, 1000, 100), piles: [], step: 70 });
    expect(snapTo([empty], 500, 250)?.target, 'released near the middle of an empty row: that column, not the first').toEqual({ kind: 'at', column: 7 });
  });

  it('snapTo: the nearest place in a row — a thin edge strip reorders, the rest stacks (W7)', () => {
    // Pile 1's box is (10, 8)-(70, 92): 60 wide, 84 tall.
    expect(snapTo(slots, 15, 50)?.target, 'the left edge strip: before it').toEqual({ kind: 'before', id: 1 });
    expect(snapTo(slots, 65, 50)?.target, 'the right edge strip of the first: in front of the second').toEqual({
      kind: 'before',
      id: 2,
    });
    expect(snapTo(slots, 135, 50)?.target, 'the right edge strip of the last: the end').toEqual({ kind: 'end' });
    // Every column that fits the row is a place (the operator, 2026-10-09); the readers apply `withColumnsToWidth`.
    const wide = [withColumnsToWidth({ ...slots[0]!, step: 70 }), slots[1]!];
    expect(snapTo(wide, 170, 50)?.target, 'past the last card, within one column: the next column').toEqual({ kind: 'at', column: 2 });
    // Z8: two columns past it, a column of its own, with gaps opened up to it.
    expect(snapTo(wide, 300, 50)?.target, 'further right: that column').toEqual({ kind: 'at', column: 4 });
    expect(snapTo(slots, 40, 14)?.target, 'dead centre, near the top: on top of it').toEqual({
      kind: 'stack',
      id: 1,
      onTop: true,
    });
    expect(snapTo(slots, 40, 86)?.target, 'dead centre, near the bottom: under it').toEqual({
      kind: 'stack',
      id: 1,
      onTop: false,
    });
    /*
     * The OLD rule read height thirds, so a drop at (40, 45) — dead centre
     * horizontally, and in the card's vertical MIDDLE third — fell through to
     * the reorder rule and read as "after" (x not < the midpoint). That
     * middle band, reachable from anywhere across the card's width, is what
     * made a drop near a card's vertical centre miss the stack. Now width
     * decides first: dead centre is nowhere near either edge strip, so it
     * stacks regardless of how close to the vertical middle the drop is.
     */
    expect(snapTo(slots, 40, 45)?.target, "W7: dead centre at the card's vertical middle still stacks, not reorders").toEqual({
      kind: 'stack',
      id: 1,
      onTop: true,
    });
    // And the strip really is thin: just inside it (not within it) still stacks.
    expect(snapTo(slots, 18, 50)?.target, 'just inside the left edge strip: stacks, not before').toEqual({
      kind: 'stack',
      id: 1,
      onTop: false,
    });
  });

  it('snapTo + withMove: the card being dragged is not a place — moving it one column right works, and dropping it on itself moves nothing', () => {
    // Four lone cards, 60 wide, 10 apart: 1 at 10, 2 at 80, 3 at 150, 4 at 220 (right edges 70, 140, 210, 280).
    const four = [
      {
        slot: 'front' as const,
        box: box(0, 0, 400, 100),
        piles: [1, 2, 3, 4].map((id, i) => ({ id, box: box(10 + 70 * i, 8, 60, 84) })),
      },
    ];
    const empty = { lands: [], artifacts: [], creatures: [], other: [], front: [], back: [] } as const;
    const rows = (): Grouped => ({ ...empty, front: [1, 2, 3, 4].map((id) => [{ id } as BoardCard]) });
    const order = (a: Arrangement) => (a[slotKey(0, 'front')] ?? []).map((pile) => pile[0]);
    // The operator's case: card 1 dragged one column to the right.
    expect(snapTo(four, 135, 50, 1)?.target, "the neighbour's right edge strip: in front of the one after it").toEqual({ kind: 'before', id: 3 });
    expect(snapTo(four, 145, 50, 1)?.target, 'the gap between the neighbour and the next: the same').toEqual({ kind: 'before', id: 3 });
    expect(order(withMove(rows(), 0, {}, 1, 'front', { kind: 'before', id: 3 }, 'single')), 'one column right').toEqual([2, 1, 3, 4]);
    expect(order(withMove(rows(), 0, {}, 2, 'front', { kind: 'before', id: 4 }, 'single')), 'from the middle, one right').toEqual([1, 3, 2, 4]);
    // Over its own column — any part of it — it is where it came from: nothing stacks onto itself, nothing goes to the end.
    expect(snapTo(four, 40, 50, 1)?.target, 'its own middle: not a stack onto itself — it stays (a self target)').toEqual({ kind: 'before', id: 1 });
    expect(snapTo(four, 15, 50, 1)?.target, 'its own left edge: on its own box, it stays (a self target)').toEqual({ kind: 'before', id: 1 });
    expect(order(withMove(rows(), 0, {}, 1, 'front', { kind: 'before', id: 1 }, 'single')), 'before itself moves nothing').toEqual([1, 2, 3, 4]);
    expect(order(withMove(rows(), 0, {}, 1, 'front', { kind: 'stack', id: 1, onTop: true }, 'single')), 'onto itself moves nothing').toEqual([1, 2, 3, 4]);
    // Dragging 2 over 1's right edge: the column after 1 is 2's own, so "after 1" is before 3 — where 2 already is.
    expect(snapTo(four, 65, 50, 2)?.target, "the left neighbour's right edge: the next column that is not its own").toEqual({ kind: 'before', id: 3 });
    expect(order(withMove(rows(), 0, {}, 2, 'front', { kind: 'before', id: 3 }, 'single')), 'which is where it is').toEqual([1, 2, 3, 4]);
    // A pile the dragged card is only part of stays a place (its base is not the card).
    const piled = [{ slot: 'front' as const, box: box(0, 0, 400, 100), piles: [{ id: 1, box: box(10, 8, 60, 84), size: 2 }, { id: 3, box: box(80, 8, 60, 84) }] }];
    expect(snapTo(piled, 40, 20, 1)?.target, 'the base of a two-card pile, dragged: the pile is still a stack target').toEqual({ kind: 'stack', id: 1, onTop: true });
    // The hand's own move, the same case by name: 1 one slot right.
    expect((withHandMove([1, 2, 3, 4], 0, {}, 1, { kind: 'before', id: 3 })[slotKey(0, 'hand')] ?? []).map((p) => p[0])).toEqual([2, 1, 3, 4]);
  });

  it('withMove: a lone card stacked onto a pile leaves its column open — the pile and every column after it stay where they are', () => {
    // The operator, 2026-10-13: "when moving the last card onto a stacked pile, the piles moves to the left one space".
    // Their row (match m-a58ab8a6bb79): [130 125 131 123 134 128] [122] [99 101] [80] [] [81 79] — 80 onto the pile at column 5.
    const empty = { lands: [], artifacts: [], creatures: [], other: [], front: [], back: [] } as const;
    const rowOf = (piles: number[][]): Grouped => ({ ...empty, back: piles.map((p) => p.map((id) => ({ id }) as BoardCard)) });
    const back = (a: Arrangement) => a[slotKey(0, 'back')];
    const theirs = rowOf([[130, 125], [122], [99, 101], [80], [], [81, 79]]);
    expect(back(withMove(theirs, 0, {}, 80, 'back', { kind: 'stack', id: 79, onTop: true }, 'single')), 'the pile stays at column 5').toEqual([
      [130, 125],
      [122],
      [99, 101],
      [],
      [],
      [81, 79, 80],
    ]);
    // The column it left is to the pile's right: nothing after it moves either, and a trailing one is trimmed as always.
    expect(back(withMove(rowOf([[1, 2], [3], [4]]), 0, {}, 3, 'back', { kind: 'stack', id: 1, onTop: false }, 'single'))).toEqual([[3, 1, 2], [], [4]]);
    expect(back(withMove(rowOf([[1, 2], [3]]), 0, {}, 3, 'back', { kind: 'stack', id: 2, onTop: true }, 'single'))).toEqual([[1, 2, 3]]);
    // A reorder is still a reorder: the card takes a column, so the one it left closes up.
    expect(back(withMove(rowOf([[1], [2], [3]]), 0, {}, 1, 'back', { kind: 'before', id: 3 }, 'single'))).toEqual([[2], [1], [3]]);
    expect(back(withMove(rowOf([[1], [2], [3]]), 0, {}, 1, 'back', { kind: 'end' }, 'single'))).toEqual([[2], [3], [1]]);
  });

  it('withMove: a whole pile carried at once lands as one pile, in its order, wherever one card would', () => {
    // The operator, 2026-10-21: "allow me to 'long press' to pick up the whole stack and move it".
    const empty = { lands: [], artifacts: [], creatures: [], other: [], front: [], back: [] } as const;
    const rowOf = (piles: number[][]): Grouped => ({ ...empty, back: piles.map((p) => p.map((id) => ({ id }) as BoardCard)) });
    const back = (a: Arrangement) => a[slotKey(0, 'back')];
    const row = rowOf([[1, 2, 3], [4], [5]]);
    expect(back(withMove(row, 0, {}, [1, 2, 3], 'back', { kind: 'end' }, 'single')), 'to the end').toEqual([[4], [5], [1, 2, 3]]);
    expect(back(withMove(row, 0, {}, [1, 2, 3], 'back', { kind: 'before', id: 5 }, 'single')), 'before a card').toEqual([[4], [1, 2, 3], [5]]);
    expect(back(withMove(row, 0, {}, [1, 2, 3], 'back', { kind: 'stack', id: 5, onTop: true }, 'single')), 'onto another pile, keeping its column open').toEqual([[], [4], [5, 1, 2, 3]]);
    expect(back(withMove(row, 0, {}, [1, 2, 3], 'back', { kind: 'at', column: 4 }, 'single')), 'at a column past the end').toEqual([[], [4], [5], [], [1, 2, 3]]);
    expect(back(withMove(row, 0, {}, [1, 2, 3], 'back', { kind: 'stack', id: 2, onTop: true }, 'single')), 'onto one of its own cards it stays').toEqual([[1, 2, 3], [4], [5]]);
  });

  it('snapTo: a whole pile carried is not a place to drop itself, a card lifted out of it still may go back', () => {
    const pile = { id: 1, size: 3, box: { left: 0, top: 0, right: 100, bottom: 140 } };
    const lone = { id: 4, box: { left: 110, top: 0, right: 210, bottom: 140 } };
    const slot: SlotGeometry = { slot: 'back', box: { left: 0, top: 0, right: 400, bottom: 140 }, piles: [pile, lone] };
    // Over the pile it came from, carried whole: the pile stays where it is.
    expect(snapTo([slot], 50, 40, 1, true)?.target).toEqual({ kind: 'before', id: 1 });
    // One card out of that pile (its base, pressed briefly) may stack back onto it, as before.
    expect(snapTo([slot], 50, 40, 1)?.target).toEqual({ kind: 'stack', id: 1, onTop: true });
  });

  it('group: a card nobody placed takes the first free column of its row from the left, else the row’s end', () => {
    // The operator, 2026-10-17: "ideally it's the first avaliable slot from top left onward" — not past the furthest card placed.
    const creature = (id: number) => ({ id, card: { typeLine: 'Creature — Soldier' } }) as BoardCard;
    const land = (id: number) => ({ id, card: { typeLine: 'Land — Plains' } }) as BoardCard;
    const ids = (g: Grouped, row: 'front' | 'back' | 'creatures' | 'lands') => g[row].map((pile) => pile.map((c) => c.id));
    const arranged: Arrangement = { [slotKey(0, 'front')]: [[], [1, 2], [3], [], [4]], [slotKey(0, 'back')]: [[10], [11]] };
    const board = [creature(1), creature(2), creature(3), creature(4), land(10), land(11)];
    // The first gap, then the next one, then the end — in the order the cards are on the battlefield.
    const one = group([...board, creature(50)], 0, arranged, 'single');
    expect(ids(one, 'front'), 'the gap at column 0').toEqual([[50], [1, 2], [3], [], [4]]);
    const two = group([...board, creature(50), creature(51)], 0, arranged, 'single');
    expect(ids(two, 'front'), 'then the gap at column 3').toEqual([[50], [1, 2], [3], [51], [4]]);
    const three = group([...board, creature(50), creature(51), creature(52)], 0, arranged, 'single');
    expect(ids(three, 'front'), 'no gap left: the end').toEqual([[50], [1, 2], [3], [51], [4], [52]]);
    // Its own row only: a land goes to the back row, which has no gap — its end.
    expect(ids(group([...board, land(12)], 0, arranged, 'single'), 'back'), 'a land: the back row’s end').toEqual([[10], [11], [12]]);
    expect(ids(group([...board, land(12)], 0, arranged, 'single'), 'front'), 'and the front row’s gaps stay open').toEqual([[], [1, 2], [3], [], [4]]);
    // The type-separated rows follow the same rule.
    const lanes: Arrangement = { [slotKey(0, 'creatures')]: [[1], [], [2]] };
    expect(ids(group([creature(1), creature(2), creature(60)], 0, lanes, 'type-separated'), 'creatures'), 'a lane’s gap').toEqual([[1], [60], [2]]);
    // A card the player placed keeps its column: it is never moved into a gap left of it.
    expect(ids(group(board, 0, arranged, 'single'), 'front'), 'nothing new: the arrangement as placed').toEqual([[], [1, 2], [3], [], [4]]);
  });

  it('group: a card nobody placed that carries a placed card is drawn in that card’s column, not the first gap', () => {
    // Batterskull let go at column 5; its Germ arrives holding it. The pile stays where Batterskull was put.
    const germ = { id: 70, card: { typeLine: 'Creature — Phyrexian Germ' }, attachedCardIds: [60] } as unknown as BoardCard;
    const skull = { id: 60, card: { typeLine: 'Artifact — Equipment' }, attachedCardIds: [] } as unknown as BoardCard;
    const creature = { id: 1, card: { typeLine: 'Creature — Soldier' } } as BoardCard;
    const ids = (g: Grouped, row: 'front' | 'artifacts' | 'creatures') => g[row].map((pile) => pile.map((c) => c.id));
    const arranged: Arrangement = { [slotKey(0, 'front')]: [[1], [], [], [], [], [60]] };
    expect(ids(group([creature, skull, germ], 0, arranged, 'single'), 'front')).toEqual([[1], [], [], [], [], [70, 60]]);
    // A chain: an unplaced aura on the unplaced Germ follows it into the same column.
    const aura = { id: 80, card: { typeLine: 'Enchantment — Aura' }, attachedCardIds: [] } as unknown as BoardCard;
    const wearing = { ...germ, attachedCardIds: [60, 80] } as BoardCard;
    expect(ids(group([creature, aura, skull, wearing], 0, arranged, 'single'), 'front')).toEqual([[1], [], [], [], [], [70, 60, 80]]);
    // The type-separated rows: the Germ joins Batterskull's pile in the artifacts row.
    const lanes: Arrangement = { [slotKey(0, 'artifacts')]: [[], [60]] };
    const g = group([creature, skull, germ], 0, lanes, 'type-separated');
    expect(ids(g, 'artifacts')).toEqual([[], [70, 60]]);
    expect(ids(g, 'creatures')).toEqual([[1]]);
  });

  it('snapTo: an EMPTY slot snaps, the nearest slot wins, and far from every slot is nowhere', () => {
    const empty = snapTo(slots, 200, 250)!;
    expect(empty.slot).toBe('back');
    expect(empty.target).toEqual({ kind: 'end' });
    expect(empty.card, 'an empty slot has no card to hang the bar on').toBeNull();
    // In the gap between the two rows it goes to the nearer one.
    expect(snapTo(slots, 200, 120)?.slot).toBe('front');
    expect(snapTo(slots, 200, 180)?.slot).toBe('back');
    // Far from everything: no snap, so the drop does nothing.
    expect(snapTo(slots, 200, -900)).toBeNull();
    expect(snapTo([], 0, 0)).toBeNull();
  });

  it('snapTo: a hand does not stack — the thirds are not read there', () => {
    const hand = [{ slot: 'hand' as const, box: box(0, 0, 400, 100), piles: [{ id: 7, box: box(10, 8, 60, 84) }] }];
    expect(snapTo(hand, 15, 14)?.target).toEqual({ kind: 'before', id: 7 });
    expect(snapTo(hand, 60, 86)?.target).toEqual({ kind: 'end' });
  });

  it('a card lifted out of a pile is drawn as one card: its ghost carries nothing of the pile, and the ghost rule outranks the pile’s', () => {
    const { container } = renderBoard(view, undefined, 'single');
    dragCard(container, 24, { card: 8, at: 'top' });
    const base = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"]')!;
    expect(base.dataset.pileSize, '24 is stacked on 8').toBe('2');
    for (const lifted of [8, 24]) {
      const release = dragCard(container, lifted, { card: 8, at: 'before' }, true);
      const ghost = boardOf(container).querySelector<HTMLElement>(':scope > [data-arrange-ghost]')!;
      expect(ghost, `the ghost of ${lifted}`).not.toBeNull();
      expect(ghost.hasAttribute('data-pile-size'), `${lifted}: no pile size on the copy`).toBe(false);
      expect(ghost.hasAttribute('data-pile-depth'), `${lifted}: no pile depth on the copy`).toBe(false);
      expect(ghost.querySelector('[data-pile-size], [data-pile-depth], .board-card__pile'), 'nor inside it').toBeNull();
      release();
    }
  });

  /** Fire Urchin (21), tapped, with an untapped Bonesplitter (901) attached: a pile whose base is turned. */
  function tappedPile(): BoardView {
    const base = boardFromFixture(fixture);
    const seed = base.players.find((p) => p.isViewer)!.battlefield[0]!;
    const gear: BoardCard = { ...seed, id: 901, tapped: false, card: { ...seed.card, cardId: 'w901', name: 'Bonesplitter', typeLine: 'Artifact — Equipment' }, attachedToId: 21, attachedCardIds: [] };
    return {
      ...base,
      players: base.players.map((p) =>
        !p.isViewer ? p : { ...p, battlefield: [...p.battlefield.map((c) => (c.id === 21 ? { ...c, tapped: true, attachedCardIds: [901] } : c)), gear] },
      ),
    };
  }

  it('a tapped base turns its own face only: a card piled behind it keeps its own data-tapped (and nobody else’s)', () => {
    // The operator, 2026-10-07: "when an untapped card is put behind a tapped card, it displays as tapped."
    const css = styled();
    const { container } = renderBoard(tappedPile());
    expect(turnOf(css, container.querySelector('[data-card-id="21"]')!), 'the base turns').toContain('90deg');
    expect(turnOf(css, container.querySelector('[data-card-id="901"]')!), 'the card behind it does not').not.toContain('90deg');
  });

  it('the overlay clips what it draws at the board’s edge, so no overlay child can widen the page', () => {
    // table-fit 2026-10-07: the presence cursor's name tag past the right edge grew the shell by 46px.
    const css = styled();
    expect(css(renderBoard(view).container.querySelector('.board__overlay')!, 'overflow')).toBe('clip');
  });

  it('a pile’s list takes no press, and every card in it takes its own', () => {
    const css = styled();
    const { container } = renderBoard(tappedPile());
    const pile = container.querySelector('[data-card-id="21"] .board-card__pile')!;
    expect(css(pile, 'pointer-events')).toBe('none');
    expect(css(pile.querySelector(':scope > .board-card')!, 'pointer-events')).not.toBe('none');
  });

  it('draws OUR ghost and indicator while a card is held, and removes every trace on release', () => {
    const { container } = renderBoard(view, undefined, 'single');
    const release = dragCard(container, 24, { card: 8, at: 'before' }, true);
    const board = boardOf(container);
    const ghost = board.querySelector<HTMLElement>(':scope > [data-arrange-ghost]')!;
    expect(ghost, 'the ghost').not.toBeNull();
    expect(ghost.dataset.arrangeGhost).toBe('24');
    expect(ghost.querySelector('.card__name')!.textContent, 'it is the card, not a browser picture').toBe(
      container.querySelector('.seat[data-viewer] [data-card-id="24"] .card__name')!.textContent,
    );
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('data-card-id'), 'no id twice on the board').toBe(false);
    expect(ghost.querySelector('[data-card-id]'), 'nor inside it').toBeNull();
    expect(board.querySelectorAll('[data-card-id="24"]'), 'the real card is the only one carrying its id').toHaveLength(1);
    expect(board.hasAttribute('data-arrange-active')).toBe(true);
    expect(container.querySelector('[data-card-id="24"]')!.hasAttribute('data-arrange-dragging'), 'the source stays, dimmed').toBe(true);
    const bar = board.querySelector<HTMLElement>(':scope > [data-arrange-indicator]')!;
    expect(bar.hasAttribute('hidden')).toBe(false);
    expect(bar.dataset.arrangeKind).toBe('before');
    expect(bar.dataset.arrangeSlot).toBe('back');
    expect(container.querySelector('[data-card-id="8"]')!.getAttribute('data-arrange-target'), 'the card it is on').toBe('before');
    expect(container.querySelector('.seat[data-viewer] [data-arrange-slot="back"]')!.hasAttribute('data-arrange-target'), 'a column is marked, never a whole row').toBe(false);
    expect(board.hasAttribute('data-placing'), 'her rows show their columns').toBe(true);
    // Nothing has moved yet: the drag is a preview until it is let go.
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li:not([data-virtual])')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['8', '24', '6', '25']);

    release();
    expect(board.querySelector('[data-arrange-ghost], [data-arrange-indicator]'), 'ghost and bar are gone').toBeNull();
    expect(board.hasAttribute('data-arrange-active')).toBe(false);
    expect(container.querySelectorAll('[data-arrange-dragging], [data-arrange-target]'), 'and every mark').toHaveLength(0);
    expect(board.hasAttribute('data-placing'), 'and the columns').toBe(false);
    expect(board.querySelectorAll('li[data-virtual]'), 'every scaffold column removed').toHaveLength(0);
    // And the card went where the bar said.
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li:not([data-virtual])')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['24', '8', '6', '25']);
  });

  it('a rearrange outlines the columns of HER rows only, and marks the empty column a release would fill', () => {
    const { container } = renderBoard(view, undefined, 'single');
    layOut(container);
    // A card is 70px wide here (`card-size.ts` reads the inherited px value where nothing is laid out), no gap.
    boardOf(container).style.setProperty('--card-w', '70px');
    const back = container.querySelector<HTMLElement>('.seat[data-viewer] [data-arrange-slot="back"]')!;
    const row = back.getBoundingClientRect();
    // Column 6 of the back row: past its four cards, a column the scaffold draws.
    const release = dragCard(container, 24, { point: { x: 10 + 6 * 70 + 30, y: row.top + 50 } }, true);
    const board = boardOf(container);
    const columns = [...back.querySelectorAll<HTMLElement>(':scope > li')];
    expect(columns.slice(4).every((li) => li.matches('li.zone__gap[data-virtual]')), 'every column past the cards is a scaffold column').toBe(true);
    expect(columns.length, 'as many as fit the row whole: 14 at a 70px pitch in 1000px').toBe(14);
    expect(columns[6]!.getAttribute('data-arrange-target'), 'the column it would fill is marked').toBe('at');
    expect(board.querySelectorAll('[data-arrange-target]'), 'and only that one').toHaveLength(1);
    expect(board.querySelectorAll('.seat:not([data-viewer]) li[data-virtual]'), 'nothing on his side').toHaveLength(0);
    for (const slot of board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot]')) {
      expect(slot.querySelectorAll('li.zone__gap').length, `${slot.dataset.arrangeSlot} shows its columns`).toBeGreaterThan(0);
    }
    release();
  });

  it('the scaffold is one drawing, put up and taken down the same for any gesture, and idempotent', () => {
    const { container } = renderBoard(view, undefined, 'single');
    layOut(container);
    boardOf(container).style.setProperty('--card-w', '70px');
    const board = boardOf(container);
    showPlacementColumns(container);
    const count = board.querySelectorAll('li[data-virtual]').length;
    expect(count, 'columns drawn').toBeGreaterThan(0);
    showPlacementColumns(container);
    expect(board.querySelectorAll('li[data-virtual]'), 'a second call draws nothing twice').toHaveLength(count);
    clearPlacementColumns(container);
    expect(board.hasAttribute('data-placing')).toBe(false);
    expect(board.querySelectorAll('li[data-virtual]')).toHaveLength(0);
  });

  it('outlines a column only on the viewer’s side while placing, never a whole row, and a column takes no press', () => {
    const { container } = renderBoard(view, undefined, 'single');
    layOut(container);
    boardOf(container).style.setProperty('--card-w', '70px');
    showPlacementColumns(container);
    // Applied after the columns are drawn: `virtualColumns` measures, and the sheet's widths are no lengths to jsdom.
    const css = styled();
    const gaps = [...container.querySelectorAll('.seat[data-viewer] [data-zone="battlefield"] li.zone__gap')];
    expect(gaps.length, 'columns drawn').toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(css(gap, 'outline'), 'a column is outlined').not.toMatch(/^(none)?$/);
      // A release over a column must hit the row, not a column the release itself takes down.
      expect(css(gap, 'pointer-events')).toBe('none');
      // An empty row's column is a card tall, not a line.
      expect(css(gap, 'aspect-ratio')).not.toBe('');
    }
    for (const row of container.querySelectorAll('.seat [data-zone="battlefield"] .zone__cards')) {
      expect(css(row, 'outline'), 'never a whole row').toMatch(/^(none)?$/);
    }
    clearPlacementColumns(container);
  });

  it('virtualColumns reads the row’s own column gap, not a fixed one', () => {
    // 60px cards and a 10px gap in a row 0..300: from an empty row, 0, 70, 140, 210 fit whole.
    expect(virtualColumns({ left: 0, right: 300 }, null, 0, 60, 10)).toBe(4);
    // After a card ending at 60, the next column starts one gap later, at 70: 70, 140, 210 fit.
    expect(virtualColumns({ left: 0, right: 300 }, 60, 1, 60, 10)).toBe(3);
    // A 1px gap: a 61px pitch — 0, 61, 122, 183, 244 (to 304) fit 310; a 10px gap fits only four there.
    expect(virtualColumns({ left: 0, right: 310 }, null, 0, 60, 1)).toBe(5);
    expect(virtualColumns({ left: 0, right: 310 }, null, 0, 60, 10)).toBe(4);
    expect(virtualColumns({ left: 0, right: 300 }, null, 0, null, 4), 'no card width, no columns').toBe(0);
  });

  it('the ghost follows the pointer, and the indicator names stack-top, stack-bottom and the next column as the pointer moves', () => {
    const { container } = renderBoard(view, undefined, 'single');
    layOut(container);
    const from = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="24"]')!;
    const at = (id: number) => container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${id}"]`)!.getBoundingClientRect();
    const start = { x: at(24).left + 30, y: at(24).top + 40 };
    fireEvent.pointerDown(from, { ...POINTER, button: 0, clientX: start.x, clientY: start.y });
    fireEvent.pointerMove(window, { ...POINTER, clientX: start.x + 20, clientY: start.y });
    const board = boardOf(container);
    const ghost = board.querySelector<HTMLElement>('[data-arrange-ghost]')!;
    const bar = board.querySelector<HTMLElement>('[data-arrange-indicator]')!;
    const move = (x: number, y: number) => fireEvent.pointerMove(window, { ...POINTER, clientX: x, clientY: y });

    move(300, 120);
    const first = { left: ghost.style.left, top: ghost.style.top };
    move(340, 160);
    expect({ left: ghost.style.left, top: ghost.style.top }, 'the ghost moved with the pointer').not.toEqual(first);
    expect(Number.parseFloat(ghost.style.left) - Number.parseFloat(first.left)).toBe(40);
    expect(ghost.style.width, 'at the card’s own size').toBe('60px');

    move(at(6).left + 10, at(6).top + 10);
    expect(bar.dataset.arrangeKind).toBe('stack-top');
    move(at(6).left + 10, at(6).bottom - 10);
    expect(bar.dataset.arrangeKind).toBe('stack-bottom');
    move(at(25).right + 20, at(25).top + 40);
    // Past the last card is the next column now (every column that fits the row is a place), never 'end'.
    expect(bar.dataset.arrangeKind).toBe('at');
    // Z8: well past the last card, a column of its own — the indicator says so.
    move(at(25).right + 200, at(25).top + 40);
    expect(bar.dataset.arrangeKind).toBe('at');
    move(500, 600);
    expect(bar.hasAttribute('hidden'), 'far from every slot there is no target').toBe(true);
    fireEvent.pointerUp(window, { ...POINTER, clientX: 500, clientY: 600 });
    expect(container.querySelector('[data-arrange-ghost]')).toBeNull();
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li:not([data-virtual])')].map((c) => (c as HTMLElement).dataset.cardId), 'released nowhere: nothing moved').toEqual(['8', '24', '6', '25']);
  });

  /*
   * Ledger Z8 (the operator, 2026-10-07): "it's still forcing a 'fill from left
   * to right' placement. that's fine generally, but if i want to place a card in
   * a particular slot further to the right with gaps in between i should be
   * able to."
   */
  describe('Z8 — a card can be placed in a column further right, with gaps before it', () => {
    const tier = (container: HTMLElement, name: string) =>
      [...container.querySelectorAll<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"] > li`)].map((li) =>
        li.classList.contains('zone__gap') ? null : Number(li.dataset.cardId),
      );
    const colsOf = (container: HTMLElement, name: string) =>
      Number(container.querySelector<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"]`)!.style.getPropertyValue('--cols'));
    /** The stub layout: column `n` of a row spans x = 10 + 70n .. 70 + 70n; a point in its middle. */
    const column = (container: HTMLElement, name: string, n: number) => {
      layOut(container);
      const box = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"]`)!.getBoundingClientRect();
      return { x: 10 + 70 * n + 30, y: (box.top + box.bottom) / 2 };
    };

    it('dropped two columns past the row’s end, the card takes that column; the columns between, and the one it left, are gaps that count', () => {
      const { container } = renderBoard(view, undefined, 'single');
      expect(tier(container, 'back'), 'the fixture’s lands').toEqual([8, 24, 6, 25]);
      dragCard(container, 25, { point: column(container, 'back', 6) });
      expect(tier(container, 'back')).toEqual([8, 24, 6, null, null, null, 25]);
      expect(colsOf(container, 'back'), 'the gaps are columns').toBe(7);
      for (const g of container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li.zone__gap')) {
        expect(g.hasAttribute('data-card-id'), 'a gap is not a card').toBe(false);
      }
    });

    it('a card dropped on a gap fills it; an ordering drop closes the column it left, and a trailing gap is never kept', () => {
      const { container } = renderBoard(view, undefined, 'single');
      dragCard(container, 25, { point: column(container, 'back', 6) });
      dragCard(container, 6, { point: column(container, 'back', 4) });
      expect(tier(container, 'back'), 'into the gap; the column it left stays open (a placement)').toEqual([8, 24, null, null, 6, null, 25]);
      // In front of the first card: an ordering move. Its own column closes, and the gap that is now last goes.
      dragCard(container, 25, { card: 8, at: 'before' });
      expect(tier(container, 'back')).toEqual([25, 8, 24, null, null, 6]);
    });

    it('a card that leaves the battlefield keeps its column while it is drawn leaving, then the column closes: only the player makes a gap', () => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      const { container, rerender } = renderBoard(view, undefined, 'single');
      dragCard(container, 25, { point: column(container, 'back', 6) });
      expect(tier(container, 'back')).toEqual([8, 24, 6, null, null, null, 25]);
      const me = view.players.find((p) => p.isViewer)!;
      const without: BoardView = { ...view, players: view.players.map((p) => (p === me ? { ...p, battlefield: p.battlefield.filter((c) => c.id !== 6) } : p)) };
      rerender(createElement(Board, { view: without, boardLayout: 'single' }));
      expect(tier(container, 'back'), 'its place is kept while it leaves').toEqual([8, 24, null, null, null, null, 25]);
      expect(container.querySelector(`.seat[data-viewer] [data-tier="back"] > li:nth-child(3)`)?.getAttribute(LEAVING_GAP_ATTR)).toBe('6');
      act(() => void vi.advanceTimersByTime(EXIT_MOTIONS.slice.ms));
      expect(tier(container, 'back'), 'its column closed; the player’s own gaps stay').toEqual([8, 24, null, null, null, 25]);
    });

    it('in Fast Mode a card that leaves the battlefield closes its column at once', () => {
      const { container, rerender } = renderBoard(view, undefined, 'single');
      const me = view.players.find((p) => p.isViewer)!;
      const without: BoardView = { ...view, players: view.players.map((p) => (p === me ? { ...p, battlefield: p.battlefield.filter((c) => c.id !== 6) } : p)) };
      rerender(createElement(Board, { view: without, boardLayout: 'single', fastMode: true }));
      expect(tier(container, 'back')).toEqual([8, 24, 25]);
    });

    it('an empty row takes a card at a column past its start too', () => {
      const { container } = renderBoard(view, undefined, 'single');
      for (const id of [8, 24, 6, 25]) dragCard(container, id, { slot: 'front' });
      expect(tier(container, 'back')).toEqual([]);
      dragCard(container, 25, { point: column(container, 'back', 3) });
      expect(tier(container, 'back')).toEqual([null, null, null, 25]);
    });
  });

  it('snaps to any slot in either row, empty ones included', () => {
    const { container } = renderBoard(view, undefined, 'single');
    dragCard(container, 8, { slot: 'front' });
    const ids = (name: string) => [...container.querySelectorAll<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"] > li`)].map((c) => Number(c.dataset.cardId));
    expect(ids('front'), 'a land put in the front row, at its end').toEqual([21, 8]);
    expect(ids('back')).toEqual([24, 6, 25]);
    // Drain a row, then put a card in the EMPTY row.
    for (const id of [24, 6, 25]) dragCard(container, id, { slot: 'front' });
    expect(ids('back'), 'the back row is empty now').toEqual([]);
    dragCard(container, 21, { slot: 'back' });
    expect(ids('back')).toEqual([21]);
  });

  /**
   * R9 (wave 35, third ask). The operator's own words at the second ask were
   * "it still snaps to the left-most free one"; the settled ruling is the
   * drop lands in the slot UNDER THE POINTER, in either row, empty slots
   * included, and the indicator names exactly that slot. The test above
   * covers the single layout, which is the default the operator plays on;
   * this one covers the type-separated alternate (`BOARD_ROWS`), where a
   * card's TYPE decides its row only until the player overrides it — a land
   * can be dragged into the creatures lane and stays there, not reclassified
   * back to lands on the next render.
   */
  it('snaps to any row of the type-separated alternate too, including a row of a different type', () => {
    const { container } = renderBoard(view, undefined, 'type-separated');
    const idsIn = (row: string) => [...container.querySelectorAll<HTMLElement>(`.seat[data-viewer] [data-arrange-slot="${row}"] > .zone__cards > li`)].map((c) => Number(c.dataset.cardId));
    const before = idsIn('lands');
    expect(before.length, 'at least one land to move').toBeGreaterThan(0);
    const land = before[0]!;
    const creaturesBefore = idsIn('creatures');
    expect(creaturesBefore, 'a precondition: the creatures row does not already hold the land').not.toContain(land);
    dragCard(container, land, { slot: 'creatures' });
    expect(idsIn('creatures'), 'the land landed in the creatures row, not snapped back to lands').toEqual([...creaturesBefore, land]);
    expect(idsIn('lands'), 'and left the lands row').not.toContain(land);
    // The indicator names exactly the slot under the pointer while the drag is held, not the card's own type's row.
    const release = dragCard(container, idsIn('artifacts')[0] ?? land, { slot: 'other' }, true);
    const bar = container.querySelector<HTMLElement>('.board > [data-arrange-indicator]')!;
    expect(bar.dataset.arrangeSlot, 'the indicator is the slot under the pointer').toBe('other');
    release();
  });

  it('works under a finger: a touch pointer drags exactly as a mouse does', () => {
    const { container } = renderBoard(view, undefined, 'single');
    layOut(container);
    const touch = { pointerId: 7, isPrimary: true, pointerType: 'touch' } as const;
    const from = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="25"]')!;
    const b = from.getBoundingClientRect();
    fireEvent.pointerDown(from, { ...touch, button: 0, clientX: b.left + 5, clientY: b.top + 5 });
    fireEvent.pointerMove(window, { ...touch, clientX: b.left + 30, clientY: b.top + 30 });
    expect(container.querySelector('[data-arrange-ghost]'), 'a finger lifts the card').not.toBeNull();
    const first = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"]')!.getBoundingClientRect();
    fireEvent.pointerMove(window, { ...touch, clientX: first.left + 5, clientY: first.top + 40 });
    fireEvent.pointerUp(window, { ...touch, clientX: first.left + 5, clientY: first.top + 40 });
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li:not([data-virtual])')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['25', '8', '24', '6']);
    expect(styled()(from, 'touch-action'), 'or the browser claims it to scroll').toBe('none');
  });

  it('a press that never moves is a plain click, and the click after a real drag is swallowed', () => {
    const { interaction, onSelectCard } = spyInteraction([8]);
    const { container } = renderBoard(view, interaction, 'single');
    layOut(container);
    const face = () => container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"] > button.board-card__face')!;
    // Press and release in place: a click, which selects.
    const li = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"]')!;
    fireEvent.pointerDown(li, { ...POINTER, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { ...POINTER, clientX: 21, clientY: 21 });
    fireEvent.pointerUp(window, { ...POINTER, clientX: 21, clientY: 21 });
    expect(container.querySelector('[data-arrange-ghost]'), 'under the slop there is no drag').toBeNull();
    fireEvent.click(face());
    expect(onSelectCard).toHaveBeenCalledTimes(1);
    // A real drag, then the click the browser sends after it: not a selection.
    dragCard(container, 8, { slot: 'front' });
    fireEvent.click(face());
    expect(onSelectCard, 'letting go of a drag is not a click on what it ended over').toHaveBeenCalledTimes(1);
  });

  it('Escape and pointercancel put the card down where it was', () => {
    for (const how of ['escape', 'cancel'] as const) {
      const { container } = renderBoard(view, undefined, 'single');
      dragCard(container, 25, { card: 8, at: 'before' }, true);
      expect(container.querySelector('[data-arrange-ghost]')).not.toBeNull();
      if (how === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      else fireEvent.pointerCancel(window, { ...POINTER });
      expect(container.querySelector('[data-arrange-ghost], [data-arrange-indicator], [data-arrange-dragging]'), how).toBeNull();
      fireEvent.pointerUp(window, { ...POINTER, clientX: 0, clientY: 0 });
      expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li:not([data-virtual])')].map((c) => (c as HTMLElement).dataset.cardId), how).toEqual(['8', '24', '6', '25']);
      cleanup();
      forgetArrangements();
    }
  });

  it('stands down on a press the gestures layer already claimed (combat, a payment)', () => {
    const { container } = renderBoard(view, undefined, 'single');
    layOut(container);
    // `install.ts` claims a press by cancelling it, on the canvas, before the window sees it.
    const claim = (e: Event) => e.preventDefault();
    container.addEventListener('pointerdown', claim);
    dragCard(container, 25, { card: 8, at: 'before' }, true);
    expect(container.querySelector('[data-arrange-ghost]'), 'a claimed press is not ours').toBeNull();
    fireEvent.pointerUp(window, { ...POINTER, clientX: 0, clientY: 0 });
    container.removeEventListener('pointerdown', claim);
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li:not([data-virtual])')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['8', '24', '6', '25']);
  });

  it('keeps no HTML5 drag-and-drop in the source', () => {
    const { container } = renderBoard(view, undefined, 'single');
    const li = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"]')!;
    expect(li.hasAttribute('data-arrange-card'), 'the seam the gestures layer stands down on').toBe(true);
    expect(li.hasAttribute('draggable'), 'the browser is never asked to drag it').toBe(false);
    const source = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'Board.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/draggable=|dataTransfer|onDrag|onDrop\b|dropEffect|effectAllowed|DragEvent/);
  });

});

/*
 * ── a cast's drop point, handed to Board by the gestures lane ──
 *
 * No hand card is ever arrangeable (`CardOnBoard`'s `arrangeable`), so a
 * cast's drop point has nowhere to land on its own — left alone, the
 * permanent that eventually arrives always joins the end of its type row.
 * `notePlayedTo`/`previewPlayedTo` are the seam with the gestures lane's cast
 * gesture (`live/gestures/cast.ts`); this suite drives them exactly the way
 * that file will, with no knowledge of its code.
 */
describe('notePlayedTo hands a cast’s drop point to Board', () => {
  const base = boardFromFixture(fixture);
  afterEach(() => forgetPendingPlacements());

  /** A new land, not yet anywhere in `base` — the shape a cast eventually produces on the battlefield. */
  const newLand = (id: number): BoardCard => ({
    id,
    card: {
      cardId: `w${id}`,
      name: 'Mountain',
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine: 'Basic Land — Mountain',
      oracleText: '',
      setCode: '',
      collectorNumber: '',
      rarity: 'common',
    },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
  });

  const withNewLand = (id: number): BoardView => ({
    ...base,
    players: base.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: [...p.battlefield, newLand(id)] })),
  });

  const backIds = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-tier="back"] > li')].map((c) => c.dataset.cardId);

  it('a card with a pending placement lands where it was dropped, not appended (mutation: reverted, it appends instead)', () => {
    const { container, rerender } = renderBoard(base, undefined, 'single');
    layOut(container);
    expect(backIds(container), 'the fixture’s own lands, before anything new arrives').toEqual(['8', '24', '6', '25']);

    const targetBox = container.querySelector<HTMLElement>('[data-card-id="24"]')!.getBoundingClientRect();
    notePlayedTo(99001, { x: targetBox.left + 5, y: targetBox.top + targetBox.height / 2 });

    rerender(createElement(Board, { view: withNewLand(99001), boardLayout: 'single' }));
    expect(backIds(container), 'landed exactly before 24, where it was dropped').toEqual(['8', '99001', '24', '6', '25']);
  });

  it('without a pending placement, a new card appends as today (the default this feature must not disturb)', () => {
    const { container, rerender } = renderBoard(base, undefined, 'single');
    layOut(container);
    rerender(createElement(Board, { view: withNewLand(99002), boardLayout: 'single' }));
    expect(backIds(container), 'appended to the end, exactly as before this wave').toEqual(['8', '24', '6', '25', '99002']);
  });

  it('a stale (TTL-expired) pending placement is ignored, same as having none', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { container, rerender } = renderBoard(base, undefined, 'single');
      layOut(container);
      const targetBox = container.querySelector<HTMLElement>('[data-card-id="24"]')!.getBoundingClientRect();
      notePlayedTo(99003, { x: targetBox.left + 5, y: targetBox.top + targetBox.height / 2 });

      vi.setSystemTime(20_000); // past the 15s TTL
      rerender(createElement(Board, { view: withNewLand(99003), boardLayout: 'single' }));
      expect(backIds(container), 'too old to use: falls back to the append default').toEqual(['8', '24', '6', '25', '99003']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a point that hits no slot at all (off the battlefield) records nothing', () => {
    const { container, rerender } = renderBoard(base, undefined, 'single');
    layOut(container);
    notePlayedTo(99004, { x: -5000, y: -5000 });
    rerender(createElement(Board, { view: withNewLand(99004), boardLayout: 'single' }));
    expect(backIds(container)).toEqual(['8', '24', '6', '25', '99004']);
  });

  it('previewPlayedTo draws and clears the same indicator bar an arrange-drag uses, without touching arrangement', () => {
    const { container } = renderBoard(base, undefined, 'single');
    layOut(container);
    const targetBox = container.querySelector<HTMLElement>('[data-card-id="24"]')!.getBoundingClientRect();
    previewPlayedTo({ x: targetBox.left + 5, y: targetBox.top + targetBox.height / 2 });
    const bar = container.querySelector<HTMLElement>('.board > [data-arrange-indicator]')!;
    expect(bar.hasAttribute('hidden'), 'shown while over a slot').toBe(false);
    expect(bar.dataset.arrangeKind).toBe('before');
    expect(bar.dataset.arrangeSlot).toBe('back');
    expect(container.querySelector('[data-card-id="24"]')!.getAttribute('data-arrange-target')).toBe('before');
    expect(container.querySelector('.seat[data-viewer] [data-arrange-slot="back"]')!.hasAttribute('data-arrange-target'), 'no whole-row mark').toBe(false);

    previewPlayedTo(null);
    expect(bar.hasAttribute('hidden'), 'hidden on null').toBe(true);
    expect(container.querySelector('[data-card-id="24"]')!.hasAttribute('data-arrange-target'), 'and the mark is cleared').toBe(false);
    // Unlike notePlayedTo, this never wrote a pending placement.
    expect(backIds(container)).toEqual(['8', '24', '6', '25']);
  });
});

/**
 * `live/gestures/hand.ts`'s seam into the arrangement store, the same shape
 * `notePlayedTo` already has — a module-level write, keyed by whatever the
 * last render saw (`LIVE_VIEWER_ID`/`LIVE_MATCH_KEY`), then every mounted
 * board is woken. `handOrder`/`withHandMove` are the pure functions
 * underneath it, pinned directly here as well as through the DOM.
 */
describe('commitHandMove hands a hand reorder to Board', () => {
  const base = boardFromFixture(fixture);
  const me = base.players.find((p) => p.isViewer)!;
  const hand = me.hand!.map((c) => c.id);

  const handOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"]')!;
  const handIds = (container: HTMLElement): number[] =>
    [...handOf(container).querySelectorAll<HTMLElement>('.board-card')].map((c) => Number(c.dataset.cardId));

  it('handOrder is the identity until the store names a hand, then the store wins, with an unnamed card at the end', () => {
    const cards = [{ id: 1 }, { id: 2 }, { id: 3 }] as unknown as readonly BoardCard[];
    expect(handOrder(cards, 0, {})).toBe(cards);
    expect(handOrder(cards, 0, { '0:hand': [[2], [1]] }).map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it('withHandMove takes bare ids (not BoardCard objects) and writes one pile per card, the dragged one moved', () => {
    const before: Record<string, readonly (readonly number[])[]> = {};
    const beforeTarget: DropTarget = { kind: 'before', id: 1 };
    expect(withHandMove([1, 2, 3], 0, before, 3, beforeTarget)).toEqual({ '0:hand': [[3], [1], [2]] });
    expect(withHandMove([1, 2, 3], 0, before, 1, { kind: 'end' })).toEqual({ '0:hand': [[2], [3], [1]] });
  });

  it('commitHandMove writes the new order into the store and wakes the mounted board — no rerender call needed', () => {
    const { container } = render(createElement(Board, { view: base }));
    expect(handIds(container), 'the view’s own order, to begin with').toEqual(hand);

    act(() => {
      commitHandMove(hand, hand.at(-1)!, { kind: 'before', id: hand[0]! });
    });
    expect(handIds(container), 'the mounted board redrew on its own').toEqual([hand.at(-1)!, ...hand.slice(0, -1)]);
  });

  it('survives a re-render, a resync and a remount, and a card drawn joins the end', () => {
    const first = render(createElement(Board, { view: base }));
    act(() => {
      commitHandMove(hand, hand.at(-1)!, { kind: 'before', id: hand[0]! });
    });
    const arranged = [hand.at(-1)!, ...hand.slice(0, -1)];
    expect(handIds(first.container)).toEqual(arranged);

    // A re-render with the same view: the order is in the module store, not in
    // React's state, so a redraw cannot lose it.
    first.rerender(createElement(Board, { view: base }));
    expect(handIds(first.container), 'after a re-render').toEqual(arranged);

    // A resync replaces the whole view and may remount the board.
    cleanup();
    const resynced: BoardView = { ...boardFromFixture(fixture), seq: 4242 };
    expect(handIds(render(createElement(Board, { view: resynced })).container), 'after a resync and a remount').toEqual(arranged);

    // A card DRAWN while the arrangement stands joins the end of the hand
    // rather than the middle of an order the player chose.
    cleanup();
    const seed = me.hand![0]!;
    const drew: BoardView = {
      ...resynced,
      players: resynced.players.map((p) =>
        !p.isViewer ? p : { ...p, hand: [{ ...seed, id: 909, card: { ...seed.card, cardId: 'w909' } }, ...(p.hand ?? [])] },
      ),
    };
    expect(handIds(render(createElement(Board, { view: drew })).container)).toEqual([...arranged, 909]);
  });

  it('is per match: another match starts from the view’s order, and sends nothing to Forge', () => {
    const { container } = render(createElement(Board, { view: base }));
    act(() => {
      commitHandMove(hand, hand.at(-1)!, { kind: 'before', id: hand[0]! });
    });
    expect(handIds(container)).not.toEqual(hand);

    // Another match starts from the view's order, as the battlefield does.
    cleanup();
    const elsewhere = render(createElement(Board, { view: { ...boardFromFixture(fixture), title: 'another match entirely' } }));
    expect(handIds(elsewhere.container)).toEqual(hand);
    // And the view `Board` was handed is untouched — the order is ours, never Forge's.
    expect(base.players.find((p) => p.isViewer)!.hand!.map((c) => c.id)).toEqual(hand);
  });
});

/*
 * ── wave 33 §B — shape 2 (target ids), poison counters, --accent-ink ────
 */
describe('wave 33 §B', () => {
  it('shape 2: targetCardIds/targetPlayerIds come off the stack item’s own TargetCards/TargetPlayers, empty when it names none', () => {
    const state = new Map(foldPackets(loadPackets(fixture)).state);
    const key = deltaKey(DELTA_TYPE.stackItem, 48);
    const item = state.get(key)!;
    state.set(key, {
      ...item,
      TargetCards: { t: 'list', v: [{ t: 'int', v: 67 }] },
      TargetPlayers: { t: 'list', v: [{ t: 'int', v: 1 }] },
    } as WireObject);
    const adapted = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
    const targeted = adapted.stack.find((s) => s.id === 48)!;
    expect(targeted.targetCardIds).toEqual([67]);
    expect(targeted.targetPlayerIds).toEqual([1]);
    // The OTHER stack item was never touched: empty, never missing.
    const untouched = adapted.stack.find((s) => s.id !== 48)!;
    expect(untouched.targetCardIds).toEqual([]);
    expect(untouched.targetPlayerIds).toEqual([]);
  });

  it('item 4: a seat’s energy/experience counters draw beside its hand/library counts, abbreviated, and only when non-zero; poison draws beside its life total', () => {
    const state = new Map(foldPackets(loadPackets(fixture)).state);
    const key = deltaKey(DELTA_TYPE.player, 1);
    const them = state.get(key)!;
    state.set(key, {
      ...them,
      Counters: {
        t: 'multiset',
        v: [
          ['Poison', 7],
          ['Energy', 3],
          ['Experience', 0],
        ],
      },
    } as WireObject);
    const adapted = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
    const { seat } = renderBoard(adapted);
    const theirBar = seat(1).querySelector<HTMLElement>('[data-player-bar]')!;
    const counters = [...theirBar.querySelectorAll('.seat__counter')].map((c) => c.textContent).sort();
    // Zero experience draws nothing — never a drawn zero. Poison is not a counts-line mark.
    expect(counters).toEqual(['E3']);
    expect(theirBar.querySelectorAll('[data-counter="poison"]')).toHaveLength(0);
    // Poison is the face's: one mark, on the life total's line, a drawn skull and the count — no letter.
    const marks = seat(1).querySelectorAll<HTMLElement>('[data-testid="poison"]');
    expect(marks).toHaveLength(1);
    const poison = marks[0]!;
    const life = seat(1).querySelector<HTMLElement>('[data-testid="life"]')!;
    expect(poison.parentElement).toBe(life.parentElement);
    expect(poison.parentElement!.classList.contains('face__vitals')).toBe(true);
    expect(poison.parentElement!.dataset.poisoned).toBe('true');
    expect(seat(1).querySelector('[data-player-face]')!.contains(poison)).toBe(true);
    expect(poison.previousElementSibling).toBe(life);
    expect(poison.querySelector('svg.face__poison-art')).not.toBeNull();
    expect(poison.textContent).toBe('7');
    expect(poison.dataset.tip).toBe('7 poison');
    expect(poison.getAttribute('aria-label')).toBe('7 poison');
    // The life badge is still the number and nothing else.
    expect(life.textContent).toBe(String(adapted.players.find((p) => p.id === 1)!.life));
    // The viewer's own seat was never given any and shows none: its life is alone on its line.
    expect(seat(0).querySelectorAll('.seat__counter, [data-testid="poison"]')).toHaveLength(0);
    expect(seat(0).querySelector<HTMLElement>('.face__vitals')!.dataset.poisoned).toBeUndefined();
  });

  it('with no player counters at all — the fixture path’s own default — nothing is drawn, the safe default every fixture renders in', () => {
    const { seat } = renderBoard(boardFromFixture(fixture));
    expect(seat(0).querySelectorAll('.seat__counter, [data-testid="poison"]')).toHaveLength(0);
    expect(seat(1).querySelectorAll('.seat__counter, [data-testid="poison"]')).toHaveLength(0);
  });
});

/*
 * ── wave 34 §B — the energy line no longer clips, and the graveyard stays put ──
 *
 * w33 B's own screenshot (since removed) showed
 * the THIRD line of `.seat__counts` cut off under the opponent's column: with
 * poison and energy both non-zero the box (`--counts-h`, fixed, `overflow:
 * hidden`) had room for barely two lines, and `poison.state` (lane S) carries
 * poison, energy AND experience together.
 *
 * The first attempt at this fix GREW `--counts-h` to fit a fourth line (one
 * per counter, the full word). That clipped nothing, but
 * `e2e/table-fit.spec.ts`'s Q9/Q2 column check reads the graveyard's own top
 * edge straight off the hand/library marks' rendered box — a gap that tracks
 * the TRACK, not the content — so the grown track moved the graveyard by
 * exactly the growth (measured: 46.3px of "nothing but a pile's own margin",
 * `GAP_MAX` 32). The track went back to 2.2rem, and has since gone altogether (the counts take the
 * room they draw, 2026-10-22); what changed instead is the counter's OWN glyph:
 * `PLAYER_COUNTER_ABBREV` (`Board.tsx`) draws `E3`, `XP5` — short enough
 * to share hand+library's second line rather than each claiming one of their
 * own. Poison has since moved beside the life total (`PoisonMark`). The word itself is not gone: `data-tip` and
 * `aria-label` still carry it in full (asserted on the wave 33 §B case above,
 * which this design also has to keep passing).
 *
 * jsdom cannot lay the box out — whether the abbreviations truly share one
 * line at `--who-w`'s width is a real-browser claim, measured against the
 * real stylesheet in w34's screenshots (since removed) and the scratch
 * repro that produced them, not asserted here. What IS asserted here,
 * structurally: the known counters abbreviate to DIFFERENT
 * glyphs (so nothing in `PLAYER_COUNTER_ABBREV` can silently collide and
 * merge two counters' text into one), and the rendered glyph for each is
 * short — never as long as the word it stands for.
 */
describe('wave 34 §B', () => {
  it('item 1: the known counts-line counters abbreviate to different, short glyphs — never the word itself', () => {
    for (const name of ['Energy', 'Experience']) {
      const state = new Map(foldPackets(loadPackets(fixture)).state);
      const key = deltaKey(DELTA_TYPE.player, 1);
      const them = state.get(key)!;
      state.set(key, { ...them, Counters: { t: 'multiset', v: [[name, 9]] } } as WireObject);
      const adapted = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
      const { seat } = renderBoard(adapted);
      const el = seat(1).querySelector<HTMLElement>('.seat__counter')!;
      expect(el.textContent!.length, `${name}'s glyph "${el.textContent}" is shorter than the word itself`).toBeLessThan(`9 ${name.toLowerCase()}`.length);
      expect(el.textContent, `${name}'s glyph carries the count`).toContain('9');
      expect(el.textContent!.toLowerCase(), `${name}'s glyph is not the bare word`).not.toBe(name.toLowerCase());
    }
    // And the glyphs (the digit stripped) are pairwise distinct — no collision to merge two counters into one.
    const glyphOf = (name: string): string => {
      const state = new Map(foldPackets(loadPackets(fixture)).state);
      const key = deltaKey(DELTA_TYPE.player, 1);
      const them = state.get(key)!;
      state.set(key, { ...them, Counters: { t: 'multiset', v: [[name, 9]] } } as WireObject);
      const adapted = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
      const { seat } = renderBoard(adapted);
      return seat(1).querySelector<HTMLElement>('.seat__counter')!.textContent!.replace(/9/g, '');
    };
    const glyphs = ['Energy', 'Experience'].map(glyphOf);
    expect(new Set(glyphs).size, `the glyphs ${JSON.stringify(glyphs)} must be pairwise distinct`).toBe(2);
  });

  it('item 1: a seat with poison, energy and experience all non-zero draws hand, library, energy and experience on the counts line and poison on the face, each with the full word in the tooltip and aria-label', () => {
    const state = new Map(foldPackets(loadPackets(fixture)).state);
    const key = deltaKey(DELTA_TYPE.player, 1);
    const them = state.get(key)!;
    state.set(key, {
      ...them,
      Counters: {
        t: 'multiset',
        v: [
          ['Poison', 7],
          ['Energy', 3],
          ['Experience', 5],
        ],
      },
    } as WireObject);
    const adapted = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, artIds: TEST_ART_IDS });
    const { seat } = renderBoard(adapted);
    const theirBar = seat(1).querySelector<HTMLElement>('[data-player-bar]')!;
    expect(theirBar.querySelector('[data-testid="library-count"]')).not.toBeNull();
    const counters = [...theirBar.querySelectorAll<HTMLElement>('.seat__counter')];
    expect(counters.map((c) => c.textContent).sort()).toEqual(['E3', 'XP5']);
    expect(counters.map((c) => c.getAttribute('data-tip')).sort()).toEqual(['3 energy', '5 experience']);
    expect(counters.map((c) => c.getAttribute('aria-label')).sort()).toEqual(['3 energy', '5 experience']);
    const poison = theirBar.querySelector<HTMLElement>('.seat__ident [data-testid="poison"]')!;
    expect(poison.getAttribute('data-tip')).toBe('7 poison');
    expect(poison.getAttribute('aria-label')).toBe('7 poison');
    // Still inside the SAME box as the library count (item 1's brief:
    // "stay inside their column") — not promoted to a track of its own.
    expect(theirBar.querySelectorAll('.seat__counts').length).toBe(1);
    const counts = theirBar.querySelector('.seat__counts')!;
    for (const el of [...counts.querySelectorAll('[data-testid="library-count"], .seat__counter')]) {
      expect(counts.contains(el)).toBe(true);
    }
  });
});

/*
 * ── wave 36 §B — T6, T7, T8, T10 ─────────────────────────────────────────
 *
 * One case per item, each reading the thing that item changed. See the
 * lane's report for mutation counts (revert each change, this case fails;
 * restore, it passes).
 */

describe('choice tags: a permanent wears what was chosen for it', () => {
  const base = boardFromFixture(fixture);
  /** The viewer's battlefield card 21, with these choices. */
  const withChoices = (choices: BoardCardChoice[], cardId = 21): BoardView => ({
    ...base,
    players: base.players.map((p) =>
      !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === cardId ? { ...c, choices } : c)) },
    ),
  });
  const tags = (container: HTMLElement, id = 21) => [...container.querySelectorAll<HTMLElement>(`[data-card-id="${id}"] > .board-card__tags > [data-choice]`)];

  it('a chosen colour is its mana symbol, and the tip says what was chosen', () => {
    const [tag, ...rest] = tags(renderBoard(withChoices([{ kind: 'color', values: ['Blue'] }])).container);
    expect(rest).toEqual([]);
    expect(tag!.dataset.choice).toBe('color');
    expect(tag!.querySelector('.ms')?.className).toMatch(/\bms-u\b/);
    expect(tag!.textContent, 'the symbol, not the word').toBe('');
    expect(tag!.dataset.tip).toBe('Chosen colour: Blue');
  });

  it('every other kind is its words, one tag per choice, before the keyword tags', () => {
    const view = withChoices([
      { kind: 'type', values: ['Goblin'] },
      { kind: 'card', values: ['Llanowar Elves'] },
      { kind: 'player', values: ['Bob'] },
    ]);
    const withKeyword: BoardView = {
      ...view,
      players: view.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === 21 ? { ...c, keywords: ['Flying'] } : c)) })),
    };
    const { container } = renderBoard(withKeyword);
    expect(tags(container).map((t) => [t.textContent, t.dataset.tip])).toEqual([
      ['Goblin', 'Chosen type: Goblin'],
      ['Llanowar Elves', 'Named card: Llanowar Elves'],
      ['Bob', 'Chosen player: Bob'],
    ]);
    const column = [...container.querySelectorAll<HTMLElement>('[data-card-id="21"] > .board-card__tags > li')];
    expect(column.map((t) => t.dataset.choice ?? t.dataset.keyword)).toEqual(['type', 'card', 'player', 'flying']);
  });

  it('the column is out of flow, takes no click, and sits in the top-right corner', () => {
    const css = styled();
    const column = renderBoard(withChoices([{ kind: 'type', values: ['Elf'] }])).container.querySelector('[data-card-id="21"] > .board-card__tags')!;
    expect(css(column, 'position')).toBe('absolute');
    expect(css(column, 'pointer-events')).toBe('none');
    expect(['top', 'right', 'bottom', 'left'].filter((side) => !/^(auto)?$/.test(css(column, side)))).toEqual(['top', 'right']);
  });

  it('a card with nothing chosen and no gained keyword (the common case) wears no column at all', () => {
    const { container } = renderBoard(withChoices([]));
    expect(container.querySelector('[data-card-id="21"] > .board-card__tags')).toBeNull();
  });

  it('is drawn on the battlefield only, not in a hand', () => {
    const view = withChoices([{ kind: 'type', values: ['Elf'] }]);
    const withHand: BoardView = {
      ...view,
      players: view.players.map((p) =>
        !p.isViewer || p.hand === null ? p : { ...p, hand: p.hand.map((c, i) => (i === 0 ? { ...c, choices: [{ kind: 'type', values: ['Elf'] }] } : c)) },
      ),
    };
    const { zone } = renderBoard(withHand);
    expect(zone(0, 'hand').querySelector('.board-card__tags'), 'not off the battlefield').toBeNull();
  });
});

describe('state marks: a permanent wears the state Forge tracks on it', () => {
  const base = boardFromFixture(fixture);
  const withStates = (states: BoardCardState[]): BoardView => ({
    ...base,
    players: base.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === 21 ? { ...c, states } : c)) })),
  });
  const mark = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-card-id="21"] > .board-card__tags > [data-state]');

  it('a level of a known top is a pip per level, the reached ones filled, and the tip says which', () => {
    const tag = mark(renderBoard(withStates([{ kind: 'classLevel', value: 2, max: 3 }])).container)!;
    expect(tag.dataset.state).toBe('classLevel');
    expect([...tag.querySelectorAll('.board-card__state-pip')].map((p) => p.hasAttribute('data-filled'))).toEqual([true, true, false]);
    expect(tag.textContent, 'pips, no words').toBe('');
    expect(tag.dataset.tip).toBe('Level 2 of 3');
  });

  it('a level with no known top is its number', () => {
    const tag = mark(renderBoard(withStates([{ kind: 'classLevel', value: 2 }])).container)!;
    expect(tag.querySelectorAll('.board-card__state-pip')).toHaveLength(0);
    expect(tag.textContent).toBe('2');
    expect(tag.dataset.tip).toBe('Level 2');
  });

  it('is drawn on the battlefield only', () => {
    const view = withStates([]);
    const withHand: BoardView = {
      ...view,
      players: view.players.map((p) => (!p.isViewer || p.hand === null ? p : { ...p, hand: p.hand.map((c, i) => (i === 0 ? { ...c, states: [{ kind: 'classLevel', value: 1, max: 3 }] } : c)) })),
    };
    expect(renderBoard(withHand).zone(0, 'hand').querySelector('[data-state]')).toBeNull();
  });
});

describe('the pointer is Forge’s offer, on every card of every seat', () => {
  /*
   * The operator, 2026-10-13: "enemy planeswalker is showing as clickable". The face is always a
   * `<button>`, and the page gives every button the pointer (`styles.css`), so a card Forge does not
   * offer read as clickable all the same. `styles.css`'s own button rule is loaded beside the board's.
   */
  function cursorOf(): (el: Element) => string {
    const sheet = document.createElement('style');
    sheet.textContent = `button { cursor: pointer; }\n${BOARD_CSS}\n${CARD_CSS}`;
    document.head.append(sheet);
    onTestFinished(() => sheet.remove());
    return (el) => getComputedStyle(el).cursor;
  }

  it('an opponent’s permanent Forge does not offer has no pointer; one it offers does', () => {
    const view = boardFromFixture(fixture);
    const theirs = view.players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
    expect(theirs.length).toBeGreaterThan(1);
    const { interaction } = spyInteraction([theirs[0]!]);
    const { container } = renderBoard(view, interaction);
    const cursor = cursorOf();
    const face = (id: number) => container.querySelector(`[data-card-id="${id}"] > .board-card__face`)!;
    expect(cursor(face(theirs[0]!)), 'offered').toBe('pointer');
    for (const id of theirs.slice(1)) expect(cursor(face(id)), `card ${id}, not offered`).not.toBe('pointer');
  });
});

describe('effect tags: what a resolved ability left waiting sits on its source until it is used', () => {
  const base = boardFromFixture(fixture);
  const withWaiting = (waiting: BoardCardWaiting[], cardId = 21): BoardView => ({
    ...base,
    players: base.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === cardId ? { ...c, waiting } : c)) })),
  });
  const effects = (container: HTMLElement, id = 21) => [...container.querySelectorAll<HTMLElement>(`[data-card-id="${id}"] > .board-card__tags > [data-effect]`)];

  it('one inverted chip per waiting effect, first in the column, its tip Forge’s own words', () => {
    const view = withWaiting([
      { kind: 'trigger', text: 'When you cast your next instant or sorcery spell from your hand this turn, it gains rebound.' },
      { kind: 'effect', text: 'Creatures you control get +1/+1.' },
    ]);
    const withChoice: BoardView = {
      ...view,
      players: view.players.map((p) => (!p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === 21 ? { ...c, choices: [{ kind: 'type', values: ['Elf'] }] } : c)) })),
    };
    const { container } = renderBoard(withChoice);
    expect(effects(container).map((t) => [t.dataset.effect, t.dataset.tip])).toEqual([
      ['trigger', 'Waiting: When you cast your next instant or sorcery spell from your hand this turn, it gains rebound.'],
      ['effect', 'In effect: Creatures you control get +1/+1.'],
    ]);
    expect(effects(container).every((t) => t.textContent === '' && t.querySelector('svg') !== null), 'a glyph, never words').toBe(true);
    const column = [...container.querySelectorAll<HTMLElement>('[data-card-id="21"] > .board-card__tags > li')];
    expect(column.map((t) => t.dataset.effect ?? t.dataset.choice)).toEqual(['trigger', 'effect', 'type']);
    const css = styled();
    expect(css(effects(container)[0]!, 'background-color'), 'ink on the card: the family’s one inverted chip').toBe(css(effects(container)[0]!, 'border-color'));
  });

  /*
   * The operator, 2026-10-20: "notice the many white hourglass effects of kappa cannoneer? once the
   * white hourglass happens more than once, let's just display it once and show a number next to it
   * that we increment rather than continuing to stack the icon lower."
   */
  it('the same mark twice or more is one mark with its count beside it, and its tip still lists each', () => {
    const cant = "Kappa Cannoneer can't be blocked this turn.";
    const view = withWaiting([
      { kind: 'effect', text: cant },
      { kind: 'effect', text: cant },
      { kind: 'trigger', text: 'At the beginning of the next end step, sacrifice it.' },
      { kind: 'effect', text: cant },
      { kind: 'effect', text: 'Creatures you control get +1/+1.' },
    ]);
    const { container } = renderBoard(view);
    const chips = effects(container);
    expect(chips.map((t) => t.dataset.effect), 'one chip per kind of mark, in the order each first appears').toEqual(['effect', 'trigger']);
    const [effect, trigger] = chips as [HTMLElement, HTMLElement];
    expect(effect.dataset.count, 'four effects on the one chip').toBe('4');
    expect(effect.querySelectorAll('svg'), 'drawn once').toHaveLength(1);
    expect(effect.querySelector('.board-card__tag-count')?.textContent, 'the number beside it').toBe('4');
    expect(effect.dataset.tip, 'the tip lists what they are').toBe(`In effect: ${cant} (×3)\nIn effect: Creatures you control get +1/+1.`);
    expect(trigger.dataset.count, 'a lone mark has no count').toBeUndefined();
    expect(trigger.textContent, 'nor a number').toBe('');
    expect(container.querySelector('[data-card-id="21"] > .board-card__tags')!.getAttribute('aria-label'), 'and the column still says each').toContain(`In effect: ${cant} (×3)`);
  });

  it('used up, it is gone: no waiting, no chip', () => {
    expect(effects(renderBoard(withWaiting([])).container)).toEqual([]);
  });
});

describe('wave 36 §B / wave 46 X3 — the stack names who/what/target in aria-label, never a drawn sentence', () => {
  it('no item draws Forge’s own resolved prose, or the old one-line summary markup — both are gone entirely (§S: so is the row itself)', () => {
    const { container } = renderBoard();
    // "the stack" describe block above already pins the exact aria-label
    // content for this fixture's two real items; this is the structural
    // claim beyond that: nothing on the board carries the classes that used
    // to hold the one-line summary, the full sentence before it, or the row.
    expect(
      container.querySelectorAll('.stack__text, .stack__what, .stack__source, .stack__controller, .stack__target, .stack__item, .stack__items'),
    ).toHaveLength(0);
  });

  it('the stack zone’s own box does not depend on how many items are on the stack (the canvas stays static)', () => {
    // `.board__mid`'s height is `var(--mid-h)`, a NAMED size with no `:has()`
    // or sibling-count selector reading anything (already pinned above, "is
    // roomy by default…"); this adds the DOM half: the stack ZONE itself
    // never grows a child, at any count — every item is `live/placed.ts`'s,
    // in the overlay, out of flow, never inside `.board__mid`/`.stack`.
    const view = boardFromFixture(fixture);
    // Unique ids per copy (React's own key, and this board's DOM-uniqueness
    // invariant) — `[0, 1, 2]` x the fixture's 2 real items is 6 distinct ids.
    const tripled: BoardView = {
      ...view,
      stack: [0, 1, 2].flatMap((n) => view.stack.map((item) => ({ ...item, id: item.id + n * 1000 }))),
    };
    const { container } = renderBoard(tripled);
    expect(container.querySelector('[data-zone="stack"]')!.children, 'the zone itself is still empty at six').toHaveLength(0);
    expect(container.querySelectorAll('[data-placed-spell]'), 'all six are drawn, just elsewhere').toHaveLength(6);
  });
});

describe('wave 36 §B — T10: the arrangement survives a reload (D1)', () => {
  afterEach(() => {
    forgetArrangements();
    sessionStorage.clear();
  });

  it('a drag written this tab is still there after `ARRANGED` itself is forgotten — sessionStorage, not memory, is what carried it', () => {
    const view = boardFromFixture(fixture);
    const me = view.players.find((p) => p.isViewer)!;
    const [first, second] = me.battlefield.filter((c) => /\bLand\b/i.test(c.card.typeLine)).map((c) => c.id);
    expect(first, 'a precondition: two lands to reorder').not.toBeUndefined();
    expect(second).not.toBeUndefined();

    const { container, unmount } = renderBoard(view, undefined, 'single');
    layOut(container);
    // Move `second` in front of `first` — a real rearrange, in a real row.
    dragCard(container, second!, { card: first!, at: 'before' });
    // Scoped to the VIEWER's own seat: both seats draw a `[data-tier="back"]`
    // list in 'single' layout, and the opponent's is first in document order.
    const tier = (c: HTMLElement) => {
      const list = c.querySelector<HTMLElement>('.seat[data-viewer] [data-tier="back"]')!;
      return [...list.querySelectorAll<HTMLElement>(':scope > li.board-card')].map((li) => Number(li.dataset.cardId));
    };
    const moved = tier(container);
    expect(moved[0], 'the drag really did move it').toBe(second);

    // "Reload": the in-memory store is gone, as it would be after a real
    // page load starts the JS over. `sessionStorage` (this tab's own) is not
    // touched — that is the whole point of the feature.
    unmount();
    forgetArrangements();

    const { container: reloaded } = renderBoard(view, undefined, 'single');
    expect(tier(reloaded), 'restored from sessionStorage, slot AND row, with no drag at all this time').toEqual(moved);
  });

  it('a DIFFERENT match starts from the view’s own order — sessionStorage is keyed by match too, not just by seat', () => {
    const view = boardFromFixture(fixture);
    const me = view.players.find((p) => p.isViewer)!;
    const [first, second] = me.battlefield.filter((c) => /\bLand\b/i.test(c.card.typeLine)).map((c) => c.id);
    const lands = me.battlefield.filter((c) => /\bLand\b/i.test(c.card.typeLine)).map((c) => c.id);
    const rest = me.battlefield.filter((c) => !/\bLand\b/i.test(c.card.typeLine)).map((c) => c.id);

    const { container, unmount } = renderBoard(view, undefined, 'single');
    layOut(container);
    dragCard(container, second!, { card: first!, at: 'before' });
    unmount();
    forgetArrangements();

    const tierOf = (c: HTMLElement, name: string) =>
      [...c.querySelectorAll<HTMLElement>(`.seat[data-viewer] [data-tier="${name}"] > li.board-card`)].map((li) =>
        Number(li.dataset.cardId),
      );
    const otherMatch: BoardView = { ...view, title: `${view.title} #2` };
    const { container: other } = renderBoard(otherMatch, undefined, 'single');
    // The DEFAULT grouping (lands in back, the rest in front, each in the
    // view's own order) — not the other match's reorder, and not a flat
    // view-order either: a fresh 'single' board is still tier-grouped.
    expect(tierOf(other, 'back'), 'untouched by the other match’s drag').toEqual(lands);
    expect(tierOf(other, 'front')).toEqual(rest);
  });

  it('a blocked or unavailable sessionStorage costs the tidying, never a crash', () => {
    const view = boardFromFixture(fixture);
    const me = view.players.find((p) => p.isViewer)!;
    const [first, second] = me.battlefield.filter((c) => /\bLand\b/i.test(c.card.typeLine)).map((c) => c.id);
    const real = globalThis.sessionStorage;
    const blocked: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    Object.defineProperty(globalThis, 'sessionStorage', { value: blocked, configurable: true });
    try {
      const { container } = renderBoard(view, undefined, 'single');
      layOut(container);
      expect(() => dragCard(container, second!, { card: first!, at: 'before' })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { value: real, configurable: true });
    }
  });
});

describe('copiesIn: the ×N a pile of copies wears', () => {
  const seed = boardFromFixture(fixture).players.find((p) => p.isViewer)!.battlefield.find((c) => c.id === 8)!;
  const copy = (id: number, over: Partial<BoardCard> = {}): BoardCard => ({ ...seed, id, ...over });

  it('counts a pile of two or more of the same card', () => {
    expect(copiesIn([copy(1), copy(2)])).toBe(2);
    expect(copiesIn([copy(1), copy(2), copy(3)])).toBe(3);
  });

  it('counts nothing for a lone card or an empty column', () => {
    expect(copiesIn([copy(1)])).toBeNull();
    expect(copiesIn([])).toBeNull();
  });

  it('counts nothing when the pile mixes cards', () => {
    expect(copiesIn([copy(1), copy(2), copy(3, { card: { ...seed.card, name: 'Grizzly Bears' } })])).toBeNull();
  });

  it('a token is not the card of the same name', () => {
    expect(copiesIn([copy(1, { token: true }), copy(2, { token: true })])).toBe(2);
    expect(copiesIn([copy(1, { token: true }), copy(2, { token: false })])).toBeNull();
  });

  it('counts nothing when a card in the pile is hidden from this seat', () => {
    expect(copiesIn([copy(1, { hidden: true }), copy(2, { hidden: true })])).toBeNull();
  });

  it('a tapped, damaged or countered copy is still a copy', () => {
    expect(copiesIn([copy(1, { tapped: true }), copy(2, { damage: 2 }), copy(3, { counters: [{ name: 'P1P1', count: 1 }] })])).toBe(3);
  });
});

/**
 * Your own face stays a circle while it is the way into the settings — the operator, 2026-10-10:
 * *"small bug, i notice that when clicking on my avatar to bring up the settings it causes it to
 * become square instead of circular. why does the circle mask break?"*
 *
 * There is no mask: the circle is the priority ring (`.seat__ring`) around the mark. What drew the
 * square was the face button's own focus outline — the press that closes the settings leaves focus
 * on the face, and the next key makes it keyboard focus, which a browser outlines on the BUTTON: a
 * column of the mark and the life under it. So the claim is the cascade on the real markup: with
 * keyboard focus on your face the button overrides the browser's outline and the ring — a circle —
 * carries it, with a character and with the drawn mark, while you are asked (outside the lit ring) and not.
 * jsdom draws no browser defaults, so an outline no rule mentions reads as empty here, not `none`.
 */
describe('your own face stays a circle when it is the way into the settings', () => {
  for (const [who, avatarId] of [
    ['a character', 'rogue'],
    ['the drawn mark', undefined],
  ] as const) {
    it(`${who}: keyboard focus rings the mark, never the button, lit and unlit`, () => {
      const css = styled();
      const base = boardFromFixture(fixture);
      const view = { ...base, players: base.players.map((p) => (p.isViewer ? { ...p, avatarId } : p)) };
      const { container } = render(createElement(Board, { view, onOpenSettings: () => undefined }));
      const button = container.querySelector<HTMLElement>('[data-testid="seat-settings"]')!;
      expect(button.querySelector(avatarId === undefined ? 'svg.face__art' : 'img.face__avatar'), `${who} is what the face draws`).not.toBeNull();
      const seat = button.closest('[data-testid="player"]')!;
      const ring = button.querySelector('.seat__ring')!;
      // Keyboard focus: a key pressed, then focus on the face (a pointer press earlier in the file would make it pointer focus).
      fireEvent.keyDown(document.body, { key: 'Tab' });
      button.focus();
      expect(button.matches(':focus-visible'), 'keyboard focus on the face').toBe(true);

      const offsets: number[] = [];
      for (const lit of [false, true]) {
        if (lit) seat.setAttribute('data-priority', '');
        else seat.removeAttribute('data-priority');
        expect(css(button, 'outline'), 'the button (the mark and the life under it) draws no focus outline').toBe('none');
        expect(css(ring, 'outline'), 'focus is drawn on the ring').toMatch(/\bsolid\b/);
        expect(css(ring, 'border-radius'), 'and the ring is a circle').toBe('50%');
        for (const el of button.querySelectorAll('*')) {
          if (el !== ring) expect(css(el, 'outline'), `${el.getAttribute('class') ?? el.tagName} draws no outline of its own`).not.toMatch(/solid|dashed|dotted|double/);
        }
        offsets.push(Number.parseFloat(css(ring, 'outline-offset')));
      }
      expect(offsets[1], 'while lit, the focus ring steps outside the lit ring').toBeGreaterThan(offsets[0]!);
    });
  }
});

/**
 * The operator, 2026-10-12: *"can we display modified costs on cards in hand
 * using our applied overlay tags? should apply to anything that modifies
 * anything in hand"* — `BoardInteraction.held`, the bridge's `heldChanges`.
 */
describe('held changes — a changed cost and a granted flash are tags on the hand card', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const [changed, plain] = me.hand!;
  const onField = me.battlefield[0]!;
  const tags = (container: HTMLElement, id: number) =>
    container.querySelector<HTMLElement>(`[data-zone="hand"][data-owner="you"] [data-board-card="${id}"] > .board-card__tags`);

  function withHeld(held: BoardInteraction['held']) {
    const { interaction } = spyInteraction([]);
    return renderBoard(view, { ...interaction, held });
  }

  it('draws the cost now as pips, says the source on hover, and colours a reduction', () => {
    const tip = "Costs {U} instead of {1}{U}: Jace's Sanctum";
    const { container } = withHeld(new Map([[changed!.id, { cost: { tokens: ['U'], change: 'less', tip } }]]));
    const cost = tags(container, changed!.id)!.querySelector<HTMLElement>(':scope > [data-cost]')!;
    expect(cost.dataset.cost).toBe('U');
    expect(cost.dataset.costChange).toBe('less');
    expect(cost.dataset.tip).toBe(tip);
    expect([...cost.querySelectorAll('.pip[data-token]')].map((p) => p.getAttribute('data-token'))).toEqual(['U']);
    expect(tags(container, plain!.id), 'a card nothing changes wears no tag').toBeNull();
  });

  it('draws a granted flash as a tag with its source', () => {
    const { container } = withHeld(new Map([[changed!.id, { flash: 'Flash: can be cast any time you could cast an instant (from Vedalken Orrery)' }]]));
    const flash = tags(container, changed!.id)!.querySelector<HTMLElement>(':scope > [data-keyword="flash"]')!;
    expect(flash.textContent).toBe('Flash');
    expect(flash.dataset.tip).toMatch(/Vedalken Orrery/);
    expect(tags(container, changed!.id)!.querySelector('[data-cost]')).toBeNull();
  });

  it('is a hand fact: an id on the battlefield draws none of it', () => {
    const { container } = withHeld(new Map([[onField.id, { cost: { tokens: ['1'], change: 'less', tip: 'x' }, flash: 'y' }]]));
    expect(container.querySelector(`[data-board-card="${onField.id}"] [data-cost]`)).toBeNull();
    expect(container.querySelector(`[data-board-card="${onField.id}"] [data-keyword="flash"]`)).toBeNull();
  });
});

/**
 * The operator, 2026-10-15: *"much like how we created a pill for cost reduction in hand, let's also
 * create an 'eye' pill for cards that have been revealed to your opponent"* — `BoardCard.seenByOpponent`.
 */
describe('seen — an eye on a card of yours the opponent was shown', () => {
  const base = boardFromFixture(fixture);
  const me = base.players.find((p) => p.isViewer)!;
  const [seen, unseen] = me.hand!;
  const view: BoardView = {
    ...base,
    players: base.players.map((p) => (!p.isViewer ? p : { ...p, hand: p.hand!.map((c) => (c.id === seen!.id ? { ...c, seenByOpponent: true } : c)) })),
  };
  const eye = (container: HTMLElement, id: number) => container.querySelector<HTMLElement>(`[data-board-card="${id}"] > .board-card__tags > [data-seen]`);

  it('draws an eye tag, a drawn glyph, that says what it means on hover — on exactly the seen card', () => {
    const { container } = renderBoard(view);
    const tag = eye(container, seen!.id)!;
    expect(tag, 'the seen card wears the eye').not.toBeNull();
    expect(tag.querySelector('svg.board-card__seen-glyph'), 'drawn, not a glyph a font might not have').not.toBeNull();
    expect(tag.dataset.tip).toBe('Your opponent has seen this card');
    expect(eye(container, unseen!.id), 'a card nobody else saw wears none').toBeNull();
    expect(container.querySelectorAll('[data-seen]')).toHaveLength(1);
  });

  it("draws it on the viewer's revealed library top too", () => {
    const top = { ...unseen!, id: 4242, seenByOpponent: true };
    const { container } = renderBoard({ ...view, players: view.players.map((p) => (p.isViewer ? { ...p, libraryTop: [top] } : p)) });
    expect(eye(container, 4242)).not.toBeNull();
  });
});

/*
 * The operator, 2026-10-17: "when enemy has circle make it color danger, same with the phase counter"
 * and "creature gave +1/0 to enhance a creatures power, it should have shown the number in green if
 * the stats have been changed." Theme tokens only.
 */
describe('2026-10-17 — the other seat’s marks in danger, a raised number in green', () => {
  const LIVE_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'live/live.css'), 'utf8');
  const rule = (css: string, selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('rings the other seat in the theme’s danger while it holds priority, and the viewer’s own in the accent', () => {
    expect(rule(CARD_CSS, '.seat[data-priority]:not([data-viewer]) .seat__ring')).toMatch(/0 0 0 6px var\(--danger\)/);
    expect(rule(CARD_CSS, '.seat[data-priority] .seat__ring')).toMatch(/0 0 0 6px var\(--accent\)/);
  });

  it('marks the current step in danger on the other seat’s turn, a stop on it keeping its warning ink', () => {
    expect(rule(LIVE_CSS, ".live__phases[data-whose='theirs'] .live__step[data-current]")).toMatch(/inset 3px 0 0 0 var\(--danger\)/);
    expect(rule(LIVE_CSS, ".live__phases[data-whose='theirs'] .live__step[data-current]:not([data-stop]) .live__step-name")).toMatch(/var\(--danger-ink\)/);
    expect(rule(LIVE_CSS, ".live__phases[data-whose='theirs'] .live__step[data-stop][data-current]")).toMatch(/inset -3px 0 0 0 var\(--warn\)/);
  });

  it('lights the active seat’s edge in the theme’s danger on the other seat’s turn, and in its success on the viewer’s — one shadow, coloured per seat', () => {
    const css = styled();
    const view = boardFromFixture(fixture);
    for (const activeIsViewer of [true, false]) {
      const turn: BoardView = { ...view, players: view.players.map((p) => ({ ...p, isActive: p.isViewer === activeIsViewer })) };
      const { seat } = renderBoard(turn);
      const active = turn.players.find((p) => p.isActive)!;
      const whose = activeIsViewer ? 'the viewer’s turn' : 'the other seat’s turn';
      expect(seat(active.id).dataset.active, whose).toBe('true');
      expect(css(seat(active.id), '--turn-lit'), `${whose}: the active seat is lit`).toBe('1');
      expect([css(seat(active.id), '--turn-line'), css(seat(active.id), '--turn-glow')], `${whose}: the edge and its glow`).toEqual(
        activeIsViewer ? ['var(--turn-edge)', 'var(--success)'] : ['var(--danger-ink)', 'var(--danger)'],
      );
      cleanup();
    }
    // The operator, 2026-10-24, picking the stronger of two edge lights: a 6px line and a glow reaching 70px in.
    expect(rule(BOARD_CSS, '.board .seat')).toMatch(/inset 0 calc\(var\(--turn-y\) \* 6px\) 0 color-mix\(in srgb, var\(--turn-line\)/);
    expect(rule(BOARD_CSS, '.board .seat')).toMatch(/inset 0 calc\(var\(--turn-y\) \* 70px\) 60px -24px color-mix\(in srgb, var\(--turn-glow\) calc\(var\(--turn-lit\) \* 60%\)/);
    expect(rule(BOARD_CSS, '.board .seat')).toMatch(/color-mix\(in srgb, var\(--turn-glow\)/);
    expect(rule(BOARD_CSS, '.board .seat:not([data-viewer])'), 'the other seat restates no shadow, only its colours and edge').not.toMatch(/box-shadow/);
  });

  it('draws a buffed number and a +1/+1 counter in the success ink', () => {
    expect(rule(CARD_CSS, ".board-card__pt-n[data-pt-state='buffed']")).toMatch(/color: var\(--success-ink\)/);
    expect(rule(CARD_CSS, ".board-card__counter[data-counter='plus']")).toMatch(/color: var\(--success-ink\)/);
  });
});

/*
 * The operator, 2026-10-19: "cards like 'Walk-In Closet' it's hard to tell whats actually going on.
 * which room was played, which room is active? has the door been unlocked?" A Room on the battlefield
 * is drawn as its two doors, each its own half of the card, marked locked or unlocked; a door that
 * unlocks while drawn plays a beat.
 */
describe('a Room on the battlefield', () => {
  const ROOM = 'Walk-In Closet // Forgotten Cellar';

  /** The fixture with its first battlefield card made a Room whose doors are `left` and `right`. */
  function withRoom(left: boolean, right: boolean): { view: BoardView; id: number } {
    const view = boardFromFixture(fixture);
    const player = view.players.find((p) => p.battlefield.length > 0)!;
    const base = player.battlefield[0]!;
    const door = (name: string, faceCrop: 'split-left' | 'split-right', unlocked: boolean) => ({
      ...base.card,
      name,
      faceCrop,
      door: unlocked ? ('unlocked' as const) : ('locked' as const),
    });
    const room: BoardCard = {
      ...base,
      card: { ...base.card, name: ROOM, faces: [door('Walk-In Closet', 'split-left', left), door('Forgotten Cellar', 'split-right', right)] },
      doors: [
        { name: 'Walk-In Closet', unlocked: left },
        { name: 'Forgotten Cellar', unlocked: right },
      ],
    };
    const players = view.players.map((p) => (p === player ? { ...p, battlefield: [room, ...p.battlefield.slice(1)] } : p));
    return { view: { ...view, players }, id: base.id };
  }

  const roomLi = (container: HTMLElement, id: number) => container.querySelector<HTMLElement>(`[data-zone="battlefield"] .board-card[data-board-card="${id}"]`)!;
  const doorStates = (li: HTMLElement) =>
    [...li.querySelectorAll<HTMLElement>('.board-card__door')].map((d) => ({
      side: d.dataset.doorSide,
      name: d.querySelector('.card__name')?.textContent,
      door: d.querySelector<HTMLElement>('.card')?.dataset.door,
      tip: d.querySelector<HTMLElement>('.card__door')?.dataset.tip,
      crop: d.querySelector<HTMLElement>('.card')?.dataset.faceCrop,
    }));

  it('draws its two doors, left then right, each its half of the card, the locked one marked locked', () => {
    const { view, id } = withRoom(true, false);
    const { container } = renderBoard(view);
    const li = roomLi(container, id);
    expect(li.dataset.room).toBe('true');
    expect(doorStates(li)).toEqual([
      { side: 'left', name: 'Walk-In Closet', door: 'unlocked', tip: 'Unlocked door', crop: 'split-left' },
      { side: 'right', name: 'Forgotten Cellar', door: 'locked', tip: 'Locked door', crop: 'split-right' },
    ]);
  });

  it('a door that unlocks while drawn plays its beat, and only for its beat; one open on arrival plays none', () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const before = withRoom(true, false);
    const { container, rerender } = renderBoard(before.view);
    const unlocking = () => [...roomLi(container, before.id).querySelectorAll<HTMLElement>('.board-card__door[data-unlocking]')].map((d) => d.dataset.doorSide);
    expect(unlocking(), 'nothing unlocked yet').toEqual([]);
    rerender(createElement(Board, { view: withRoom(true, true).view, boardLayout: 'type-separated' }));
    expect(unlocking()).toEqual(['right']);
    expect(doorStates(roomLi(container, before.id)).map((d) => d.door)).toEqual(['unlocked', 'unlocked']);
    act(() => {
      vi.advanceTimersByTime(UNLOCK_BEAT_MS);
    });
    expect(unlocking(), 'the beat is over').toEqual([]);
  });

  it('is drawn as one card when its doors are not both in hand to draw', () => {
    const { view, id } = withRoom(false, false);
    const players = view.players.map((p) => ({ ...p, battlefield: p.battlefield.map((c) => (c.id === id ? { ...c, card: { ...c.card, faces: c.card.faces!.slice(0, 1) } } : c)) }));
    const { container } = renderBoard({ ...view, players });
    expect(roomLi(container, id).dataset.room).toBeUndefined();
  });
});
