import { describe, expect, it } from 'vitest';

import type { DraftCard } from '@hadoku/shared';

import { cardStateKey, DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';

import { toBoardView, type BoardCard, type BoardPlayer, type BoardView, type StackEntry } from '../adapter.ts';
import { loadPackets, PLAY_FIXTURES } from '../fixtures.ts';
import { foldPackets } from '../fold.ts';
import { type WireObject } from '../wire.ts';
import { damagePower } from '../motion.ts';
import type { DelayedSoundEvent } from '../../sound/index.ts';
import poolData from '../../draft/pool.json' with { type: 'json' };
import { attackDeclared, castRole, colourCell, colourRow, deriveSoundEvents, LAND_THUD_DELAY_MS, UNTAP_REPEAT_GAP_MS, UNTAP_REPEAT_MAX, wasShuffled } from './sound-events.ts';

function card(typeLine: string, colors: DraftCard['colors'] = [], oracleText = ''): DraftCard {
  return {
    cardId: typeLine,
    name: typeLine,
    manaCost: [],
    manaValue: 0,
    colors,
    typeLine,
    oracleText,
    setCode: 'tst',
    collectorNumber: '1',
    rarity: 'common',
  };
}

function entry(id: number, c: DraftCard, extra: Partial<BoardCard> = {}): BoardCard {
  return { id, card: c, tapped: false, summoningSick: false, damage: 0, counters: [], attacking: false, blocking: false, token: false, ...extra };
}

function player(id: number, isViewer: boolean, extra: Partial<BoardPlayer> = {}): BoardPlayer {
  return {
    id,
    name: isViewer ? 'alice' : 'bob',
    life: 20,
    isViewer,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: isViewer ? [] : null,
    handCount: 5,
    libraryCount: 30,
    battlefield: [],
    graveyard: [],
    exile: [],
    ...extra,
  };
}

function view(seq: number, me: Partial<BoardPlayer>, them: Partial<BoardPlayer> = {}, extra: Partial<BoardView> = {}): BoardView {
  return {
    seq,
    title: '',
    turn: 3,
    phase: 'MAIN1',
    phaseLabel: 'Main',
    activePlayerId: 1,
    players: [player(1, true, me), player(2, false, them)],
    stack: [],
    gameOver: false,
    missingCardIds: [],
    ...extra,
  };
}

function spell(id: number, c: DraftCard, controllerName: string, isAbility = false): StackEntry {
  return { id, description: c.name, sourceCardId: 100 + id, sourceName: c.name, sourceCard: c, controllerName, isAbility } as StackEntry;
}

const ids = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);
/** A fixed reordering that keeps no neighbours: odds then evens, reversed. */
const scramble = (list: readonly number[]): number[] => [...list.filter((_, i) => i % 2 === 1), ...list.filter((_, i) => i % 2 === 0)].reverse();

const BEAR = card('Creature — Bear', ['G']);
const GOLEM = card('Artifact Creature — Golem');
const FOREST = card('Basic Land — Forest');
const BOLT = card('Instant', ['R']);

/*
 * Every land in the pool and the colour cell it sounds. A land added to the pool shows up here as a
 * diff, so it gets a decision. Multiversal Passage is colourless until it chooses (the chosen-type
 * case below); a land that adds, fetches and grants nothing coloured (Ancient Tomb, Wasteland…)
 * stays colourless.
 */
