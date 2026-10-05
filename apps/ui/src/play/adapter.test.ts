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
import {
  boardPT,
  CUBE_ART_IDS,
  KNOWN_ART_IDS,
  POOL_PRINTED_PT,
  printedPTIndex,
  scryfallIdFor,
  toBoardView,
  type BoardCard,
} from './adapter.ts';
import { loadPackets, PLAY_FIXTURES } from './fixtures.ts';
import { foldPackets, type WireState } from './fold.ts';
import { cardStateKey, deltaKey, WireType, type WireObject } from './wire.ts';

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

/* ── §A.2, §A.3, §A.4: what else the wire already carries ─────────────── */

/** Set one property on a `CardView` in place. */
function setCard(state: Map<string, WireObject>, cardId: number, prop: string, value: unknown): void {
  const key = deltaKey(WireType.Card, cardId);
  const card = state.get(key);
  if (card === undefined) throw new Error(`no card ${cardId} in the fixture`);
  state.set(key, { ...card, [prop]: value } as WireObject);
}

/** Replace one of a player's zone lists, so a card can be put where a test needs it. */
function setZone(state: Map<string, WireObject>, playerId: number, zone: string, ids: number[]): void {
  const key = deltaKey(WireType.Player, playerId);
  const player = state.get(key)!;
  state.set(key, { ...player, [zone]: { t: 'list', v: ids.map((v) => ({ t: 'int', v })) } } as WireObject);
}

const ids = (list: readonly number[] | undefined) => [...(list ?? [])];

/** Every card of the view, by id. */
function cardsById(view: ReturnType<typeof toBoardView>): Map<number, BoardCard> {
  return new Map(allCards(view).map((c) => [c.id, c]));
}

describe('§A.4 #17 — haste is not summoning sickness', () => {
  /*
   * The wire DOES carry what this needs, and the committed capture proves it
   * rather than a fixture someone typed: Oxidda Golem (card 76) is a real
   * Forge precon creature whose `CardStateView` carries
   * `Keywords: ["Affinity:Mountain", "Haste"]`. A keyword crosses as its own
   * `original()` text with any parameter after a colon, which is why the check
   * is a membership test on a token and not a match against a sentence.
   */
  it('reads Keywords off the current face — the capture really carries Haste', () => {
    const view = adapt(baseState());
    const golem = allCards(view).find((c) => c.card.name === 'Oxidda Golem')!;
    expect(golem, 'the capture has an Oxidda Golem').toBeDefined();
    expect([...(golem.keywords ?? [])]).toEqual(['Affinity:Mountain', 'Haste']);
    // And a creature with no haste carries its own keywords, not an empty guess.
    const urchin = allCards(view).find((c) => c.id === 21)!;
    expect([...(urchin.keywords ?? [])]).toEqual(['Trample']);
  });

  /**
   * The capture's Oxidda Golem, moved from the graveyard onto the battlefield.
   *
   * **Its `Sickness` is already `true` in the capture** and nothing here sets
   * it: Forge really does put the flag on a card in a graveyard, which is both
   * why the adapter only reports it on a battlefield creature and why this is a
   * real hasty-and-sick creature rather than a flag a test invented. The boar
   * (99, no keywords at all) is the contrast and does need one.
   */
  function golemOnBattlefield(): Map<string, WireObject> {
    const state = baseState();
    expect(state.get(deltaKey(WireType.Card, 76))!['Sickness'], 'the capture’s own flag').toEqual({ t: 'bool', v: true });
    setZone(state, 1, 'Graveyard', [77, 79]);
    setZone(state, 1, 'Battlefield', [87, 78, 93, 83, 99, 116, 67, 118, 76]);
    setCard(state, 99, 'Sickness', { t: 'bool', v: true });
    return state;
  }

  it('a hasty creature that arrived this turn is NOT summoning sick; one without haste is', () => {
    const by = cardsById(adapt(golemOnBattlefield()));
    const golem = by.get(76)!;
    const boar = by.get(99)!;
    // Forge's raw answer is the same for both: both arrived this turn.
    expect(golem.arrivedThisTurn, 'Forge says the golem arrived this turn').toBe(true);
    expect(boar.arrivedThisTurn, 'and so did the boar').toBe(true);
    // Ours is not. This is the whole of #17.
    expect(golem.summoningSick, 'it has haste, so it can act').toBe(false);
    expect(boar.summoningSick, 'it has not, so it cannot').toBe(true);
  });

  it('reports neither when the creature did not arrive this turn', () => {
    const state = golemOnBattlefield();
    setCard(state, 76, 'Sickness', { t: 'bool', v: false });
    setCard(state, 99, 'Sickness', { t: 'bool', v: false });
    const by = cardsById(adapt(state));
    for (const id of [76, 99]) {
      expect(by.get(id)!.arrivedThisTurn, `card ${id}`).toBe(false);
      expect(by.get(id)!.summoningSick, `card ${id}`).toBe(false);
    }
  });

  it('still reports nothing for a card that is not a creature on a battlefield', () => {
    // Forge sets `Sickness` on cards in every zone. The golem back in the
    // graveyard, sick on the wire, is not sick on the board.
    const state = baseState();
    setCard(state, 76, 'Sickness', { t: 'bool', v: true });
    const golem = cardsById(adapt(state)).get(76)!;
    expect(golem.arrivedThisTurn).toBe(false);
    expect(golem.summoningSick).toBe(false);
  });
});

