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
import { artIdIndex, CUBE_ART_IDS, scryfallIdFor, toBoardView, type ArtIdIndex, type BoardView } from './adapter.ts';
import { Board, forgetArrangements, type BoardInteraction } from './Board.tsx';
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

function renderBoard(view: BoardView = boardFromFixture(fixture), interaction?: BoardInteraction) {
  const utils = render(createElement(Board, interaction === undefined ? { view } : { view, interaction }));
  const seat = (id: number) => utils.container.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${id}"]`)!;
  const zone = (id: number, name: string) => seat(id).querySelector<HTMLElement>(`[data-zone="${name}"]`)!;
  const cardNames = (el: HTMLElement) => [...el.querySelectorAll('.card__name')].map((n) => n.textContent);
  /** A battlefield row, by the name `Board.tsx` puts in `data-board-row`. */
  const row = (id: number, name: string) => zone(id, 'battlefield').querySelector<HTMLElement>(`[data-board-row="${name}"]`)!;
  /** The ids a row draws, in the order it draws them. */
  const rowIds = (id: number, name: string) =>
    [...row(id, name).querySelectorAll<HTMLElement>('.board-card')].map((c) => Number(c.dataset.cardId));
  return { ...utils, view, seat, zone, cardNames, row, rowIds };
}

/**
 * Forge's own controls are the cards and the seats; `Regroup` is ours and
 * answers nothing (`Board.tsx`). The assertions about what Forge made
 * clickable count the buttons that are Forge's.
 */
const forgeButtons = (container: HTMLElement) => container.querySelectorAll('button:not([data-arrange-reset])');