const POOL_LAND_ROWS: Readonly<Record<string, string>> = {
  'Abandoned Air Temple': 'W|land',
  'Witch Enchanter // Witch-Blessed Meadow': 'W|creature',
  'Otawara, Soaring City': 'U|land',
  'Shelldock Isle': 'U|land',
  'Sink into Stupor // Soporific Springs': 'U|spell',
  'Urborg, Tomb of Yawgmoth': 'B|land',
  'Arena of Glory': 'R|land',
  'Sundering Eruption // Volcanic Fissure': 'R|spell',
  'Boseiju, Who Endures': 'G|land',
  'Shifting Woodland': 'G|land',
  'Yavimaya, Cradle of Growth': 'G|land',
  'Celestial Colonnade': 'WU|land',
  'Flooded Strand': 'WU|land',
  'Hallowed Fountain': 'WU|land',
  'Meticulous Archive': 'WU|land',
  'Seachrome Coast': 'WU|land',
  'Tundra': 'WU|land',
  'Creeping Tar Pit': 'UB|land',
  'Darkslick Shores': 'UB|land',
  'Polluted Delta': 'UB|land',
  'Undercity Sewers': 'UB|land',
  'Underground Sea': 'UB|land',
  'Watery Grave': 'UB|land',
  'Badlands': 'BR|land',
  'Blackcleave Cliffs': 'BR|land',
  'Blazemire Verge': 'BR|land',
  'Blood Crypt': 'BR|land',
  'Bloodstained Mire': 'BR|land',
  'Raucous Theater': 'BR|land',
  'Commercial District': 'RG|land',
  'Copperline Gorge': 'RG|land',
  'Stomping Ground': 'RG|land',
  'Taiga': 'RG|land',
  'Thornspire Verge': 'RG|land',
  'Wooded Foothills': 'RG|land',
  'Horizon Canopy': 'GW|land',
  'Lush Portico': 'GW|land',
  'Razorverge Thicket': 'GW|land',
  'Savannah': 'GW|land',
  'Temple Garden': 'GW|land',
  'Windswept Heath': 'GW|land',
  'Bleachbone Verge': 'WB|land',
  'Concealed Courtyard': 'WB|land',
  'Godless Shrine': 'WB|land',
  'Marsh Flats': 'WB|land',
  'Scrubland': 'WB|land',
  'Shadowy Backstreet': 'WB|land',
  'Riverpyre Verge': 'UR|land',
  'Scalding Tarn': 'UR|land',
  'Spirebluff Canal': 'UR|land',
  'Steam Vents': 'UR|land',
  'Thundering Falls': 'UR|land',
  'Volcanic Island': 'UR|land',
  'Bayou': 'BG|land',
  'Blooming Marsh': 'BG|land',
  'Overgrown Tomb': 'BG|land',
  'Underground Mortuary': 'BG|land',
  'Verdant Catacombs': 'BG|land',
  'Wastewood Verge': 'BG|land',
  'Arid Mesa': 'RW|land',
  'Elegant Parlor': 'RW|land',
  'Inspiring Vantage': 'RW|land',
  'Plateau': 'RW|land',
  'Sacred Foundry': 'RW|land',
  'Sunbaked Canyon': 'RW|land',
  'Botanical Sanctum': 'GU|land',
  'Breeding Pool': 'GU|land',
  'Hedge Maze': 'GU|land',
  'Misty Rainforest': 'GU|land',
  'Tropical Island': 'GU|land',
  'Waterlogged Grove': 'GU|land',
  "Spara's Headquarters": 'GWU|land',
  "Raffine's Tower": 'WUB|land',
  "Xander's Lounge": 'UBR|land',
  'Twisted Landscape': 'BRG|land',
  "Ziatora's Proving Ground": 'BRG|land',
  "Jetmir's Garden": 'RGW|land',
  'Sheltering Landscape': 'RGW|land',
  'Savai Triome': 'RWB|land',
  'Bountiful Landscape': 'GUR|land',
  'Ketria Triome': 'GUR|land',
  'Indatha Triome': 'WBG|land',
  'Raugrin Triome': 'URW|land',
  'Zagoth Triome': 'BGU|land',
  'Ancient Tomb': 'C|land',
  'Bazaar of Baghdad': 'C|land',
  'City of Traitors': 'C|land',
  'Dark Depths': 'C|land',
  'Fabled Passage': 'WUBRG|land',
  "Gaea's Cradle": 'G|land',
  'Karakas': 'W|land',
  'Library of Alexandria': 'C|land',
  'Mana Confluence': 'WUBRG|land',
  "Mishra's Workshop": 'C|land',
  'Multiversal Passage': 'C|land',
  'Prismatic Vista': 'WUBRG|land',
  'Starting Town': 'WUBRG|land',
  'Strip Mine': 'C|land',
  'Talon Gates of Madara': 'WUBRG|land',
  "Thespian's Stage": 'C|land',
  'Tolarian Academy': 'U|land',
  "Urza's Saga": 'C|land',
  'Wasteland': 'C|land',
};

