/**
 * The mana ring's model against asks shaped as real Forge sent them (runs 42132000056 and
 * 42137472274: a probe suite that clicked 31 kinds of source on a claw), each parsed through the wire schema
 * so the facts the bridge adds are the ones the schema accepts.
 */

import { parseServerFrame, type ManaFacts } from '@hadoku/forge-wire';
import { describe, expect, it } from 'vitest';

import type { AskOf } from '../prompts/types.ts';
import {
  abilityRing,
  answerFromIntent,
  chipLayout,
  colorRing,
  optionForKeys,
  promptRing,
  ringLayout,
  tallyDone,
  tallyRing,
  type Mana,
} from './mana-ring.ts';

function offer(abilities: { id: number; label: string; mana?: ManaFacts }[]): AskOf<'getAbilityToPlay'> {
  return parseServerFrame({
    kind: 'ask',
    callId: 'c-1',
    method: 'getAbilityToPlay',
    hostCard: { kind: 'card', id: 87 },
    abilities: abilities.map((a) => ({ kind: 'spellAbility', ...a })),
    triggerEvent: null,
  }) as AskOf<'getAbilityToPlay'>;
}

function colorList(colors: Mana[], min = 1): AskOf<'getChoices'> {
  return parseServerFrame({
    kind: 'ask',
    callId: 'c-2',
    method: 'getChoices',
    message: 'Select Mana to Produce',
    min,
    max: 1,
    choices: colors.map((c, i) => ({ key: `c${i}`, label: c, ref: null })),
    selected: [],
    colors,
  }) as AskOf<'getChoices'>;
}

function split(colors: Record<number, number>, amount: number): AskOf<'assignGenericAmount'> {
  return parseServerFrame({
    kind: 'ask',
    callId: 'c-3',
    method: 'assignGenericAmount',
    effectSource: { kind: 'card', id: 88 },
    target: Object.entries(colors).map(([bit, most]) => ({ key: { target: 'manaColor', color: Number(bit) }, amount: most })),
    amount,
    atLeastOne: false,
    amountLabel: 'mana',
  }) as AskOf<'assignGenericAmount'>;
}

const shown = (ring: ReturnType<typeof abilityRing>) => ring?.options.map((o) => o.syms.join('') + (o.times > 1 ? `×${o.times}` : ''));

