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

import { FACE_REGIONS } from '../components/faceCrop.ts';
import artManifest from '../draft/art-manifest.json';
import poolData from '../draft/pool.json';
import {
  abilityTextOf,
  boardPT,
  cardFaces,
  CUBE_ART_IDS,
  drawsFaceUp,
  HIDDEN_CARD_NAME,
  keywordTags,
  KNOWN_ART_IDS,
  POOL_PRINTED_PT,
  printedPTIndex,
  scryfallIdFor,
  toBoardView,
  type BoardCard,
  type BoardView,
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

  // The operator, 2026-10-17: a dying Wurmcoil drew the toxic/trample Wurm. Forge names all three
  // "Phyrexian Wurm Token"; each token's ImageKey names its own tokenscript (token-art.jvm.test.ts).
  it('draws a token by the tokenscript its image key names, never by a name another token shares', () => {
    const state = baseState();
    const mountains = [...state].filter(([key, o]) => o._type === WireType.CardState && key === cardStateKey(o._id >> 4, 0) && (o['Name'] as { v?: unknown } | undefined)?.v === 'Mountain').map(([, o]) => o._id >> 4);
    const [deathtouch, lifelink] = mountains as [number, number];
    for (const [id, script, number] of [
      [deathtouch, 'c_3_3_a_phyrexian_wurm_deathtouch', 29],
      [lifelink, 'c_3_3_a_phyrexian_wurm_lifelink', 30],
    ] as const) {
      renameCard(state, id, 'Phyrexian Wurm Token', '2XM');
      const key = cardStateKey(id, 0);
      state.set(key, { ...state.get(key)!, ImageKey: { t: 'str', v: `t:${script}|2XM|${number}|1` } } as WireObject);
    }
    const byId = new Map(allCards(adapt(state)).map((c) => [c.id, c]));
    expect(byId.get(deathtouch)?.card.scryfallId, 'the deathtouch Wurm, t2xm 29').toBe('b68e816f-f9ac-435b-ad0b-ceedbe72447a');
    expect(byId.get(lifelink)?.card.scryfallId, 'the lifelink Wurm, t2xm 30').toBe('a6ee0db9-ac89-4ab6-ac2e-8a7527d9ecbd');
    expect(scryfallIdFor(KNOWN_ART_IDS, 'Phyrexian Wurm Token', '2XM'), 'what the name alone gave: the toxic Wurm').toBe('594c55d3-d435-4dec-bc92-011442a43684');
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

  // 2026-10-17: "creature gave +1/0 to enhance a creatures power, it should have shown the number in
  // green". A constructed deck's creature is in no table the browser holds, so it drew plain; the
  // bridge's `printedPT` carries Forge's own printed base for it.
  it('reads a creature the cube never held as buffed by Forge’s own printed base (the bridge’s printedPT)', () => {
    const state = baseState();
    renameCard(state, 21, 'Cardtable Constructed Ogre', 'XYZ');
    const face = state.get(cardStateKey(21, 0))!;
    state.set(cardStateKey(21, 0), { ...face, Power: { t: 'int', v: 3 }, Toughness: { t: 'int', v: 2 } } as WireObject);
    const plain = boardPT(cardsById(adapt(state)).get(21)!)!;
    expect([plain.powerState, plain.toughnessState], 'no base known: plain, which is the bug').toEqual(['plain', 'plain']);
    const told = toBoardView(state, 27, { viewerPlayerId: fixture.viewerPlayerId, printedPTs: new Map([[21, { power: 2, toughness: 2 }]]) });
    const pt = boardPT(cardsById(told).get(21)!)!;
    expect([pt.powerState, pt.toughnessState], 'printed 2/2, now 3/2: power up').toEqual(['buffed', 'plain']);
    expect(pt.printed).toEqual({ power: 2, toughness: 2 });
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
    expect(adapt(state).players.find((p) => p.isViewer)!.libraryTop?.[0]?.seenByOpponent).toBe(true);
  });

  it("draws a library's top card only when the seat was sent its name — Courser of Kruphix", () => {
    const state = baseState();
    const id = cardIdNamed(state, 'Mountain');
    const viewer = onLibraryTop(state, id);
    const shown = adapt(state).players.find((p) => p.id === viewer)!;
    expect(shown.libraryTop?.map((c) => c.id)).toEqual([id]);
    expect(shown.libraryTop?.[0]?.card.name).toBe('Mountain');
    redact(state, id);
    expect(adapt(state).players.find((p) => p.id === viewer)!.libraryTop, 'a library card the seat may not see is never drawn').toBeUndefined();
  });

  it('draws every top card the seat knows, top first, up to the first it does not — and none while it sees the whole library (a search)', () => {
    const state = baseState();
    const top = cardIdNamed(state, 'Mountain');
    const under = [...cardsById(adapt(state)).values()].find((c) => c.hidden !== true && c.id !== top)!.id;
    onLibraryTop(state, under);
    const viewer = onLibraryTop(state, top);
    const seat = () => adapt(state).players.find((p) => p.id === viewer)!;
    expect(seat().libraryIds?.slice(0, 2)).toEqual([top, under]);
    expect(seat().libraryTop?.map((c) => c.id), 'a scry that kept both: both, top first').toEqual([top, under]);
    redact(state, under);
    expect(seat().libraryTop?.map((c) => c.id), 'the top alone').toEqual([top]);
    const library = seat().libraryIds!;
    const named = [...cardsById(adapt(state)).values()].find((c) => c.hidden !== true)!.id;
    for (const id of library) state.set(deltaKey(WireType.Card, id), state.get(deltaKey(WireType.Card, named))!);
    expect(seat().libraryTop, 'a look at the whole library is a search, never the board’s').toBeUndefined();
  });

  it('draws nothing under a top card the seat does not know — a card put on top of the ones it knew', () => {
    const state = baseState();
    const known = cardIdNamed(state, 'Mountain');
    const viewer = onLibraryTop(state, known);
    const stranger = [...cardsById(adapt(state)).values()].find((c) => c.hidden !== true && c.id !== known)!.id;
    redact(state, stranger);
    onLibraryTop(state, stranger);
    expect(adapt(state).players.find((p) => p.id === viewer)!.libraryTop).toBeUndefined();
  });

  it('marks a known top card only the viewer may look at, and not one the table saw', () => {
    const state = baseState();
    const top = cardIdNamed(state, 'Mountain');
    const viewer = onLibraryTop(state, top);
    const them = adapt(state).players.find((p) => p.id !== viewer)!.id;
    const card = () => adapt(state).players.find((p) => p.id === viewer)!.libraryTop?.[0];
    mayLook(state, top, [viewer]);
    expect(card()?.onlyViewer, 'a scry of its own, a fate seal').toBe(true);
    mayLook(state, top, [viewer, them]);
    expect(card()?.onlyViewer, 'Courser of Kruphix, Goblin Guide').toBeUndefined();
  });

  it('draws no library top while the open decision shows it — a scry 1’s Top or Bottom, a scry’s order', () => {
    const state = baseState();
    const top = cardIdNamed(state, 'Mountain');
    const viewer = onLibraryTop(state, top);
    const seat = (promptCards: ReadonlySet<number>) =>
      toBoardView(state, 1, { viewerPlayerId: fixture.viewerPlayerId, promptCards }).players.find((p) => p.id === viewer)!;
    expect(seat(new Set()).libraryTop?.map((c) => c.id)).toEqual([top]);
    expect(seat(new Set([top])).libraryTop, 'the decision’s card, not the board’s').toBeUndefined();
  });

  describe('drawsFaceUp: whether a reveal shows the seat anything the board does not', () => {
    /** The ids in `playerId`'s `zone` list, as the wire holds them. */
    const idsIn = (state: Map<string, WireObject>, playerId: number, zone: string): number[] =>
      ((state.get(deltaKey(WireType.Player, playerId))![zone] as { v?: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);

    it("an opponent's hand the seat was shown (Gitaxian Probe) is drawn face up in that hand; before it was shown, it is not", () => {
      const state = baseState();
      const view = adapt(state);
      const me = view.players.find((p) => p.isViewer)!;
      const them = view.players.find((p) => !p.isViewer)!;
      const hand = idsIn(state, them.id, 'Hand');
      expect(hand.length).toBeGreaterThan(0);
      expect(drawsFaceUp(view, hand), 'a hidden hand is not on the board').toBe(false);
      for (const id of hand) mayLook(state, id, [me.id]);
      const shown = adapt(state);
      expect(shown.players.find((p) => !p.isViewer)!.handShown?.map((c) => c?.id)).toEqual(hand);
      expect(drawsFaceUp(shown, hand)).toBe(true);
    });

    it("the viewer's own hand, a battlefield and the known run on top of a library are drawn; the library under it is not", () => {
      const state = baseState();
      const view = adapt(state);
      const me = view.players.find((p) => p.isViewer)!;
      const them = view.players.find((p) => !p.isViewer)!;
      expect(drawsFaceUp(view, [...me.hand!.map((c) => c.id), ...them.battlefield.map((c) => c.id)])).toBe(true);
      // A card the seat holds the name of but the board draws nowhere, put on top of its library.
      const top = idsIn(state, them.id, 'Hand')[0]!;
      const under = idsIn(state, me.id, 'Library')[0]!;
      expect(drawsFaceUp(view, [top]), 'not on the board yet').toBe(false);
      onLibraryTop(state, top);
      const withTop = adapt(state);
      expect(withTop.players.find((p) => p.isViewer)!.libraryTop?.map((c) => c.id), 'the top alone is known: the run on top').toEqual([top]);
      expect(drawsFaceUp(withTop, [top]), 'a revealed top card').toBe(true);
      expect(drawsFaceUp(withTop, [under]), 'a library card the board does not draw').toBe(false);
      expect(drawsFaceUp(withTop, [top, under]), 'one card the board does not draw is enough').toBe(false);
    });

    it('a face-down card is not drawn face up, and an empty reveal is not drawn', () => {
      const state = baseState();
      const view = adapt(state);
      const id = view.players.find((p) => p.isViewer)!.battlefield[0]!.id;
      redact(state, id);
      expect(drawsFaceUp(adapt(state), [id])).toBe(false);
      expect(drawsFaceUp(view, [])).toBe(false);
    });
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

  it('gives the unheld seat’s face (Forge’s AI, as a room character) to the one player no seat names, and to nobody a seat names', () => {
    const view = toBoardView(baseState(), 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      avatarByPlayerId: new Map([[fixture.viewerPlayerId, 'wanderer']]),
      unclaimed: { avatarId: 'mage', seated: new Set([fixture.viewerPlayerId]) },
    });
    expect(view.players.find((p) => p.isViewer)).toHaveProperty('avatarId', 'wanderer');
    expect(view.players.find((p) => !p.isViewer)).toHaveProperty('avatarId', 'mage');

    const bare = toBoardView(baseState(), 27, {
      viewerPlayerId: fixture.viewerPlayerId,
      avatarByPlayerId: new Map(),
      unclaimed: { avatarId: 'mage', seated: new Set([fixture.viewerPlayerId]) },
    });
    expect(bare.players.find((p) => p.isViewer), 'a named seat with no face keeps none').not.toHaveProperty('avatarId');
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
 * Extra turns — the operator, 2026-10-19: *"when a player has extra turns, this kind of thing should
 * be visible somewhere around their portrait"*. `PlayerView.ExtraTurnCount` is the turns to come,
 * public, on every seat; `PlayerView.IsExtraTurn` is Forge's flag that the player's turn is an
 * extra one, set when a turn begins on the player whose turn it is and left behind on the player
 * who took one when the other's turn begins — so it counts only on the active player.
 */
describe('extra turns — the turns to come on every seat, and the mark on the seat taking one', () => {
  const game = (state: Map<string, WireObject>) => deltaKey(WireType.Game, [...state.values()].find((o) => o._type === WireType.Game)!._id);
  function withTurns(active: number, players: Record<number, { count?: number; isExtra?: boolean }>): Map<string, WireObject> {
    const state = baseState();
    state.set(game(state), { ...state.get(game(state))!, PlayerTurn: { t: 'int', v: active } } as WireObject);
    for (const [pid, { count, isExtra }] of Object.entries(players)) {
      const key = deltaKey(WireType.Player, Number(pid));
      state.set(key, {
        ...state.get(key)!,
        ...(count === undefined ? {} : { ExtraTurnCount: { t: 'int', v: count } }),
        ...(isExtra === undefined ? {} : { IsExtraTurn: { t: 'bool', v: isExtra } }),
      } as WireObject);
    }
    return state;
  }
  const player = (view: BoardView, id: number) => view.players.find((p) => p.id === id)!;

  it('reads the turns to come onto whichever seat has them, the viewer’s or not', () => {
    const view = adapt(withTurns(0, { 0: { count: 0 }, 1: { count: 2 } }));
    expect(player(view, 1).extraTurns).toBe(2);
    expect(player(view, 0), 'none to come, no key').not.toHaveProperty('extraTurns');
    expect(player(adapt(withTurns(1, { 0: { count: 1 } })), 0).extraTurns, 'the viewer’s own too').toBe(1);
  });

  it('marks the active player’s extra turn, and never a flag Forge left on a player whose turn it is not', () => {
    expect(player(adapt(withTurns(0, { 0: { isExtra: true } })), 0).extraTurn).toBe(true);
    const after = adapt(withTurns(1, { 0: { isExtra: true }, 1: { isExtra: false } }));
    for (const p of after.players) expect(p, `seat ${p.id}: the turn after an extra one is not one`).not.toHaveProperty('extraTurn');
  });

  it('nothing on the wire, no keys', () => {
    for (const p of adapt(baseState()).players) {
      expect(p).not.toHaveProperty('extraTurns');
      expect(p).not.toHaveProperty('extraTurn');
    }
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

/*
 * The operator, 2026-10-17: "show transformed cards with mousewheel (Fable of the Mirror-Breaker)" and
 * "flip cards should show both art". A card's other faces come off the face states Forge sends beside
 * its current one: `AlternateState` for a transformed or modal double-faced card, the split states for
 * a split card. Card 21 is turned into each, in place.
 */
describe('a card’s other faces', () => {
  /** Give card 21 a face state at `v`, named `name`, typed `core`. */
  function addFace(state: Map<string, WireObject>, v: number, name: string, core: string[], setCode = 'NEO', own: Record<string, unknown> = {}): void {
    const front = state.get(cardStateKey(21, 0))!;
    state.set(cardStateKey(21, v), {
      ...front,
      _id: 21 * 16 + v,
      Name: { t: 'str', v: name },
      SetCode: { t: 'str', v: setCode },
      Type: { t: 'cardtype', sup: [], core, sub: [], all: false, exc: [] },
      ...own,
    } as WireObject);
  }

  /** Card 21 as a split card `whole` with halves `left` and `right` — Forge's ordinals 5 and 6, its other side the right half. */
  function splitCard(whole: string, setCode: string, left: [string, string, string], right: [string, string, string], rightKeywords: string[] = []): Map<string, WireObject> {
    const state = baseState();
    renameCard(state, 21, whole, setCode);
    const half = ([, cost, text]: [string, string, string], keywords: string[]) => ({
      ManaCost: { t: 'manacost', v: cost },
      OracleText: { t: 'str', v: text },
      Keywords: { t: 'keywords', v: keywords },
    });
    addFace(state, 5, left[0], ['Instant'], setCode, half(left, []));
    addFace(state, 6, right[0], ['Instant'], setCode, half(right, rightKeywords));
    setCard(state, 21, 'LeftSplitState', { t: 'int', v: 5 });
    setCard(state, 21, 'RightSplitState', { t: 'int', v: 6 });
    setCard(state, 21, 'AlternateState', { t: 'int', v: 6 });
    return state;
  }

  it('carries a transformed card’s other face, with that face’s own art', () => {
    const state = baseState();
    renameCard(state, 21, 'Fable of the Mirror-Breaker', 'NEO');
    addFace(state, 3, 'Reflection of Kiki-Jiki', ['Enchantment', 'Creature']);
    setCard(state, 21, 'AlternateState', { t: 'int', v: 3 });
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.card.faces?.map((f) => f.name)).toEqual(['Reflection of Kiki-Jiki']);
    expect(card.card.faces?.[0]?.scryfallId, 'the back face’s own art').toBe(scryfallIdFor(KNOWN_ART_IDS, 'Reflection of Kiki-Jiki', 'NEO'));
    expect(card.card.faces?.[0]?.scryfallId).not.toBe(card.card.scryfallId);
    expect(cardFaces(state, 21).map((f) => f.name), 'the face on show first').toEqual(['Fable of the Mirror-Breaker', 'Reflection of Kiki-Jiki']);
  });

  /*
   * Etali, Primal Conqueror as Forge sends it to its owner: the front on show, `AlternateState` naming
   * the transformed back, Etali, Primal Sickness. On the stack — cast, so in no zone list — the spell's
   * card still carries the back face for the stack's tile to draw.
   */
  it('carries Etali, Primal Conqueror’s back on the stack too, with the back’s own art', () => {
    const state = baseState();
    renameCard(state, 21, 'Etali, Primal Conqueror', 'MOM');
    addFace(state, 1, 'Etali, Primal Sickness', ['Creature'], 'MOM');
    setCard(state, 21, 'AlternateState', { t: 'int', v: 1 });
    const { id: sid } = adapt(state).stack[0]!;
    const key = deltaKey(WireType.StackItem, sid);
    state.set(key, { ...state.get(key)!, Ability: { t: 'bool', v: false }, SourceCard: { t: 'int', v: 21 } } as WireObject);
    for (const { id: pid } of adapt(state).players) {
      for (const zone of ['Hand', 'Library', 'Battlefield', 'Graveyard', 'Exile']) {
        const list = ((state.get(deltaKey(WireType.Player, pid))?.[zone] as { v?: { v: number }[] } | undefined)?.v ?? []).map((t) => t.v);
        setZone(state, pid, zone, list.filter((id) => id !== 21));
      }
    }
    const spell = adapt(state).stack.find((i) => i.id === sid)!;
    expect(spell.sourceCard?.name).toBe('Etali, Primal Conqueror');
    expect(spell.sourceCard?.faces?.map((f) => f.name)).toEqual(['Etali, Primal Sickness']);
    expect(spell.sourceCard?.faces?.[0]?.scryfallId).toBe('95c14c4d-6c16-4826-8d93-d89ad04aee09#back');
  });

  it('carries a split card’s halves, drawn with the card’s art where a half has none of its own', () => {
    const state = baseState();
    renameCard(state, 21, 'Fire // Ice', 'DMR');
    addFace(state, 5, 'Fire', ['Instant'], 'DMR');
    addFace(state, 6, 'Ice', ['Instant'], 'DMR');
    setCard(state, 21, 'LeftSplitState', { t: 'int', v: 5 });
    setCard(state, 21, 'RightSplitState', { t: 'int', v: 6 });
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.card.faces?.map((f) => f.name)).toEqual(['Fire', 'Ice']);
    expect(card.card.faces?.every((f) => f.scryfallId === card.card.scryfallId)).toBe(true);
  });

  // The operator, 2026-10-19: "i see the entire split card in both choices so i can't really tell which one is wish".
  it('crops a split card’s halves to their own part of its image, turned upright, each with its own name, cost and text', () => {
    const state = splitCard('Fire // Ice', 'AP', ['Fire', '1\u0006RED', 'Fire deals 2 damage divided as you choose'], ['Ice', '1\u0006BLUE', 'Tap target permanent.\nDraw a card.']);
    const whole = cardsById(adapt(state)).get(21)!;
    const faces = whole.card.faces!;
    expect(faces.map((f) => [f.name, f.faceCrop])).toEqual([['Fire', 'split-left'], ['Ice', 'split-right']]);
    expect(faces.map((f) => FACE_REGIONS[f.faceCrop!].rotate), 'printed sideways: a quarter turn clockwise reads them').toEqual([90, 90]);
    expect(faces.map((f) => [f.manaCost, f.oracleText])).toEqual([
      [['1', 'R'], 'Fire deals 2 damage divided as you choose'],
      [['1', 'U'], 'Tap target permanent.\nDraw a card.'],
    ]);
    expect(faces.every((f) => f.scryfallId === whole.card.scryfallId), 'the card’s own image').toBe(true);
    expect(cardFaces(state, 21).map((f) => [f.name, f.faceCrop]), 'the whole card first, uncropped — a fuse spell’s face').toEqual([
      ['Fire // Ice', undefined],
      ['Fire', 'split-left'],
      ['Ice', 'split-right'],
    ]);
  });

  it('crops an aftermath card’s halves: the first upright at the top, the second turned the other way', () => {
    const state = splitCard('Cut // Ribbons', 'AKH', ['Cut', '1\u0006RED', 'Cut deals 4 damage to target creature.'], ['Ribbons', '0\u0006X\u0006BLACK\u0006BLACK', 'Each opponent loses X life.'], ['Aftermath']);
    const faces = cardsById(adapt(state)).get(21)!.card.faces!;
    expect(faces.map((f) => [f.name, f.faceCrop, FACE_REGIONS[f.faceCrop!].rotate])).toEqual([
      ['Cut', 'aftermath-top', 0],
      ['Ribbons', 'aftermath-bottom', -90],
    ]);
  });

  it('crops an adventure to its inset, and leaves a double-faced card’s back whole', () => {
    const state = baseState();
    renameCard(state, 21, 'Bonecrusher Giant', 'ELD');
    addFace(state, 7, 'Stomp', ['Instant'], 'ELD', { OracleText: { t: 'str', v: 'Stomp deals 2 damage to any target.' } });
    setCard(state, 21, 'AlternateState', { t: 'int', v: 7 });
    const giant = cardsById(adapt(state)).get(21)!;
    expect(giant.card.faces!.map((f) => [f.name, f.faceCrop, f.oracleText, f.scryfallId === giant.card.scryfallId])).toEqual([
      ['Stomp', 'adventure', 'Stomp deals 2 damage to any target.', true],
    ]);

    // Its own name alone could name another printing (Stomp|CLB); the face is printed on this card's image.
    const other = baseState();
    renameCard(other, 21, 'Bonecrusher Giant', 'ELD');
    addFace(other, 7, 'Stomp', ['Instant'], 'CLB');
    setCard(other, 21, 'AlternateState', { t: 'int', v: 7 });
    expect(scryfallIdFor(KNOWN_ART_IDS, 'Stomp', 'CLB')).not.toBe(scryfallIdFor(KNOWN_ART_IDS, 'Bonecrusher Giant', 'ELD'));
    expect(cardsById(adapt(other)).get(21)!.card.faces![0]!.scryfallId).toBe(scryfallIdFor(KNOWN_ART_IDS, 'Bonecrusher Giant', 'ELD'));

    const dfc = baseState();
    renameCard(dfc, 21, 'Fable of the Mirror-Breaker', 'NEO');
    addFace(dfc, 3, 'Reflection of Kiki-Jiki', ['Enchantment', 'Creature']);
    setCard(dfc, 21, 'AlternateState', { t: 'int', v: 3 });
    expect(cardsById(adapt(dfc)).get(21)!.card.faces![0]!.faceCrop).toBeUndefined();
  });

  it('carries none for a face-down card — its other face is what is hidden — nor for a card with one face', () => {
    const state = baseState();
    addFace(state, 3, 'Reflection of Kiki-Jiki', ['Enchantment', 'Creature']);
    setCard(state, 21, 'AlternateState', { t: 'int', v: 3 });
    setCard(state, 21, 'Facedown', { t: 'bool', v: true });
    expect(cardsById(adapt(state)).get(21)!.card.faces).toBeUndefined();
    expect(cardsById(adapt(baseState())).get(21)!.card.faces).toBeUndefined();
  });
});

/*
 * The operator, 2026-10-19: "cards like 'Walk-In Closet' it's hard to tell whats actually going on.
 * which room was played, which room is active? has the door been unlocked?" Forge shows a Room's
 * unlocked doors as its current state, measured in `apps/server/src/play/rooms.jvm.test.ts`: the cast
 * door's split state (5 or 6), `Original` (0) for both, `EmptyRoom` (9, nameless) for neither. Card 21
 * is made Walk-In Closet // Forgotten Cellar on the viewer's battlefield, as that wire has it.
 */
describe('a Room’s doors', () => {
  const ROOM = 'Walk-In Closet // Forgotten Cellar';

  function roomState(current: number, where: 'Battlefield' | 'Hand' = 'Battlefield'): Map<string, WireObject> {
    const state = baseState();
    const front = state.get(cardStateKey(21, 0))!;
    const face = (v: number, name: string): void => {
      state.set(cardStateKey(21, v), {
        ...front,
        _id: 21 * 16 + v,
        Name: { t: 'str', v: name },
        SetCode: { t: 'str', v: 'DSK' },
        OracleText: { t: 'str', v: `${name} text` },
      } as WireObject);
    };
    face(0, ROOM);
    face(5, 'Walk-In Closet');
    face(6, 'Forgotten Cellar');
    face(9, '');
    setCard(state, 21, 'Room', { t: 'bool', v: true });
    setCard(state, 21, 'LeftSplitState', { t: 'int', v: 5 });
    setCard(state, 21, 'RightSplitState', { t: 'int', v: 6 });
    setCard(state, 21, 'CurrentState', { t: 'int', v: current });
    setCard(state, 21, 'Zone', { t: 'enum', c: 'forge.game.zone.ZoneType', v: where });
    const pid = fixture.viewerPlayerId;
    for (const { id } of adapt(state).players) {
      for (const zone of ['Hand', 'Library', 'Battlefield', 'Graveyard', 'Exile']) {
        const list = ((state.get(deltaKey(WireType.Player, id))?.[zone] as { v?: { v: number }[] } | undefined)?.v ?? []).map((t) => t.v);
        setZone(state, id, zone, [...list.filter((c) => c !== 21), ...(id === pid && zone === where ? [21] : [])]);
      }
    }
    return state;
  }
  const doorsOf = (state: Map<string, WireObject>) => cardsById(adapt(state)).get(21)!.doors;

  it('none unlocked: both doors locked, and the Room is drawn whole, not as its nameless face', () => {
    const state = roomState(9);
    // A Room put onto the battlefield uncast: its whole face never reaches the seat.
    state.delete(cardStateKey(21, 0));
    expect(doorsOf(state)).toEqual([{ name: 'Walk-In Closet', unlocked: false }, { name: 'Forgotten Cellar', unlocked: false }]);
    const card = cardsById(adapt(state)).get(21)!;
    expect(card.hidden).toBe(false);
    expect(card.card.name).toBe(ROOM);
    expect(card.card.scryfallId, 'the whole Room’s art').toBe(scryfallIdFor(KNOWN_ART_IDS, ROOM, 'DSK'));
    expect(card.card.oracleText, 'its left door’s face stands in for the whole one').toBe('Walk-In Closet text');
  });

  it('the cast door alone unlocked, whichever it was', () => {
    expect(doorsOf(roomState(5))).toEqual([{ name: 'Walk-In Closet', unlocked: true }, { name: 'Forgotten Cellar', unlocked: false }]);
    expect(doorsOf(roomState(6))).toEqual([{ name: 'Walk-In Closet', unlocked: false }, { name: 'Forgotten Cellar', unlocked: true }]);
  });

  it('both unlocked', () => {
    expect(doorsOf(roomState(0))).toEqual([{ name: 'Walk-In Closet', unlocked: true }, { name: 'Forgotten Cellar', unlocked: true }]);
  });

  it('the whole Room is shown, and its doors are its other faces for the inspector', () => {
    const card = cardsById(adapt(roomState(5))).get(21)!;
    expect(card.card.name).toBe(ROOM);
    expect(card.card.oracleText, 'the whole card, not the door Forge shows').toBe(`${ROOM} text`);
    expect(card.card.faces?.map((f) => f.name)).toEqual(['Walk-In Closet', 'Forgotten Cellar']);
  });

  it('its doors are its faces, each cropped to its half of the card and marked with its state', () => {
    const card = cardsById(adapt(roomState(5))).get(21)!;
    expect(card.card.faces?.map((f) => [f.name, f.faceCrop, f.door])).toEqual([
      ['Walk-In Closet', 'split-left', 'unlocked'],
      ['Forgotten Cellar', 'split-right', 'locked'],
    ]);
  });

  it('a choice between a never-cast Room’s unlocks is drawn as its doors, both locked', () => {
    const state = roomState(9);
    state.delete(cardStateKey(21, 0));
    expect(cardFaces(state, 21).map((f) => [f.name, f.door])).toEqual([
      [ROOM, undefined],
      ['Walk-In Closet', 'locked'],
      ['Forgotten Cellar', 'locked'],
    ]);
    expect(cardFaces(roomState(0, 'Hand'), 21).map((f) => f.door), 'in hand, a cast choice: no door is locked or unlocked').toEqual([undefined, undefined, undefined]);
  });

  it('no doors for a Room in hand — its doors lock and unlock only on the battlefield — nor for any other card', () => {
    expect(doorsOf(roomState(0, 'Hand'))).toBeUndefined();
    expect(cardsById(adapt(baseState())).get(21)!.doors).toBeUndefined();
  });
});