describe('colours and types', () => {
  it('spells a colour set the way COLOUR_IDS does', () => {
    expect(colourRow([])).toBe('C');
    expect(colourRow(['G'])).toBe('G');
    expect(colourRow(['G', 'R'])).toBe('RG');
    expect(colourRow(['W', 'B', 'G'])).toBe('WBG');
    expect(colourRow(['W', 'U', 'B', 'R'])).toBe('WUBRG');
  });

  it('layers a card by its paradigm, and a basic land by its land type', () => {
    expect(colourCell(entry(1, BEAR))).toBe('G|creature');
    expect(colourCell(entry(1, GOLEM))).toBe('C|artifact-creature');
    expect(colourCell(entry(1, FOREST))).toBe('G|basic');
    expect(colourCell(entry(1, card('Enchantment')))).toBeNull();
    // An artifact sounds the colourless cell whatever its colours (2026-10-10).
    expect(colourCell(entry(1, card('Artifact Creature — Construct', ['U', 'R'])))).toBe('C|artifact-creature');
    expect(colourCell(entry(1, card('Artifact — Equipment', ['W'])))).toBe('C|artifact');
  });

  it('splits a mono colour’s basic land from its other lands (2026-10-10)', () => {
    expect(colourCell(entry(1, card('Basic Snow Land — Island')))).toBe('U|basic');
    // A nonbasic land is coloured by the mana its text adds.
    expect(colourCell(entry(1, card('Land', [], '{T}: Add {C}.\n{T}, Pay 1 life: Add {R}.')))).toBe('R|land');
    expect(colourCell(entry(1, card('Land', [], '{T}: Add {W} or {U}.')))).toBe('WU|land');
    // A dual by its basic types, Wastes and a land that adds nothing coloured are colourless.
    expect(colourCell(entry(1, card('Land — Island Mountain')))).toBe('UR|land');
    expect(colourCell(entry(1, card('Basic Land')))).toBe('C|land');
    expect(colourCell(entry(1, card('Land', [], '{T}: Add {C}.')))).toBe('C|land');
    expect(colourCell(entry(1, card('Land', [], '{T}: Add one mana of any color.')))).toBe('WUBRG|land');
  });

  it('sounds a fetch land as the basic land types it can fetch', () => {
    const tarn = card('Land', [], '{T}, Pay 1 life, Sacrifice this land: Search your library for an Island or Mountain card, put it onto the battlefield, then shuffle.');
    expect(colourCell(entry(1, tarn))).toBe('UR|land');
    // A Landscape adds {C} but fetches three basic types.
    expect(colourCell(entry(1, card('Land', [], '{T}: Add {C}.\n{T}, Sacrifice this land: Search your library for a basic Swamp, Mountain, or Forest card, put it onto the battlefield tapped, then shuffle.')))).toBe('BRG|land');
    // "A basic land card" is any basic: all five.
    expect(colourCell(entry(1, card('Land', [], '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.')))).toBe('WUBRG|land');
    // Another player's search is not this land's colours.
    expect(colourCell(entry(1, card('Land', [], 'Its controller may search their library for a basic Island card.')))).toBe('C|land');
    // Naming a type it only checks for ("if you control a Mountain") is not a colour either.
    expect(colourCell(entry(1, card('Land', [], 'This land enters tapped unless you control a Mountain.\n{T}: Add {C}.')))).toBe('C|land');
  });

  it('sounds a land that makes every land a basic type as that type', () => {
    expect(colourCell(entry(1, card('Legendary Land', [], 'Each land is a Swamp in addition to its other land types.')))).toBe('B|land');
    expect(colourCell(entry(1, card('Legendary Land', [], 'Each land is a Forest in addition to its other land types.')))).toBe('G|land');
  });

  it('sounds a land by the basic land type it chose', () => {
    const passage = card('Land', [], "As this land enters, choose a basic land type. Then you may pay 2 life. If you don't, it enters tapped.\nThis land is the chosen type.");
    expect(colourCell(entry(1, passage, { choices: [{ kind: 'type', values: ['Island'] }] }))).toBe('U|land');
    expect(colourCell(entry(1, passage)), 'before it has chosen, nothing').toBe('C|land');
    // A chosen creature type (Cavern of Souls') is no colour.
    expect(colourCell(entry(1, card('Land', [], '{T}: Add {C}.'), { choices: [{ kind: 'type', values: ['Elf'] }] }))).toBe('C|land');
  });

  it('sounds a modal double-faced card played as its land by the land face Forge has in play', () => {
    // Forge plays the land face by setting the card's state to `Backside` (`Card.setSplitStateToPlayAbility`,
    // `CardSplitType.Modal`), so its view's `CurrentState` is ordinal 3 — the face the adapter reads.
    const fixture = PLAY_FIXTURES[0]!;
    const folded = foldPackets(loadPackets(fixture));
    const state = new Map(folded.state);
    const seq = folded.seq;
    const id = toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId }).players.flatMap((p) => p.battlefield)[0]!.id;
    const BACKSIDE = 3;
    const original = state.get(cardStateKey(id, 0))!;
    const face = (name: string, core: string[], text: string): WireObject =>
      ({ ...original, _id: id * 16 + BACKSIDE, Name: { t: 'str', v: name }, Type: { t: 'cardtype', sup: [], core, sub: [], all: false, exc: [] }, OracleText: { t: 'str', v: text } }) as WireObject;
    state.set(cardStateKey(id, 0), { ...face('Sink into Stupor', ['Instant'], 'Return target spell or nonland permanent an opponent controls to its owner’s hand.'), _id: id * 16 });
    state.set(cardStateKey(id, BACKSIDE), face('Soporific Springs', ['Land'], "As Soporific Springs enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {U}."));
    const key = deltaKey(DELTA_TYPE.card, id);
    state.set(key, { ...state.get(key)!, CurrentState: { t: 'int', v: BACKSIDE } } as WireObject);
    const springs = toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId }).players.flatMap((p) => p.battlefield).find((c) => c.id === id)!;
    expect(springs.card.name).toBe('Soporific Springs');
    expect(colourCell(springs)).toBe('U|land');
  });

  it('pins the row of every land in the pool', () => {
    // The pool carries a two-faced card's front face only (its text, and no colours), so those rows
    // are the front face's; the land face in play is the case above.
    const rows = Object.fromEntries(
      poolData.cards
        .filter((c) => /\bLand\b/.test(c.typeLine))
        .map((c) => [c.name, colourCell(entry(1, { ...c, typeLine: c.typeLine.split(' // ')[0]! } as DraftCard))]),
    );
    expect(rows).toEqual(POOL_LAND_ROWS);
  });

  it('names the cast by the most specific type', () => {
    expect(castRole('Artifact Creature — Golem')).toBe('g.cast.creature');
    expect(castRole('Legendary Planeswalker — Jace')).toBe('g.cast.planeswalker');
    expect(castRole('Instant')).toBe('g.cast.instant');
    expect(castRole('Sorcery')).toBe('g.cast.sorcery');
    expect(castRole('Enchantment — Aura')).toBe('g.cast.enchantment');
  });
});