describe('a source’s abilities draw every result at once', () => {
  it('a dual (Tundra): two abilities, one disc each, nothing carried to a second question', () => {
    const ring = abilityRing(offer([
      { id: 1, label: '{T}: Add {W}.', mana: { makes: 'W', amount: 1 } },
      { id: 2, label: '{T}: Add {U}.', mana: { makes: 'U', amount: 1 } },
    ]));
    expect(shown(ring)).toEqual(['W', 'U']);
    expect(ring?.options.map((o) => o.answer)).toEqual([
      { to: 'ability', ability: expect.objectContaining({ id: 1 }), then: null },
      { to: 'ability', ability: expect.objectContaining({ id: 2 }), then: null },
    ]);
    expect(ring?.cancellable).toBe(true);
  });

  it('a pain land (Adarkar Wastes): {C}, and W or U with 1 damage, each colour carried to Forge’s yes/no', () => {
    const ring = abilityRing(offer([
      { id: 1, label: '{T}: Add {C}.', mana: { makes: 'C', amount: 1 } },
      { id: 2, label: '{T}: Add {W} or {U}. Adarkar Wastes deals 1 damage to you.', mana: { choose: 'WU', amount: 1, damage: 1 } },
    ]));
    expect(shown(ring)).toEqual(['C', 'W', 'U']);
    expect(ring?.options.map((o) => o.marks.damage)).toEqual([undefined, 1, 1]);
    expect(ring?.options.map((o) => (o.answer.to === 'ability' ? o.answer.then : 'x'))).toEqual([null, ['W'], ['U']]);
  });

  it('City of Brass: one ability, five discs, the damage on every one', () => {
    const ring = abilityRing(offer([{ id: 1, label: '{T}: Add one mana of any color.', mana: { choose: 'WUBRG', amount: 1, damage: 1 } }]));
    expect(shown(ring)).toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(ring?.options.every((o) => o.marks.damage === 1)).toBe(true);
  });

  it('a filter land (Mystic Gate): {C}, or WW, WU, UU for {W/U}', () => {
    const ring = abilityRing(offer([
      { id: 1, label: '{T}: Add {C}.', mana: { makes: 'C', amount: 1 } },
      { id: 2, label: '{W/U}, {T}: Add {W}{W}, {W}{U}, or {U}{U}.', mana: { choose: 'WU', amount: 2, combination: true, cost: '{W/U}' } },
    ]));
    expect(shown(ring)).toEqual(['C', 'WW', 'WU', 'UU']);
    expect(ring?.options[2]?.answer).toEqual({ to: 'ability', ability: expect.objectContaining({ id: 2 }), then: ['W', 'U'] });
  });

  it('Cascading Cataracts: a five-mana combination is one disc, built in its own ring next', () => {
    const ring = abilityRing(offer([
      { id: 1, label: '{T}: Add {C}.', mana: { makes: 'C', amount: 1 } },
      { id: 2, label: '{5}, {T}: Add five mana in any combination of colors.', mana: { choose: 'WUBRG', amount: 5, combination: true, cost: '{5}' } },
    ]));
    expect(ring?.options[1]).toMatchObject({ split: 5, syms: ['W', 'U', 'B', 'R', 'G'], answer: { to: 'ability', then: null } });
  });

  it('Lotus Field: three of one colour; Ancient Tomb: a pair of {C}', () => {
    expect(shown(abilityRing(offer([{ id: 1, label: 'x', mana: { choose: 'WUBRG', amount: 3 } }])))).toEqual(['W×3', 'U×3', 'B×3', 'R×3', 'G×3']);
    expect(shown(abilityRing(offer([{ id: 1, label: 'x', mana: { makes: 'C', amount: 2, damage: 2 } }])))).toEqual(['CC']);
  });

  it("Mishra's Factory: its animation is an outer chip, named by Forge's label", () => {
    const ring = abilityRing(offer([
      { id: 1, label: '{T}: Add {C}.', mana: { makes: 'C', amount: 1 } },
      { id: 2, label: "{1}: Mishra's Factory becomes a 2/2 Assembly-Worker artifact creature until end of turn." },
    ]));
    expect(shown(ring)).toEqual(['C']);
    expect(ring?.chips).toEqual([{ key: 'a2', label: expect.stringContaining('Assembly-Worker'), answer: { to: 'ability', ability: expect.objectContaining({ id: 2 }), then: null } }]);
  });

  it('costs and rules ride as marks: life, a counter, a sacrifice, a tapped creature, a spending rule', () => {
    const ring = abilityRing(offer([
      { id: 1, label: 'x', mana: { choose: 'WUBRG', amount: 1, life: 1 } },
      { id: 2, label: 'x', mana: { choose: 'W', amount: 1, counter: 'charge', sacrifice: 'self', tapType: 'Creature', spendOnly: 'creature' } },
    ]));
    expect(ring?.options[0]?.marks).toEqual({ life: 1 });
    expect(ring?.options[5]?.marks).toEqual({ counter: 'charge', sacrifice: 'self', tapType: 'Creature', spendOnly: 'creature' });
  });

  it('a reflecting source draws one disc; Forge asks its colours next', () => {
    expect(abilityRing(offer([{ id: 1, label: 'x', mana: { reflects: true, amount: 1 } }]))?.options[0]).toMatchObject({ reflects: true, answer: { then: null } });
  });

  it('an offer with no mana ability is no ring: the generic picker asks', () => {
    expect(abilityRing(offer([{ id: 1, label: 'Fire' }, { id: 2, label: 'Ice' }]))).toBeNull();
  });
});

