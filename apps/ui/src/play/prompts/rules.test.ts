/**
 * The answer rules, on their own — every method's legal answers and at least
 * one it must refuse. The component tests check that the UI cannot produce the
 * refused ones; these check the rule itself says no, and says why.
 */

import { describe, expect, it } from 'vitest';
import { cardRequest } from '@hadoku/forge-wire';

import { askFor, asksFor, fixtureLookup } from './fixtures.ts';
import {
  abilityProblems,
  autoAnswer,
  chooseEntitiesProblems,
  chooseSingleProblems,
  combatDamageProblems,
  combatDamageReply,
  combatDamageRules,
  confirmProblems,
  deckFromSideboardAsk,
  genericAmountProblems,
  getChoicesProblems,
  inputDialogProblems,
  manipulateProblems,
  moveItem,
  optionDialogProblems,
  orderProblems,
  sideboardProblems,
  zoneReplyProblems,
  zonesOpened,
  zonesShown,
} from './rules.ts';
import type { AskOf } from './types.ts';

const lookup = fixtureLookup();
const card = (id: number) => ({ kind: 'card', id }) as const;
const player = (id: number) => ({ kind: 'player', id }) as const;

describe('showOptionDialog', () => {
  const ask = askFor('showOptionDialog');
  it('takes any index into the options, and nothing past them', () => {
    expect(optionDialogProblems(ask, 0)).toEqual([]);
    expect(optionDialogProblems(ask, 2)).toEqual([]);
    expect(optionDialogProblems(ask, 3)).toHaveLength(1);
    expect(optionDialogProblems(ask, -1)).toHaveLength(1);
  });
});

describe('showInputDialog', () => {
  const ask = askFor('showInputDialog');
  it('wants a whole number from a numeric dialog, and allows cancel', () => {
    expect(inputDialogProblems(ask, '3')).toEqual([]);
    expect(inputDialogProblems(ask, null)).toEqual([]);
    expect(inputDialogProblems(ask, 'three')).toEqual(['"three" is not a whole number']);
    expect(inputDialogProblems(ask, '2.5')).toHaveLength(1);
  });
  it('holds a dialog with input options to those options', () => {
    const listed = { ...ask, isNumeric: false, inputOptions: ['left', 'right'] };
    expect(inputDialogProblems(listed, 'left')).toEqual([]);
    expect(inputDialogProblems(listed, 'up')).toHaveLength(1);
  });
});

describe('confirm', () => {
  it('answers either way when there are two buttons', () => {
    const ask = askFor('confirm');
    expect(confirmProblems(ask, true)).toEqual([]);
    expect(confirmProblems(ask, false)).toEqual([]);
  });
  it('cannot answer false to a one-button confirm', () => {
    const okOnly = asksFor('confirm').find((a) => a.options.length === 1)!;
    expect(confirmProblems(okOnly, true)).toEqual([]);
    expect(confirmProblems(okOnly, false)).toEqual(['this question has only one answer']);
  });
});

describe('getChoices', () => {
  const [colors, reveal] = asksFor('getChoices') as [AskOf<'getChoices'>, AskOf<'getChoices'>];
  it('takes exactly one colour for a 1..1 choice', () => {
    expect(getChoicesProblems(colors, ['red'])).toEqual([]);
    expect(getChoicesProblems(colors, [])).toEqual(['choose at least 1']);
    expect(getChoicesProblems(colors, ['red', 'blue'])).toEqual(['choose at most 1']);
  });
  it('refuses a key that was not offered, and a key twice', () => {
    expect(getChoicesProblems(colors, ['purple'])).toContain('"purple" was not offered');
    expect(getChoicesProblems({ ...colors, max: 2 }, ['red', 'red'])).toContain('"red" chosen twice');
  });
  it('treats min/max -1 as display-only: the only answer is empty', () => {
    expect(getChoicesProblems(reveal, [])).toEqual([]);
    expect(getChoicesProblems(reveal, ['c76'])).toEqual(['nothing may be chosen here']);
  });
});