describe('deriveSoundEvents', () => {
  it('says nothing for the first view, or a view that is not newer', () => {
    const v = view(5, {});
    expect(deriveSoundEvents(null, v)).toEqual([]);
    expect(deriveSoundEvents(v, view(5, {}))).toEqual([]);
  });

  it('a creature spell: the quiet cast, then on resolution its voice, then the thud', () => {
    const before = view(1, { hand: [entry(101, BEAR)], handCount: 1 });
    const cast = view(2, { hand: [], handCount: 0 }, {}, { stack: [spell(1, BEAR, 'alice')] });
    expect(deriveSoundEvents(before, cast)).toEqual([{ role: 'g.cast.creature', seat: 'me' }]);

    const resolved = view(3, { hand: [], handCount: 0, battlefield: [entry(101, BEAR)] });
    expect(deriveSoundEvents(cast, resolved)).toEqual([
      { role: 'g.resolve', seat: 'me' },
      { role: 'g.creature', seat: 'me', colourCell: 'G|creature', delayMs: 60 },
      { role: 'g.enter', seat: 'me', delayMs: 60 + LAND_THUD_DELAY_MS },
    ]);
  });

  it("the opponent's instant resolves with its colour's spell cell, from their seat", () => {
    const cast = view(1, {}, {}, { stack: [spell(1, BOLT, 'bob')] });
    const done = view(2, {}, { graveyard: [entry(101, BOLT)] });
    expect(deriveSoundEvents(cast, done)).toEqual([{ role: 'g.resolve', seat: 'opp', colourCell: 'R|spell' }]);
  });

  it('a permanent spell that ends in the graveyard was countered', () => {
    const cast = view(1, {}, {}, { stack: [spell(1, BEAR, 'alice')] });
    const countered = view(2, { graveyard: [entry(101, BEAR)] });
    expect(deriveSoundEvents(cast, countered).map((e) => e.role)).toEqual(['g.counter']);
  });

  it('a land from hand plays the land role layered with its basic type', () => {
    const before = view(1, { hand: [entry(7, FOREST)], handCount: 1 });
    const after = view(2, { hand: [], handCount: 0, battlefield: [entry(7, FOREST)] });
    expect(deriveSoundEvents(before, after)).toEqual([{ role: 'g.land', seat: 'me', colourCell: 'G|basic' }]);
  });

  it("a creature dying on your turn is your doing; a token appearing is its owner's", () => {
    const before = view(1, {}, { battlefield: [entry(9, BEAR)] });
    const after = view(2, { battlefield: [entry(10, BEAR, { token: true })] }, { graveyard: [entry(9, BEAR)] });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.token', seat: 'me' },
      { role: 'g.dies', seat: 'me' },
    ]);
  });

  it('the untap step is the untap once per card, spaced past the collapse window and capped; one tap is a tap', () => {
    const tapped = [entry(1, FOREST, { tapped: true }), entry(2, FOREST, { tapped: true })];
    const before = view(1, { battlefield: tapped });
    const after = view(2, { battlefield: [entry(1, FOREST), entry(2, FOREST, { tapped: true })] });
    expect(deriveSoundEvents(before, after).map((e) => e.role)).toEqual(['g.untap']);
    const all = view(3, { battlefield: [entry(1, FOREST), entry(2, FOREST)] });
    expect(deriveSoundEvents(before, all)).toEqual([
      { role: 'g.untap', seat: 'me' },
      { role: 'g.untap', seat: 'me', delayMs: UNTAP_REPEAT_GAP_MS },
    ]);
    const board = Array.from({ length: 12 }, (_, i) => entry(i + 1, FOREST, { tapped: true }));
    const untapped = deriveSoundEvents(view(5, { battlefield: board }), view(6, { battlefield: board.map((c) => ({ ...c, tapped: false })) }));
    expect(untapped).toHaveLength(UNTAP_REPEAT_MAX);
    expect(UNTAP_REPEAT_GAP_MS).toBeGreaterThan(80);
    const tap = view(4, { battlefield: [entry(1, FOREST, { tapped: true }), entry(2, FOREST, { tapped: true }), entry(3, FOREST, { tapped: true })] });
    expect(deriveSoundEvents(view(3, { battlefield: [...all.players[0]!.battlefield, entry(3, FOREST)] }), tap).map((e) => e.role)).toEqual([
      'g.tap',
      'g.tap',
      'g.tap',
    ]);
  });

  it('draws, damage to a player and life gain read off the player; the damage as heavy as the life it took', () => {
    const before = view(1, { handCount: 5, libraryCount: 30, life: 20 }, { life: 20 });
    const after = view(2, { handCount: 6, libraryCount: 29, life: 23 }, { life: 17 });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.draw', seat: 'me' },
      { role: 'g.lifegain', seat: 'me' },
      { role: 'g.damage-player', seat: 'me', intensity: damagePower(3) },
    ]);
  });

  it('their turn starting is silent, and says nothing about the phase', () => {
    const before = view(1, {}, {}, { turn: 3, activePlayerId: 1, phase: 'CLEANUP' });
    const after = view(2, {}, {}, { turn: 4, activePlayerId: 2, phase: 'UNTAP' });
    expect(deriveSoundEvents(before, after)).toEqual([]);
  });

  it('attackers and blockers, from their controllers', () => {
    const before = view(1, { battlefield: [entry(1, BEAR)] }, { battlefield: [entry(2, BEAR)] });
    const after = view(2, { battlefield: [entry(1, BEAR, { attacking: true, tapped: true })] }, { battlefield: [entry(2, BEAR, { blocking: true })] });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.combat', seat: 'me' },
      { role: 'g.tap', seat: 'me' },
      { role: 'g.attack', seat: 'me' },
      { role: 'g.block', seat: 'opp' },
    ]);
  });

  it('the view that ends the game is a win or a loss, and the blow that ended it besides', () => {
    const before = view(1, {}, { life: 3 });
    expect(deriveSoundEvents(before, view(2, { hasLost: true }, { life: 3 }, { gameOver: true }))).toEqual([{ role: 'g.lose', seat: 'me' }]);
    expect(deriveSoundEvents(before, view(2, {}, { life: 0, hasLost: true }, { gameOver: true }))).toEqual([
      { role: 'g.win', seat: 'me' },
      { role: 'g.damage-player', seat: 'me', intensity: damagePower(3) },
    ]);
  });

  it('a mulligan sends the hand back and shuffles', () => {
    const library = ids(1, 33);
    const before = view(1, { handCount: 7, libraryCount: 33, libraryIds: library });
    const after = view(2, { handCount: 0, libraryCount: 40, libraryIds: scramble([...library, ...ids(34, 7)]) });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.mulligan', seat: 'me' },
      { role: 'g.shuffle', seat: 'me', delayMs: 250 },
    ]);
  });

  it('a London mulligan is one delta: the same counts, a new hand, the library shuffled', () => {
    // The shape `mulligan.jvm.test.ts` reads off real Forge: 53 → 53, 7 → 7.
    const library = ids(1, 53);
    const before = view(1, { handCount: 7, libraryCount: 53, libraryIds: library });
    const after = view(2, { handCount: 7, libraryCount: 53, libraryIds: scramble([...library.slice(7), ...ids(60, 7)]) });
    expect(deriveSoundEvents(before, after)).toEqual([
      { role: 'g.mulligan', seat: 'me' },
      { role: 'g.shuffle', seat: 'me', delayMs: 250 },
    ]);
  });

  it('a library reordered in place is a shuffle, whoever owns it', () => {
    const library = ids(1, 30);
    expect(deriveSoundEvents(view(1, {}, { libraryIds: library }), view(2, {}, { libraryIds: scramble(library) }))).toEqual([
      { role: 'g.shuffle', seat: 'opp' },
    ]);
  });

  it('a tutor is a card leaving and the rest shuffled', () => {
    const library = ids(1, 30);
    const after = scramble(library.filter((id) => id !== 12));
    expect(wasShuffled(library, after)).toBe(true);
  });

  it('a draw, a mill, a scry or a card put on top is not a shuffle', () => {
    const library = ids(1, 30);
    expect(wasShuffled(library, library.slice(1))).toBe(false);
    expect(wasShuffled(library, library.slice(3))).toBe(false);
    expect(wasShuffled(library, [...library.slice(2), library[1]!, library[0]!])).toBe(false);
    expect(wasShuffled(library, [99, ...library])).toBe(false);
    expect(wasShuffled(library, [library[1]!, library[0]!, ...library.slice(2)])).toBe(false);
  });

  it('too few shared cards to tell, or nothing known, stays quiet', () => {
    expect(wasShuffled([1, 2, 3], [3, 1, 2])).toBe(false);
    expect(wasShuffled(undefined, [1, 2, 3, 4])).toBe(false);
  });

  it('a view that changes everything at once is a snapshot, not a moment', () => {
    const before = view(1, { battlefield: [] });
    const after = view(2, { battlefield: Array.from({ length: 30 }, (_, i) => entry(i + 1, BEAR)) });
    expect(deriveSoundEvents(before, after)).toEqual([]);
  });
});

