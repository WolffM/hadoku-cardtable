/*
 * What the adapter puts on a card, and on a stack item.
 *
 * `./Board.test.ts` asks what the board DRAWS. This file asks the question one
 * layer down, because that is where wave 19 §D's two defects live:
 *
 *   #9  *"some art missing"* — a card reached the board with no `scryfallId`,
 *       so `CardTile` had nothing to resolve and drew the text tile. Every such
 *       card was one the cube's `pool.json` had never heard of: a basic land,
 *       or anything from a constructed list.
 *   #10 *"cards on the stack are missing art"* — a `StackEntry` carried only a
 *       name, so the stack could not draw the same tile the board draws.
 *
 * Both assertions run through the REAL art resolver (`@hadoku/carddata/art`),
 * never a stub, because a stub is exactly how a blank board passes its tests:
 * the id was always being looked up, it was simply never found.
 *
 * The state under test is the committed capture — a real Forge match — mutated
 * only by renaming a card's face where a specific printing is needed. Shape,
 * ids and zone membership stay as captured.
 */

import { describe, expect, it } from 'vitest';

import { ALLOWED_ART_HOSTS, resolveArtUrl } from '@hadoku/carddata/art';

import artManifest from '../draft/art-manifest.json';
import poolData from '../draft/pool.json';
import { CUBE_ART_IDS, KNOWN_ART_IDS, scryfallIdFor, toBoardView, type BoardCard } from './adapter.ts';
import { loadPackets, PLAY_FIXTURES } from './fixtures.ts';
import { foldPackets, type WireState } from './fold.ts';
import { cardStateKey, WireType, type WireObject } from './wire.ts';

const fixture = PLAY_FIXTURES[0]!;
const MANIFEST = artManifest.entries;

function baseState(): Map<string, WireObject> {
  return new Map(foldPackets(loadPackets(fixture)).state);
}

/** The whole art path as `CardTile` walks it: a card's id in, a URL out. */
function artUrlOf(card: BoardCard): string | null {
  return resolveArtUrl(card.card.scryfallId, MANIFEST);
}

/**
 * Rename one card's face in place — the same lever `Board.test.ts` uses.
 * `SetCode` is set too, because the printing is the thing under test.
 *
 * **By card id, never by name.** The fixture holds two cards called Fire Urchin
 * (ids 20 and 21) and the stack's trigger names the second one; a name-keyed
 * rename edits the wrong card and the test then reads an id off a card nothing
 * renamed. That cost one debugging round, so it is written down here.
 */
function renameCard(state: Map<string, WireObject>, cardId: number, to: string, setCode: string): void {
  const key = cardStateKey(cardId, 0);
  const face = state.get(key);
  if (face === undefined) throw new Error(`no card state for card ${cardId}`);
  state.set(key, { ...face, Name: { t: 'str', v: to }, SetCode: { t: 'str', v: setCode } } as WireObject);
}

/** The id of the first card whose current face carries this name. */
function cardIdNamed(state: WireState, name: string): number {
  for (const [key, obj] of state) {
    if (obj._type !== WireType.CardState) continue;
    const id = obj._id >> 4;
    if (key !== cardStateKey(id, 0)) continue;
    if ((obj['Name'] as { v?: unknown } | undefined)?.v === name) return id;
  }
  throw new Error(`no card named ${name} in the fixture`);
}

function renameFace(state: Map<string, WireObject>, from: string, to: string, setCode: string): void {
  renameCard(state, cardIdNamed(state, from), to, setCode);
}

function allCards(view: ReturnType<typeof toBoardView>): BoardCard[] {
  return view.players.flatMap((p) => [...(p.hand ?? []), ...p.battlefield, ...p.graveyard, ...p.exile]);
}

function adapt(state: WireState) {
  return toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId });
}