describe('chooseSingleEntityForEffect', () => {
  const ask = askFor('chooseSingleEntityForEffect');
  it('takes one of the offered entities', () => {
    expect(chooseSingleProblems(ask, player(1))).toEqual([]);
    expect(chooseSingleProblems(ask, card(67))).toEqual([]);
  });
  it('refuses null unless optional, and anything not offered', () => {
    expect(chooseSingleProblems(ask, null)).toEqual(['a choice is required']);
    expect(chooseSingleProblems({ ...ask, isOptional: true }, null)).toEqual([]);
    expect(chooseSingleProblems(ask, card(54))).toEqual(['card:54 was not offered']);
    // Same id, other kind: player 1 is offered, card 1 is not.
    expect(chooseSingleProblems(ask, card(1))).toHaveLength(1);
  });
});

describe('chooseEntitiesForEffect', () => {
  const ask = askFor('chooseEntitiesForEffect');
  it('takes 0 to 2 of the offered cards', () => {
    expect(chooseEntitiesProblems(ask, [])).toEqual([]);
    expect(chooseEntitiesProblems(ask, [card(20), card(2)])).toEqual([]);
  });
  it('refuses three, a repeat, and a stranger', () => {
    expect(chooseEntitiesProblems(ask, [card(20), card(11), card(2)])).toEqual(['choose at most 2']);
    expect(chooseEntitiesProblems(ask, [card(20), card(20)])).toContain('card:20 chosen twice');
    expect(chooseEntitiesProblems(ask, [card(99)])).toContain('card:99 was not offered');
  });
});

describe('getAbilityToPlay', () => {
  const ask = askFor('getAbilityToPlay');
  it('takes an offered ability or none, and refuses any other', () => {
    expect(abilityProblems(ask, { kind: 'spellAbility', id: 9002 })).toEqual([]);
    expect(abilityProblems(ask, null)).toEqual([]);
    expect(abilityProblems(ask, { kind: 'spellAbility', id: 9003 })).toHaveLength(1);
  });
});

/* ── One answer is no question (wave 20 §B.1) ─────────────────────────── */

describe('autoAnswer', () => {
  const two = askFor('getAbilityToPlay');
  const one = { ...two, abilities: [two.abilities[0]!] };

  it('answers an offer of exactly one ability, with the ability itself', () => {
    expect(autoAnswer(one)).toEqual({
      method: 'getAbilityToPlay',
      reply: { kind: 'spellAbility', id: two.abilities[0]!.id },
      why: `ability #${two.abilities[0]!.id}`,
    });
  });

  it('names the offer’s own label when the bridge sent one — the shortcut can say what it played', () => {
    const labelled = { ...one, abilities: [{ ...one.abilities[0]!, label: '{T}: Add {R}.' }] };
    expect(autoAnswer(labelled)?.why).toBe('{T}: Add {R}.');
  });

  it('asks when there are two abilities: that is a real choice', () => {
    expect(autoAnswer(two)).toBeNull();
  });

  it('asks when there are none — an empty offer is not an answer', () => {
    expect(autoAnswer({ ...two, abilities: [] })).toBeNull();
  });

  it('answers only getAbilityToPlay: everything else with one legal reply is the server’s', () => {
    // `apps/server/src/play/auto.ts`'s `onlyAnswer` owns the rest, and its own
    // suite holds it. Two statements of one policy is what this keeps out.
    for (const ask of [
      askFor('getChoices'),
      askFor('chooseSingleEntityForEffect'),
      askFor('chooseEntitiesForEffect'),
      askFor('showOptionDialog'),
      askFor('order'),
      askFor('confirm'),
      askFor('assignCombatDamage'),
      askFor('sideboard'),
      askFor('manipulateCardList'),
      askFor('tempShowZones'),
      askFor('openZones'),
      askFor('showInputDialog'),
      askFor('assignGenericAmount'),
    ]) {
      expect(autoAnswer(ask), ask.method).toBeNull();
    }
  });
});

