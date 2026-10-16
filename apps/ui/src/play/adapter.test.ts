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
  abilityTextOf,
  boardPT,
  CUBE_ART_IDS,
  HIDDEN_CARD_NAME,
  keywordTags,
  KNOWN_ART_IDS,
  POOL_PRINTED_PT,
  printedPTIndex,
  scryfallIdFor,
  toBoardView,
  type BoardCard,
} from './adapter.ts';
import { loadPackets, PLAY_FIXTURES } from './fixtures.ts';
import { foldPackets, type WireState } from './fold.ts';
import { cardStateKey, deltaKey, WireType, type Tagged, type WireObject } from './wire.ts';

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

describe('targetStackItemId (wave 49 §A)', () => {
  /*
   * `StackEntry.targetStackItemId` is read off `AdaptOptions.stackTargetSpells`
   * — PlayBridge.java's own `stackTargetSpells` wire fact, a `fromId → toId`
   * map keyed by stack item id — NOT off `targetCardIds`/`targetPlayerIds`,
   * which is what the counterspell case fails both of (see `auto-targets.ts`'s
   * own header on why).
   */
  it('reads the paired item’s id onto the item that targets it, and leaves every other item null', () => {
    const state = baseState();
    const [first, second] = adapt(state).stack;
    expect(first, 'the fixture has at least two stack items').toBeDefined();
    expect(second).toBeDefined();

    const view = toBoardView(state, 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      stackTargetSpells: new Map([[first!.id, second!.id]]),
    });
    const got = new Map(view.stack.map((item) => [item.id, item.targetStackItemId]));
    expect(got.get(first!.id)).toBe(second!.id);
    expect(got.get(second!.id) ?? null).toBeNull();
  });

  it('is null for every item when no map is supplied at all', () => {
    const view = adapt(baseState());
    for (const item of view.stack) expect(item.targetStackItemId).toBeNull();
  });
});

describe('a modal spell’s targets', () => {
  /*
   * A charm's or a Command's chosen modes are sub-abilities: the stack item Forge publishes targets
   * nothing itself, and each mode's targets sit one `SubInstance` down (`StackItemView.updateSubInstance`).
   */
  it('reads every target down the SubInstance chain onto the item, each once, and the chain adds no stack entry', () => {
    const state = baseState();
    const before = adapt(state).stack;
    const sid = before[0]!.id;
    const mountain = cardIdNamed(state, 'Mountain');
    const ids = (...v: number[]): Tagged => ({ t: 'list', v: v.map((id) => ({ t: 'int', v: id })) });
    const key = deltaKey(WireType.StackItem, sid);
    state.set(key, { ...state.get(key)!, TargetCards: ids(), TargetPlayers: ids(), SubInstance: { t: 'int', v: 9001 } });
    state.set(deltaKey(WireType.StackItem, 9001), { _type: WireType.StackItem, _id: 9001, TargetCards: ids(mountain), TargetPlayers: ids(), SubInstance: { t: 'int', v: 9002 } });
    state.set(deltaKey(WireType.StackItem, 9002), { _type: WireType.StackItem, _id: 9002, TargetCards: ids(mountain), TargetPlayers: ids(fixture.viewerPlayerId) });

    const view = adapt(state);
    const entry = view.stack.find((e) => e.id === sid)!;
    expect(entry.targetCardIds).toEqual([mountain]);
    expect(entry.targetPlayerIds).toEqual([fixture.viewerPlayerId]);
    expect(view.stack.map((e) => e.id)).toEqual(before.map((e) => e.id));
  });
});