describe('§D #9 — a card the cube pool never held still has art', () => {
  /*
   * The fixture's lands are `c:Mountain|MRD|1` — Mirrodin basics, in a match
   * whose decks are Forge precons. `pool.json` holds no basic land at all, so
   * before this wave every one of them drew a text tile. This is that card.
   */
  it('gives a basic land an id and a real art URL', () => {
    const view = adapt(baseState());
    const lands = allCards(view).filter((c) => c.card.name === 'Mountain');
    expect(lands.length, 'the fixture has Mountains').toBeGreaterThan(0);

    for (const land of lands) {
      expect(land.card.setCode).toBe('MRD');
      expect(scryfallIdFor(CUBE_ART_IDS, 'Mountain', 'MRD'), 'the bug: the pool has no basics').toBeUndefined();
      expect(land.card.scryfallId, 'Mountain|MRD').toMatch(/^[0-9a-f-]{36}$/);

      const url = artUrlOf(land);
      expect(url, 'Mountain has art').not.toBeNull();
      expect(ALLOWED_ART_HOSTS).toContain(new URL(url!).origin);
      expect(url).toContain(land.card.scryfallId!);
    }
  });

  it('gives an out-of-pool constructed card an id and a real art URL', () => {
    // A card from a committed `decks/` list, and a double-faced one at that:
    // Forge names the front face, Scryfall calls it `Front // Back`.
    expect((poolData as { cards: { name: string }[] }).cards.some((c) => c.name === 'Delver of Secrets')).toBe(false);

    const state = baseState();
    renameFace(state, 'Mountain', 'Delver of Secrets', 'ISD');
    const card = allCards(adapt(state)).find((c) => c.card.name === 'Delver of Secrets');
    expect(card, 'the renamed card is on the board').toBeDefined();

    expect(scryfallIdFor(CUBE_ART_IDS, 'Delver of Secrets', 'ISD')).toBeUndefined();
    const url = artUrlOf(card!);
    expect(url, 'Delver of Secrets has art').not.toBeNull();
    expect(ALLOWED_ART_HOSTS).toContain(new URL(url!).origin);
  });

  it('falls back to another printing rather than going blank', () => {
    const state = baseState();
    // Forge may name a printing nobody wrote down. Another printing's art is
    // still that card's art — the one thing that must not happen is a blank.
    renameFace(state, 'Mountain', 'Vapor Snag', 'NO-SUCH-SET');
    const card = allCards(adapt(state)).find((c) => c.card.name === 'Vapor Snag')!;
    expect(card.card.scryfallId).toBe(scryfallIdFor(KNOWN_ART_IDS, 'Vapor Snag', ''));
    expect(artUrlOf(card)).not.toBeNull();
  });

  it('still leaves a card nothing knows without an id, and the tile stays text', () => {
    const state = baseState();
    renameFace(state, 'Mountain', 'Not A Card Anyone Printed', 'XYZ');
    const card = allCards(adapt(state)).find((c) => c.card.name === 'Not A Card Anyone Printed')!;
    expect(card.card.scryfallId).toBeUndefined();
    expect(artUrlOf(card)).toBeNull();
  });

  it('does not repoint a cube card: the drafted pool keeps precedence', () => {
    const state = baseState();
    const giver = (poolData as { cards: { name: string; setCode: string; scryfallId?: string }[] }).cards.find(
      (c) => c.name === 'Giver of Runes',
    )!;
    renameFace(state, 'Mountain', 'Giver of Runes', giver.setCode);
    const card = allCards(adapt(state)).find((c) => c.card.name === 'Giver of Runes')!;
    expect(card.card.scryfallId).toBe(giver.scryfallId);
  });
});

describe('§D #10 — the stack carries its source card', () => {
  /*
   * The contract lane A renders against: `StackEntry.sourceCard` is the source
   * card's full `DraftCard`, so the stack draws the same `CardTile` every board
   * card uses — art included — without knowing where art comes from.
   */
  it('puts the source card’s whole face on every item that names one', () => {
    const view = adapt(baseState());
    expect(view.stack.length, 'the fixture has two items on the stack').toBe(2);

    for (const item of view.stack) {
      expect(item.sourceCardId, item.description).not.toBeNull();
      expect(item.sourceCard, item.description).not.toBeNull();
      expect(item.sourceCard!.name).toBe(item.sourceName);
      // The same card object the board would draw, not a name in a wrapper.
      expect(item.sourceCard!.cardId).toBe(`w${item.sourceCardId}`);
      expect(item.sourceCard!.typeLine.length).toBeGreaterThan(0);
    }
  });

  it('carries the art id, so a stack item resolves exactly as a board card does', () => {
    const state = baseState();
    const item = adapt(state).stack[0]!;
    // The captured decks are Forge precons, whose cards are outside every
    // committed table — so make the source card one we do know, and assert the
    // id travels with it.
    renameCard(state, item.sourceCardId!, 'Delver of Secrets', 'ISD');

    const renamed = adapt(state).stack[0]!;
    expect(renamed.sourceCard).not.toBeNull();
    expect(renamed.sourceCard!.scryfallId).toBe(scryfallIdFor(KNOWN_ART_IDS, 'Delver of Secrets', 'ISD'));

    const url = resolveArtUrl(renamed.sourceCard!.scryfallId, MANIFEST);
    expect(url, 'the stack item has art').not.toBeNull();
    expect(ALLOWED_ART_HOSTS).toContain(new URL(url!).origin);

    // And it is the same card the battlefield/hand copy carries.
    const onBoard = allCards(adapt(state)).find((c) => c.id === renamed.sourceCardId);
    if (onBoard !== undefined) expect(renamed.sourceCard).toEqual(onBoard.card);
  });

  it('is null when the item names no card', () => {
    const state = baseState();
    for (const [key, obj] of state) {
      if (obj._type !== WireType.StackItem) continue;
      const next = { ...obj };
      delete next['SourceCard'];
      state.set(key, next);
    }
    for (const item of adapt(state).stack) {
      expect(item.sourceCardId).toBeNull();
      expect(item.sourceCard).toBeNull();
    }
  });
});

describe('hidden information is untouched by any of this', () => {
  it('gives an opponent’s hand no cards to carry an id on', () => {
    const view = adapt(baseState());
    for (const player of view.players) {
      if (player.isViewer) continue;
      expect(player.hand).toBeNull();
      expect(player.handCount).toBeGreaterThan(0);
    }
  });
});
