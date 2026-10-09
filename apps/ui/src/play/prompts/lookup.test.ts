import { describe, expect, it } from 'vitest';

import type { WireObject } from '../wire.ts';
import { cardStateKey, deltaKey, WireType } from '../wire.ts';
import { isZoneDividerLabel, lookupFromState, plainRulesText, promptText, translateTargetWords } from './lookup.ts';

const card = (id: number): [string, WireObject] => [deltaKey(WireType.Card, id), { _type: WireType.Card, _id: id }];
const face = (id: number, name: string, setCode: string): [string, WireObject] => [
  cardStateKey(id, 0),
  { _type: WireType.CardState, _id: id * 16, Name: { t: 'str', v: name }, SetCode: { t: 'str', v: setCode } },
];

describe('lookupFromState', () => {
  it("reads a card's name and set code off its current face", () => {
    const lookup = lookupFromState(new Map([card(12), face(12, 'Forest', 'TRK')]));
    expect(lookup.card(12)).toMatchObject({ name: 'Forest', setCode: 'TRK' });
  });

  // prompts.jvm, 2026-10-03: a card another player revealed reached seat 1 as
  // an object with no face yet. An invented name ("card #47") became the art
  // key; null lets the caller fall back to Forge's own label.
  it('a card object whose face has not arrived has facts with a null name, never an invented one', () => {
    const lookup = lookupFromState(new Map([card(47)]));
    expect(lookup.card(47)?.name).toBeNull();
  });

  it('no object at all is no facts', () => {
    expect(lookupFromState(new Map()).card(5)).toBeUndefined();
  });
});

/*
 * Y18 — Forge's real target-restriction expressions, translated.
 *
 * Every `raw` string below is what `TargetRestrictions.java:141,149`'s OWN
 * default builder produces for the cited card's real `ValidTgts$` (no
 * `TgtPrompt$`/`ValidTgtsDesc$` in the way, computed by hand against
 * `Lang.java`'s `buildValidDesc`/`formatValidDesc`/`joinHomogenous`, never
 * invented) — so this table is Forge's own ugly text, not a stand-in for it.
 * Where another real card's author independently wrote a `TgtPrompt$` for the
 * identical qualifier, that card is cited too: the `expected` column is
 * Forge's own word, read off that card, not prose of ours.
 */
describe('translateTargetWords — Forge’s ValidTgts expressions, in words', () => {
  const cases: readonly [string, string, string][] = [
    // venser_shaper_savant.txt:7 — `ValidTgts$ Permanent,Card.inZoneStack`,
    // no override at all: the operator's own repro (Y18).
    [
      'Venser, Shaper Savant — permanent or a spell on the stack',
      'Select target permanent or Card.inZoneStack',
      'Select target permanent or spell',
    ],
    // futurist_spellthief.txt:7 — `Card.inZoneStack` alone; that card's own
    // `TgtPrompt$` is exactly "Select target spell".
    [
      'a bare spell target',
      'Select target Card.inZoneStack',
      'Select target spell',
    ],
    // subtlety.txt:8 — `Card.inZoneStack+Creature,Card.inZoneStack+Planeswalker`;
    // that card's own `TgtPrompt$` is "...creature spell or planeswalker spell".
    [
      'a spell narrowed by type, two of them',
      'Select target Card.inZoneStack+Creature or Card.inZoneStack+Planeswalker',
      'Select target creature spell or planeswalker spell',
    ],
    // A bare core type and a bare commonStuff word: Forge's own builder
    // already lowercases both (`Lang.java:233-242`) — unaffected pass-through.
    ['a bare recognised word Forge already lowercased', 'Select target player', 'Select target player'],
    // `Creature.YouCtrl` — read off many cards' own `TgtPrompt$`
    // (e.g. `ally.txt`-style "Select target Ally you control"): "you control".
    [
      'a creature you control',
      'Select target Creature.YouCtrl',
      'Select target creature you control',
    ],
    // `Creature.OppCtrl` — read off cards whose own `TgtPrompt$` is
    // "Choose/Select target creature an opponent controls".
    [
      'a creature an opponent controls',
      'Select target Creature.OppCtrl',
      'Select target creature an opponent controls',
    ],
    // `Land.nonBasic` — `smolder`-style cards' own `TgtPrompt$`: "nonbasic land".
    [
      'a nonbasic land',
      'Select target Land.nonBasic',
      'Select target nonbasic land',
    ],
    // `Permanent.YouCtrl+nonLand` — a chained qualifier, read off cards whose
    // own `TgtPrompt$` is "Select target nonland permanent you control".
    [
      'a chained qualifier (prefix AND suffix)',
      'Select target Permanent.YouCtrl+nonLand',
      'Select target nonland permanent you control',
    ],
    // `Creature.attacking` / `Creature.tapped` — read off `Zombie.attacking`-
    // and `Creature.tapped`-shaped cards' own `TgtPrompt$`.
    ['an attacking creature', 'Select target Creature.attacking', 'Select target attacking creature'],
    ['a tapped creature', 'Select target Creature.tapped', 'Select target tapped creature'],
    // `Creature.powerGE3` — read off cards whose own `TgtPrompt$` is
    // "...creature with power 3 or greater".
    [
      'a power comparison',
      'Select target Creature.powerGE3',
      'Select target creature with power 3 or greater',
    ],
    // `Creature.Other,Card.inZoneStack` (`aang_swift_savior…txt:8`'s own
    // shape) — "Other" is Forge's own "another" (read off many `.Other`
    // cards' own `TgtPrompt$`/`ValidTgtsDesc$`, e.g. "another creature").
    [
      'another creature, or a spell — a comma list mixing Other and inZoneStack',
      'Select target Creature.Other or Card.inZoneStack',
      'Select target another creature or spell',
    ],
    // A synthetic three-item list — Forge's own `joinHomogenous` (3+ items:
    // "A, B or C", no comma before the last union word) is untouched; only
    // the three raw tokens inside it are translated.
    [
      'a three-item comma list',
      'Select target Instant.YouOwn, Sorcery.YouOwn or Card.inZoneStack',
      'Select target instant you own, sorcery you own or spell',
    ],
    // A cmc comparison INSIDE an inZoneStack qualifier chain — the stack-spell
    // noun override and the comparison suffix compose.
    [
      'a mana-value comparison on a permanent and on a spell',
      'Select target Permanent.cmcGE1 or Card.inZoneStack+cmcGE1',
      'Select target permanent with mana value 1 or greater or spell with mana value 1 or greater',
    ],
    // `with<Keyword>` — generic regex, no card cited (no cube card hits this
    // through the default builder; `CardProperty`'s own grammar supports it).
    ['a with-keyword qualifier', 'Select target Creature.withFlying', 'Select target creature with flying'],
    // A qualifier this table has no dedicated word for — the long-tail
    // fallback still reads as words, never raw CamelCase.
    [
      'an unrecognised qualifier still reads as words, never CamelCase',
      'Select target Creature.ExiledWithSource',
      'Select target creature exiled with source',
    ],
  ];

  it.each(cases)('%s', (_label, raw, expected) => {
    expect(translateTargetWords(raw)).toBe(expected);
  });

  it('composes into plainRulesText, so every existing caller gets it for free', () => {
    expect(plainRulesText('Select target permanent or Card.inZoneStack')).toBe('Select target permanent or spell');
  });

  it('a string with no raw ValidTgts token is returned unchanged', () => {
    const prose = 'Venser, Shaper Savant - Return target spell or permanent to its owner’s hand.';
    expect(translateTargetWords(prose)).toBe(prose);
  });
});