describe('a spell is drawn in one place: the stack lets go when a zone list holds its card', () => {
  /*
   * GameView `Stack` and the PlayerView lists arrive in separate deltas: a resolving creature was on
   * the battlefield one frame before the stack let go of it (st-stack-resolve, the other seat's screen),
   * and the stack card and the board card were both drawn. The view puts the card in one place.
   */
  /** The fixture's first stack item, made a spell: its card is on the stack, so no zone list holds it. */
  function spellOnStack(state: Map<string, WireObject>): { sid: number; card: number } {
    const { id: sid, sourceCardId } = adapt(state).stack[0]!;
    const key = deltaKey(WireType.StackItem, sid);
    state.set(key, { ...state.get(key)!, Ability: { t: 'bool', v: false } } as WireObject);
    for (const { id: pid } of adapt(state).players) {
      for (const zone of ['Hand', 'Library', 'Battlefield', 'Graveyard', 'Exile']) {
        setZone(state, pid, zone, listOf(state, pid, zone).filter((id) => id !== sourceCardId));
      }
    }
    const item = adapt(state).stack.find((i) => i.id === sid)!;
    expect(item.isAbility).toBe(false);
    return { sid, card: item.sourceCardId! };
  }
  const playerOf = (state: WireState, pid: number) => state.get(deltaKey(WireType.Player, pid));
  const listOf = (state: WireState, pid: number, zone: string): number[] =>
    ((playerOf(state, pid)?.[zone] as { v?: { v: number }[] } | undefined)?.v ?? []).map((t) => t.v);

  for (const zone of ['Battlefield', 'Graveyard', 'Exile', 'Hand']) {
    it(`drops a spell whose card the ${zone} list already holds, in the frame before the stack lets go`, () => {
      const state = baseState();
      const { sid, card } = spellOnStack(state);
      const pid = fixture.viewerPlayerId;
      setZone(state, pid, zone, [...listOf(state, pid, zone), card]);
      const view = adapt(state);
      expect(view.stack.map((i) => i.id)).not.toContain(sid);
      if (zone === 'Battlefield') expect(view.players.find((p) => p.id === pid)!.battlefield.map((c) => c.id)).toContain(card);
    });
  }

  it('keeps an ability whose source is on the battlefield — it is an effect of the card, not the card', () => {
    const state = baseState();
    const view = adapt(state);
    const ability = view.stack.find((i) => i.isAbility)!;
    const pid = fixture.viewerPlayerId;
    setZone(state, pid, 'Battlefield', [...listOf(state, pid, 'Battlefield'), ability.sourceCardId!]);
    expect(adapt(state).stack.map((i) => i.id)).toContain(ability.id);
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

describe('a stack item’s ability text and hidden source', () => {
  /*
   * Forge's own strings for one trigger, as the captured game (`tierc-game1-seq1-27.json`) carries
   * them less the closing " [Zone Changer: …]" the bridge takes off (`PlayBridge.stackText`):
   * `Description` with the stack instance's targets note, `Key` (the auto-yield key) with the card's
   * words behind a "<card> (<id>): " prefix.
   */
  const KEY = 'Rubblebelt Boar (11): When Rubblebelt Boar enters, target creature gets +2/+0 until end of turn.';
  const DESCRIPTION =
    'When Rubblebelt Boar enters, target creature gets +2/+0 until end of turn. (Targeting: [[Fire Urchin (20)]])';
  const OWN = 'When Rubblebelt Boar enters, target creature gets +2/+0 until end of turn.';
  const TOKEN = 'At the beginning of combat on your turn, create a 1/1 red Goblin creature token with haste.';

  it('reads the ability’s own words off Key, past its card prefix — never Description’s notes', () => {
    expect(abilityTextOf(KEY, DESCRIPTION, 'Rubblebelt Boar')).toBe(OWN);
    expect(abilityTextOf(`Battlefield Goblin Rabblemaster (7): ${TOKEN}`, TOKEN, 'Goblin Rabblemaster')).toBe(TOKEN);
    // A face-down host's key names it by its hidden id; an activated ability's text keeps its cost.
    expect(abilityTextOf('Face-down card (H3): {T}: Add {G}.', 'Hidden card - Add {G}.', 'Hidden card')).toBe('{T}: Add {G}.');
  });

  it('falls back to Description without its notes when Key is missing or never filled in', () => {
    expect(abilityTextOf(null, DESCRIPTION, 'Rubblebelt Boar')).toBe(OWN);
    expect(
      abilityTextOf(
        'Kitchen Finks (4): When CARDNAME enters, choose one — ABILITY',
        'When Kitchen Finks enters, choose one — • You gain 2 life. (Targeting: [[Bob]])',
        'Kitchen Finks',
      ),
    ).toBe('When Kitchen Finks enters, choose one — • You gain 2 life.');
    // The card's own name leading Description is the chip's band already.
    expect(abilityTextOf(null, 'Llanowar Elves - Add {G}.', 'Llanowar Elves')).toBe('Add {G}.');
  });

  it('carries both on every entry: Key’s text, and whether this seat may see the source card', () => {
    const state = baseState();
    const sid = adapt(state).stack[0]!.id;
    const key = deltaKey(WireType.StackItem, sid);
    state.set(key, { ...state.get(key)!, Key: { t: 'str', v: KEY }, Description: { t: 'str', v: DESCRIPTION } } as WireObject);
    const item = adapt(state).stack.find((i) => i.id === sid)!;
    expect(item.abilityText).toBe(OWN);
    expect(item.sourceHidden, 'a card this seat was sent').toBe(false);
    redact(state, item.sourceCardId!);
    const hidden = adapt(state).stack.find((i) => i.id === sid)!;
    expect(hidden.sourceHidden, 'a face-down spell of theirs').toBe(true);
    expect(hidden.sourceCard!.name).toBe(HIDDEN_CARD_NAME);
  });
});

describe('keyword tags: only what the card was not printed with', () => {
  it('the capture’s Fire Urchin has Trample printed, so it wears no tag', () => {
    const urchin = allCards(adapt(baseState())).find((c) => c.id === 21)!;
    expect(urchin.card.oracleText.split('\n')[0]).toBe('Trample');
    expect(keywordTags(urchin.keywords, urchin.card.oracleText)).toEqual([]);
  });

  it('a printed keyword line is a list; a sentence that grants a keyword is not', () => {
    // Serra Angel, wearing Arcane Flight: flying is both printed and granted.
    expect(keywordTags(['Flying', 'Vigilance'], 'Flying, vigilance')).toEqual([]);
    // Grizzly Bears wearing Arcane Flight: flying is granted only.
    expect(keywordTags(['Flying'], '')).toEqual(['Flying']);
    // Arcane Flight's own sentence, and reminder text, print nothing.
    expect(keywordTags(['Flying'], 'Enchant creature\nEnchanted creature gets +1/+1 and has flying.')).toEqual(['Flying']);
    expect(keywordTags(['Flying', 'Lifelink'], 'Flying (This creature can’t be blocked except by creatures with flying or reach.)')).toEqual([
      'Lifelink',
    ]);
    expect(keywordTags(['First Strike', 'Trample'], 'First strike; trample')).toEqual([]);
  });
});

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

describe('choices, generically', () => {
  const list = (...v: string[]) => ({ t: 'list', v: v.map((x) => ({ t: 'str', v: x })) });

  it('a card with no choice property (every card in the capture) carries none', () => {
    for (const card of allCards(adapt(baseState()))) expect(card.choices, `card ${card.id}`).toEqual([]);
  });

  it('ChosenColors: Forge’s lower-case colour names, capitalised, in Forge’s order', () => {
    const state = baseState();
    setCard(state, 21, 'ChosenColors', list('blue', 'red'));
    expect(cardsById(adapt(state)).get(21)!.choices).toEqual([{ kind: 'color', values: ['Blue', 'Red'] }]);
  });

  it('every choice property, each read off its own wire shape, in the table’s order', () => {
    const state = baseState();
    const bob = baseState().get(deltaKey(WireType.Player, fixture.viewerPlayerId === 0 ? 1 : 0))!;
    setCard(state, 21, 'ChosenType', { t: 'str', v: ' Goblin ' });
    setCard(state, 21, 'ChosenType2', { t: 'str', v: 'Elf' });
    setCard(state, 21, 'NotedTypes', list('Wizard'));
    setCard(state, 21, 'NamedCard', list('Llanowar Elves'));
    setCard(state, 21, 'ChosenCards', { t: 'list', v: [{ t: 'int', v: 2 }, { t: 'int', v: 404 }] });
    setCard(state, 21, 'ChosenPlayer', { t: 'int', v: bob._id });
    setCard(state, 21, 'ProtectingPlayer', { t: 'int', v: -1 });
    setCard(state, 21, 'ChosenNumber', { t: 'str', v: '3' });
    setCard(state, 21, 'ChosenMode', { t: 'str', v: 'Dragons' });
    setCard(state, 21, 'ChosenDirection', { t: 'enum', c: 'forge.game.Direction', v: 'Left' });
    setCard(state, 21, 'ChosenEvenOdd', { t: 'enum', c: 'forge.game.EvenOdd', v: 'Odd' });
    setCard(state, 21, 'Sector', { t: 'str', v: 'Red' });
    const bobName = String((bob.Name as { v: string }).v);
    expect(cardsById(adapt(state)).get(21)!.choices).toEqual([
      { kind: 'type', values: ['Goblin'] },
      { kind: 'type', values: ['Elf'] },
      { kind: 'notedType', values: ['Wizard'] },
      { kind: 'card', values: ['Llanowar Elves'] },
      { kind: 'chosenCard', values: ["Ral's Staticaster", HIDDEN_CARD_NAME] },
      { kind: 'player', values: [bobName] },
      { kind: 'number', values: ['3'] },
      { kind: 'mode', values: ['Dragons'] },
      { kind: 'direction', values: ['Left'] },
      { kind: 'evenOdd', values: ['Odd'] },
      { kind: 'sector', values: ['Red'] },
    ]);
  });

  it('a chosen player is named as the board names the seat, not Forge’s raw name', () => {
    const state = baseState();
    const other = fixture.viewerPlayerId === 0 ? 1 : 0;
    setCard(state, 21, 'ChosenPlayer', { t: 'int', v: other });
    const view = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, nameByPlayerId: new Map([[other, 'Bob']]) });
    expect(cardsById(view).get(21)!.choices).toEqual([{ kind: 'player', values: ['Bob'] }]);
  });

  it('a blank value is Forge’s "nothing chosen" — a cleared ChosenNumber, an empty list — never a tag', () => {
    const state = baseState();
    setCard(state, 21, 'ChosenNumber', { t: 'str', v: '' });
    setCard(state, 21, 'ChosenType', { t: 'str', v: '   ' });
    setCard(state, 21, 'ChosenColors', list());
    expect(cardsById(adapt(state)).get(21)!.choices).toEqual([]);
  });
});

describe('relations, generically', () => {
  /*
   * The committed capture has no haunt, encode, imprint or must-block
   * relation in it — same proof `AttachedCards` needed above, read the same
   * way: none of the five relation properties appear in any
   * packet, so the pairing below is written into the real state by hand.
   */
  it('the capture carries none of the five relation properties, which is why they had to be written in', () => {
    for (const packet of loadPackets(fixture)) {
      const json = JSON.stringify([packet.newObjects, packet.objectDeltas]);
      for (const key of ['HauntedBy', 'Haunting', 'EncodedCards', 'ImprintedCards', 'MustBlockCards']) {
        expect(json, key).not.toContain(key);
      }
    }
    const view = adapt(baseState());
    for (const card of allCards(view)) {
      expect(card.relations, `card ${card.id}`).toEqual([]);
    }
  });

  it('HauntedBy on one card and Haunting on the other, each naming the other by its own resolved name', () => {
    const state = baseState();
    // Fire Urchin (21) haunted by Ral's Staticaster (2) — the exact pairing
    // Cry of Contrition's own Haunt ability leaves on the real wire.
    setCard(state, 21, 'HauntedBy', { t: 'list', v: [{ t: 'int', v: 2 }] });
    setCard(state, 2, 'Haunting', { t: 'int', v: 21 });

    const by = cardsById(adapt(state));
    expect(by.get(21)!.relations).toEqual([{ kind: 'hauntedBy', ids: [2], names: ["Ral's Staticaster"] }]);
    expect(by.get(2)!.relations).toEqual([{ kind: 'haunting', ids: [21], names: ['Fire Urchin'] }]);
    // Neither is invented for a card with no relation property set.
    expect(by.get(8)!.relations).toEqual([]);
  });

  it('every other relation kind, read off its own property', () => {
    const state = baseState();
    setCard(state, 21, 'EncodedCards', { t: 'list', v: [{ t: 'int', v: 2 }] });
    setCard(state, 20, 'ImprintedCards', { t: 'list', v: [{ t: 'int', v: 2 }] });
    setCard(state, 25, 'MustBlockCards', { t: 'list', v: [{ t: 'int', v: 2 }] });

    const by = cardsById(adapt(state));
    expect(by.get(21)!.relations).toEqual([{ kind: 'encoded', ids: [2], names: ["Ral's Staticaster"] }]);
    expect(by.get(20)!.relations).toEqual([{ kind: 'imprinted', ids: [2], names: ["Ral's Staticaster"] }]);
    expect(by.get(25)!.relations).toEqual([{ kind: 'mustBlock', ids: [2], names: ["Ral's Staticaster"] }]);
  });

  it('an id this seat was never sent a CardView for is named "Hidden card" — the hidden-id case', () => {
    const state = baseState();
    setCard(state, 21, 'HauntedBy', { t: 'list', v: [{ t: 'int', v: 404 }] });
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.relations).toEqual([{ kind: 'hauntedBy', ids: [404], names: [HIDDEN_CARD_NAME] }]);
  });

  it('drops Forge’s -1 off Haunting, same as every other single entity reference', () => {
    const state = baseState();
    setCard(state, 21, 'Haunting', { t: 'int', v: -1 });
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.relations).toEqual([]);
  });

  /*
   * `AbilityText` is Forge's LIVE text (`CardStateView.getAbilityText`), and
   * unlike the six relation properties above the capture really does carry
   * it — including the one case that matters here: Ral's Staticaster (2)
   * has a conditional pump that Forge marks as reminder text with its own
   * `useGrayText` markup, on the real wire, with no edit needed to prove it.
   */
  it('reads AbilityText off the same face OracleText reads, CRLF-normalised and gray-tag markup stripped', () => {
    const card = cardsById(adapt(baseState())).get(2)!;
    expect(card.card.oracleText.includes('<span')).toBe(false); // the printed text never had the markup to begin with
    expect(card.abilityText).toBe(
      "Trample\n\nWhenever Ral's Staticaster attacks, if you control a Ral planeswalker, Ral's Staticaster gets +1/+0 for each card in your hand until end of turn.",
    );
  });

  it('is null, never a blank string, for a card with no AbilityText on the wire (Island — a basic land)', () => {
    const card = cardsById(adapt(baseState())).get(24)!;
    expect(card.card.name).toBe('Island');
    expect(card.abilityText).toBeNull();
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
    expect(pt.toughnessState, 'red: damage is marked').toBe('damaged');
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

/**
 * What the server's visibility layer leaves of a card this seat may not see
 * (`apps/server/src/play/visibility.ts`, `HIDDEN_KEEP`): the view keeps who
 * owns it and where it is, and no face reaches the seat at all.
 */
function redact(state: Map<string, WireObject>, cardId: number): void {
  const key = deltaKey(WireType.Card, cardId);
  const card = state.get(key)!;
  state.set(key, { _type: card._type, _id: card._id, Owner: card['Owner'], Controller: card['Controller'], Zone: card['Zone'] } as WireObject);
  for (let ordinal = 0; ordinal < 16; ordinal++) state.delete(cardStateKey(cardId, ordinal));
}

describe('hidden information is untouched by any of this', () => {
  it('gives an opponent’s hand no cards to carry an id on', () => {
    const view = adapt(baseState());
    for (const player of view.players) {
      if (player.isViewer) continue;
      expect(player.hand).toBeNull();
      expect(player.handCount).toBeGreaterThan(0);
    }
  });

  it('marks a card whose name this seat was not sent as hidden, named "Hidden card", with no art — never "card <id>"', () => {
    const state = baseState();
    const id = cardIdNamed(state, 'Mountain');
    redact(state, id);
    const card = cardsById(adapt(state)).get(id)!;
    expect(card.hidden).toBe(true);
    expect(card.card.name).toBe(HIDDEN_CARD_NAME);
    expect(card.card.scryfallId).toBeUndefined();
    expect(JSON.stringify(card)).not.toMatch(/card \d+/i);
  });

  /** Put `cardId` on top of the viewer's library list. */
  function onLibraryTop(state: Map<string, WireObject>, cardId: number): number {
    const viewer = adapt(state).players.find((p) => p.isViewer)!.id;
    const key = deltaKey(WireType.Player, viewer);
    const player = state.get(key)!;
    const library = player.Library as { t: string; v: { t: string; v: number }[] } | undefined;
    state.set(key, { ...player, Library: { t: 'list', v: [{ t: 'int', v: cardId }, ...(library?.v ?? [])] } } as WireObject);
    return viewer;
  }

  /** Set `cardId`'s `PlayerMayLook` to these players. */
  function mayLook(state: Map<string, WireObject>, cardId: number, players: readonly number[]): void {
    const key = deltaKey(WireType.Card, cardId);
    state.set(key, { ...state.get(key)!, PlayerMayLook: { t: 'list', v: players.map((v) => ({ t: 'int', v })) } } as WireObject);
  }

  it("marks a card of the viewer's seen by the opponent exactly when its PlayerMayLook names someone else — in hand and on a revealed top", () => {
    const state = baseState();
    const view = adapt(state);
    const me = view.players.find((p) => p.isViewer)!;
    const them = view.players.find((p) => !p.isViewer)!;
    const [seen, own] = me.hand!;
    mayLook(state, seen!.id, [them.id]);
    mayLook(state, own!.id, [me.id]);
    const hand = adapt(state).players.find((p) => p.isViewer)!.hand!;
    expect(hand.filter((c) => c.seenByOpponent === true).map((c) => c.id), 'the one the opponent knows, not the one only the viewer is named on').toEqual([seen!.id]);
    const top = cardIdNamed(state, 'Mountain');
    onLibraryTop(state, top);
    mayLook(state, top, [me.id, them.id]);
    expect(adapt(state).players.find((p) => p.isViewer)!.libraryTop?.seenByOpponent).toBe(true);
  });

  it("draws a library's top card only when the seat was sent its name — Courser of Kruphix", () => {
    const state = baseState();
    const id = cardIdNamed(state, 'Mountain');
    const viewer = onLibraryTop(state, id);
    const shown = adapt(state).players.find((p) => p.id === viewer)!;
    expect(shown.libraryTop?.id).toBe(id);
    expect(shown.libraryTop?.card.name).toBe('Mountain');
    redact(state, id);
    expect(adapt(state).players.find((p) => p.id === viewer)!.libraryTop, 'a library card the seat may not see is never drawn').toBeUndefined();
  });

  it('draws no library top while the seat may also see the card under it — a search or a scry, not Courser', () => {
    const state = baseState();
    const top = cardIdNamed(state, 'Mountain');
    const under = [...cardsById(adapt(state)).values()].find((c) => c.hidden !== true && c.id !== top)!.id;
    onLibraryTop(state, under);
    const viewer = onLibraryTop(state, top);
    const seat = () => adapt(state).players.find((p) => p.id === viewer)!;
    expect(seat().libraryIds?.slice(0, 2)).toEqual([top, under]);
    expect(seat().libraryTop, 'a look at more than the top is a prompt’s, never a standing reveal').toBeUndefined();
    redact(state, under);
    expect(seat().libraryTop?.id, 'the top alone is a standing reveal').toBe(top);
  });

  it('draws no library top while a prompt names it — a scry 1’s Top or Bottom', () => {
    const state = baseState();
    const top = cardIdNamed(state, 'Mountain');
    const viewer = onLibraryTop(state, top);
    const seat = (promptCard: number | null) =>
      toBoardView(state, 1, { viewerPlayerId: fixture.viewerPlayerId, promptCard }).players.find((p) => p.id === viewer)!;
    expect(seat(null).libraryTop?.id).toBe(top);
    expect(seat(top).libraryTop, 'the prompt’s card is the decision’s, not the board’s').toBeUndefined();
  });

  it('treats a blank name as no name', () => {
    const state = baseState();
    const id = cardIdNamed(state, 'Mountain');
    renameCard(state, id, ' ', 'MRD');
    const card = cardsById(adapt(state)).get(id)!;
    expect(card.hidden).toBe(true);
    expect(card.card.name).toBe(HIDDEN_CARD_NAME);
  });

  it('leaves every card the seat was sent a name for unhidden', () => {
    const cards = allCards(adapt(baseState()));
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.hidden, card.card.name).toBe(false);
      expect(card.card.name).not.toBe(HIDDEN_CARD_NAME);
    }
  });

  /** Turn a card face down the way Forge does: `CurrentState` FaceDown (ordinal 1), and neither it nor the view named. */
  function faceDown(state: Map<string, WireObject>, cardId: number): void {
    const key = deltaKey(WireType.Card, cardId);
    const { Name: _name, ...view } = state.get(key)!;
    state.set(key, view as WireObject);
    setCard(state, cardId, 'Facedown', { t: 'bool', v: true });
    setCard(state, cardId, 'CurrentState', { t: 'int', v: 1 });
    state.set(cardStateKey(cardId, 1), { _type: WireType.CardState, _id: cardId * 16 + 1 } as WireObject);
  }

  it('reads a face-down card this seat may look at off its Original face — Hideaway, to the player who exiled it', () => {
    const state = baseState();
    const id = adapt(state).players.flatMap((p) => p.graveyard)[0]!.id;
    renameCard(state, id, 'Serra Angel', '');
    faceDown(state, id);
    const card = cardsById(adapt(state)).get(id)!;
    expect(card.hidden).toBe(false);
    expect(card.card.name).toBe('Serra Angel');
    expect(artUrlOf(card), 'it draws with its art').not.toBeNull();
  });

  it('is hidden when the seat was sent no Original face — Hideaway, to the opponent', () => {
    const state = baseState();
    const id = adapt(state).players.flatMap((p) => p.graveyard)[0]!.id;
    faceDown(state, id);
    state.delete(cardStateKey(id, 0));
    const card = cardsById(adapt(state)).get(id)!;
    expect(card.hidden).toBe(true);
    expect(card.card.name).toBe(HIDDEN_CARD_NAME);
  });

  it('keeps a nameless face-down permanent face down on the battlefield, whatever its Original face says', () => {
    const state = baseState();
    const id = cardIdNamed(state, 'Mountain');
    faceDown(state, id);
    const card = cardsById(adapt(state)).get(id)!;
    expect(card.hidden).toBe(true);
  });

  it('names a stack target this seat may not see "Hidden card"', () => {
    const state = baseState();
    const target = cardIdNamed(state, 'Mountain');
    redact(state, target);
    const sid = adapt(state).stack[0]!.id;
    const key = deltaKey(WireType.StackItem, sid);
    state.set(key, { ...state.get(key)!, TargetCards: { t: 'list', v: [{ t: 'int', v: target }, { t: 'int', v: 404 }] }, TargetPlayers: { t: 'list', v: [] } } as WireObject);
    const entry = adapt(state).stack.find((e) => e.id === sid)!;
    expect(entry.targetLabel).toBe(`${HIDDEN_CARD_NAME}, ${HIDDEN_CARD_NAME}`);
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

describe('waiting effects — what a resolved ability left on its source (the bridge’s waitingEffects)', () => {
  it('rides onto the battlefield source it names, in the bridge’s order, and onto nothing else', () => {
    const plain = adapt(baseState());
    const me = plain.players.find((p) => p.isViewer)!;
    const source = me.battlefield[0]!.id;
    const handCard = me.hand![0]!.id;
    const view = toBoardView(baseState(), 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      waitingEffects: [
        { source, kind: 'trigger', text: 'When you cast your next instant or sorcery spell from your hand this turn, it gains rebound.' },
        { source, kind: 'effect', text: 'Creatures you control get +1/+1.' },
        { source: handCard, kind: 'trigger', text: 'Not drawn from a hand.' },
      ],
    });
    const mine = view.players.find((p) => p.isViewer)!;
    expect(mine.battlefield[0]!.waiting).toEqual([
      { kind: 'trigger', text: 'When you cast your next instant or sorcery spell from your hand this turn, it gains rebound.' },
      { kind: 'effect', text: 'Creatures you control get +1/+1.' },
    ]);
    expect(mine.battlefield.slice(1).every((c) => c.waiting === undefined)).toBe(true);
    expect(mine.hand!.every((c) => c.waiting === undefined), 'a hand card wears none').toBe(true);
  });

  it('with none (the fixture path’s own default) no card carries the key', () => {
    for (const p of adapt(baseState()).players) for (const c of p.battlefield) expect(c).not.toHaveProperty('waiting');
  });
});

describe('condition met — the cards whose condition Forge says is on (the bridge’s conditionMet)', () => {
  it('marks the hand and battlefield cards it names, on either side of the table, and no other', () => {
    const plain = adapt(baseState());
    const me = plain.players.find((p) => p.isViewer)!;
    const them = plain.players.find((p) => !p.isViewer)!;
    const mine = me.battlefield[0]!.id;
    const theirs = them.battlefield[0]!.id;
    const handCard = me.hand![0]!.id;
    const view = toBoardView(baseState(), 27, { viewerPlayerId: fixture.viewerPlayerId, conditionMet: new Set([mine, theirs, handCard]) });
    const lit = view.players.flatMap((p) => [...p.battlefield, ...(p.hand ?? [])]).filter((c) => c.conditionMet === true).map((c) => c.id);
    expect(lit.sort()).toEqual([mine, theirs, handCard].sort());
    expect(view.players.flatMap((p) => p.battlefield).filter((c) => c.id !== mine && c.id !== theirs).every((c) => c.conditionMet === undefined)).toBe(true);
  });

  it('with none (the fixture path’s own default) no card carries the key', () => {
    for (const p of adapt(baseState()).players) for (const c of [...p.battlefield, ...(p.hand ?? [])]) expect(c).not.toHaveProperty('conditionMet');
  });
});

describe('can’t block — the creatures Forge says can’t block (the bridge’s cantBlock)', () => {
  it('marks the battlefield cards it names, on either side of the table, and nothing in a hand', () => {
    const plain = adapt(baseState());
    const me = plain.players.find((p) => p.isViewer)!;
    const them = plain.players.find((p) => !p.isViewer)!;
    const mine = me.battlefield[0]!.id;
    const theirs = them.battlefield[0]!.id;
    const handCard = me.hand![0]!.id;
    const view = toBoardView(baseState(), 27, { viewerPlayerId: fixture.viewerPlayerId, cantBlock: new Set([mine, theirs, handCard]) });
    const all = view.players.flatMap((p) => p.battlefield);
    expect(all.filter((c) => c.cantBlock === true).map((c) => c.id).sort()).toEqual([mine, theirs].sort());
    expect(view.players.find((p) => p.isViewer)!.hand!.every((c) => c.cantBlock === undefined), 'a hand card wears none').toBe(true);
  });

  it('with none (the fixture path’s own default) no card carries the key', () => {
    for (const p of adapt(baseState()).players) for (const c of p.battlefield) expect(c).not.toHaveProperty('cantBlock');
  });
});

/*
 * Emblems — the operator, 2026-10-14. The shape is the bridge's own, read off a real Forge game
 * (`e2e/em-emblems.spec.ts`'s red run, Sorin, Lord of Innistrad's -2): an `EFFECT` card with
 * `IsEmblem`, named `Emblem — <source>`, its face's `SetCode` the emblem's printing and its
 * `AbilityText` the static's own words, listed in its owner's `Command`.
 */
describe('emblems — a player’s IsEmblem cards in their Command zone', () => {
  function putInCommand(state: Map<string, WireObject>, playerId: number, cards: { id: number; name: string; text: string; emblem: boolean }[]): void {
    for (const c of cards) {
      state.set(deltaKey(WireType.Card, c.id), {
        _type: WireType.Card,
        _id: c.id,
        Owner: { t: 'int', v: playerId },
        Zone: { t: 'enum', c: 'forge.game.zone.ZoneType', v: 'Command' },
        GamePieceType: { t: 'enum', c: 'forge.card.GamePieceType', v: 'EFFECT' },
        IsEmblem: { t: 'bool', v: c.emblem },
        CurrentState: { t: 'int', v: 0 },
        Name: { t: 'str', v: c.name },
      } as WireObject);
      state.set(cardStateKey(c.id, 0), {
        _type: WireType.CardState,
        _id: c.id * 16,
        Name: { t: 'str', v: c.name },
        SetCode: { t: 'str', v: 'LCC' },
        AbilityText: { t: 'str', v: c.text },
      } as WireObject);
    }
    setZone(state, playerId, 'Command', cards.map((c) => c.id));
  }

  it('reads each emblem with its source, its words and the source’s art id, for both seats; a non-emblem effect is not one', () => {
    const state = baseState();
    putInCommand(state, 0, [
      { id: 9001, name: 'Emblem — Sorin, Lord of Innistrad', text: 'Creatures you control get +1/+0.', emblem: true },
      { id: 9002, name: "Sorin, Lord of Innistrad's Effect", text: 'Prevent all damage.', emblem: false },
      { id: 9003, name: 'Emblem — Narset Transcendent', text: "Your opponents can't cast noncreature spells.", emblem: true },
    ]);
    const view = adapt(state);
    const owner = view.players.find((p) => p.id === 0)!;
    expect(owner.emblems?.map(({ id, source, text }) => ({ id, source, text }))).toEqual([
      { id: 9001, source: 'Sorin, Lord of Innistrad', text: 'Creatures you control get +1/+0.' },
      { id: 9003, source: 'Narset Transcendent', text: "Your opponents can't cast noncreature spells." },
    ]);
    // The source's art, by its bare name: the emblem's own printing (LCC) has no row.
    expect(owner.emblems?.every((e) => e.scryfallId !== undefined && resolveArtUrl(e.scryfallId, MANIFEST) !== null)).toBe(true);
    expect(view.players.find((p) => p.id === 1)!, 'the other player has none').not.toHaveProperty('emblems');
  });

  it('a player with none carries no key', () => {
    for (const p of adapt(baseState()).players) expect(p).not.toHaveProperty('emblems');
  });
});

/*
 * The storm count — the operator, 2026-10-14: *"show storm counter as an emblem if storm card in
 * hand"*. `GameView.StormCount` is one number for the game; the board puts it on the viewer's own
 * seat while their hand holds a Storm card, and never on another seat.
 */
describe('storm — the game’s storm count on the viewer’s seat while a Storm card is in hand', () => {
  const game = (state: Map<string, WireObject>) => deltaKey(WireType.Game, [...state.values()].find((o) => o._type === WireType.Game)!._id);
  function withStorm(stormCount: number, stormInHand: boolean): Map<string, WireObject> {
    const state = baseState();
    const g = state.get(game(state))!;
    state.set(game(state), { ...g, StormCount: { t: 'int', v: stormCount } } as WireObject);
    const viewer = state.get(deltaKey(WireType.Player, fixture.viewerPlayerId))!;
    const first = (viewer['Hand'] as { v: { v: number }[] }).v[0]!.v;
    const face = state.get(cardStateKey(first, 0))!;
    state.set(cardStateKey(first, 0), { ...face, Keywords: { t: 'keywords', v: stormInHand ? ['Storm'] : [] } } as WireObject);
    return state;
  }

  it('reads the count onto the viewer’s seat, and onto no other', () => {
    const view = adapt(withStorm(3, true));
    expect(view.players.find((p) => p.isViewer)!.storm).toBe(3);
    for (const p of view.players.filter((q) => !q.isViewer)) expect(p, 'another seat never carries it').not.toHaveProperty('storm');
  });

  it('a count of nought is still drawn while the Storm card is in hand', () => {
    expect(adapt(withStorm(0, true)).players.find((p) => p.isViewer)!.storm).toBe(0);
  });

  it('no Storm card in hand, no key', () => {
    for (const p of adapt(withStorm(4, false)).players) expect(p).not.toHaveProperty('storm');
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

  it('reads one band per attacking group: attackers, the defender (0=card, 1=player), and its live blockers', () => {
    const view = adapt(
      withCombat({
        t: 'combat',
        atk: [[10], [20, 21]],
        def: [
          [1, 99], // a player
          [0, 55], // a card: a planeswalker or a battle
        ],
        blk: [[], []],
        pblk: [[], [30]],
      }),
    );
    expect(view.combat).toEqual([
      { attackers: [10], defender: { kind: 'player', id: 99 }, plannedBlockers: [] },
      { attackers: [20, 21], defender: { kind: 'card', id: 55 }, plannedBlockers: [30] },
    ]);
  });

  it('a band with no entry in `blk` reads as blocked by nobody, not a crash', () => {
    const view = adapt(withCombat({ t: 'combat', atk: [[10]], def: [[1, 99]], blk: [], pblk: [] }));
    expect(view.combat).toEqual([
      { attackers: [10], defender: { kind: 'player', id: 99 }, plannedBlockers: [] },
    ]);
  });

  /**
   * Forge sends `blk` only once `AttackingBand.isBlocked()` is set, after
   * declare-blockers has resolved, and then it is the list `pblk` already
   * carries — so `pblk` is the one read, mid-declaration and after.
   */
  it('reads the live map, mid-declaration and once confirmed, and never `blk`', () => {
    const view = adapt(
      withCombat({
        t: 'combat',
        atk: [[10], [20]],
        def: [[1, 99], [1, 98]],
        blk: [[], [41]],
        pblk: [[30], [41]],
      }),
    );
    expect(view.combat).toEqual([
      { attackers: [10], defender: { kind: 'player', id: 99 }, plannedBlockers: [30] },
      { attackers: [20], defender: { kind: 'player', id: 98 }, plannedBlockers: [41] },
    ]);
  });

  it('a band with no entry in `pblk` reads as planning nobody, not a crash', () => {
    const view = adapt(withCombat({ t: 'combat', atk: [[10]], def: [[1, 99]], blk: [], pblk: [] }));
    expect(view.combat![0]!.plannedBlockers).toEqual([]);
  });

  it('is absent-safe: a `CombatView` whose tag is not `combat` reads as no combat', () => {
    const state = baseState();
    const key = gameKey(state);
    state.set(key, { ...state.get(key)!, CombatView: { t: 'bool', v: true } } as WireObject);
    expect(adapt(state).combat).toEqual([]);
  });
});
