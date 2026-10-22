/*
 * `deal()` turns a `DraftPlan` into `packs[round][seat]`, pure and seeded —
 * `docs/planning/wave73-2026-10-21.md` §A step 2. The engine no longer
 * shuffles or slices (`engine.test.ts` covers that it just plays out whatever
 * `packs` it is handed); this file covers the dealing itself.
 */

import { describe, expect, it } from 'vitest';
import type { DraftCard, DraftPlan, PoolSource } from '@hadoku/shared';
import { deal, poolShortfall } from './deal.ts';

/** A synthetic cube, named so a test can tell which cube a card came from. */
function makeCube(name: string, size: number): DraftCard[] {
  return Array.from({ length: size }, (_, i) => ({
    cardId: `${name}-${i}`,
    name: `${name} ${i}`,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: 'Creature — Test',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: String(i + 1),
    rarity: 'common' as const,
  }));
}

const VINTAGE = makeCube('vintage', 540);
const LEGACY = makeCube('legacy', 360);

function sources(src: PoolSource): readonly DraftCard[] {
  if (src.kind !== 'cube') throw new Error('set sources are not dealt this wave');
  if (src.cubeId === 'vintage') return VINTAGE;
  if (src.cubeId === 'legacy') return LEGACY;
  if (src.cubeId === 'tiny') return makeCube('tiny', 20);
  throw new Error(`unknown cube: ${src.cubeId}`);
}

const VINTAGE_X3: { rounds: [PoolSource, PoolSource, PoolSource] } = {
  rounds: [
    { kind: 'cube', cubeId: 'vintage' },
    { kind: 'cube', cubeId: 'vintage' },
    { kind: 'cube', cubeId: 'vintage' },
  ],
};

describe('deal — same seed, same packs', () => {
  it('the same seed twice produces byte-identical packs', () => {
    const a = deal(VINTAGE_X3, sources, 'friday-cube', 8, 15);
    const b = deal(VINTAGE_X3, sources, 'friday-cube', 8, 15);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a different seed deals a different draft', () => {
    const a = deal(VINTAGE_X3, sources, 'friday-cube', 8, 15);
    const b = deal(VINTAGE_X3, sources, 'saturday-cube', 8, 15);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('[round][seat] shape: 3 rounds, 8 seats, 15 cards a pack', () => {
    const packs = deal(VINTAGE_X3, sources, 'shape-check', 8, 15);
    expect(packs.length).toBe(3);
    for (const round of packs) {
      expect(round.length).toBe(8);
      for (const pack of round) expect(pack.length).toBe(15);
    }
  });
});

describe('deal — rounds sharing a cube share one shuffled copy', () => {
  it('two rounds of the same cube never deal the same card twice', () => {
    const packs = deal(VINTAGE_X3, sources, 'no-repeats', 8, 15);
    const seen = new Set<string>();
    for (const round of packs) {
      for (const pack of round) {
        for (const card of pack) {
          expect(seen.has(card.cardId)).toBe(false);
          seen.add(card.cardId);
        }
      }
    }
    // 3 rounds * 8 seats * 15 cards, all distinct — singleton, as the plan says.
    expect(seen.size).toBe(3 * 8 * 15);
  });

  it('two DIFFERENT cubes in a custom plan each deal from their own pool', () => {
    const plan: DraftPlan = {
      rounds: [
        { kind: 'cube', cubeId: 'vintage' },
        { kind: 'cube', cubeId: 'legacy' },
        { kind: 'cube', cubeId: 'vintage' },
      ],
    };
    const packs = deal(plan, sources, 'custom-plan', 8, 15);
    const names = (round: number) => new Set(packs[round]!.flatMap((p) => p.map((c) => c.name)));
    expect([...names(0)].every((n) => n.startsWith('vintage'))).toBe(true);
    expect([...names(1)].every((n) => n.startsWith('legacy'))).toBe(true);
    expect([...names(2)].every((n) => n.startsWith('vintage'))).toBe(true);
    // Rounds 0 and 2 share the vintage cube's one shuffled copy, so together
    // they still never repeat a card, even with round 1 (a different cube)
    // dealt in between.
    const vintageSeen = new Set([...packs[0]!.flat(), ...packs[2]!.flat()].map((c) => c.cardId));
    expect(vintageSeen.size).toBe(2 * 8 * 15);
  });
});

describe('deal — a cube too small for the pod', () => {
  const TINY_X3: DraftPlan = {
    rounds: [
      { kind: 'cube', cubeId: 'tiny' },
      { kind: 'cube', cubeId: 'tiny' },
      { kind: 'cube', cubeId: 'tiny' },
    ],
  };

  it('never throws, and still deals full packs by wrapping', () => {
    expect(() => deal(TINY_X3, sources, 'short-pool', 8, 15)).not.toThrow();
    const packs = deal(TINY_X3, sources, 'short-pool', 8, 15);
    for (const round of packs) {
      expect(round.length).toBe(8);
      for (const pack of round) expect(pack.length).toBe(15);
    }
  });

  it('reports the shortfall as a value rather than hiding it', () => {
    expect(poolShortfall(VINTAGE_X3, sources, 8, 15)).toBe(0);
    // 3 rounds sharing one 20-card cube need 3*8*15 = 360 cards; 20 are real.
    expect(poolShortfall(TINY_X3, sources, 8, 15)).toBe(340);
  });
});