describe('turn and phase', () => {
  it('shows the turn, the phase and whose turn it is', () => {
    const { getByTestId } = renderBoard();
    expect(getByTestId('turn').textContent).toBe('Turn 14');
    expect(getByTestId('phase').textContent).toBe('Main 1');
    expect(getByTestId('phase').dataset.phase).toBe('MAIN1');
    expect(getByTestId('active-player').textContent).toBe('Bob (Capturing)’s turn');
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

  it('counts libraries', () => {
    const { seat } = renderBoard();
    expect(within(seat(0)).getByTestId('library-count').textContent).toBe('library 46');
    expect(within(seat(1)).getByTestId('library-count').textContent).toBe('library 47');
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

  it('marks tapped permanents in words', () => {
    const { zone } = renderBoard();
    const tapped = zone(1, 'battlefield').querySelectorAll('[data-tapped]');
    // Mountain 87, Mountain 78, Vulshok War Boar 99.
    expect(tapped).toHaveLength(3);
    expect(within(tapped[2] as HTMLElement).getByText('tapped')).toBeTruthy();
  });

  it('reports summoning sickness only for creatures on the battlefield', () => {
    // Forge's raw `Sickness` is true on most cards in hand and graveyard too.
    const { container, zone } = renderBoard();
    expect(zone(0, 'hand').textContent).not.toContain('summoning sick');
    expect(zone(0, 'graveyard').textContent).not.toContain('summoning sick');
    expect(container.querySelectorAll('.board-card__chip').length).toBeGreaterThan(0);
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
      // The count is the label, not a sentence: "2 cards, hidden" is gone.
      expect(hand.textContent).toBe('Hand 2');
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

function spyInteraction(selectable: number[], selectablePlayers: number[] = []) {
  const onSelectCard = vi.fn<(id: number) => void>();
  const onSelectPlayer = vi.fn<(id: number) => void>();
  const interaction: BoardInteraction = {
    selectable: new Set(selectable),
    selectablePlayers: new Set(selectablePlayers),
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
    // Ours is still there: it answers nothing and is not Forge's to enable.
    expect(container.querySelectorAll('[data-arrange-reset]')).toHaveLength(1);
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

/* ── our words, not their marks ────────────────────────────────────────── */

describe('marks', () => {
  it('writes {T} as TAP in text the board draws', () => {
    const view = boardFromFixture(fixture);
    const withTap: BoardView = { ...view, stack: [{ ...view.stack[0]!, description: '{T}: Add one mana.' }] };
    const { container } = renderBoard(withTap);
    const text = container.querySelector('.stack__text')!.textContent;
    expect(text).toBe('TAP: Add one mana.');
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
 * One declaration out of a rule in `board.css`, so a regression reads as itself.
 *
 * `selector` has to be a whole selector LINE, which is how a rule with several
 * selectors is addressed by any one of them. More than one rule can therefore
 * carry the line — `.zone__cards`'s shared sizing rule and the per-zone rule
 * that gives it a `--card-slack` are two such — so the blocks are read in file
 * order and the LAST one declaring the property wins, which for rules of equal
 * specificity is also what the cascade does.
 */
function declarationIn(selector: string, property: string): string | undefined {
  const blocks = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)^\\}`, 'gm');
  const declares = new RegExp(`(?:^|;|\\{)\\s*${property}:([^;]+);`, 'm');
  let found: string | undefined;
  for (const block of BOARD_CSS.matchAll(blocks)) {
    const value = declares.exec(block[1]!)?.[1]?.replace(/\s+/g, ' ').trim();
    if (value !== undefined) found = value;
  }
  return found;
}

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
      'them/battlefield',
      'them/graveyard',
      'them/exile',
      'them/hand',
      'table/stack',
      'you/battlefield',
      'you/graveyard',
      'you/exile',
      'you/hand',
    ]);
    for (const z of zones) {
      expect(z.querySelector(':scope > ul, :scope > ol'), `${z.dataset.owner} ${z.dataset.zone} still has its list`).not.toBeNull();
      expect(z.dataset.count).toBe('0');
    }
  });

  it('lays the board and the seats out in named tracks, not in their content', () => {
    expect(declarationIn('.board', 'grid-template-rows')).toBe('var(--bar-h) minmax(0, 1fr) var(--mid-h) minmax(0, 1.4fr)');
    /*
     * A seat is two card rows and no head row: the furniture is a vertical bar
     * in a fixed COLUMN spanning both (§C.3), so nothing about it is sized by
     * what it holds and the head row's height went to the battlefields.
     */
    expect(declarationIn('.board .seat', 'grid-template-columns')).toBe('var(--who-w) minmax(0, 1fr) auto');
    expect(declarationIn('.board .seat', 'grid-template-rows')).toBe('minmax(0, 4fr) minmax(0, 2.6fr)');
    expect(declarationIn('.board .seat:not([data-viewer])', 'grid-template-rows')).toBe('var(--opp-hand-h) minmax(0, 1fr)');
    expect(BOARD_CSS, 'the head row is gone, token and all').not.toContain('--seat-head-h');
    /*
     * And the bar itself is two fixed tracks with the avatar block in the seat's
     * OUTER one — `auto` first for the opponent (the top of the board), `auto`
     * last for the viewer (the bottom). That is what keeps wave 20's faces at
     * opposite ends of the canvas through §C.3's move, and what
     * `e2e/table-fit.spec.ts` measures as "their face is in the top third".
     */
    expect(declarationIn('.board .seat__who', 'grid-template-rows')).toBe('auto minmax(0, 1fr)');
    expect(declarationIn('.board .seat[data-viewer] .seat__who', 'grid-template-rows')).toBe('minmax(0, 1fr) auto');
    expect(declarationIn('.board .seat[data-viewer] .seat__ident', 'grid-row')).toBe('2');
    expect(declarationIn('.board .seat[data-viewer] .seat__counts', 'grid-row')).toBe('1');
    // The faces left the centre band, so the stack has all of it.
    expect(declarationIn('.board__mid', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(BOARD_CSS).not.toContain('--faces-w');
    expect(declarationIn('.seat__piles', 'grid-template-rows')).toBe('minmax(0, 2fr) minmax(0, 1fr)');
    // The bar spans both of the seat's card rows, on both sides of the table,
    // so neither zone loses a row to it and both zones keep the same box.
    expect(declarationIn('.board .seat', 'grid-template-areas')).toBe("'who field piles' 'who hand piles'");
    expect(declarationIn('.board .seat:not([data-viewer])', 'grid-template-areas')).toBe("'who hand piles' 'who field piles'");
    /*
     * Every label is a horizontal strip in a FIXED track (§C.1) — the zone's own
     * across its slot, a lane's across the lane — and `--card-slack` owes back
     * every strip between a list's container and its cards, or a two-row lane
     * computes a card taller than the room under its own label and has to
     * scroll. That is the one way un-rotating a label can break the fit.
     */
    expect(declarationIn('.seat[data-viewer] > .zone--hand', 'grid-template-rows')).toBe('var(--zone-head-h) minmax(0, 1fr)');
    expect(declarationIn('.zone__row', 'grid-template-rows')).toBe('var(--row-head-h) minmax(0, 1fr)');
    expect(declarationIn('.seat[data-viewer] > .zone--hand > .zone__cards', '--card-slack')).toBe(
      'calc(8px + var(--zone-head-h) + var(--zone-head-gap))',
    );
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
    const tapped = /\.board-card\[data-tapped\] \.board-card__face > \.card \{[^}]*rotate\(90deg\)/;
    expect(tapped.test(withoutComments(CARD_CSS)), 'and it is on the tapped card’s own rule').toBe(true);
  });

  it('draws every zone and lane label horizontally, with its count', () => {
    const { container, zone } = renderBoard();
    const board = container.querySelector<HTMLElement>('.board')!;
    // The labels the operator named, by the zones they head. Each is one
    // element with the label and the count in it, and nothing rotates it.
    const heads = [
      [zone(0, 'battlefield').querySelector<HTMLElement>(':scope > .zone__gutter > .zone__head')!, 'Battlefield'],
      [zone(0, 'hand').querySelector<HTMLElement>(':scope > .zone__head')!, 'Hand'],
      [zone(0, 'graveyard').querySelector<HTMLElement>(':scope > .zone__head')!, 'Graveyard'],
      [zone(0, 'exile').querySelector<HTMLElement>(':scope > .zone__head')!, 'Exile'],
      // Theirs too, hidden hand and all: a count and a label, never a sentence.
      [zone(1, 'battlefield').querySelector<HTMLElement>(':scope > .zone__head')!, 'Battlefield'],
      [zone(1, 'hand').querySelector<HTMLElement>(':scope > .zone__head')!, 'Hand'],
    ] as const;
    for (const [head, label] of heads) {
      expect(head, `a head for ${label}`).not.toBeNull();
      const count = head.closest<HTMLElement>('[data-zone]')!.dataset.count!;
      expect(head.textContent, `${label}'s head reads label then count`).toBe(`${label} ${count}`);
    }
    // And the four lane labels, which were the other rotated words.
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
      expect(within(bar).getByTestId('hand-count').textContent).toBe(`hand ${p.handCount}`);
      expect(within(bar).getByTestId('library-count').textContent).toBe(`library ${p.libraryCount}`);
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
      expect(bar.querySelector('[data-zone]'), 'and holds none').toBeNull();
    }
    expect([...board.querySelectorAll<HTMLElement>('[data-zone]')].map((z) => `${z.dataset.owner}/${z.dataset.zone}`)).toEqual([
      'them/battlefield',
      'them/graveyard',
      'them/exile',
      'them/hand',
      'table/stack',
      'you/battlefield',
      'you/graveyard',
      'you/exile',
      'you/hand',
    ]);
  });

  it('tells ours from theirs: the viewer’s bar says (you) and its seat says data-viewer', () => {
    const { container, seat } = renderBoard(view);
    const board = container.querySelector<HTMLElement>('.board')!;
    const me = view.players.find((p) => p.isViewer)!;
    const them = view.players.find((p) => !p.isViewer)!;
    expect(seat(me.id).dataset.viewer).toBe('true');
    expect(seat(them.id).dataset.viewer).toBeUndefined();
    expect(seat(me.id).querySelector('.seat__you')!.textContent).toBe(' (you)');
    expect(seat(them.id).querySelector('.seat__you')).toBeNull();
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
      expect(flags, `seat ${p.id}'s flags`).toEqual(['their turn', 'priority', 'lost']);
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

  it('draws all four rows, labelled and counted, on both sides and at every count', () => {
    const { seat, zone } = renderBoard();
    for (const id of [0, 1]) {
      const rows = [...zone(id, 'battlefield').querySelectorAll<HTMLElement>('[data-board-row]')];
      expect(rows.map((r) => r.dataset.boardRow), `seat ${id}'s rows, in order`).toEqual(ROWS);
      // A lane's share of the width is its card count (`board.css`).
      expect(
        rows.map((r) => r.style.flexGrow),
        `seat ${id}'s lanes grow by what they hold`,
      ).toEqual(rows.map((r) => String(r.querySelectorAll('.board-card').length)));
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
    // Seat 1: an `Artifact Land` is a land, an `Artifact Creature` a creature.
    const them = view.players.find((p) => p.id === 1)!;
    expect(them.battlefield.find((c) => c.id === 116)!.card.typeLine).toBe('Artifact Land');
    expect(them.battlefield.find((c) => c.id === 67)!.card.typeLine).toBe('Artifact Creature — Goblin');
    expect(rowIds(1, 'lands')).toEqual([87, 78, 93, 83, 116, 118]);
    expect(rowIds(1, 'creatures')).toEqual([99, 67]);
    expect(rowIds(1, 'artifacts')).toEqual([]);
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
 * `fireEvent.dragStart` carries no `DataTransfer` in jsdom, which is exactly
 * why `Board.tsx` remembers the dragged card itself and treats the transfer as
 * a courtesy to the browser.
 */
describe('drag to arrange (#10)', () => {
  /** Drag a card onto another card, or onto a row's own box. */
  function drag(container: HTMLElement, cardId: number, onto: { card: number } | { row: string }) {
    const from = container.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`)!;
    const to =
      'card' in onto
        ? container.querySelector<HTMLElement>(`[data-card-id="${onto.card}"]`)!
        : container.querySelector<HTMLElement>(`.seat[data-viewer] [data-board-row="${onto.row}"]`)!;
    fireEvent.dragStart(from);
    fireEvent.dragOver(to);
    fireEvent.drop(to);
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

  it('Regroup throws it away and the default grouping comes back', () => {
    const { container, rowIds, getByLabelText } = renderBoard();
    // Dropped on the row itself, so it joins the end of it.
    drag(container, 8, { row: 'creatures' });
    expect(rowIds(0, 'creatures')).toEqual([21, 8]);
    fireEvent.click(getByLabelText('Regroup your battlefield'));
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    expect(rowIds(0, 'creatures')).toEqual([21]);
  });

  it('sends nothing to the engine: no selection, no reply, only the view moved', () => {
    const view = boardFromFixture(fixture);
    const { interaction, onSelectCard, onSelectPlayer } = spyInteraction([8, 24], [0, 1]);
    const { container, rowIds } = renderBoard(view, interaction);
    drag(container, 8, { card: 24 });
    drag(container, 24, { row: 'artifacts' });
    expect(rowIds(0, 'artifacts')).toEqual([24]);
    expect(onSelectCard).not.toHaveBeenCalled();
    expect(onSelectPlayer).not.toHaveBeenCalled();
    // And the view the board was handed is untouched: the arrangement is ours.
    expect(view.players.find((p) => p.isViewer)!.battlefield.map((c) => c.id)).toEqual([8, 24, 21, 6, 25]);
  });

  it('is the viewer’s own battlefield only, and one Regroup with it', () => {
    const { container, seat } = renderBoard();
    expect(seat(0).querySelectorAll('.board-card[draggable="true"]')).toHaveLength(5);
    expect(seat(0).querySelectorAll('[data-zone="hand"] .board-card[draggable]')).toHaveLength(0);
    expect(seat(0).querySelectorAll('[data-zone="graveyard"] .board-card[draggable]')).toHaveLength(0);
    // The opponent's side is theirs to arrange, on their own screen.
    expect(seat(1).querySelectorAll('.board-card[draggable]')).toHaveLength(0);
    expect(seat(1).querySelectorAll('[data-arrange-reset]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-arrange-reset]')).toHaveLength(1);
  });

  it('a card dragged onto the opponent’s battlefield stays where it was', () => {
    const { container, rowIds } = renderBoard();
    const from = container.querySelector<HTMLElement>('[data-card-id="8"]')!;
    fireEvent.dragStart(from);
    const theirs = container.querySelector<HTMLElement>('.seat:not([data-viewer]) [data-board-row="lands"]')!;
    fireEvent.dragOver(theirs);
    fireEvent.drop(theirs);
    expect(rowIds(0, 'lands')).toEqual([8, 24, 6, 25]);
    expect(rowIds(1, 'lands')).toEqual([87, 78, 93, 83, 116, 118]);
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