describe('tempShowZones / openZones', () => {
  it('opens only what Forge’s desktop would: no battlefield, no own hand', () => {
    const ask = askFor('tempShowZones');
    const shown = zonesShown(ask.controller.id, ask.zonesToUpdate);
    expect(shown).toEqual([
      { player: player(1), zones: ['Graveyard', 'Hand'] },
      { player: player(0), zones: ['Exile'] },
    ]);
    expect(zoneReplyProblems(ask.zonesToUpdate, shown)).toEqual([]);
  });
  it('refuses a reply naming a zone that was not requested, or the battlefield', () => {
    const ask = askFor('tempShowZones');
    expect(zoneReplyProblems(ask.zonesToUpdate, [{ player: player(0), zones: ['Library'] }])).toHaveLength(1);
    expect(zoneReplyProblems(ask.zonesToUpdate, [{ player: player(1), zones: ['Battlefield'] }])).toEqual([
      'the battlefield is never opened as a zone',
    ]);
  });
  it('openZones opens every requested zone per player except battlefield, hand and stack', () => {
    const ask = askFor('openZones');
    expect(zonesOpened(ask)).toEqual([
      { player: player(0), zones: ['Graveyard'] },
      { player: player(1), zones: ['Graveyard'] },
    ]);
    expect(zonesOpened({ ...ask, zones: ['Battlefield', 'Stack'] })).toEqual([]);
  });
});

describe('assignCombatDamage', () => {
  const ask = askFor('assignCombatDamage');
  const rules = combatDamageRules(ask, lookup);
  // The same attack into Goblin Replica alone, so trample can reach the player.
  const oneBlocker = combatDamageRules({ ...ask, blockers: [card(67)] }, lookup);

  it('reads Forge’s own facts off the real board', () => {
    // Fire Urchin has Trample, so the defender gets a slot; Goblin Replica's
    // LethalDamage is 2 and Vulshok War Boar's 5 in the captured state.
    expect(rules.defenderSlot).toBe(true);
    expect(rules.blockers).toEqual([
      { id: 67, lethal: 2 },
      { id: 99, lethal: 5 },
    ]);
  });

  it('accepts lethal in order with the rest behind it', () => {
    expect(combatDamageProblems(rules, { blockers: [2, 3], defender: 0 })).toEqual([]);
    expect(combatDamageProblems(rules, { blockers: [5, 0], defender: 0 })).toEqual([]);
    expect(combatDamageProblems(rules, { blockers: [3, 2], defender: 0 })).toEqual([]);
    expect(combatDamageProblems(oneBlocker, { blockers: [2], defender: 3 })).toEqual([]);
  });

  it('refuses damage that does not sum to the damage dealt', () => {
    expect(combatDamageProblems(rules, { blockers: [2, 4], defender: 0 })).toEqual(['assign exactly 5 (assigned 6)']);
    expect(combatDamageProblems(rules, { blockers: [2, 2], defender: 0 })).toEqual(['assign exactly 5 (assigned 4)']);
  });

  it('refuses damage to a later blocker before the earlier one has lethal', () => {
    expect(combatDamageProblems(rules, { blockers: [1, 4], defender: 0 })).toEqual([
      'blocker 2 cannot take damage until the ones before it have lethal',
    ]);
  });

  it('refuses trample-over before every blocker has lethal', () => {
    expect(combatDamageProblems(rules, { blockers: [2, 2], defender: 1 })).toEqual([
      'every blocker needs lethal damage before any tramples over',
    ]);
    expect(combatDamageProblems(oneBlocker, { blockers: [1], defender: 4 })).toEqual([
      'every blocker needs lethal damage before any tramples over',
    ]);
  });

  it('refuses negative amounts, and any defender damage without trample', () => {
    expect(combatDamageProblems(rules, { blockers: [6, -1], defender: 0 })).toContain(
      'amounts are whole numbers, 0 or more',
    );
    const noTrample = { ...rules, defenderSlot: false };
    expect(combatDamageProblems(noTrample, { blockers: [2, 2], defender: 1 })).toContain(
      'no damage can go past the blockers',
    );
  });

  it('gives a non-trampler no defender slot', () => {
    // Hellkite Whelp has Flying, not Trample.
    expect(combatDamageRules({ ...ask, attacker: card(60) }, lookup).defenderSlot).toBe(false);
  });

  it('lets blockers take damage in any order under overrideOrder, but still gates the defender', () => {
    const override = combatDamageRules({ ...ask, overrideOrder: true }, lookup);
    expect(combatDamageProblems(override, { blockers: [0, 5], defender: 0 })).toEqual([]);
    expect(combatDamageProblems(override, { blockers: [0, 4], defender: 1 })).toEqual([
      'every blocker needs lethal damage before any tramples over',
    ]);
  });

  it('caps lethal at 1 for a deathtoucher', () => {
    const deathtouch = {
      ...lookup,
      card: (id: number) => {
        const facts = lookup.card(id);
        return id === 21 && facts ? { ...facts, keywords: [...facts.keywords, 'Deathtouch'] } : facts;
      },
    };
    const dt = combatDamageRules(ask, deathtouch);
    expect(dt.blockers.map((b) => b.lethal)).toEqual([1, 1]);
    expect(combatDamageProblems(dt, { blockers: [1, 1], defender: 3 })).toEqual([]);
  });

  it('spells the defender as Forge’s -1 key, and includes every slot', () => {
    expect(combatDamageReply(rules, { blockers: [2, 3], defender: 0 })).toEqual([
      { target: card(67), amount: 2 },
      { target: card(99), amount: 3 },
      { target: card(-1), amount: 0 },
    ]);
  });
});