describe('§A.2 #11 — the attachment properties the adapter used to ignore', () => {
  /*
   * The committed capture has no equipment and no aura in it — census of all 27
   * packets: `AttachedCards` and `EntityAttachedTo` appear zero times — so the
   * relation is exercised by writing the documented encoding into the real
   * state. `AttachedCards` is a `CardViewCollectionType`, which crosses as a
   * `list` of `int` (`packages/forge-wire/src/tier-c.ts`), and both properties
   * are in `apps/server/src/play/visibility.ts`'s `FACE_ONLY_KEEP`, so a seat
   * really does receive them.
   */
  it('the capture carries neither, which is why they had to be written in', () => {
    for (const packet of loadPackets(fixture)) {
      const json = JSON.stringify([packet.newObjects, packet.objectDeltas]);
      expect(json).not.toContain('AttachedCards');
      expect(json).not.toContain('EntityAttachedTo');
    }
    const view = adapt(baseState());
    for (const card of allCards(view)) {
      expect(ids(card.attachedCardIds), `card ${card.id}`).toEqual([]);
      expect(card.attachedToId, `card ${card.id}`).toBeNull();
    }
  });

  it('reads AttachedCards on the host and EntityAttachedTo on the attachment', () => {
    const state = baseState();
    // Card 2 (Ral's Staticaster, in seat 0's graveyard) put on the battlefield
    // as the thing attached to Fire Urchin (21).
    setZone(state, 0, 'Graveyard', [20, 11]);
    setZone(state, 0, 'Battlefield', [8, 24, 21, 6, 25, 2]);
    setCard(state, 21, 'AttachedCards', { t: 'list', v: [{ t: 'int', v: 2 }] });
    setCard(state, 2, 'EntityAttachedTo', { t: 'int', v: 21 });

    const by = cardsById(adapt(state));
    expect(ids(by.get(21)!.attachedCardIds), 'the host lists its gear').toEqual([2]);
    expect(by.get(2)!.attachedToId, 'and the gear names its host').toBe(21);
    // Neither is invented for anything else on the board.
    expect(ids(by.get(8)!.attachedCardIds)).toEqual([]);
    expect(by.get(8)!.attachedToId).toBeNull();
  });

  it('drops Forge’s -1 and a set as readily as a list', () => {
    const state = baseState();
    setCard(state, 21, 'EntityAttachedTo', { t: 'int', v: -1 });
    setCard(state, 21, 'AttachedCards', { t: 'set', v: [{ t: 'int', v: 8 }, { t: 'int', v: -1 }] });
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.attachedToId, '-1 is Forge’s "nothing"').toBeNull();
    expect(ids(card.attachedCardIds)).toEqual([8]);
  });
});