describe('combat drums: once per combat, when the attack is declared', () => {
  const DA = 'COMBAT_DECLARE_ATTACKERS';
  const drums = (a: BoardView, b: BoardView): DelayedSoundEvent[] => deriveSoundEvents(a, b).filter((e) => e.role === 'g.combat');
  const at = (seq: number, phase: string, mine: BoardCard[], meExtra: Partial<BoardPlayer> = {}, themExtra: Partial<BoardPlayer> = {}): BoardView =>
    view(seq, { isActive: true, battlefield: mine, ...meExtra }, themExtra, { phase });

  it('waits on the attacker’s own screen while creatures are picked, and plays at the lock-in', () => {
    const begin = at(1, 'COMBAT_BEGIN', [entry(1, BEAR), entry(2, BEAR)]);
    const picking = at(2, DA, [entry(1, BEAR, { attacking: true }), entry(2, BEAR)], {}, { hasPriority: true });
    const picked = at(3, DA, [entry(1, BEAR, { attacking: true }), entry(2, BEAR, { attacking: true })], {}, { hasPriority: true });
    const locked = at(4, DA, [entry(1, BEAR, { attacking: true, tapped: true }), entry(2, BEAR, { attacking: true, tapped: true })]);
    const blockers = at(5, 'COMBAT_DECLARE_BLOCKERS', locked.players[0]!.battlefield);
    expect(drums(begin, picking), 'the first pick').toEqual([]);
    expect(drums(picking, picked), 'the second pick').toEqual([]);
    expect(drums(picked, locked)).toEqual([{ role: 'g.combat', seat: 'me' }]);
    expect(drums(locked, blockers), 'the same combat, a step on').toEqual([]);
  });

  it('plays for the defender when the locked-in attack arrives, quieter as the opponent’s', () => {
    const begin = view(1, { battlefield: [entry(9, BEAR)] }, { isActive: true, battlefield: [entry(1, BEAR)] }, { phase: 'COMBAT_BEGIN', activePlayerId: 2 });
    const locked = view(2, { battlefield: [entry(9, BEAR)] }, { isActive: true, battlefield: [entry(1, BEAR, { attacking: true, tapped: true })] }, { phase: DA, activePlayerId: 2 });
    expect(drums(begin, locked)).toEqual([{ role: 'g.combat', seat: 'opp' }]);
  });

  it('stays quiet when combat is skipped: no creature attacks', () => {
    const begin = at(1, 'COMBAT_BEGIN', [entry(1, BEAR)]);
    const none = at(2, DA, [entry(1, BEAR)], { hasPriority: true });
    expect(drums(begin, none)).toEqual([]);
    expect(drums(none, at(3, 'COMBAT_END', [entry(1, BEAR)]))).toEqual([]);
  });

  it('a vigilant attack locks in on the attacker’s priority, and plays once through the steps after', () => {
    const vigilant = (extra: Partial<BoardCard> = {}): BoardCard[] => [entry(1, BEAR, { attacking: true, ...extra })];
    const picking = at(1, DA, vigilant(), {}, { hasPriority: true });
    const locked = at(2, DA, vigilant(), { hasPriority: true });
    const passed = at(3, DA, vigilant(), {}, { hasPriority: true });
    const blockers = at(4, 'COMBAT_DECLARE_BLOCKERS', vigilant());
    expect(drums(picking, locked)).toEqual([{ role: 'g.combat', seat: 'me' }]);
    expect(drums(locked, passed)).toEqual([]);
    expect(drums(passed, blockers), 'leaving Declare Attackers is not a second attack').toEqual([]);
  });

  it('a second combat in the turn plays again', () => {
    const ended = at(1, 'COMBAT_END', [entry(1, BEAR, { tapped: true })]);
    const again = at(2, DA, [entry(1, BEAR, { tapped: true }), entry(2, BEAR, { attacking: true, tapped: true })]);
    expect(drums(ended, again)).toEqual([{ role: 'g.combat', seat: 'me' }]);
  });

  it('attackDeclared: an attacking creature, and in Declare Attackers the lock-in', () => {
    expect(attackDeclared(at(1, DA, [entry(1, BEAR, { attacking: true })], {}, { hasPriority: true }))).toBe(false);
    expect(attackDeclared(at(1, DA, [entry(1, BEAR, { attacking: true, tapped: true })]))).toBe(true);
    expect(attackDeclared(at(1, 'COMBAT_DAMAGE', [entry(1, BEAR, { attacking: true })]))).toBe(true);
    expect(attackDeclared(at(1, DA, [entry(1, BEAR)], { hasPriority: true }))).toBe(false);
  });
});