describe('assignGenericAmount', () => {
  const [damage, mana] = asksFor('assignGenericAmount') as [AskOf<'assignGenericAmount'>, AskOf<'assignGenericAmount'>];
  it('divides 3 damage one each over three targets, at least one apiece', () => {
    expect(genericAmountProblems(damage, [1, 1, 1])).toEqual([]);
  });
  it('refuses a zero under atLeastOne, a wrong total, and more than a target’s max', () => {
    expect(genericAmountProblems(damage, [2, 1, 0])).toEqual(['target 3: at least 1']);
    expect(genericAmountProblems(damage, [1, 1, 2])).toEqual(['assign exactly 3 (assigned 4)']);
    expect(genericAmountProblems(mana, [3, -1])).toEqual([
      'target 1: at most 2',
      'target 2: amounts are whole numbers, 0 or more',
    ]);
  });
  it('lets a mana split leave a colour at zero when atLeastOne is off', () => {
    expect(genericAmountProblems(mana, [2, 0])).toEqual([]);
  });
});

describe('order', () => {
  const ask = askFor('order');
  const all = ask.sourceChoices.map((c) => c.key);
  it('needs every item placed when nothing may remain', () => {
    expect(orderProblems(ask, { ordered: [...all].reverse(), rememberDecision: true })).toEqual([]);
    expect(orderProblems(ask, { ordered: all.slice(0, 2), rememberDecision: false })).toEqual([
      'place every item (1 left)',
    ]);
  });
  it('refuses an unknown key, a repeat, and "remember" when it was not offered', () => {
    expect(orderProblems(ask, { ordered: [...all, 'sa-0'], rememberDecision: false })).toContain('"sa-0" was not offered');
    expect(orderProblems(ask, { ordered: [...all, all[0]!], rememberDecision: false })).toContain(
      `"${all[0]}" appears twice`,
    );
    expect(
      orderProblems({ ...ask, showRememberCheckbox: false }, { ordered: all, rememberDecision: true }),
    ).toEqual(['"remember" was not offered']);
  });
  it('allows any split when remainingObjectsMax is negative', () => {
    expect(orderProblems({ ...ask, remainingObjectsMin: -1, remainingObjectsMax: -1 }, { ordered: [], rememberDecision: false })).toEqual([]);
  });
  it('holds a bounded split to its range', () => {
    const upTo2Left = { ...ask, remainingObjectsMin: 1, remainingObjectsMax: 2 };
    expect(orderProblems(upTo2Left, { ordered: all.slice(0, 1), rememberDecision: false })).toEqual([]);
    expect(orderProblems(upTo2Left, { ordered: all, rememberDecision: false })).toEqual([
      'leave at least 1 unplaced (0 left)',
    ]);
  });
});