describe('§A.3 #12/#18 — printed versus current power and toughness', () => {
  /*
   * The answer, established before anything was drawn: **the wire carries the
   * CURRENT values and no printed base at all.** `Power`/`Toughness` are
   * `CardStateView` properties, `Damage` and `LethalDamage` are `CardView`
   * properties, and `TrackableProperty` has no `BasePower`, no `BaseToughness`
   * and no original card state — `OriginalColors` and `OriginalManaCost` exist
   * with no P/T counterpart, and `HasPrintedPT` is a boolean Forge sets only for
   * vehicles and spacecraft. So the printed base comes from `pool.json`, and a
   * card that is not in it has none.
   */
  it('the capture carries no printed base: no Base* key, and P/T only on a face', () => {
    for (const packet of loadPackets(fixture)) {
      const json = JSON.stringify([packet.newObjects, packet.objectDeltas]);
      expect(json).not.toContain('BasePower');
      expect(json).not.toContain('BaseToughness');
      expect(json).not.toContain('OriginalPower');
      expect(json).not.toContain('OriginalToughness');
    }
    // And every Power/Toughness in the fold is on a CardStateView.
    let faces = 0;
    for (const obj of foldPackets(loadPackets(fixture)).state.values()) {
      if (obj['Power'] === undefined && obj['Toughness'] === undefined) continue;
      expect(obj._type, 'P/T lives on a face').toBe(WireType.CardState);
      faces += 1;
    }
    expect(faces, 'the capture has faces with P/T').toBeGreaterThan(0);
  });

  it('carries LethalDamage, which is Forge’s own and is not "toughness left"', () => {
    // Fire Urchin is 1/3 with no damage, so Forge's LethalDamage is 3 — it is
    // `getLethal() - getDamage() - getTotalAssignedDamage()` and it returns 0
    // outright against deathtouch (`Card.java:5978`), which is why the board
    // computes the number it draws from Toughness and Damage instead.
    const by = cardsById(adapt(baseState()));
    expect(by.get(21)!.card.toughness).toBe('3');
    expect(by.get(21)!.lethalDamage).toBe(3);
    expect(by.get(99)!.lethalDamage).toBe(5);
    expect(by.get(8)!.lethalDamage, 'a land has none').toBe(0);
  });

  it('gives every card of the capture NO printed base, because our data has none of them', () => {
    const view = adapt(baseState());
    for (const card of allCards(view)) {
      expect(card.printed, `${card.card.name} is not in the cube pool`).toBeNull();
    }
    // And `boardPT` therefore calls all of them plain — never buffed.
    for (const card of allCards(view)) {
      const pt = boardPT(card);
      if (pt === null) continue;
      expect(pt.powerState, card.card.name).toBe('plain');
      expect(pt.toughnessState, card.card.name).toBe('plain');
    }
  });

  it('finds the printed base for a card our data DOES know', () => {
    // Giver of Runes is a 1/2 in the committed pool.
    const giver = (poolData as { cards: { name: string; setCode: string; power?: string; toughness?: string }[] }).cards.find(
      (c) => c.name === 'Giver of Runes',
    )!;
    expect([giver.power, giver.toughness]).toEqual(['1', '2']);

    const state = baseState();
    renameCard(state, 21, 'Giver of Runes', giver.setCode);
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.printed).toEqual({ power: 1, toughness: 2 });
  });

  it('draws the operator’s case from the wire: a 1/2 with +2/+2 that has taken 3 reads 3 / 1', () => {
    const state = baseState();
    renameCard(state, 21, 'Giver of Runes', 'PRM');
    // The buff: Forge sends the CURRENT values, so a +2/+2 is 3/4 on the wire.
    const face = state.get(cardStateKey(21, 0))!;
    state.set(cardStateKey(21, 0), { ...face, Power: { t: 'int', v: 3 }, Toughness: { t: 'int', v: 4 } } as WireObject);
    setCard(state, 21, 'Damage', { t: 'int', v: 3 });

    const card = cardsById(adapt(state)).get(21)!;
    const pt = boardPT(card)!;
    expect(pt.power, 'the current power').toBe(3);
    expect(pt.toughness, 'what is LEFT of the toughness').toBe(1);
    expect(pt.powerState, 'blue: above its printed 1').toBe('buffed');
    expect(pt.toughnessState, 'red: damage is marked').toBe('hurt');
    expect(pt.printed).toEqual({ power: 1, toughness: 2 });
    expect(pt.damage).toBe(3);
  });

  it('calls a shrunk creature hurt and an untouched one plain', () => {
    const state = baseState();
    renameCard(state, 21, 'Giver of Runes', 'PRM');
    const face = state.get(cardStateKey(21, 0))!;
    const at = (power: number, toughness: number) => {
      const s = new Map(state);
      s.set(cardStateKey(21, 0), { ...face, Power: { t: 'int', v: power }, Toughness: { t: 'int', v: toughness } } as WireObject);
      return boardPT(cardsById(adapt(s)).get(21)!)!;
    };
    expect([at(1, 2).powerState, at(1, 2).toughnessState], 'exactly its printed 1/2').toEqual(['plain', 'plain']);
    expect([at(0, 1).powerState, at(0, 1).toughnessState], 'below its printed 1/2').toEqual(['hurt', 'hurt']);
    expect([at(4, 2).powerState, at(4, 2).toughnessState], 'power only').toEqual(['buffed', 'plain']);
  });

  it('is null for anything without both numbers', () => {
    const by = cardsById(adapt(baseState()));
    expect(boardPT(by.get(8)!), 'a land').toBeNull();
  });

  describe('the printed index itself', () => {
    it('keys by name and holds only integers', () => {
      const index = printedPTIndex([
        { name: 'Two Two', power: '2', toughness: '2' },
        { name: 'Starry', power: '*', toughness: '1+*' },
        { name: 'Half', power: '3' },
        { name: 'Landish' },
        { name: 'TWO two', power: '9', toughness: '9' },
      ]);
      expect(index.get('two two')).toEqual({ power: 2, toughness: 2 });
      expect(index.get('starry'), '`*` is not a number').toBeUndefined();
      expect(index.get('half'), 'a power with no toughness is not a base').toBeUndefined();
      expect(index.get('landish')).toBeUndefined();
      // First row wins, so a later duplicate cannot silently repoint a card.
      expect(index.get('two two')!.power).toBe(2);
    });

    it('covers the cube’s creatures and nothing else', () => {
      const pool = (poolData as { cards: { name: string; power?: string; toughness?: string }[] }).cards;
      const numeric = pool.filter((c) => /^\d+$/.test(String(c.power)) && /^\d+$/.test(String(c.toughness)));
      expect(numeric.length, 'the pool has creatures with integer P/T').toBeGreaterThan(100);
      expect(POOL_PRINTED_PT.size).toBe(new Set(numeric.map((c) => c.name.toLowerCase())).size);
      // A card with a `*` in the pool is deliberately absent.
      const starry = pool.find((c) => String(c.power) === '*');
      if (starry !== undefined) expect(POOL_PRINTED_PT.get(starry.name.toLowerCase())).toBeUndefined();
      expect(POOL_PRINTED_PT.get('mountain'), 'and nothing outside the cube').toBeUndefined();
    });
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

/* ── §A.6 — the mana pool, which nothing read before wave 26 ────────── */

/**
 * The pool is `PlayerView.Mana`, a `ManaMapType` Forge sets in the constructor
 * (`PlayerView.java:54`) and refills in `updateMana` (:501-507), and this adapter
 * simply did not read it — so a player could not see mana they had already tapped
 * for. Forge applies the pool to a cost before it asks for the rest, which is why
 * the mana WORKED and was only invisible; that is the whole of the bug.
 *
 * The one thing here that can go wrong quietly is the byte→colour map, and it is
 * wrong in exactly one place if you take the obvious constant: `updateMana` walks
 * `ManaAtom.MANATYPES`, whose colourless is `1 << 5` = **32**
 * (`ManaAtom.java:12,15`), while `MagicColor.COLORLESS` is **0**
 * (`MagicColor.java:22`) and never appears in this map at all.
 *
 * So the census below is read off the COMMITTED CAPTURE rather than off either
 * constant.
 */
describe('§A.6 — the seat’s mana pool', () => {
  /** Every `Mana` value in the committed fixture, as the wire carries it. */
  function manaValuesInFixture(): { keys: number[]; counts: number[] }[] {
    const out: { keys: number[]; counts: number[] }[] = [];
    for (const obj of baseState().values()) {
      if (obj._type !== WireType.Player) continue;
      const v = obj['Mana'] as { t?: string; v?: unknown } | undefined;
      if (v === undefined || v.t !== 'map' || !Array.isArray(v.v)) continue;
      const pairs = v.v as { v: number }[][];
      out.push({ keys: pairs.map((pr) => pr[0]!.v), counts: pairs.map((pr) => pr[1]!.v) });
    }
    return out;
  }

  function withMana(playerId: number, pool: [number, number][]): WireState {
    const state = baseState();
    const key = deltaKey(WireType.Player, playerId);
    state.set(key, {
      ...state.get(key)!,
      Mana: { t: 'map', v: pool.map(([b, n]) => [{ t: 'byte', v: b }, { t: 'int', v: n }]) },
    } as WireObject);
    return state;
  }

  const poolOf = (state: WireState, playerId: number) => adapt(state).players.find((p) => p.id === playerId)!.manaPool;

  it('knows what the wire actually carries: six ManaAtom bytes per seat, all zero in this capture', () => {
    const seen = manaValuesInFixture();
    expect(seen.length, 'both seats carry a pool').toBeGreaterThanOrEqual(2);
    for (const { keys, counts } of seen) {
      // 32 is ManaAtom's colourless. 0 — MagicColor's — is not a key here.
      expect([...keys].sort((a, b) => a - b)).toEqual([1, 2, 4, 8, 16, 32]);
      expect(keys).not.toContain(0);
      expect(counts.every((n) => n === 0), 'nothing was floating when this was captured').toBe(true);
    }
  });

  it('reports no pool for six zeroes, because six zeroes are not a pool', () => {
    for (const player of adapt(baseState()).players) expect(player.manaPool, `seat ${player.id}`).toEqual([]);
  });

  it('maps every ManaAtom byte to its colour, colourless included, and orders WUBRG then C', () => {
    // Every type Forge can hold, one each, in the HashMap's own scrambled order.
    const all = withMana(0, [
      [16, 1],
      [32, 1],
      [1, 1],
      [2, 1],
      [4, 1],
      [8, 1],
    ]);
    expect(poolOf(all, 0)).toEqual([
      { color: 'W', count: 1 },
      { color: 'U', count: 1 },
      { color: 'B', count: 1 },
      { color: 'R', count: 1 },
      { color: 'G', count: 1 },
      { color: 'C', count: 1 },
    ]);
  });

  it('keeps the counts and drops the colours that are nought', () => {
    expect(
      poolOf(
        withMana(0, [
          [8, 3],
          [1, 0],
          [2, 1],
        ]),
        0,
      ),
    ).toEqual([
      { color: 'U', count: 1 },
      { color: 'R', count: 3 },
    ]);
  });

  it('ignores a key that is not a mana type rather than guessing at one', () => {
    // 64 is `ManaAtom.GENERIC`, which is not a pool colour and never a key here;
    // -1 is Forge's "nothing". Neither may invent an entry.
    expect(
      poolOf(
        withMana(0, [
          [64, 2],
          [-1, 2],
          [4, 1],
        ]),
        0,
      ),
    ).toEqual([{ color: 'B', count: 1 }]);
  });

  it('is read per seat, because a mana pool is public information', () => {
    const state = withMana(1, [[2, 2]]);
    expect(poolOf(state, 1), 'the opponent’s pool is carried').toEqual([{ color: 'U', count: 2 }]);
    expect(poolOf(state, 0), 'and it is not the viewer’s').toEqual([]);
  });

  it('reports nothing when the property is absent or is not a map', () => {
    const state = baseState();
    const key = deltaKey(WireType.Player, 0);
    const { Mana: _dropped, ...withoutMana } = state.get(key)!;
    state.set(key, withoutMana as WireObject);
    expect(poolOf(state, 0)).toEqual([]);
    state.set(key, { ...withoutMana, Mana: { t: 'int', v: 3 } } as WireObject);
    expect(poolOf(state, 0)).toEqual([]);
  });
});

describe('item 4 — the avatar reaches the seat, wave 29 §A.6-8', () => {
  it('joins a seat’s avatar onto its BoardPlayer by playerId, and a seat the map does not name has no key at all', () => {
    const view = toBoardView(baseState(), 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      avatarByPlayerId: new Map([[fixture.viewerPlayerId, 'wanderer']]),
    });
    const me = view.players.find((p) => p.isViewer)!;
    const them = view.players.find((p) => !p.isViewer)!;
    expect(me).toHaveProperty('avatarId', 'wanderer');
    expect(them).not.toHaveProperty('avatarId');
  });

  it('with no map at all — the fixture path’s own default — nobody carries the key, exactly as every committed fixture drew before this wave', () => {
    const view = adapt(baseState());
    for (const p of view.players) expect(p).not.toHaveProperty('avatarId');
  });

  it('an EMPTY map (the seats arrived, nobody has a face) draws exactly the same as no map at all', () => {
    const view = toBoardView(baseState(), 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      avatarByPlayerId: new Map(),
    });
    for (const p of view.players) expect(p).not.toHaveProperty('avatarId');
  });
});

/*
 * X1/W14 — `view.combat`, Forge's own `CombatView` read off the single `Game`
 * object (`adapter.ts`'s `readCombat`, `abf705c`'s WIP). `atk`/`def`/`blk` are
 * three parallel lists; `def[i]` is `[marker, id]` with 0 = card (a
 * planeswalker or a battle) and 1 = player. There is no committed fixture with
 * a live CombatView (the capture this fixture comes from was taken outside
 * combat), so the Game object's `CombatView` property is set by hand, the same
 * lever `renameCard` uses for a card's face.
 */
describe('view.combat — Forge’s CombatView, read off the state channel (X1)', () => {
  function gameKey(state: WireState): string {
    for (const [key, obj] of state) if (obj._type === WireType.Game) return key;
    throw new Error('no Game object in the fixture state');
  }

  function withCombat(v: { t: 'combat'; atk: number[][]; def: number[][]; blk: number[][]; pblk: number[][] }): WireState {
    const state = baseState();
    const key = gameKey(state);
    state.set(key, { ...state.get(key)!, CombatView: v });
    return state;
  }

  it('is empty outside combat — the committed capture carries no CombatView at all', () => {
    expect(adapt(baseState()).combat).toEqual([]);
  });

  it('reads one band per attacking group: attackers, the defender (0=card, 1=player), and its blockers', () => {
    const view = adapt(
      withCombat({
        t: 'combat',
        atk: [[10], [20, 21]],
        def: [
          [1, 99], // a player
          [0, 55], // a card: a planeswalker or a battle
        ],
        blk: [[], [30]],
        pblk: [[], []],
      }),
    );
    expect(view.combat).toEqual([
      { attackers: [10], defender: { kind: 'player', id: 99 }, blockers: [] },
      { attackers: [20, 21], defender: { kind: 'card', id: 55 }, blockers: [30] },
    ]);
  });

  it('a band with no entry in `blk` reads as blocked by nobody, not a crash', () => {
    const view = adapt(withCombat({ t: 'combat', atk: [[10]], def: [[1, 99]], blk: [], pblk: [] }));
    expect(view.combat).toEqual([{ attackers: [10], defender: { kind: 'player', id: 99 }, blockers: [] }]);
  });

  it('is absent-safe: a `CombatView` whose tag is not `combat` reads as no combat', () => {
    const state = baseState();
    const key = gameKey(state);
    state.set(key, { ...state.get(key)!, CombatView: { t: 'bool', v: true } } as WireObject);
    expect(adapt(state).combat).toEqual([]);
  });
});
