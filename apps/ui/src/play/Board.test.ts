// @vitest-environment jsdom
/**
 * The board renders a real game state — every number asserted here is read
 * off the committed fixture, a real Forge match's packet stream (see
 * `fixtures.ts` for its provenance). If the adapter mis-maps a zone, a count
 * below moves and this file fails.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';

import { ALLOWED_ART_HOSTS } from '@hadoku/carddata/art';
import { createProjector, type StateFrame } from '../../../server/src/play/visibility.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import poolData from '../draft/pool.json';
import {
  artIdIndex,
  CUBE_ART_IDS,
  scryfallIdFor,
  toBoardView,
  type ArtIdIndex,
  type BoardCard,
  type BoardView,
} from './adapter.ts';
import { Board, forgetArrangements, snapTo, type BoardInteraction, type BoardLayout } from './Board.tsx';
import { boardFromFixture, loadPackets, PLAY_FIXTURES } from './fixtures.ts';
import { foldPackets, type WireState } from './fold.ts';
import { cardStateKey, deltaKey, expectWirePackets, isAnnotationKey, WireType, type WireObject } from './wire.ts';

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
 * that was ours, was deleted in wave 31 §A.3, so every button is Forge's.
 */
const forgeButtons = (container: HTMLElement) => container.querySelectorAll('button');

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
    [...list.querySelectorAll(':scope > li.board-card')].forEach((li, j) => stubBox(li, 10 + j * 70, top + 8, CARD_W, CARD_H));
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
    const slot = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-arrange-slot="${to.slot}"]`)!;
    const box = slot.getBoundingClientRect();
    return { x: box.right - 20, y: (box.top + box.bottom) / 2 };
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
 * The one thing it carried that is neither the rail's nor on the operator's
 * delete list is the game ENDING, so `.board__over` survives — out of flow,
 * beside the missing-card alert, where four e2e assertions still find it.
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
    // The stylesheet went with it, token and all.
    expect(BOARD_RULES).not.toContain('.board__bar');
    expect(BOARD_RULES).not.toContain('--bar-h');
    expect(declarationIn('.board', 'grid-template-areas'), 'and the board has no bar row').toBe("'them' 'you'");
  });

  it('keeps the game-over line, out of flow', () => {
    const base = boardFromFixture(fixture);
    const { container } = renderBoard({ ...base, gameOver: true });
    const over = container.querySelector<HTMLElement>('.board__over')!;
    expect(over, 'the line is drawn when the game is over').not.toBeNull();
    expect(over.textContent).toBe('game over');
    expect(declarationIn('.board__over', 'position'), 'and it cannot push a track').toBe('absolute');
    cleanup();
    const { container: live } = renderBoard(base);
    expect(live.querySelector('.board__over'), 'and not while the game runs').toBeNull();
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
   * word entirely would be a symbol nobody can name.
   */
  it('draws each count as a symbol and a number, with the word in its accessible name', () => {
    const { seat } = renderBoard();
    const library = within(seat(0)).getByTestId('library-count');
    expect(library.textContent, 'the number, and no word').toBe('46');
    expect(library.getAttribute('aria-label')).toBe('library 46');
    expect(library.querySelector('svg.seat__count-art'), 'a drawn mark beside it').toBeTruthy();
    expect(within(seat(1)).getByTestId('library-count').textContent).toBe('47');
    const hand = within(seat(0)).getByTestId('hand-count');
    expect(hand.textContent).toBe('5');
    expect(hand.getAttribute('aria-label')).toBe('hand 5');
    expect(hand.querySelector('svg.seat__count-art')).toBeTruthy();
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
   * §A.15: a card's state is DRAWN, not written. The operator: *"all the shitty
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
    // And the turn is real: the stylesheet turns anything tapped or attacking.
    expect(
      /\.board-card:is\(\[data-tapped\], \[data-attacking\]\) \.board-card__face > \.card \{[^}]*rotate\(90deg\)/.test(
        withoutComments(CARD_CSS),
      ),
      'the turn is on the tapped/attacking rule',
    ).toBe(true);
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

describe('the stack', () => {
  it('lists both items, top first', () => {
    const { container } = renderBoard();
    const stack = container.querySelector<HTMLElement>('[data-zone="stack"]')!;
    expect(stack.dataset.count).toBe('2');
    const items = [...stack.querySelectorAll('.stack__source')].map((n) => n.textContent);
    expect(items).toEqual(['Fire Urchin · ability', 'Direct Current']);
    expect(stack.textContent).toContain('deals 2 damage to Goblin Replica (67)');
  });
});

/* ── art ──────────────────────────────────────────────────────────────── */

/** Every card name the raw stream carries, including ones the viewer may not see. */
function namesOnTheWire(): string[] {
  const names = new Set<string>();
  for (const packet of loadPackets(fixture)) {
    for (const obj of Object.values(packet.newObjects)) {
      if (typeof obj !== 'object' || obj._type !== WireType.CardState) continue;
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
      ([k, o]) => o._type === WireType.CardState && k === cardStateKey(o._id >> 4, 0) && (o.Name as { v?: unknown } | undefined)?.v === 'Island',
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
  const hand = state.get(deltaKey(WireType.Player, 1))?.Hand as { v: { v: number }[] };
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
) {
  const onSelectCard = vi.fn<(id: number) => void>();
  const onSelectPlayer = vi.fn<(id: number) => void>();
  const interaction: BoardInteraction = {
    selectable: new Set(selectable),
    selectablePlayers: new Set(selectablePlayers),
    selectionOpen,
    actionable: new Set(actionable),
    stagedCardId,
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

  it('an inert card is not a button and a click on it calls nothing', () => {
    const { interaction, onSelectCard } = spyInteraction(picks);
    const { container } = renderBoard(view, interaction);
    const inert = [...container.querySelectorAll<HTMLElement>('[data-board-card]:not([data-selectable])')];
    // 5 + 8 battlefield, 3 + 3 graveyard, 5 in hand: 24 cards, 4 of them picked.
    expect(inert).toHaveLength(24 - picks.length);
    for (const card of inert) {
      expect(card.querySelector('button')).toBeNull();
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
    const item = container.querySelector<HTMLElement>(`[data-stack-id="${spell.id}"]`)!;
    expect(item.dataset.selectable).toBe('true');
    fireEvent.click(within(item).getByRole('button'));
    expect(onSelectCard.mock.calls).toEqual([[spell.sourceCardId]]);
  });

  it('an id Forge names that is not on the board makes nothing clickable', () => {
    const { interaction } = spyInteraction([987654]);
    const { container } = renderBoard(view, interaction);
    expect(forgeButtons(container)).toHaveLength(0);
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
   * §A.7. The board spelled `{T}` out as the word TAP while the tap symbol was a
   * mark we had decided not to reproduce. **D20 settled that the other way** —
   * the operator, 2026-09-27: *"naw we're not drawing our own"* — so the symbol
   * ships from the Mana pack and `CardTile` has drawn `ms-tap` in a card's own
   * rules text since wave 26 §C. The stack's text was the last place still
   * writing the word, and it now goes through the same `ManaPip`.
   */
  it('draws {T} in the stack’s text as the tap SYMBOL, not the word TAP', () => {
    const view = boardFromFixture(fixture);
    const withTap: BoardView = { ...view, stack: [{ ...view.stack[0]!, description: '{T}: Add {R}.' }] };
    const { container } = renderBoard(withTap);
    const text = container.querySelector<HTMLElement>('.stack__text')!;
    expect(text.textContent, 'neither the word nor the braces are left in the text').toBe(': Add .');
    expect(
      [...text.querySelectorAll<HTMLElement>('.pip')].map((p) => p.dataset.token),
      'both symbols are pips, and the tap one is a pip like any other',
    ).toEqual(['T', 'R']);
    expect(text.querySelector('.ms-tap'), 'drawn from the Mana pack’s own glyph (D20)').not.toBeNull();
  });

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

/**
 * A stylesheet with its comments taken out. A grep for a declaration must not
 * be able to read PROSE about that declaration — both files below discuss
 * `writing-mode` and `rotate` at length, and a test that the discussion can
 * satisfy is a test that cannot fail for the right reason.
 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * `board.css`'s DECLARATIONS, with every comment gone.
 *
 * Every "this token is gone" assertion below reads this and not `BOARD_CSS`, for
 * the same reason the rotation grep does: this file discusses the tokens it
 * deleted — `.board__bar`'s own `padding-right` trick, the `--gutter-w` column
 * §A.3 removed — and a test the PROSE can satisfy is a test that cannot fail for
 * the right reason.
 */
const BOARD_RULES = withoutComments(BOARD_CSS);

/**
 * One declaration out of a rule in `board.css`, so a regression reads as itself.
 *
 * `selector` has to be a whole selector LINE, which is how a rule with several
 * selectors is addressed by any one of them. More than one rule can therefore
 * carry the line — `.zone__cards`'s shared sizing rule and the per-zone rule
 * that gives it a `--card-slack` are two such — so the blocks are read in file
 * order and the LAST one declaring the property wins, which for rules of equal
 * specificity is also what the cascade does.
 */
function declarationInCss(css: string, selector: string, property: string): string | undefined {
  const blocks = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)^\\}`, 'gm');
  const declares = new RegExp(`(?:^|;|\\{)\\s*${property}:([^;]+);`, 'm');
  let found: string | undefined;
  for (const block of css.matchAll(blocks)) {
    const value = declares.exec(block[1]!)?.[1]?.replace(/\s+/g, ' ').trim();
    if (value !== undefined) found = value;
  }
  return found;
}

const declarationIn = (selector: string, property: string): string | undefined =>
  declarationInCss(BOARD_CSS, selector, property);

/** The fixture's own stack item, repeated, so the only thing that varies is how many. */
function withStack(base: BoardView, n: number): BoardView {
  const seed = base.stack[0]!;
  return { ...base, stack: Array.from({ length: n }, (_, i) => ({ ...seed, id: 9000 + i })) };
}