describe('manipulateCardList', () => {
  const ask = askFor('manipulateCardList');
  const ids = (...xs: number[]) => xs.map(card);
  it('accepts the pile unchanged, and movable cards sent to the bottom', () => {
    expect(manipulateProblems(ask, ask.cards)).toEqual([]);
    expect(manipulateProblems(ask, ids(47, 17, 46, 60, 54))).toEqual([]);
    expect(manipulateProblems(ask, ids(17, 46, 60, 47, 54))).toEqual([]);
  });
  it('refuses a movable card wedged between fixed ones', () => {
    expect(manipulateProblems(ask, ids(47, 17, 54, 46, 60))).toEqual([
      'movable cards go to the top or the bottom, not between the others',
    ]);
  });
  it('refuses reordering the fixed cards, and a pile with a card swapped out', () => {
    expect(manipulateProblems(ask, ids(54, 47, 46, 17, 60))).toEqual(['cards that cannot move must keep their order']);
    expect(manipulateProblems(ask, ids(54, 47, 17, 46, 99))).toEqual(['the answer must hold exactly the cards shown']);
  });
  it('refuses the bottom when only the top is allowed', () => {
    expect(manipulateProblems({ ...ask, toBottom: false }, ids(47, 17, 46, 60, 54))).toEqual([
      'nothing may be put on the bottom',
    ]);
  });
  it('allows anything that keeps the fixed cards in order when toAnywhere', () => {
    expect(manipulateProblems({ ...ask, toAnywhere: true }, ids(17, 54, 46, 47, 60))).toEqual([]);
  });
  it('moveItem moves one item and keeps the rest in order', () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
  });
});

describe('sideboard', () => {
  const ask = askFor('sideboard');
  it('builds one @hadoku/deck Deck from the two pools', () => {
    const deck = deckFromSideboardAsk(ask);
    expect(deck.main.reduce((s, e) => s + e.count, 0)).toBe(60);
    expect(deck.sideboard.reduce((s, e) => s + e.count, 0)).toBe(15);
  });
  it('accepts null, the unchanged main, and a swap within the pools', () => {
    expect(sideboardProblems(ask, null)).toEqual([]);
    expect(sideboardProblems(ask, ask.main)).toEqual([]);
    const annul = ask.sideboard.find((e) => e.card.name === 'Annul')!;
    expect(sideboardProblems(ask, [...ask.main, { count: 4, card: annul.card }])).toEqual([]);
  });
  it('refuses a card from outside both pools, and more copies than the pools hold', () => {
    expect(sideboardProblems(ask, [...ask.main, { count: 1, card: cardRequest('Black Lotus', 'LEA') }])).toEqual([
      'plays 1x Black Lotus but drafted 0',
    ]);
    const annul = ask.sideboard.find((e) => e.card.name === 'Annul')!;
    expect(sideboardProblems(ask, [{ count: 5, card: annul.card }])).toEqual(['plays 5x Annul but drafted 4']);
  });
});