describe('the colour question that follows', () => {
  it('a list of colours (getChoices) is a ring, and a carried colour answers it', () => {
    const ask = colorList(['W', 'U', 'B', 'R', 'G']);
    expect(colorRing(ask)?.options.map((o) => o.syms[0])).toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(colorRing(ask)?.cancellable).toBe(false);
    expect(answerFromIntent(ask, ['R'])).toEqual({ kind: 'reply', reply: ['c3'] });
    expect(answerFromIntent(ask, ['C'])).toBeNull();
  });

  it('a list that is not colours is no ring', () => {
    const ask = parseServerFrame({ kind: 'ask', callId: 'c', method: 'getChoices', message: 'm', min: 1, max: 1, choices: [{ key: 'c0', label: 'Bear', ref: null }], selected: [] }) as AskOf<'getChoices'>;
    expect(colorRing(ask)).toBeNull();
  });

  it("Forge's two-colour yes/no: OK is the first colour, Cancel the second", () => {
    expect(promptRing(['U', 'R']).options.map((o) => o.answer)).toEqual([{ to: 'button', which: 'ok' }, { to: 'button', which: 'cancel' }]);
    expect(answerFromIntent({ manaColors: ['W', 'U'] }, ['U'])).toEqual({ kind: 'button', which: 'cancel' });
    expect(answerFromIntent({ manaColors: ['W', 'U'] }, ['B'])).toBeNull();
  });

  it('a filter land’s split (assignGenericAmount W ≤2, U ≤2, total 2) is answered by the carried pair', () => {
    const ask = split({ 1: 2, 2: 2 }, 2);
    expect(answerFromIntent(ask, ['W', 'U'])).toEqual({
      kind: 'reply',
      reply: [{ key: { target: 'manaColor', color: 1 }, amount: 1 }, { key: { target: 'manaColor', color: 2 }, amount: 1 }],
    });
    expect(answerFromIntent(ask, ['W', 'W', 'W'])).toBeNull();
  });

  it('a five-mana combination builds one pip at a time and is done at the total', () => {
    const ring = tallyRing(split({ 1: 5, 2: 5, 4: 5, 8: 5, 16: 5 }, 5));
    expect(ring?.options.map((o) => o.syms[0])).toEqual(['W', 'U', 'B', 'R', 'G']);
    const tally = ring!.tally!;
    expect(tallyDone(tally, new Map([['W', 2], ['U', 2]]))).toBe(false);
    expect(tallyDone(tally, new Map([['W', 2], ['U', 3]]))).toBe(true);
    expect(tally.reply(new Map([['W', 2], ['U', 3]])).map((e) => e.amount)).toEqual([2, 3, 0, 0, 0]);
  });
});

describe('keys and layout', () => {
  const ring = abilityRing(offer([
    { id: 1, label: 'x', mana: { makes: 'C', amount: 1 } },
    { id: 2, label: 'x', mana: { choose: 'WU', amount: 2, combination: true } },
  ]))!;

  it('a colour letter, a pair in turn, or a digit', () => {
    expect(optionForKeys(ring.options, 'c')).toEqual({ index: 0 });
    expect(optionForKeys(ring.options, 'W')).toBe('pending');
    expect(optionForKeys(ring.options, 'WU')).toEqual({ index: 2 });
    expect(optionForKeys(ring.options, '4')).toEqual({ index: 3 });
    expect(optionForKeys(ring.options, 'B')).toBeNull();
  });

  it('every disc sits on one circle round the click; two sit either side of it', () => {
    const at = ringLayout(ring.options, 42);
    for (const p of at) expect(Math.hypot(p.dx, p.dy)).toBeCloseTo(p.radius);
    const two = ringLayout(abilityRing(offer([{ id: 1, label: 'x', mana: { choose: 'WU', amount: 1 } }]))!.options, 42);
    expect(two.map((p) => Math.round(p.dy))).toEqual([0, 0]);
    expect(Math.sign(two[0]!.dx)).toBe(-Math.sign(two[1]!.dx));
  });

  it('outer chips sit below the ring, outside it', () => {
    for (const c of chipLayout(2, 50, 42)) expect(c.dy).toBeGreaterThan(50);
  });
});