describe('isZoneDividerLabel', () => {
  // `TargetSelection.chooseCardFromList` (`forge-gui/src/main/java/forge/player/
  // TargetSelection.java:228-250`) splices these exact marker strings into a
  // `getChoices` choice list — never a real card or player name.
  it.each([
    ['--CARDS ON BATTLEFIELD:--'],
    ['--CARDS IN STACK:--'],
    ['--CARDS IN EXILE:--'],
    ['--CARDS IN GRAVEYARD:--'],
    ['--CARDS IN LIBRARY:--'],
    ['--CARDS IN ANTE:--'],
  ])('%s is a zone divider, not a choice', (label) => {
    expect(isZoneDividerLabel(label)).toBe(true);
  });

  it.each([['Lightning Bolt'], ['[FINISH TARGETING]'], ['player']])('%s is a real choice, not a divider', (label) => {
    expect(isZoneDividerLabel(label)).toBe(false);
  });
});

describe('plainRulesText: the card-id suffix (T4)', () => {
  // The operator, 2026-10-08: "Dragonskull Summit (31)… just the name" — AD-era
  // rule, previously only `promptText` honoured it; `plainRulesText` (every
  // aria-label, dialog name and log line that reads through `live-says`) did
  // not. One pipeline now.
  it('strips the suffix, same as promptText', () => {
    expect(plainRulesText('Dragonskull Summit (31)')).toBe('Dragonskull Summit');
    expect(promptText('Dragonskull Summit (31)')).toBe('Dragonskull Summit');
  });
});

describe('plainRulesText: the attack prompt', () => {
  // The operator, 2026-10-07: "'Select creatures to attack Sorin, Grim Nemesis (47) or select player/card you wish to attack.' It's too wordy."
  it('shortens Forge’s declare-attackers line to its first four words, whatever defender it names', () => {
    expect(plainRulesText('Select creatures to attack Sorin, Grim Nemesis (47) or select player/card you wish to attack.')).toBe('Select creatures to attack.');
    expect(plainRulesText('Select creatures to attack e2e-alice or select player/card you wish to attack.')).toBe('Select creatures to attack.');
    expect(plainRulesText('Select creatures to attack e2e-alice or select player/card you wish to attack.\nStack: Empty')).toBe('Select creatures to attack.\nStack: Empty');
    expect(plainRulesText('Select creatures to block'), 'nothing else is touched').toBe('Select creatures to block');
  });
});