describe('the canvas is static', () => {
  const base = boardFromFixture(fixture);
  const counts = [0, 1, 5] as const;

  it('draws every other slot identically with 0, 1 and 5 items on the stack', () => {
    const shots = counts.map((n) => {
      const { container } = renderBoard(withStack(base, n));
      const board = container.querySelector<HTMLElement>('.board')!;
      const stack = board.querySelector<HTMLElement>('[data-zone="stack"]')!;
      const shot = {
        // Everything outside the stack, byte for byte.
        rest: board.outerHTML.replace(stack.outerHTML, '<!--stack-->'),
        // The viewer's battlefield on its own, because that is the box the
        // operator watched move.
        battlefield: board.querySelector<HTMLElement>('.seat[data-viewer] > [data-zone="battlefield"]')!.outerHTML,
        // And the stack's own slot: the same elements at every size, never a
        // different one and never nothing.
        slot: [...stack.children].map((c) => `${c.tagName}.${c.className}`),
        items: stack.querySelectorAll('.stack__item').length,
      };
      cleanup();
      return shot;
    });

    expect(shots.map((s) => s.items), 'the stack really did hold 0, 1 and 5').toEqual([0, 1, 5]);
    for (const i of [1, 2]) {
      expect(shots[i]!.rest, `everything but the stack, with ${counts[i]} items`).toBe(shots[0]!.rest);
      expect(shots[i]!.battlefield, `the battlefield, with ${counts[i]} items`).toBe(shots[0]!.battlefield);
      expect(shots[i]!.slot, `the stack's own slot, with ${counts[i]} items`).toEqual(shots[0]!.slot);
    }
    expect(shots[0]!.slot).toEqual(['H3.zone__head', 'OL.stack__items']);
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
      // A default battlefield's lists are its two tiers, under `.zone__tiers`.
      expect(
        z.querySelector(':scope > ul, :scope > ol, :scope > .zone__tiers > ul'),
        `${z.dataset.owner} ${z.dataset.zone} still has its list`,
      ).not.toBeNull();
      expect(z.dataset.count).toBe('0');
    }
  });

  it('lays the board and the seats out in named tracks, not in their content', () => {
    /*
     * TWO rows, one to one (§A.1): the bar is deleted and the stack floats, so the
     * two seats have the canvas between them and the two battlefields come out the
     * same size on either side of the centre line — 26% each, the operator's own
     * number (`board-layout-2026-09-27.md`).
     */
    expect(declarationIn('.board', 'grid-template-rows')).toBe('minmax(0, 1fr) minmax(0, 1fr)');
    /*
     * A seat is two card rows, no head row and ONE narrow column (wave 32 Q9) that
     * spans both of them: the avatar, the counts, then the piles. Nothing about it
     * is sized by what it holds.
     */
    expect(declarationIn('.board .seat', 'grid-template-columns')).toBe('var(--who-w) minmax(0, 1fr)');
    expect(declarationIn('.board .seat', 'grid-template-rows')).toBe('minmax(0, 4fr) minmax(0, 2.6fr)');
    expect(declarationIn('.board .seat:not([data-viewer])', 'grid-template-rows')).toBe('minmax(0, 2.6fr) minmax(0, 4fr)');
    expect(BOARD_RULES, 'the head row is gone, token and all').not.toContain('--seat-head-h');
    expect(BOARD_RULES, 'and so is the opponent-hand strip the fr row replaced').not.toContain('--opp-hand-h');
    /*
     * And the bar itself is fixed tracks with the avatar block in the seat's
     * INNER one — `auto` LAST for the opponent, whose bar is the lower cell of
     * their seat, and `auto` FIRST for the viewer, whose bar is the upper cell of
     * theirs. That is item 10, and it REVERSES wave 20's anchoring on the
     * operator's own instruction: *"lets push them closer together. bottom avatar
     * anchored top of that box, top avatar anchored bottom of that box."* Telling
     * ours from theirs still rests on `(you)`, on `data-viewer` and on the ink,
     * which is what wave 20 was actually about.
     */
    expect(declarationIn('.board .seat__who', 'grid-template-rows')).toBe('auto var(--mana-h) var(--counts-h)');
    expect(declarationIn('.board .seat__ident', 'grid-row')).toBe('1');
    expect(declarationIn('.board .seat__mana', 'grid-row')).toBe('2');
    expect(declarationIn('.board .seat__counts', 'grid-row')).toBe('3');
    // The opponent's bar is the mirror: counts first, the avatar last, against the centre line.
    expect(declarationIn('.board .seat:not([data-viewer]) .seat__who', 'grid-template-rows')).toBe(
      'var(--counts-h) var(--mana-h) auto',
    );
    expect(declarationIn('.board .seat:not([data-viewer]) .seat__ident', 'grid-row')).toBe('3');
    expect(declarationIn('.board .seat:not([data-viewer]) .seat__mana', 'grid-row')).toBe('2');
    expect(declarationIn('.board .seat:not([data-viewer]) .seat__counts', 'grid-row')).toBe('1');
    // The graveyard left the bar entirely, and the bar's track for it with it.
    expect(BOARD_RULES, 'the bar no longer has a graveyard track').not.toContain('--grave-h');
    expect(BOARD_RULES).not.toContain('--grave-w');
    /*
     * The stack FLOATS (settled: *"float over the board makes sense"*), so the
     * centre band is out of flow and the battlefields meet at the centre line. It
     * takes the top of the same column the question panel takes the rest of —
     * lane B's `--live-col-*` tokens, with the operator's own numbers as the
     * fallback for a board mounted bare.
     */
    expect(declarationIn('.board__mid', 'position')).toBe('absolute');
    expect(declarationIn('.board__mid', 'left')).toBe('var(--live-col-x, 59.4%)');
    expect(declarationIn('.board__mid', 'width')).toBe('var(--live-col-w, 24.1%)');
    expect(declarationIn('.board__mid', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(BOARD_RULES).not.toContain('--faces-w');
    // The piles are ONE column (item 9, wave 30), and since wave 32 Q9 they are
    // whatever the avatar and the counts leave of the seat's one left column: the
    // graveyard takes the row that is left, and exile is an `auto` strip.
    expect(declarationIn('.seat__piles', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationIn('.seat__piles', 'grid-template-rows')).toBe('minmax(0, 1fr) auto');
    expect(declarationIn('.seat__piles', 'flex')).toBe('1 1 0');
    // The left column spans BOTH seat rows, on both sides of the table.
    expect(declarationIn('.board .seat', 'grid-template-areas')).toBe("'side field' 'side hand'");
    expect(declarationIn('.board .seat:not([data-viewer])', 'grid-template-areas')).toBe("'side hand' 'side field'");
    /*
     * The labels left on the board are a battlefield's four LANE names, and each
     * is a `--row-head-h` strip across the top of its own lane — a lane is tall
     * and narrow, and a column there would eat its whole share of the width. The
     * zone captions and the `--gutter-w` COLUMN they sat in are gone (§A.3), so a
     * row zone is one column, all of it the cards'.
     *
     * A lane paying in height means `--card-slack` owes that height back, or a
     * two-row lane computes a card taller than the room under its own label and
     * the lane has to scroll. The hand has no label at all, so its slack is the
     * ring and lift alone.
     */
    expect(BOARD_RULES, 'no label column, token and all').not.toContain('--gutter-w');
    expect(declarationIn('.seat[data-viewer] > .zone--hand', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationIn('.seat[data-viewer] > .zone--hand', 'grid-template-rows'), 'no label track over the lanes').toBeUndefined();
    expect(declarationIn('.zone__row', 'grid-template-rows')).toBe('var(--row-head-h) minmax(0, 1fr)');
    expect(declarationIn('.seat[data-viewer] > .zone--hand > .zone__cards', '--card-slack')).toBe('8px');
    expect(declarationIn('.seat > .zone--battlefield .zone__row > .zone__cards', '--card-slack')).toBe(
      'calc(6px + var(--row-head-h) + var(--row-head-gap))',
    );
    // A battlefield's four groups are lanes across the slot, each lane's share
    // of the width its card count (`Board.tsx` sets the grow), and a lane with
    // nothing in it its label's width. Neither is sized by what is in it.
    expect(declarationIn('.zone__rows', 'flex-direction')).toBe('row');
    expect(declarationIn('.zone__row', 'flex')).toBe('0 1 var(--group-overhead)');
    expect(declarationIn('.zone__row[data-empty]', 'flex')).toBe('0 0 var(--group-empty-w)');
    expect(declarationIn('.zone__row', 'overflow')).toBe('hidden');
    // The two things that appear mid-game are out of flow, so neither can
    // push a track when it does.
    expect(declarationIn('.board__warn', 'position')).toBe('absolute');
    expect(declarationIn('.board__overlay', 'position')).toBe('absolute');
    expect(declarationIn('.board__overlay', 'inset')).toBe('0');
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
   * rows, top to bottom, with the HANDS OUTERMOST.
   *
   * Read off the three `grid-template-areas` declarations rather than asserted as
   * three separate strings, so the test says the thing the operator said — the
   * order — and reds if any one of them stops mirroring the others.
   */
  const rowsOf = (selector: string): string[] =>
    (declarationIn(selector, 'grid-template-areas') ?? '')
      .split("'")
      .filter((part) => part.trim() !== '')
      .map((part) => part.trim());

  it('stacks four rows with each hand furthest from the middle', () => {
    expect(rowsOf('.board'), 'the board: their seat, then ours').toEqual(['them', 'you']);
    /*
     * Which of the two CARD areas each row line holds, by name rather than by
     * position, so the answer is the row order and not an index into whatever
     * else the line mentions.
     */
    const cardRows = (selector: string): string[] =>
      rowsOf(selector).map((line) => {
        const names = line.split(/\s+/);
        return ['field', 'hand'].find((a) => names.includes(a)) ?? '?';
      });
    expect([
      ...cardRows('.board .seat:not([data-viewer])').map((r) => `them/${r}`),
      ...cardRows('.board .seat').map((r) => `you/${r}`),
    ]).toEqual(['them/hand', 'them/field', 'you/field', 'you/hand']);
    // And the two battlefields are the same size, which is what "face each other
    // across the middle" means for a canvas with nothing in flow between them.
    expect(declarationIn('.board', 'grid-template-rows')).toBe('minmax(0, 1fr) minmax(0, 1fr)');
    expect(declarationIn('.board .seat', 'grid-template-rows')).toBe('minmax(0, 4fr) minmax(0, 2.6fr)');
    expect(declarationIn('.board .seat:not([data-viewer])', 'grid-template-rows')).toBe('minmax(0, 2.6fr) minmax(0, 4fr)');
    // The one thing that was between them is out of flow now.
    expect(declarationIn('.board__mid', 'position')).toBe('absolute');
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
    // Nowhere in a seat, not one: `.zone__head` survives on the STACK alone, which
    // is a floating panel rather than a region of the table (`board.css`).
    expect(seat(0).querySelectorAll('.zone__head')).toHaveLength(0);
    expect(seat(1).querySelectorAll('.zone__head')).toHaveLength(0);
    expect(board.querySelectorAll('.zone__head')).toHaveLength(1);
    expect(board.querySelector('.zone__head')!.closest('[data-zone]')!.getAttribute('data-zone')).toBe('stack');
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
   * All four card rows, because a card can come to rest in any of them — and one
   * token, because four hand-written paddings is how three of them end up wrong.
   */
  it('reserves the right end of every row for the permanent overlays', () => {
    /*
     * The VALUE is pinned, not just the reference, because it is a measurement and
     * because over-reserving is a silent failure with a real cost: 12rem — taken
     * from the operator's drawing, where the leftmost permanent overlay sits at
     * x=1080 of a 1280 WINDOW — reds `e2e/table-fit.spec.ts`'s crowded table at
     * 28px against its 30px floor, because `live.css` anchors those overlays to
     * `.live`'s right edge and `.live` is ~944px wide in a watchparty room. What
     * they occupy is the widest of the three plus their shared 6px gutter: the
     * controls, 6 + 112 = 118px. 7.5rem is that plus 2px of clearance.
     */
    expect(declarationIn('.board', '--right-gutter'), 'the reservation is what they occupy').toBe('7.5rem');
    // A literal, not a reference: `--live-*` is `live.css`'s and is undefined when
    // `Board` is mounted bare, which this suite and the dev harnesses both do.
    expect(declarationIn('.board', '--right-gutter')).not.toContain('--live-');
    for (const row of [
      '.seat > .zone--battlefield,\n.seat[data-viewer] > .zone--hand',
      '.seat > .zone--battlefield',
      '.seat[data-viewer] > .zone--hand',
      '.seat:not([data-viewer]) > .zone--hand',
    ]) {
      expect(declarationIn(row, 'padding-right'), `${row} reserves it`).toBe('var(--right-gutter)');
    }
    // A transient overlay reserves nothing: the stack and the question panel come
    // and go, so they cover what is under them (the operator, 2026-09-27).
    expect(declarationIn('.board__mid', 'padding-right'), 'the stack reserves nothing').toBeUndefined();
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
    const key = deltaKey(WireType.Player, playerId);
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
    expect(pool.textContent, 'the counts are drawn, not only coloured').toBe('W1R2C1');
    // Colour is never the only signal: the whole pool is in words to a reader.
    const mine = view.players.find((p) => p.isViewer)!.name;
    expect(pool.getAttribute('aria-label')).toBe(`${mine} mana pool: 1 white, 2 red, 1 colourless`);
    // It is against the portrait — one is the other's sibling in the bar — and it
    // is NOT a zone, so the set of zones on the board is untouched by it.
    expect(pool.previousElementSibling!.className).toBe('seat__ident');
    expect(pool.dataset.zone).toBeUndefined();
    // And the other seat, whose pool this state left empty, draws the same box
    // holding nothing: a pool arriving mid-turn may not move a track.
    const theirs = seat(1).querySelector<HTMLElement>('[data-mana-pool]')!;
    expect(theirs, 'every seat has the box').not.toBeNull();
    expect(theirs.dataset.manaTotal).toBe('0');
    expect(theirs.children).toHaveLength(0);
    expect(declarationIn('.board .seat', '--mana-h'), 'and the box is a named track').toBeDefined();
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
     * card.css keeps exactly one rotation and it is not a word: a tapped
     * permanent is turned a quarter inside a landscape box, which is the
     * operator's own affordance and stays. If a second one appears, this is the
     * test that says so.
     */
    const inCards = withoutComments(CARD_CSS).match(SIDEWAYS) ?? [];
    expect(inCards).toEqual(['rotate(']);
    const rotates = /^\s*transform: translate\(-50%, -50%\) rotate\(90deg\);$/m;
    expect(rotates.test(CARD_CSS), 'the one rotation is the tapped card’s quarter turn').toBe(true);
    const turned = /\.board-card:is\(\[data-tapped\], \[data-attacking\]\) \.board-card__face > \.card \{[^}]*rotate\(90deg\)/;
    expect(turned.test(withoutComments(CARD_CSS)), 'and it is on the turned card’s own rule').toBe(true);
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
      // Symbols and numbers since §A.10; the words are the accessible names.
      expect(within(bar).getByTestId('hand-count').getAttribute('aria-label')).toBe(`hand ${p.handCount}`);
      expect(within(bar).getByTestId('library-count').getAttribute('aria-label')).toBe(`library ${p.libraryCount}`);
      expect(within(bar).getByTestId('hand-count').textContent).toBe(String(p.handCount));
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
   * bar — avatar, mana, counts — in fixed tracks, then the piles with everything
   * that is left. It REVERSES wave 26 §A.2's two cells, so a graveyard confined to
   * the hand's rows is the regression this reads for.
   */
  it('puts the piles in the REST of one left column: avatar, counts, then the graveyard takes the space', () => {
    const { seat } = renderBoard(view);
    for (const p of view.players) {
      const bar = seat(p.id).querySelector<HTMLElement>('[data-player-bar]')!;
      expect(bar.querySelector('[data-zone]'), `seat ${p.id}'s bar holds no zone`).toBeNull();
      expect([...bar.children].map((c) => c.className), `seat ${p.id}'s bar, in order`).toEqual(
        ['seat__ident', 'seat__mana', 'seat__counts'],
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
    // One column spanning both seat rows, the piles `flex: 1` — no fraction anywhere.
    expect(declarationIn('.board .seat', 'grid-template-areas')).toBe("'side field' 'side hand'");
    expect(declarationIn('.board .seat__side', 'grid-area')).toBe('side');
    expect(declarationIn('.board .seat__side', 'display')).toBe('flex');
    expect(declarationIn('.board .seat__side', 'flex-direction')).toBe('column');
    expect(declarationIn('.seat__piles', 'flex')).toBe('1 1 0');
    expect(declarationIn('.board .seat__who', 'flex'), 'the bar takes what it needs and no more').toBe('none');
    // The bar is fixed tracks: avatar, mana, counts — so the graveyard starts at one place.
    expect(declarationIn('.board .seat__who', 'grid-template-rows')).toBe('auto var(--mana-h) var(--counts-h)');
    expect(BOARD_RULES).not.toContain('seat__who > .zone--graveyard');
    // The retired w26 geometry is not still there.
    expect(BOARD_RULES).not.toContain("'piles hand'");
    expect(BOARD_RULES).not.toContain("'who field'");
  });

  it('Q9: the opponent’s column is the vertical mirror, and exile is a strip that exists only while it holds a card', () => {
    // The mirror is the order only: text and faces are never turned.
    expect(declarationIn('.board .seat:not([data-viewer]) > .seat__side', 'flex-direction')).toBe('column-reverse');
    expect(declarationIn('.seat:not([data-viewer]) .seat__piles', 'grid-template-rows')).toBe('auto minmax(0, 1fr)');
    expect(declarationIn('.board .seat:not([data-viewer]) .zone--graveyard', 'justify-content')).toBe('flex-end');
    expect(declarationIn('.board .seat .zone--exile[data-count=\'0\']', 'display')).toBe('none');
    expect(declarationIn('.board .seat .zone--exile', 'max-height'), 'a strip, not a second pile').toBe('3.6rem');
    // The attribute that rule reads is the zone's own count.
    const { zone } = renderBoard(view);
    expect(zone(0, 'exile').dataset.count).toBe(String(view.players.find((p) => p.isViewer)!.exile.length));
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

  it('keeps the flags out of the avatar’s track, so one arriving mid-game cannot move a face', () => {
    const flagged: BoardView = {
      ...view,
      players: view.players.map((p) => ({ ...p, isActive: true, hasPriority: true, hasLost: true })),
    };
    const { seat } = renderBoard(flagged);
    for (const p of view.players) {
      const bar = seat(p.id).querySelector<HTMLElement>('[data-player-bar]')!;
      const flags = [...bar.querySelectorAll('.seat__flag')].map((f) => f.textContent);
      // No "their turn" in words any more: whose turn it is is a ring round the avatar (Q1b).
      expect(flags, `seat ${p.id}'s flags`).toEqual(['priority', 'lost']);
      // Every one of them is in the counts block, never the avatar block.
      for (const f of bar.querySelectorAll('.seat__flag')) {
        expect(f.closest('.seat__counts'), 'a flag is in the counts track').not.toBeNull();
        expect(f.closest('.seat__ident'), 'and not in the avatar track').toBeNull();
      }
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

  it('puts a positioned overlay root at the board’s top level, empty and untouched', () => {
    const { container } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const overlays = [...board.querySelectorAll<HTMLElement>('[data-board-overlay]')];
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.parentElement).toBe(board);
    // This lane renders nothing into it and hangs no handler on it.
    expect(overlays[0]!.children).toHaveLength(0);
    expect(overlays[0]!.className).toBe('board__overlay');
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
    expect(container.querySelector<HTMLElement>('[data-card-id="8"]')!.getAttribute('draggable'), 'and still draggable').toBe('true');
    drag(container, 8, { card: 24 });
    drag(container, 24, { row: 'artifacts' });
    expect(rowIds(0, 'artifacts')).toEqual([24]);
    expect(onSelectCard).not.toHaveBeenCalled();
    expect(onSelectPlayer).not.toHaveBeenCalled();
    // And the view the board was handed is untouched: the arrangement is ours.
    expect(view.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id)).toEqual([8, 24, 21, 6, 25]);
  });

  it('is the viewer’s own battlefield and hand only, and there is no reset control', () => {
    const { container, seat } = renderBoard();
    // Five permanents and the five cards of their own hand (§E.1). With no
    // `interaction` at all nothing is offered, so the whole hand arranges.
    expect(seat(0).querySelectorAll('[data-zone="battlefield"] .board-card[draggable="true"]')).toHaveLength(5);
    expect(seat(0).querySelectorAll('[data-zone="hand"] .board-card[draggable="true"]')).toHaveLength(5);
    expect(seat(0).querySelectorAll('.board-card[draggable="true"]')).toHaveLength(10);
    // A pile is Forge's own order, never the player's.
    expect(seat(0).querySelectorAll('[data-zone="graveyard"] .board-card[draggable]')).toHaveLength(0);
    expect(seat(0).querySelectorAll('[data-zone="exile"] .board-card[draggable]')).toHaveLength(0);
    // The opponent's side is theirs to arrange, on their own screen.
    expect(seat(1).querySelectorAll('.board-card[draggable]')).toHaveLength(0);
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
   * Drop `cardId` on `ontoId`, in the named third of its box (`middle` is the
   * reorder: the left half of the middle band is "in front of it").
   */
  function dragOnto(container: HTMLElement, cardId: number, ontoId: number, where: 'top' | 'middle' | 'bottom') {
    dragCard(container, cardId, { card: ontoId, at: where === 'middle' ? 'before' : where });
  }

  /** The viewer's lands lane, as columns of piles: each column bottom card first. */
  function columns(container: HTMLElement, row = 'lands'): number[][] {
    const lane = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-board-row="${row}"]`)!;
    return [...lane.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li.board-card')].map((base) => [
      Number(base.dataset.cardId),
      ...[...base.querySelectorAll<HTMLElement>(':scope > ul.board-card__pile > li.board-card')].map((m) => Number(m.dataset.cardId)),
    ]);
  }

  it('stacks ON TOP when the drop lands in the upper third', () => {
    const { container, rowIds } = renderBoard();
    dragOnto(container, 25, 8, 'top');
    expect(columns(container), '25 is on 8, and the lane is one column shorter').toEqual([[8, 25], [24], [6]]);
    // Every card is still drawn, still once, and still in its lane.
    expect(rowIds(0, 'lands')).toEqual([8, 25, 24, 6]);
  });

  it('stacks UNDERNEATH when the drop lands in the lower third', () => {
    const { container } = renderBoard();
    dragOnto(container, 25, 8, 'bottom');
    expect(columns(container), '25 is under 8').toEqual([[25, 8], [24], [6]]);
  });

  it('still reorders when the drop lands in the middle third', () => {
    const { container } = renderBoard();
    dragOnto(container, 25, 24, 'middle');
    expect(columns(container), 'four columns, nothing stacked').toEqual([[8], [25], [24], [6]]);
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
      container.querySelectorAll('.seat[data-viewer] [data-zone="battlefield"] .board-card[draggable="true"]'),
      'and all of them draggable',
    ).toHaveLength(5);
    dragOnto(container, 24, 8, 'top');
    dragOnto(container, 6, 8, 'bottom');
    dragOnto(container, 25, 24, 'middle');
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
    expect(seat(1).querySelectorAll('.board-card[draggable]')).toHaveLength(0);

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

    it('leaves an aura on the opponent’s creature where Forge lists it', () => {
      // The host is not on this battlefield, so nothing is folded in: the aura
      // is a card of its own controller's side, which is where Forge put it.
      const base = equipped();
      const view: BoardView = {
        ...base,
        players: base.players.map((p) =>
          !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id === 901 ? { ...c, attachedToId: 99 } : c)) },
        ),
      };
      // Card 21 still claims it, so it still stacks — the HOST's `AttachedCards`
      // is the authority and `attachedToId` never builds a stack by itself.
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
});

/* ── a card Forge is ASKING ABOUT belongs to Forge, not to the arrangement ── */

/**
 * The two gestures on this board must not both fire on one press, and the line
 * between them is an OPEN SELECTION — not Forge's actionable set.
 *
 * The interaction lane starts its targeter drag on `pointerdown` over a card in
 * `interaction.selectable`; a `draggable="true"` element starts the BROWSER's own
 * HTML5 drag from the same press, so a card that was both would rearrange the
 * board and send a `selectCard` from one gesture.
 *
 * The first cut at this gated on `selectable` alone and was wrong, which the real
 * e2e caught: `selectable` also carries `setWeaklySelectable`, Forge's
 * ACTIONABLE set, which on your own turn is most of your own permanents — so
 * arranging was dead for most of a game and `e2e/table-fit.spec.ts` red with a
 * permanent that would not move between rows. `selectionOpen` is the narrow
 * fact, and every assertion below is on the ATTRIBUTE because that is what the
 * browser reads.
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
      zone(0, 'battlefield').querySelectorAll('.board-card[draggable="true"]'),
      'all five stay arrangeable: actionable is not a question',
    ).toHaveLength(5);
    // The hand was not offered anything, so it arranges too — and none of its
    // cards is both offered and draggable, which the loop below checks board-wide.
    expect(zone(0, 'hand').querySelectorAll('.board-card[draggable="true"]')).toHaveLength(5);
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
      expect(card(container, id).hasAttribute('draggable'), `card ${id} is Forge’s while it asks`).toBe(false);
    }
    for (const id of lands.filter((l) => !chosen.includes(l))) {
      expect(card(container, id).dataset.selectable, `card ${id} is not in the selection`).toBeUndefined();
      expect(card(container, id).getAttribute('draggable'), `card ${id} is still yours to arrange`).toBe('true');
    }
    expect(card(container, 21).getAttribute('draggable'), 'and the creature').toBe('true');
    // No card is ever both, however it got there.
    for (const el of container.querySelectorAll<HTMLElement>('.board-card')) {
      expect(
        el.hasAttribute('draggable') && el.hasAttribute('data-selectable'),
        `card ${el.dataset.cardId} is both draggable and in the selection`,
      ).toBe(false);
    }
  });

  it('with a selection open over the whole battlefield, nothing is draggable', () => {
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id), [], true);
    const { container } = renderBoard(view, interaction);
    expect(container.querySelectorAll('.board-card[draggable]'), 'the whole board is Forge’s while it asks').toHaveLength(0);
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
    expect(zone(0, 'battlefield').querySelectorAll('.board-card[draggable="true"]')).toHaveLength(5);
    expect(zone(0, 'hand').querySelectorAll('.board-card[draggable="true"]'), 'and the hand with it').toHaveLength(5);
  });

  it('with nothing offered at all, every card of your own battlefield and hand is draggable', () => {
    const { interaction } = spyInteraction([]);
    const { container, seat, zone } = renderBoard(view, interaction);
    expect(zone(0, 'battlefield').querySelectorAll('.board-card[draggable="true"]')).toHaveLength(5);
    expect(zone(0, 'hand').querySelectorAll('.board-card[draggable="true"]')).toHaveLength(5);
    expect(seat(1).querySelectorAll('.board-card[draggable]'), 'still never theirs').toHaveLength(0);
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
    expect(member!.hasAttribute('draggable'), 'so it is not draggable, pile or no pile').toBe(false);
    expect(stacked.dataset.selectable, 'the base is not in the selection').toBeUndefined();
    expect(stacked.getAttribute('draggable'), 'and stays draggable').toBe('true');
  });

  /*
   * The other half, and it is NOT covered by `selectionOpen` — established from
   * Forge rather than assumed. `setSelectables` has exactly two call sites in all
   * of Forge, both selection inputs; `InputAttack` publishes none of them (it
   * calls `updateButtons` and `clearActionableCards`, `InputAttack.java:87-101`).
   * So during declare-attackers the seat's creatures arrive as Forge's ACTIONABLE
   * set with NO selection open — and the interaction lane's pointer layer stands
   * down on any natively-draggable element, so a draggable creature here means
   * you cannot attack with it.
   */
  it('stands down on your own CREATURES while you are declaring attackers, and on nothing else', () => {
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id));
    interaction.declaringAttackers = true;
    const { container, seat } = renderBoard(view, interaction);
    // The creature is the attack gesture's; the four lands are still yours.
    expect(card(container, 21).hasAttribute('draggable'), 'the creature is the attack gesture’s').toBe(false);
    for (const id of lands) {
      expect(card(container, id).getAttribute('draggable'), `land ${id} is still arrangeable`).toBe('true');
    }
    expect(seat(0).querySelectorAll('.board-card[draggable="true"]')).toHaveLength(4);
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
    expect(card(container, 21).hasAttribute('draggable'), 'still the attack gesture’s').toBe(false);
    expect(card(container, 8).getAttribute('draggable'), 'the lands beside it are not').toBe('true');
  });

  it('defaults to not declaring attackers when the field is absent', () => {
    const { interaction } = spyInteraction(me.battlefield.map((c) => c.id));
    expect(interaction.declaringAttackers, 'the field really is absent').toBeUndefined();
    const { zone } = renderBoard(view, interaction);
    expect(
      zone(0, 'battlefield').querySelectorAll('.board-card[draggable="true"]'),
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
    expect(card(container, 8).hasAttribute('draggable')).toBe(false);
    expect(container.querySelectorAll('.board-card[draggable="true"]')).toHaveLength(4);
  });
});

/* ── the hand is the player's to arrange ──────────────────────────────── */

/**
 * §E.1. The operator, 2026-09-27: they could not reorder their own hand at all —
 * wave 24's free placement reached the battlefield and stopped there.
 *
 * It is the same store, the same gesture and the same reset as a battlefield
 * row (`Board.tsx`), so what is left to prove is the part that is the hand's
 * own: that the cards are draggable at all, that a drop moves them, that the
 * order outlives a re-render, that NOTHING goes to Forge, and the stand-down —
 * a hand card Forge offered stays undraggable, because dragging a card out of
 * hand is how it is PLAYED (`e2e/play.spec.ts`), not how it is tidied.
 */
describe('drag to arrange your own hand (#2)', () => {
  const view = boardFromFixture(fixture);
  const me = view.players.find((p) => p.isViewer)!;
  const hand = me.hand!.map((c) => c.id);

  const handOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"]')!;
  /** The ids the hand draws, in the order it draws them. */
  const handIds = (container: HTMLElement): number[] =>
    [...handOf(container).querySelectorAll<HTMLElement>('.board-card')].map((c) => Number(c.dataset.cardId));
  const draggableInHand = (container: HTMLElement) => handOf(container).querySelectorAll('.board-card[draggable="true"]');

  /** Drag a card in front of another card, or onto the hand's own list. */
  function drag(container: HTMLElement, cardId: number, onto: { card: number } | 'the hand'): void {
    dragCard(container, cardId, onto === 'the hand' ? { slot: 'hand' } : { card: onto.card, at: 'before' });
  }

  it('makes every card of the viewer’s own hand draggable, and a drop reorders it', () => {
    const { container } = renderBoard(view);
    expect(hand.length, 'the fixture dealt a hand worth arranging').toBeGreaterThan(2);
    expect(handIds(container), 'the view’s own order, to begin with').toEqual(hand);
    expect(draggableInHand(container), 'every card of it').toHaveLength(hand.length);
    // The last card to the front of the hand.
    const last = hand.at(-1)!;
    drag(container, last, { card: hand[0]! });
    expect(handIds(container)).toEqual([last, ...hand.slice(0, -1)]);
    // And the count on the zone is still the truth.
    expect(handOf(container).dataset.count).toBe(String(hand.length));
  });

  it('puts a card dropped on the hand’s own list at the end of it', () => {
    const { container } = renderBoard(view);
    drag(container, hand[0]!, 'the hand');
    expect(handIds(container)).toEqual([...hand.slice(1), hand[0]!]);
  });

  it('survives a re-render, a resync and a remount, and a card drawn joins the end', () => {
    const first = renderBoard(view);
    drag(first.container, hand.at(-1)!, { card: hand[0]! });
    const arranged = [hand.at(-1)!, ...hand.slice(0, -1)];
    expect(handIds(first.container)).toEqual(arranged);

    // A re-render with the same view: the order is in the module store, not in
    // React's state, so a redraw cannot lose it.
    first.rerender(createElement(Board, { view }));
    expect(handIds(first.container), 'after a re-render').toEqual(arranged);

    // A resync replaces the whole view and may remount the board.
    cleanup();
    const resynced: BoardView = { ...boardFromFixture(fixture), seq: 4242 };
    const after = renderBoard(resynced);
    expect(handIds(after.container), 'after a resync and a remount').toEqual(arranged);

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
    expect(handIds(renderBoard(drew).container)).toEqual([...arranged, 909]);
  });

  it('is per match: another match starts from the view’s order', () => {
    const { container, rowIds } = renderBoard(view);
    drag(container, hand.at(-1)!, { card: hand[0]! });
    dragCard(container, 8, { slot: 'other' });
    expect(handIds(container)).not.toEqual(hand);
    expect(rowIds(0, 'other')).toEqual([8]);

    // Another match starts from the view's order, as the battlefield does.
    cleanup();
    const there = renderBoard(view);
    drag(there.container, hand.at(-1)!, { card: hand[0]! });
    cleanup();
    const elsewhere = renderBoard({ ...boardFromFixture(fixture), title: 'another match entirely' });
    expect(handIds(elsewhere.container)).toEqual(hand);
  });

  it('stacks nothing: a drop in the top third of a hand card is still a reorder', () => {
    const { container } = renderBoard(view);
    // A pointer in a card's top third — which on a BATTLEFIELD means "stack on top
    // of this card" (`snapTo`). A hand does not stack.
    dragCard(container, hand.at(-1)!, { card: hand[0]!, at: 'top' });
    expect(handIds(container)).toEqual([hand.at(-1)!, ...hand.slice(0, -1)]);
    expect(handOf(container).querySelectorAll('[data-pile-size], [data-pile-depth]'), 'no pile in a hand').toHaveLength(0);
  });

  it('a hand card Forge OFFERED is not draggable — that press plays the card', () => {
    /*
     * The whole reason the hand's condition is stricter than the battlefield's.
     * A `draggable="true"` element takes the press away from the interaction
     * lane (`live/gestures/install.ts`'s `nativelyDraggable`), and
     * `e2e/play.spec.ts` plays a land AND a spell by dragging them out of hand —
     * the gesture the operator reported broken in production. So Forge's own
     * offer, actionable set included, pins the card.
     */
    const { interaction } = spyInteraction([hand[0]!, hand[1]!]);
    const { container } = renderBoard(view, interaction);
    for (const id of [hand[0]!, hand[1]!]) {
      const el = container.querySelector<HTMLElement>(`.seat[data-viewer] [data-card-id="${id}"]`)!;
      expect(el.dataset.selectable, `Forge offered ${id}`).toBe('true');
      expect(el.hasAttribute('draggable'), `so ${id} is the pointer lane's, not the arrangement's`).toBe(false);
    }
    expect(draggableInHand(container), 'the rest of the hand still arranges').toHaveLength(hand.length - 2);
    // A drop that names an offered card still moves nothing of Forge's: the
    // carried card is the one that moves, and it is one of ours.
    drag(container, hand.at(-1)!, { card: hand[0]! });
    expect(handIds(container)).toEqual([hand.at(-1)!, ...hand.slice(0, -1)]);
  });

  it('holds the whole hand still while Forge is ASKING, and while combat is declared', () => {
    // A selection open anywhere: the source-less targeter drag may begin
    // anywhere on the table, including over a hand card.
    const asking = spyInteraction(me.battlefield.map((c) => c.id), [], true).interaction;
    expect(draggableInHand(renderBoard(view, asking).container), 'while Forge asks').toHaveLength(0);
    cleanup();
    // And a declaration: the box-draw sweeps from anywhere.
    const declaring: BoardInteraction = { ...spyInteraction([]).interaction, declaringAttackers: true };
    expect(draggableInHand(renderBoard(view, declaring).container), 'while attackers are declared').toHaveLength(0);
  });

  it('never moves a card between zones, and never touches the opponent’s hand', () => {
    const { container, rowIds, seat } = renderBoard(view);
    // A hand card dropped on a battlefield lane: neither zone moves.
    dragCard(container, hand[0]!, { slot: 'lands' });
    expect(rowIds(0, 'lands'), 'the battlefield did not take a card out of hand').toEqual([8, 24, 6, 25]);
    expect(handIds(container), 'and the hand still holds it').toEqual(hand);
    // A permanent dropped in the hand: the same, from the other side.
    drag(container, 8, 'the hand');
    expect(handIds(container), 'the hand did not take a permanent').toEqual(hand);
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    // The opponent's hand is backs, and none of them is draggable.
    expect(seat(1).querySelectorAll('[data-zone="hand"] .board-card')).toHaveLength(0);
    expect(seat(1).querySelectorAll('[draggable="true"]'), 'nothing of theirs is ours to drag').toHaveLength(0);
  });

  it('sends nothing to the engine: the senders are armed on the very cards dragged', () => {
    /*
     * Armed on both players and on the two hand cards the gesture below uses —
     * one of which Forge offered, so it is the one card of the two that is NOT
     * draggable. A stray call would land on an id under the drag.
     */
    const { interaction, onSelectCard, onSelectPlayer } = spyInteraction([hand[0]!], view.players.map((p) => p.id));
    const { container } = renderBoard(view, interaction);
    drag(container, hand.at(-1)!, { card: hand[0]! });
    drag(container, hand[1]!, 'the hand');
    expect(handIds(container), 'the hand really did move').not.toEqual(hand);
    expect(onSelectCard).not.toHaveBeenCalled();
    expect(onSelectPlayer).not.toHaveBeenCalled();
    // And the view the board was handed is untouched: the order is ours.
    expect(view.players.find((p) => p.isViewer)!.hand!.map((c) => c.id)).toEqual(hand);
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
  it('writes user-select: none on the seat’s own cards, and only there', () => {
    expect(declarationIn('.board .seat .board-card', 'user-select')).toBe('none');
    /*
     * Scoped to the seat: `card.css` and `prompts/prompts.css` style
     * `.board-card` too, and a card in a prompt is read, not dragged. So this
     * file may not write the rule on a bare `.board-card`.
     */
    expect(declarationIn('.board-card', 'user-select'), 'not on every .board-card there is').toBeUndefined();
  });

  it('really is on a card the player can drag, and on the opponent’s too', () => {
    const { container, seat } = renderBoard();
    const sheet = document.createElement('style');
    sheet.textContent = BOARD_CSS;
    document.head.append(sheet);
    try {
      for (const el of [
        container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"] .board-card')!,
        container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] .board-card')!,
        seat(1).querySelector<HTMLElement>('[data-zone="battlefield"] .board-card')!,
      ]) {
        expect(el, 'a card to read the rule off').not.toBeNull();
        expect(getComputedStyle(el).userSelect, `${el.dataset.cardId} selects no text`).toBe('none');
      }
    } finally {
      sheet.remove();
    }
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
      of: parts.map((p) => p.dataset.ptOf),
      states: parts.map((p) => p.dataset.ptState),
      marks: parts.map((p) => p.querySelector('[aria-hidden="true"]')?.textContent ?? null),
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
      text: '▲3/▼1',
      label: 'power 3, up from 1, toughness 1, 3 damage marked',
      of: ['power', 'toughness'],
      states: ['buffed', 'hurt'],
      marks: ['▲', '▼'],
    });
  });

  it('draws a plain creature plain — no ink, no marker, no claim', () => {
    const { container } = renderBoard(urchin(1, 2, 0, { power: 1, toughness: 2 }));
    expect(badge(container, 21)).toEqual({
      text: '1/2',
      label: 'power 1, toughness 2',
      of: ['power', 'toughness'],
      states: [undefined, undefined],
      marks: [null, null],
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
      of: ['power', 'toughness'],
      states: [undefined, undefined],
      marks: [null, null],
    });
    // A 5/5 with a big base and no knowledge of it is plain too, not blue.
    expect(badge(container, 99)!.states).toEqual([undefined, undefined]);
  });

  it('marks a shrunk creature hurt, and a damaged one hurt without a base at all', () => {
    const shrunk = renderBoard(urchin(0, 1, 0, { power: 1, toughness: 2 }));
    expect(badge(shrunk.container, 21)!.states).toEqual(['hurt', 'hurt']);
    expect(badge(shrunk.container, 21)!.text).toBe('▼0/▼1');
    cleanup();
    const hurt = renderBoard(urchin(1, 3, 2, null));
    expect(badge(hurt.container, 21), 'damage alone is enough: it needs no printed base').toEqual({
      text: '1/▼1',
      label: 'power 1, toughness 1, 2 damage marked',
      of: ['power', 'toughness'],
      states: [undefined, 'hurt'],
      marks: [null, '▼'],
    });
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

  it('never carries meaning in colour alone: every state has a marker and words', () => {
    const { container } = renderBoard(urchin(3, 4, 3, { power: 1, toughness: 2 }));
    for (const n of container.querySelectorAll<HTMLElement>('[data-card-id="21"] > .board-card__pt .board-card__pt-n')) {
      const state = n.dataset.ptState;
      if (state === undefined) continue;
      expect(n.querySelector('[aria-hidden="true"]')!.textContent, `${state} has a marker glyph`).toMatch(/[▲▼]/);
    }
    // The stylesheet pairs the ink with a weight, so the two states differ
    // without a colour too.
    for (const state of ['buffed', 'hurt']) {
      const rule = new RegExp(`\\.board-card__pt-n\\[data-pt-state='${state}'\\] \\{([^}]*)\\}`).exec(withoutComments(CARD_CSS));
      expect(rule, `${state} has a rule`).not.toBeNull();
      expect(rule![1], `${state} sets a colour`).toMatch(/color:/);
      expect(rule![1], `${state} sets a weight too`).toMatch(/font-weight:/);
    }
  });

  it('is out of flow and takes no click: it may not move a card or eat a selection', () => {
    expect(declarationInCss(CARD_CSS, '.board-card__pt', 'position')).toBe('absolute');
    expect(declarationInCss(CARD_CSS, '.board-card__pt', 'pointer-events')).toBe('none');
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
    expect(container.querySelector('[data-card-id="21"]')!.hasAttribute('data-sick')).toBe(false);
    cleanup();
    const sick = renderBoard({
      ...base,
      players: base.players.map((p) =>
        !p.isViewer ? p : { ...p, battlefield: p.battlefield.map((c) => (c.id !== 21 ? c : { ...c, summoningSick: true })) },
      ),
    });
    expect(marksOf(sick.container, 21), 'and a creature that cannot act still says so').toContain('sick');
    expect(sick.container.querySelector('[data-card-id="21"]')!.getAttribute('data-sick')).toBe('true');
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
  it('is booted on the board root, draws into the overlay, and is disposed on unmount', () => {
    inspector.mounts.length = 0;
    const { container, unmount } = renderBoard();
    const board = container.querySelector<HTMLElement>('.board')!;
    expect(inspector.mounts).toHaveLength(1);
    expect(inspector.mounts[0]!.root, 'booted on the board itself').toBe(board);
    expect(inspector.mounts[0]!.disposed).toBe(false);

    // Live, and drawing where the contract says: hovering a card enlarges it
    // into the overlay root and nowhere else on the board.
    const overlay = board.querySelector<HTMLElement>('[data-board-overlay]')!;
    expect(overlay.children).toHaveLength(0);
    fireEvent.pointerOver(board.querySelector<HTMLElement>('[data-card-id="8"]')!, { pointerType: 'mouse' });
    expect(overlay.querySelectorAll('[data-inspect]'), 'the enlargement is in the overlay').toHaveLength(1);
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
    const items = [...container.querySelectorAll<HTMLElement>('.stack__item')];
    expect(items).toHaveLength(2);
    for (const item of items) {
      const name = item.querySelector('.card__name')!.textContent!;
      const img = item.querySelector('img');
      expect(img, `${name} on the stack has art`).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(cardImageUrl(TEST_IDS.get(name)));
      expect(ALLOWED_ART_HOSTS).toContain(new URL(img!.getAttribute('src')!).origin);
    }
    expect(container.innerHTML).not.toMatch(/url\(/);
  });

  it('draws no art for an item that names no card, and still draws the item', () => {
    const view = boardFromFixture(fixture);
    const bare: BoardView = {
      ...view,
      stack: [{ ...view.stack[0]!, sourceCard: null, sourceCardId: null, sourceName: null }],
    };
    const { container } = renderBoard(bare);
    const item = container.querySelector<HTMLElement>('.stack__item')!;
    expect(item.querySelector('.stack__art')).toBeNull();
    expect(item.querySelector('.stack__source')!.textContent).toBe('unknown source · ability');
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
    // And the OFFSET is `card.css`'s fan, the one an attachment has always been
    // drawn with: the depth drives `--pile-fan`, a step per card, and the pile
    // occupies exactly one card's box whatever it holds.
    expect(CARD_CSS).toContain("--pile-fan: var(--stack-step);");
    expect(CARD_CSS).toMatch(/\.board-card\[data-pile-size\][^{]*\{[^}]*--pile-fan/);
    expect(CARD_CSS).toMatch(/\.board-card__pile > \.board-card\[data-pile-depth='1'\]/);
  });
});

/**
 * §A.1 — the fit. The table is **960px wide at a 1280 viewport**, not 1280:
 * watchparty's roster-and-chat aside is `flex: 0 0 20rem` and pinned above
 * 767px (`apps/ui/src/chrome/chrome.css`), so the board gets 1280 − 320.
 *
 * jsdom lays nothing out, so this does the arithmetic the stylesheet does, on
 * the tokens read out of the stylesheet and the counts read off the rendered
 * markup. The same numbers were measured in a real browser at 960×705 and
 * 1046×683 while this was written; `e2e/table-fit.spec.ts` (lane B's) is where
 * they are measured on a live match.
 */
describe('a full row keeps its names legible at the 960 budget (§A.1)', () => {
  /** 1280 minus watchparty's pinned 320px aside. `chrome.css` documents both. */
  const TABLE_W = 960;
  /** The board's own height there, measured: the page header takes the rest. */
  const TABLE_H = 705;
  const px = (value: string | undefined): number => {
    const rem = /^([\d.]+)rem$/.exec(value ?? '');
    if (rem !== null) return Number(rem[1]) * 16;
    const abs = /^([\d.]+)px$/.exec(value ?? '');
    if (abs === null) throw new Error(`not a length: ${String(value)}`);
    return Number(abs[1]);
  };
  const token = (selector: string, name: string): number => px(declarationIn(selector, name));
  /** The one rule that sizes a card's column, in a hand and in a battlefield lane. */
  const GRID =
    '.seat > .zone--battlefield .zone__row > .zone__cards,\n.seat > .zone--battlefield > .zone__cards,\n.seat > .zone--battlefield .zone__tiers > .zone__cards,\n.seat[data-viewer] > .zone--hand > .zone__cards';
  /** The rule that gives a row zone its `--card-max`, shared by a battlefield and a hand. */
  const ROW_ZONE = '.seat > .zone--battlefield,\n.seat[data-viewer] > .zone--hand';

  /** Every `--rows` formula in file order: the base band, then >= 3, 4, 5, 6, 8, 10. */
  const ladder = (): { above: number; steps: number[] }[] => {
    const found = BOARD_RULES.match(/--rows: calc\([^;]+\);/g) ?? [];
    expect(found, 'the row ladder is arithmetic on `--cols`, one rule per band').toHaveLength(7);
    return found.map((rule, i) => ({
      above: [0, 3, 4, 5, 6, 8, 10][i]!,
      steps: [...rule.matchAll(/clamp\(0, var\(--cols, 0\) - (\d+), 1\)/g)].map((m) => Number(m[1]) + 1),
    }));
  };

  /**
   * A viewer's battlefield filled lane by lane, in `BOARD_ROWS` order: lands,
   * artifacts, creatures, everything else. The split is what decides whether the
   * lanes starve each other, so it is the input.
   */
  function lopsided(...want: [number, number, number, number]): BoardView {
    const base = boardFromFixture(fixture);
    const me = base.players.find((p) => p.isViewer)!;
    const seed = me.battlefield.find((c) => c.card.typeLine.includes('Land'))!;
    const kinds = [
      ['Land', 'Izzet Guildgate'],
      ['Artifact', 'Bonesplitter'],
      ['Creature — Elemental', 'Fire Urchin'],
      ['Enchantment', 'Pacifism'],
    ] as const;
    const made: BoardCard[] = [];
    let id = 50_000;
    want.forEach((n, lane) => {
      const [typeLine, name] = kinds[lane]!;
      for (let i = 0; i < n; i += 1) made.push({ ...seed, id: (id += 1), card: { ...seed.card, cardId: `w${id}`, typeLine, name } });
    });
    return { ...base, players: base.players.map((p) => (p.isViewer ? { ...p, battlefield: made } : p)) };
  }

  /**
   * What the stylesheet will draw, at `TABLE_W`: the narrowest card on the
   * viewer's battlefield, and the row count the zone settled on.
   *
   * Every number below is a token out of `board.css` or a count out of the
   * markup. It follows the boxes down: the board's padding, the seat's border
   * and padding, the left column and its gap, the zone's border, its 2px of
   * left pad and the gutter it reserves for the permanent overlays, the lane
   * gaps and each lane's own border and list padding.
   */
  function draws(container: HTMLElement) {
    const zone = container.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"]')!;
    const list = zone.querySelector<HTMLElement>(':scope > ul.zone__rows')!;
    const lanes = [...list.querySelectorAll<HTMLElement>(':scope > li.zone__row')];
    const cols = lanes.map((l) => Number(l.style.getPropertyValue('--cols')));
    const total = Number(list.style.getPropertyValue('--cols'));
    expect(total, 'the zone reports every column on it').toBe(cols.reduce((a, b) => a + b, 0));

    const boardGap = token('.board', '--board-gap');
    const seat = TABLE_W - 2 * boardGap - 2 /* the seat's own border */ - 2 * 8 /* its padding */;
    const zoneW = seat - token('.board .seat', '--who-w') - 8 /* the seat's column gap */;
    const inner = zoneW - 2 /* the zone's border */ - 2 /* its 2px of left pad */ - token('.board', '--right-gutter');

    // The zone's height, the same way down, because the row ladder reads the
    // zone's SHAPE and `--card-w` reads its height.
    const seatH = (TABLE_H - 2 * boardGap - boardGap) / 2 - 2 - 11;
    const zoneH = ((seatH - 4) * 4) / 6.6 - 2;

    const band = ladder()
      .filter((b) => inner / zoneH >= b.above)
      .at(-1)!;
    const rows = 1 + band.steps.filter((t) => total >= t).length;

    const gap = token('.seat > .zone--battlefield', '--group-gap');
    const emptyW = token('.seat > .zone--battlefield', '--group-empty-w');
    const overhead = token('.seat > .zone--battlefield', '--group-overhead');
    const cardsGap = token('.board', '--cards-gap');
    // How many columns each lane DRAWS, and — read out of the stylesheet, so
    // that reverting the budget reverts this arithmetic with it — how much width
    // each lane ASKS for. Wave 26 asked by the pile count, which is the defect.
    const drawn = cols.map((n) => Math.ceil(n / rows));
    const grow = declarationIn('.zone__row', 'flex-grow') ?? 'var(--cols, 0)';
    const share = grow.includes('--rows') ? drawn : cols;
    const grown = share.reduce((a, b) => a + b, 0);
    // Flexbox: every lane starts at its basis, an empty one is pinned to its
    // label's width, and what is left is shared out by the grow.
    const spare = inner - 3 * gap - cols.filter((n) => n === 0).length * emptyW - cols.filter((n) => n > 0).length * overhead;
    const widths = cols.map((n, i) => (n === 0 ? emptyW : overhead + (spare * share[i]!) / grown));
    const cardW = cols.map((n, i) => {
      if (n === 0) return Infinity;
      const laneInner = widths[i]! - (i === 0 ? 0 : 1) /* the lane's left rule */ - 2 * 2 /* the list's padding */;
      const even = (laneInner - (drawn[i]! - 1) * cardsGap) / drawn[i]!;
      // A column is never wider than one card and, since §A.1, never narrower
      // than a name can be read — the floor giving way to the lane's own share.
      const floor = declarationIn(GRID, 'grid-auto-columns')!.includes('--card-min') ? Math.min(token('.board', '--card-min'), even) : 0;
      return Math.max(floor, Math.min(even, token(ROW_ZONE, '--card-max')));
    });
    return { rows, narrowest: Math.min(...cardW), cardW, widths };
  }

  /**
   * The floor and the budget, as declarations — so reverting either hunk fails
   * here and not only in a browser.
   */
  it('floors a column at a legible width and takes the lane’s share from the COLUMNS it draws', () => {
    expect(declarationIn('.board', '--card-min'), 'the floor is a token of the board, beside the gutter').toBe('2.75rem');
    const columns = declarationIn(GRID, 'grid-auto-columns')!;
    expect(columns, 'a column is never narrower than a card whose name can be read').toContain('var(--card-min)');
    expect(columns, 'nor wider than one card').toContain('var(--card-w)');
    expect(columns, 'and the floor gives way to the lane’s own share rather than overflowing it').toContain('100cqw');
    expect(columns, 'the wave-26 rule let it go on shrinking to nothing').not.toContain('minmax(0,');
    // A lane asks for the COLUMNS it draws, `ceil(--cols / --rows)`. Wave 26 grew
    // it by its piles, so a lane on two rows starved the lane beside it.
    expect(declarationIn('.zone__row', 'flex-grow')).toBe('round(up, var(--cols, 0) / var(--rows), 1)');
    // And the row count is ONE decision per battlefield, taken on the zone's own
    // shape — not four lanes disagreeing. The hand is one list and keeps its own,
    // and so (item 11) does the single-layout default's one lane.
    expect(
      declarationIn('.zone__rows,\n.zone--hand > .zone__cards,\n.seat > .zone--battlefield > .zone__cards', '--rows'),
    ).toMatch(/^calc\(1 \+ clamp\(/);
    expect(BOARD_RULES, 'nothing counts cards with a `:has()` ladder any more').not.toContain('nth-child');
  });

  it('draws the report’s own row — sixteen lands beside four creatures — with every name readable', () => {
    const { container } = renderBoard(lopsided(16, 0, 4, 0));
    const got = draws(container);
    expect(got.rows, 'twenty columns on a zone this shape is two rows').toBe(2);
    // The committed screenshot `docs/planning/wave26-question-panel-1280x800.png`
    // is this row: the creatures lane came out at 27px, where "Izzet Guildgate"
    // is seven lines of one letter. Measured in chromium at 960×705 after the
    // fix: 56px in the lands lane and 57px in the creatures lane.
    expect(Math.round(got.narrowest), 'the narrowest card on the battlefield').toBeGreaterThanOrEqual(
      px(declarationIn('.board', '--card-min')),
    );
    expect(Math.round(got.narrowest)).toBeLessThan(70);
  });

  it('holds for every split a real game produces, and puts every lane at one width', () => {
    const splits: [number, number, number, number][] = [
      [9, 2, 8, 1],
      [16, 0, 4, 0],
      [5, 1, 4, 1],
      [12, 2, 5, 1],
      [20, 4, 12, 2],
    ];
    for (const want of splits) {
      const [lands, artifacts, creatures, other] = want;
      const total = lands + artifacts + creatures + other;
      const { container } = renderBoard(lopsided(...want));
      const got = draws(container);
      const drawn = got.cardW.filter((w) => w !== Infinity);
      expect(Math.round(got.narrowest), `the split ${want.join('/')}`).toBeGreaterThanOrEqual(
        // Past the point where the zone can hold them all at the floor the floor
        // gives way — on purpose, because a clipped card is worse than a small
        // one. Twenty lands and twelve creatures is already far past a real game.
        total > 30 ? 36 : px(declarationIn('.board', '--card-min')),
      );
      /*
       * One width, whatever the split — which is what taking the share from the
       * columns buys and what wave 26 could not do. Chromium measured 60/61/60/61
       * for this split at 960 and 59/59/59/59 at 1046; wave 26 measured
       * 59/33/61/35. The few pixels of slack here are the lane's flat
       * `--group-overhead` basis, which a one-column lane spends on one card and
       * an eight-column lane spreads over eight.
       */
      expect(Math.max(...drawn) - Math.min(...drawn), `${want.join('/')}: every lane draws one card width`).toBeLessThan(5);
      cleanup();
    }
  });
});

/* ── §A.15 — a card's state is DRAWN, not written ─────────────────────── */

/**
 * Wave 28's headline. The operator, 2026-09-28: *"+1/+1 looks really ugly, we
 * need a better way to show that. actually all the shitty text you have written
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
    const { container } = renderBoard(withState({ attacking: true, tapped: false }));
    expect(card(container).getAttribute('data-attacking')).toBe('true');
    expect(card(container).hasAttribute('data-tapped'), 'and Forge’s own tapped is untouched').toBe(false);
    // One rule turns either, so a card that is both is turned once.
    const rule = /\.board-card:is\(\[data-tapped\], \[data-attacking\]\) \.board-card__face > \.card \{([^}]*)\}/.exec(
      withoutComments(CARD_CSS),
    );
    expect(rule, 'the turn is one rule for both').not.toBeNull();
    expect(rule![1]).toMatch(/rotate\(90deg\)/);
  });

  it('summoning sickness desaturates the card and carries a drawn mark, never an outline', () => {
    const { container } = renderBoard(withState({ summoningSick: true }));
    expect(card(container).getAttribute('data-sick')).toBe('true');
    const mark = card(container).querySelector<HTMLElement>('.board-card__mark[data-mark="sick"]')!;
    expect(mark, 'a mark of its own').not.toBeNull();
    expect(mark.querySelector('svg.board-card__mark-art'), 'drawn, not a glyph a font might not have').not.toBeNull();
    expect(mark.textContent, 'and the word is still said, for anything that cannot see it').toBe('summoning sick');
    // The treatment is a FILTER — a channel no outline uses — and it is not the accent.
    const sick = /\.board-card\[data-sick\] > \.board-card__face \{([^}]*)\}/.exec(withoutComments(CARD_CSS));
    expect(sick, 'the sick rule').not.toBeNull();
    expect(sick![1]).toMatch(/filter:\s*grayscale/);
    expect(sick![1], 'and it is not a fourth outline').not.toMatch(/outline|--accent/);
  });

  it('blocking and token are corner marks, and neither is drawn in the accent', () => {
    const { container } = renderBoard(withState({ blocking: true, token: true }));
    const marks = [...card(container).querySelectorAll<HTMLElement>('.board-card__mark')].map((m) => m.dataset.mark);
    expect(marks).toEqual(['blocking', 'token']);
    expect(card(container).getAttribute('data-token')).toBe('true');
    // The three outlines a card can already wear belong to the two gesture states
    // and nothing here may add a fourth colour to that conversation.
    const layer = withoutComments(CARD_CSS).slice(withoutComments(CARD_CSS).indexOf('.board-card__marks {'));
    expect(layer, 'the state layer never draws in the accent').not.toMatch(/\.board-card__mark[^}]*--accent/);
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
    expect(badge.querySelector('[data-pt-of="toughness"]')!.getAttribute('data-pt-state')).toBe('hurt');
    cleanup();
    // A land: no power, no toughness, and damage marked on it anyway.
    const land = renderBoard(withState({ damage: 3 }, 25));
    const only = card(land.container, 25).querySelector<HTMLElement>('.board-card__pt')!;
    expect(only, 'a card with no P/T still shows its damage').not.toBeNull();
    expect(only.dataset.damage).toBe('3');
    expect(only.getAttribute('aria-label')).toBe('3 damage marked');
    expect(only.textContent, 'the number, with the hurt marker — not the word').toBe('▼3');
  });

  it('nothing the state layer draws can change a card’s box', () => {
    const css = withoutComments(CARD_CSS);
    for (const sel of ['.board-card__marks', '.board-card__counters']) {
      expect(declarationInCss(css, sel, 'position'), `${sel} is out of flow`).toBe('absolute');
      expect(declarationInCss(css, sel, 'pointer-events'), `${sel} eats no click`).toBe('none');
    }
  });

  it('the state layer is drawn on the battlefield and nowhere else', () => {
    const view = withState({ summoningSick: true, token: true, counters: [{ name: '+1/+1', count: 1 }] });
    const sicken = (cards: BoardCard[]) => cards.map((c) => ({ ...c, summoningSick: true, token: true, counters: [{ name: '+1/+1', count: 1 }] }));
    const { zone } = renderBoard({
      ...view,
      players: view.players.map((p) =>
        !p.isViewer ? p : { ...p, hand: p.hand === null ? null : sicken(p.hand), graveyard: sicken(p.graveyard) },
      ),
    });
    expect(zone(0, 'battlefield').querySelectorAll('.board-card__marks').length).toBeGreaterThan(0);
    for (const where of ['hand', 'graveyard', 'exile'] as const) {
      expect(zone(0, where).querySelectorAll('.board-card__marks, .board-card__counters'), where).toHaveLength(0);
    }
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

  it('draws nothing when the stack is empty, and the rule is keyed on the LIST being empty', () => {
    // The operator: *"the stack doesn't need to show if its empty."*
    const hidden = /\.stack:has\(> \.stack__items:empty\) \{([^}]*)\}/.exec(BOARD_RULES);
    expect(hidden, 'the empty-stack rule').not.toBeNull();
    expect(hidden![1]).toMatch(/visibility:\s*hidden/);
    /*
     * `visibility`, not `display` — the BOX has to stay the box. That is the
     * older, absolute rule (*"the entire canvas must be fully static at all
     * times"*) and it is what keeps `e2e/table-fit.spec.ts`'s four stack shots
     * comparable; and the condition is the list rather than a React-written
     * count, so that spec's DOM probe makes the stack appear by filling it.
     */
    expect(hidden![1], 'the slot is not taken away').not.toMatch(/display:\s*none/);
    const { container } = renderBoard({ ...base, stack: [] });
    expect(container.querySelector('[data-zone="stack"] > ol.stack__items')!.children).toHaveLength(0);
  });

  it('is roomy by default and compact while a question is open', () => {
    // *"the stack should allow to be bigger unless there is a decision waiting"*.
    const roomy = declarationIn('.board', '--mid-h')!;
    const asked = declarationIn('.board', '--mid-h-asked')!;
    expect(Number.parseFloat(roomy), 'the roomy band is the bigger one').toBeGreaterThan(Number.parseFloat(asked));
    expect(declarationIn('.board__mid[data-question]', '--mid-h')).toBe('var(--mid-h-asked)');
    // And the card on the stack follows the band, so a roomy band draws a bigger one.
    expect(declarationIn('.stack__items', '--stack-card-w')).toContain('var(--mid-h)');

    const quiet = renderBoard(base, noInteraction());
    expect(quiet.container.querySelector<HTMLElement>('.board__mid')!.hasAttribute('data-question')).toBe(false);
    cleanup();
    const asking = renderBoard(base, noInteraction({ questionOpen: true }));
    expect(asking.container.querySelector<HTMLElement>('.board__mid')!.getAttribute('data-question')).toBe('true');
  });
});

describe('§A.9 — a pile’s cards expand to fit their box', () => {
  it('sizes a graveyard card from the box rather than from a fixed width', () => {
    // *"the graveyard is unecessarily small, i think the cards can expand to fit
    // the width of that box"*.
    /*
     * Both piles share one rule, so it is addressed by its LAST selector line —
     * which is how `declarationIn` reads a multi-selector rule, and the two lines
     * are asserted to be together so "the graveyard's rule" cannot drift from
     * "exile's rule" without this failing.
     */
    expect(BOARD_RULES).toContain('.board .seat .zone--graveyard,\n.board .seat .zone--exile {');
    expect(BOARD_RULES).toContain('.board .seat .zone--graveyard .zone__cards,\n.board .seat .zone--exile .zone__cards {');
    expect(declarationIn('.board .seat .zone--exile', 'container-type'), 'the pile is a size container').toBe(
      'inline-size',
    );
    expect(declarationIn('.board .seat .zone--exile .zone__cards', '--pile-card-w')).toBe('100cqw');
    expect(declarationIn('.board .seat .zone--exile .zone__cards', '--card-w')).toBe('var(--pile-card-w)');
    expect(declarationIn('.board .seat .zone--exile .zone__cards', 'justify-content'), 'and it fills it').toBe(
      'stretch',
    );
    // The fixed width it replaced is gone outright, not merely unused.
    expect(BOARD_RULES, 'the fixed pile width is gone').not.toContain('--pile-w:');
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
  it('the single list shares the lanes’ own sizing grid — same --card-max, same --rows device, not the hand’s fallback size', () => {
    const gridSelector =
      '.seat > .zone--battlefield .zone__row > .zone__cards,\n.seat > .zone--battlefield > .zone__cards,\n.seat > .zone--battlefield .zone__tiers > .zone__cards,\n.seat[data-viewer] > .zone--hand > .zone__cards';
    expect(
      declarationIn(gridSelector, 'display'),
      'the single list is in the SAME shared grid rule as the lanes and the hand',
    ).toBe('grid');
    expect(declarationIn(gridSelector, 'grid-auto-flow')).toBe('column');
    expect(declarationIn(gridSelector, '--card-w')).toContain('var(--card-max)');
    expect(
      declarationIn('.seat > .zone--battlefield .zone__tiers > .zone__cards', '--card-slack'),
      'the tier lists have their own slack override — they are not silently falling back to the hand’s',
    ).toBe('6px');
    // Two tiers, so a card is sized for two rows of cards in the zone's own height.
    expect(declarationIn('.zone__tiers', '--rows'), 'a card is sized for TWO tiers in the zone’s height').toBe('2');
    expect(declarationIn('.zone__tiers', 'grid-template-rows')).toBe('repeat(2, minmax(0, 1fr))');
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
  const BOARD_TSX = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'Board.tsx'), 'utf8');

  it('P3: no text node says (you), the life sits under the mark, and the name is the seat’s own', () => {
    const { container, seat, view } = renderBoard();
    const me = view.players.find((p) => p.isViewer)!;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      expect(n.textContent, 'no visible (you) anywhere on the board').not.toContain('(you)');
    }
    // Still there for a screen reader.
    expect(seat(me.id).getAttribute('aria-label')).toBe(`${me.name} (you)`);
    // The life is the face's last child after the mark, in flow: the card.css rule
    // that used to lay it over the avatar is overridden to `static` in the seat.
    const hit = seat(me.id).querySelector('.face__hit')!;
    expect([...hit.children].map((c) => (c.getAttribute('class') ?? '').split(' ')[0])).toEqual(['face__art', 'face__life']);
    expect(declarationInCss(CARD_CSS, '.seat__ident .face__life', 'position')).toBe('static');
    expect(declarationInCss(CARD_CSS, '.seat__ident .face__art', 'width')).toBe('var(--face-w)');
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
    // Wave 31's `4fr / 1fr` inside the hand's cell is gone, and so is the idea of a figure.
    const rows = declarationIn('.seat__piles', 'grid-template-rows')!;
    expect(rows, 'the graveyard row is `1fr`, not a ratio of a ratio').toBe('minmax(0, 1fr) auto');
    expect(BOARD_RULES).not.toMatch(/\d+(?:\.\d+)?fr\s+minmax\(0,\s*1fr\)/);
    expect(BOARD_RULES).not.toMatch(/\b[0-9.]+%\s+of the (?:column|cell)/);
    // The counts spend none of it: they are in the bar, on one row, in their own track.
    const { seat } = renderBoard();
    expect(seat(0).querySelector('.seat__piles [data-testid="hand-count"]')).toBeNull();
    expect(declarationIn('.board .seat__counts', 'flex-direction')).toBe('row');
    expect(declarationIn('.board .seat', '--counts-h'), 'a flag arriving mid-game moves nothing under it').toBe('2.2rem');
  });

  it('P5: Regroup is gone from the markup, the stylesheet and the source', () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-arrange-reset], .seat__regroup')).toBeNull();
    expect(container.textContent).not.toMatch(/Regroup/i);
    expect(BOARD_RULES).not.toContain('seat__regroup');
    const code = BOARD_TSX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/regroup\s*\(|withoutSeat|ARRANGE_SLOTS|data-arrange-reset/);
  });

  it('P9: a stack effect is read at 13px in an item as wide as the band, and the band is one size per state, not per item', () => {
    expect(Number.parseFloat(declarationIn('.stack__text', 'font-size')!)).toBeGreaterThanOrEqual(13);
    expect(declarationIn('.stack__item', 'flex')).toBe('0 0 100%');
    // The band is sized by state (`--mid-h`, `--mid-h-asked`) and nothing else:
    // no rule of the stack sizes itself by what it holds.
    expect(Number.parseFloat(declarationIn('.board', '--mid-h')!)).toBeGreaterThanOrEqual(12);
    expect(declarationIn('.board__mid', 'height')).toBe('var(--mid-h)');
    // The card cannot crowd the text out: its width is capped.
    expect(declarationIn('.stack__items', '--stack-card-w')).toContain('min(3.5rem');
  });

  it('P6: the canvas has no outer border or inset shadow, and board.css has no hex literal', () => {
    expect(declarationIn('.seat > .zone--battlefield', 'border')).toBeUndefined();
    expect(declarationIn('.seat > .zone--battlefield', 'box-shadow')).toBeUndefined();
    expect(BOARD_RULES.match(/#[0-9a-fA-F]{3,8}\b/g), 'the colour pie comes off the --c-* tokens').toBeNull();
    for (const c of ['white', 'blue', 'black', 'red', 'green']) {
      expect(BOARD_RULES).toContain(`var(--c-${c})`);
    }
  });
});

/* ── wave 32 lane B: the board surface, and a drag that is ours ───────── */

describe('wave 32 §B — the surface: Q2, Q13, Q1b, Q16, the stack', () => {
  const view = boardFromFixture(fixture);

  it('Q2: the opponent’s hand is drawn at the card size of yours, from the same tokens', () => {
    const theirs = '.seat:not([data-viewer]) > .zone--hand';
    const mine = '.seat[data-viewer] > .zone--hand';
    // The cap and the slack are the viewer's own, not a size of their own.
    expect(declarationIn(theirs, '--card-max')).toBe(declarationIn(mine, '--card-max'));
    expect(declarationIn(theirs, '--card-slack')).toBe(declarationIn(`${mine} > .zone__cards`, '--card-slack'));
    // `--card-w` is derived from the zone's height the way the hand's is, not a fixed 4rem.
    const w = declarationIn(theirs, '--card-w')!;
    expect(w).toContain('var(--card-max)');
    expect(w).toContain('100cqh');
    expect(w).not.toContain('4rem');
    expect(declarationIn(theirs, 'container')).toBe('row-zone / size');
    // A back is a whole column of that grid, and the grid shrinks to the width down to the same floor.
    expect(declarationIn('.seat:not([data-viewer]) > .zone--hand > .card-backs', '--card-back-w')).toBe('100%');
    expect(declarationIn('.seat:not([data-viewer]) > .zone--hand > .card-backs', 'grid-auto-columns')).toContain(
      'var(--card-min)',
    );
  });

  it('stack: a long effect scrolls INSIDE the item — the band’s row is bounded, so nothing is clipped (real-Forge e2e)', () => {
    // An `auto` row left `.stack__items`' `height: 100%` with nothing to resolve
    // against, the item grew past the band, and `overflow: hidden` cut both ends.
    expect(declarationIn('.stack', 'grid-template-rows'), 'one row, the band’s own height').toBe('minmax(0, 1fr)');
    expect(declarationIn('.stack__what', 'min-height')).toBe('0');
    expect(declarationIn('.stack__what', 'max-height'), 'bounded by the item').toBe('100%');
    expect(declarationIn('.stack__what', 'overflow-y'), 'the last resort is a scroll, not a clip').toBe('auto');
    expect(declarationIn('.stack__item', 'overflow')).toBe('hidden');
  });

  it('stack: under a question the effect gets the band’s whole width — no caption, no art, name above the text', () => {
    expect(declarationIn('.board__mid[data-question] .stack', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationIn('.board__mid[data-question] .stack > .zone__head,\n.board__mid[data-question] .stack__art', 'display')).toBe('none');
    expect(declarationIn('.board__mid[data-question] .stack__what', 'flex-direction')).toBe('row');
    expect(declarationIn('.board__mid[data-question] .stack__what', 'flex-wrap')).toBe('wrap');
    expect(declarationIn('.board__mid[data-question] .stack__text', 'flex')).toBe('1 0 100%');
    // Chosen by question state alone, never by what the stack holds.
    expect(BOARD_RULES).not.toMatch(/\.stack[^{]*:has\([^)]*nth/);
  });

  it('Q2: the strip tells the stylesheet how many backs it holds, as a hand of faces does', () => {
    const { zone } = renderBoard(view);
    const backs = zone(1, 'hand').querySelector<HTMLElement>('ul.card-backs')!;
    const them = view.players.find((p) => !p.isViewer)!;
    expect(backs.style.getPropertyValue('--cols')).toBe(String(them.handCount));
    expect(backs.querySelectorAll('[data-card-back]')).toHaveLength(them.handCount);
  });

  it('Q13: power/toughness sits in the card’s BOTTOM-right corner, clear of the counters and the marks', () => {
    expect(declarationInCss(CARD_CSS, '.board-card__pt', 'bottom')).toBe('2px');
    expect(declarationInCss(CARD_CSS, '.board-card__pt', 'top'), 'it no longer hangs off the top').toBeUndefined();
    expect(declarationInCss(CARD_CSS, '.board-card__pt', 'right')).toContain('--pile-fan');
    // The other two corners it must not collide with.
    expect(declarationInCss(CARD_CSS, '.board-card__counters', 'left')).toBe('2px');
    expect(declarationInCss(CARD_CSS, '.board-card__marks', 'top')).toBe('2px');
  });

  it('Q1b: whose turn it is is a ring round the avatar, and the words are gone', () => {
    const active: BoardView = { ...view, players: view.players.map((p, i) => ({ ...p, isActive: i === 0 })) };
    const { container } = renderBoard(active);
    const faces = [...container.querySelectorAll<HTMLElement>('[data-player-face]')];
    expect(faces.filter((f) => f.dataset.active === 'true')).toHaveLength(1);
    const ring = declarationInCss(CARD_CSS, '.face[data-active] .face__art', 'box-shadow')!;
    expect(ring, 'a ring, in the accent').toContain('var(--accent)');
    expect(declarationInCss(CARD_CSS, '.face[data-active] .face__art', 'border-radius')).toBe('50%');
    expect(container.textContent).not.toMatch(/their turn/i);
  });

  it('Q16: card badges sit on the shared scale, inside a stacking context of the card’s own', () => {
    for (const sel of ['.board-card__pt', '.board-card__marks', '.board-card__counters']) {
      expect(declarationInCss(CARD_CSS, sel, 'z-index'), sel).toBe('var(--z-card-badge, 1)');
    }
    expect(declarationInCss(CARD_CSS, '.board-card', 'isolation')).toBe('isolate');
    // No literal that outranks the scale survives in the card's own sheet.
    expect(withoutComments(CARD_CSS)).not.toMatch(/z-index:\s*(?:[2-9]|\d\d+)\s*;/);
    // The pile is behind its base card's face, inside the same context.
    expect(declarationInCss(CARD_CSS, '.board-card__pile > .board-card', 'z-index')).toBe('calc(var(--at) * -1)');
    // And what the card must sit UNDER is on the overlay rung of the same scale.
    expect(declarationIn('.board__mid', 'z-index')).toBe('var(--z-overlay, 20)');
    expect(declarationIn('.staging', 'z-index')).toBe('var(--z-overlay, 20)');
  });

  it('stack: a question moves the band’s top up and gives it room for a long effect; the band is sized by state alone', () => {
    expect(Number.parseFloat(declarationIn('.board', '--mid-h-asked')!), 'roomier than w31’s 5.75rem').toBeGreaterThanOrEqual(8.5);
    expect(declarationIn('.board__mid[data-question]', '--mid-h')).toBe('var(--mid-h-asked)');
    expect(declarationIn('.board__mid[data-question]', 'top'), 'out of flow, so moving it moves no track').toBe('var(--board-gap)');
    expect(declarationIn('.board__mid', 'position')).toBe('absolute');
    const { container } = renderBoard(withStack(view, 5), { ...spyInteraction([]).interaction, questionOpen: true });
    expect(container.querySelector('[data-testid="board-mid"]')!.hasAttribute('data-question')).toBe(true);
    // The band's height never reads how many items there are.
    expect(BOARD_RULES).not.toMatch(/--mid-h[^;]*(?:--items|--stack-n|--count)/);
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

  it('there is no direction rule that reads a row right to left', () => {
    // The brief's "found, unverified": `board.css` was checked for `direction` / `rtl` / `row-reverse` and has none.
    expect(BOARD_RULES).not.toMatch(/direction:\s*rtl|flex-direction:\s*row-reverse|justify-content:\s*(?:end|flex-end)\s*;\s*\n\s*\}\s*\n\s*\.zone__cards/);
    expect(declarationIn('.seat > .zone--battlefield .zone__tiers > .zone__cards', 'justify-content')).toBeUndefined();
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

  it('snapTo: the nearest place in a row — before, after, the end, and the thirds of a card', () => {
    expect(snapTo(slots, 15, 50)?.target, 'left half of a card: before it').toEqual({ kind: 'before', id: 1 });
    expect(snapTo(slots, 65, 50)?.target, 'right half of the first: in front of the second').toEqual({ kind: 'before', id: 2 });
    expect(snapTo(slots, 135, 50)?.target, 'right half of the last: the end').toEqual({ kind: 'end' });
    expect(snapTo(slots, 300, 50)?.target, 'past the last card: the end').toEqual({ kind: 'end' });
    expect(snapTo(slots, 40, 14)?.target, 'top third: on top of it').toEqual({ kind: 'stack', id: 1, onTop: true });
    expect(snapTo(slots, 40, 86)?.target, 'bottom third: under it').toEqual({ kind: 'stack', id: 1, onTop: false });
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
    expect(container.querySelector('.seat[data-viewer] [data-arrange-slot="back"]')!.getAttribute('data-arrange-target')).toBe('before');
    // Nothing has moved yet: the drag is a preview until it is let go.
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['8', '24', '6', '25']);

    release();
    expect(board.querySelector('[data-arrange-ghost], [data-arrange-indicator]'), 'ghost and bar are gone').toBeNull();
    expect(board.hasAttribute('data-arrange-active')).toBe(false);
    expect(container.querySelectorAll('[data-arrange-dragging], [data-arrange-target]'), 'and every mark').toHaveLength(0);
    // And the card went where the bar said.
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['24', '8', '6', '25']);
  });

  it('the ghost follows the pointer, and the indicator names stack-top, stack-bottom and end as the pointer moves', () => {
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
    move(at(25).right + 200, at(25).top + 40);
    expect(bar.dataset.arrangeKind).toBe('end');
    move(500, 600);
    expect(bar.hasAttribute('hidden'), 'far from every slot there is no target').toBe(true);
    fireEvent.pointerUp(window, { ...POINTER, clientX: 500, clientY: 600 });
    expect(container.querySelector('[data-arrange-ghost]')).toBeNull();
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li')].map((c) => (c as HTMLElement).dataset.cardId), 'released nowhere: nothing moved').toEqual(['8', '24', '6', '25']);
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
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['25', '8', '24', '6']);
    expect(declarationIn('.board .seat .board-card[draggable=\'true\']', 'touch-action'), 'or the browser claims it to scroll').toBe('none');
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
      expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li')].map((c) => (c as HTMLElement).dataset.cardId), how).toEqual(['8', '24', '6', '25']);
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
    expect([...container.querySelectorAll('.seat[data-viewer] [data-tier="back"] > li')].map((c) => (c as HTMLElement).dataset.cardId)).toEqual(['8', '24', '6', '25']);
  });

  it('cancels the browser’s own drag, and keeps no HTML5 drag-and-drop in the source', () => {
    const { container } = renderBoard(view, undefined, 'single');
    const li = container.querySelector<HTMLElement>('.seat[data-viewer] [data-card-id="8"]')!;
    expect(li.getAttribute('draggable'), 'still the seam the gestures layer stands down on').toBe('true');
    // `fireEvent` returns false when the event was cancelled: the browser's ghost never starts.
    expect(fireEvent.dragStart(li), 'dragstart is cancelled').toBe(false);
    const source = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'Board.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/dataTransfer|onDrop\b|onDragOver\b|onDragEnd\b|dropEffect|effectAllowed|DragEvent/);
  });

  it('a hand drag snaps within the hand only: over the battlefield a hand card is nowhere', () => {
    const { container } = renderBoard(view, undefined, 'single');
    const hand = view.players.find((p) => p.isViewer)!.hand!.map((c) => c.id);
    dragCard(container, hand[0]!, { slot: 'front' });
    expect([...container.querySelectorAll('.seat[data-viewer] [data-zone="hand"] .board-card')].map((c) => Number((c as HTMLElement).dataset.cardId))).toEqual(hand);
    dragCard(container, hand[0]!, { slot: 'hand' });
    expect([...container.querySelectorAll('.seat[data-viewer] [data-zone="hand"] .board-card')].map((c) => Number((c as HTMLElement).dataset.cardId))).toEqual([...hand.slice(1), hand[0]!]);
  });
});