describe('against a real captured game', () => {
  /*
   * The deriver's zone moves assume a card keeps its id from hand to stack to
   * battlefield (`fold.ts` replaces the object on a zone change). This replays
   * the committed Tier C capture one packet at a time and proves the stream
   * comes out as a game sounds: a creature cast in one view resolves with its
   * voice in a later one, lands come from hand with their basic type.
   */
  it('turns the captured stream into the moments a game is made of', () => {
    const fixture = PLAY_FIXTURES[0]!;
    const packets = loadPackets(fixture);
    const roles = new Set<string>();
    const cells = new Set<string>();
    const drumTurns: number[] = [];
    const attackTurns = new Set<number>();
    let prev: BoardView | null = null;
    for (let k = 1; k <= packets.length; k++) {
      const { state, seq } = foldPackets(packets.slice(0, k));
      const next = toBoardView(state, seq, { viewerPlayerId: fixture.viewerPlayerId });
      for (const e of deriveSoundEvents(prev, next)) {
        roles.add(e.role);
        if (e.colourCell != null) cells.add(e.colourCell);
        if (e.role === 'g.combat') drumTurns.push(next.turn);
      }
      if (next.players.some((p) => p.battlefield.some((c) => c.attacking))) attackTurns.add(next.turn);
      prev = next;
    }
    expect(drumTurns, 'the drums once in every turn that had an attack, and in no other').toEqual([...attackTurns]);
    for (const role of ['g.turn-mine', 'g.draw', 'g.land', 'g.cast.creature', 'g.resolve', 'g.creature', 'g.enter', 'g.tap', 'g.untap', 'g.attack', 'g.block', 'g.dies', 'g.damage-player']) {
      expect(roles, role).toContain(role);
    }
    expect(roles, 'no false shuffles in an ordinary game').not.toContain('g.shuffle');
    // Mountain and Island are their colour's basic; Great Furnace (adds {R}) and Izzet Guildgate (adds {U} or {R}) are lands.
    for (const cell of ['R|basic', 'U|basic', 'R|land', 'UR|land']) expect(cells, cell).toContain(cell);
    expect(cells).toContain('R|creature');
  });
});
