import { describe, expect, it } from 'vitest';

import { parseDck } from '@hadoku/carddata/dck';
import type { DraftCard, ManaColor } from '@hadoku/shared';

import { checkSeat, type GateContext } from '../../../http/gate.ts';
import { buildDeck } from './pod-deck.ts';

let collector = 0;
const card = (name: string, colors: ManaColor[], manaValue: number, typeLine = 'Creature — Mouse'): DraftCard => {
  collector += 1;
  return { cardId: `${name}#${String(collector)}`, name, manaCost: [], manaValue, colors, typeLine, oracleText: '', setCode: 'BLB', collectorNumber: String(collector), rarity: 'common' };
};

function counts(dck: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of parseDck(dck).sections.get('main') ?? []) out.set(e.card.name, (out.get(e.card.name) ?? 0) + e.count);
  return out;
}

const pool = [
  ...Array.from({ length: 15 }, (_, i) => card(`White ${String(i)}`, ['W'], (i % 5) + 1)),
  ...Array.from({ length: 12 }, (_, i) => card(`Green ${String(i)}`, ['G'], (i % 4) + 1)),
  ...Array.from({ length: 8 }, () => card('Blue', ['U'], 2)),
  card('Rope', [], 1, 'Artifact'),
  card('Lupinflower Village', [], 0, 'Land'),
];

describe('buildDeck', () => {
  it("is 40 cards of the pool's two deepest colours plus their basics", () => {
    const deck = counts(buildDeck(pool, 'test'));
    expect([...deck.values()].reduce((a, b) => a + b, 0)).toBe(40);
    expect(deck.has('Blue')).toBe(false);
    expect(deck.has('Lupinflower Village')).toBe(false);
    expect((deck.get('Plains') ?? 0) + (deck.get('Forest') ?? 0)).toBe(17);
    expect(deck.get('Plains') ?? 0).toBeGreaterThan(deck.get('Forest') ?? 0);
  });

  it('passes the match gate against the pool it came from, printings and all', () => {
    const ctx: GateContext = {
      library: { formats: [], decks: [], faults: [], format: () => undefined, deck: () => undefined },
      draftPool: (draftId) => (draftId === 'r-pod' ? { ok: true, pool } : { ok: false, error: 'no seat' }),
    };
    const verdict = checkSeat({ deck: { dck: buildDeck(pool, 'gate') }, rules: { kind: 'draft', draftId: 'r-pod' } }, ctx);
    expect('legal' in verdict && verdict.issues).toEqual([]);
    expect('legal' in verdict && verdict.legal).toBe(true);
  });
});
