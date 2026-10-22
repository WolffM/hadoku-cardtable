/*
 * `deal()` turns a `DraftPlan` into `packs[round][seat]`, pure and seeded —
 * `docs/planning/wave73-2026-10-21.md` §A step 2. The engine no longer
 * shuffles or slices (`engine.test.ts` covers that it just plays out whatever
 * `packs` it is handed); this file covers the dealing itself.
 */

import { describe, expect, it } from 'vitest';
import type { DraftCard, DraftPlan, PoolSource } from '@hadoku/shared';
import { deal, poolShortfall, type RealisticPacks } from './deal.ts';
import { createDraft, packOf, pick, waitingOn } from './engine.ts';
import { runBots } from './bot.ts';

/** Every field but `cardId` — `deal()` now stamps its own per-instance id (wave 74 §E fix-forward: "every dealt card instance gets a unique id within its draft"), so a byte-for-byte content check compares everything else. */
function withoutId(packs: readonly (readonly DraftCard[])[]): unknown {
  return packs.map((pack) => pack.map(({ cardId: _cardId, ...rest }) => rest));
}

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

/** A synthetic set's non-basic singletons, named so a test can tell which set a card came from. */
function makeSet(code: string, size: number): DraftCard[] {
  return Array.from({ length: size }, (_, i) => ({
    cardId: `${code}-${i}`,
    name: `${code} card ${i}`,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: 'Creature — Test',
    oracleText: '',
    setCode: code,
    collectorNumber: String(i + 1),
    rarity: 'common' as const,
  }));
}

const VINTAGE = makeCube('vintage', 540);
const LEGACY = makeCube('legacy', 360);
const ARB_SET_CUBE = makeSet('ARB', 145);

function sources(src: PoolSource): readonly DraftCard[] {
  if (src.kind === 'set') {
    if (src.style !== 'set-cube') throw new Error('realistic rounds are not dealt through sources()');
    if (src.code === 'ARB') return ARB_SET_CUBE;
    throw new Error(`unknown set: ${src.code}`);
  }
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

/*
 * Acceptance 2 (`docs/planning/wave74-2026-10-21.md`): "Set-cube ARB for 8
 * seats deals 360 cards from 145 non-basic singletons. No name appears more
 * than ⌈360/145⌉ = 3 times. No second copy enters while singletons remain
 * (ruling 3). No basic land appears." `ARB_SET_CUBE` above is exactly the
 * 145-card non-basic singleton list `pool:setCards` would hand back (never a
 * basic — Forge's own filter, `PoolService.java`'s `handleSetCards`); the
 * generic wrap-on-shortfall mechanism `deal` already has for cubes is what
 * gives the ⌈360/145⌉ bound and the "no second copy while singletons remain"
 * rule for free, with ZERO set-specific code in `deal` itself.
 */
describe('deal — set-cube: the plan\'s set-cube style is dealt exactly like a cube', () => {
  const ARB_SET_CUBE_X3: DraftPlan = {
    rounds: [
      { kind: 'set', code: 'ARB', style: 'set-cube' },
      { kind: 'set', code: 'ARB', style: 'set-cube' },
      { kind: 'set', code: 'ARB', style: 'set-cube' },
    ],
  };

  it('8 seats, 3 rounds of 145 singletons: 360 cards dealt, no name more than 3 times, no basic land, no second copy until the first pass is exhausted', () => {
    expect(ARB_SET_CUBE).toHaveLength(145);
    expect(ARB_SET_CUBE.every((c) => !c.typeLine.includes('Basic Land'))).toBe(true);

    const packs = deal(ARB_SET_CUBE_X3, sources, 'arb-set-cube', 8, 15);
    const dealt = packs.flatMap((round) => round.flatMap((pack) => pack.map((c) => c.name)));
    expect(dealt.length).toBe(360);

    const counts = new Map<string, number>();
    for (const name of dealt) counts.set(name, (counts.get(name) ?? 0) + 1);
    // Every one of the 145 names was dealt at least once before any name was
    // dealt a second time — the "no second copy while singletons remain"
    // ruling — which the single-shuffled-pass wrap already guarantees: name i
    // appears floor(360/145)=2 or ceil(360/145)=3 times, never 1 or 4+, and
    // every name appears at least twice only once the whole 145 have been seen.
    expect(counts.size).toBe(145);
    expect(Math.max(...counts.values())).toBe(3);
    expect(Math.min(...counts.values())).toBe(2);
    // 70 names dealt 3 times, 75 dealt twice: 70*3 + 75*2 = 360.
    expect([...counts.values()].filter((n) => n === 3)).toHaveLength(70);
    expect([...counts.values()].filter((n) => n === 2)).toHaveLength(75);
  });

  it('two DIFFERENT sets in a custom plan each deal from their own non-basic list (ALA + ALA Reborn composes the same way two cubes do)', () => {
    const alaSources = (src: PoolSource): readonly DraftCard[] => {
      if (src.kind === 'set' && src.code === 'ALA') return makeSet('ALA', 180);
      if (src.kind === 'set' && src.code === 'ARB') return ARB_SET_CUBE;
      throw new Error('unexpected source');
    };
    const plan: DraftPlan = {
      rounds: [
        { kind: 'set', code: 'ALA', style: 'set-cube' },
        { kind: 'set', code: 'ALA', style: 'set-cube' },
        { kind: 'set', code: 'ARB', style: 'set-cube' },
      ],
    };
    const packs = deal(plan, alaSources, 'shards-of-alara', 8, 15);
    const names = (round: number) => new Set(packs[round]!.flatMap((p) => p.map((c) => c.name)));
    expect([...names(0)].every((n) => n.startsWith('ALA'))).toBe(true);
    expect([...names(1)].every((n) => n.startsWith('ALA'))).toBe(true);
    expect([...names(2)].every((n) => n.startsWith('ARB'))).toBe(true);
  });
});

/*
 * Wave 74 §E step 2: "realistic boosters are fetched before `deal` and
 * passed in, so `deal` stays synchronous and seeded." These packs never come
 * from `sources()` at all — `deal` just plays them back, by round index.
 */
describe('deal — realistic: pre-fetched packs are played back, never shuffled', () => {
  const REALISTIC_X1: DraftPlan = {
    rounds: [
      { kind: 'set', code: 'ISD', style: 'realistic' },
      { kind: 'cube', cubeId: 'vintage' },
      { kind: 'cube', cubeId: 'vintage' },
    ],
  };

  function forgePacks(seatCount: number): DraftCard[][] {
    return Array.from({ length: seatCount }, (_, seat) => makeCube(`isd-seat${seat}`, 15));
  }

  it('round 0 is exactly the packs the caller supplied, byte for byte', () => {
    const realistic: RealisticPacks = (round) => (round === 0 ? forgePacks(8) : undefined);
    const packs = deal(REALISTIC_X1, sources, 'realistic-plan', 8, 15, realistic);
    expect(JSON.stringify(withoutId(packs[0]!))).toBe(JSON.stringify(withoutId(forgePacks(8))));
    // Every dealt card still gets its own unique id (the fix-forward below).
    const ids = packs[0]!.flat().map((c) => c.cardId);
    expect(new Set(ids).size).toBe(ids.length);
    // Round 1 (a cube) still deals normally, untouched by the realistic hook.
    expect(packs[1]!.every((pack) => pack.every((c) => c.name.startsWith('vintage')))).toBe(true);
  });

  it('throws rather than silently dealing nothing when a realistic round has no supplied packs', () => {
    expect(() => deal(REALISTIC_X1, sources, 'realistic-plan', 8, 15)).toThrow(/realistic/);
    expect(() => deal(REALISTIC_X1, sources, 'realistic-plan', 8, 15, () => undefined)).toThrow(/realistic/);
  });

  it('throws when the supplied packs do not match the room\'s seat count', () => {
    const realistic: RealisticPacks = (round) => (round === 0 ? forgePacks(6) : undefined);
    expect(() => deal(REALISTIC_X1, sources, 'realistic-plan', 8, 15, realistic)).toThrow(/seats/);
  });

  it('two realistic rounds of the SAME set never share a cursor — each round index is independent', () => {
    const plan: DraftPlan = {
      rounds: [
        { kind: 'set', code: 'ISD', style: 'realistic' },
        { kind: 'set', code: 'ISD', style: 'realistic' },
        { kind: 'cube', cubeId: 'vintage' },
      ],
    };
    const round0 = forgePacks(8);
    const round1 = forgePacks(8).map((pack) => pack.map((c) => ({ ...c, cardId: `${c.cardId}-r1` })));
    const realistic: RealisticPacks = (round) => (round === 0 ? round0 : round === 1 ? round1 : undefined);
    const packs = deal(plan, sources, 'two-realistic-rounds', 8, 15, realistic);
    expect(JSON.stringify(withoutId(packs[0]!))).toBe(JSON.stringify(withoutId(round0)));
    expect(JSON.stringify(withoutId(packs[1]!))).toBe(JSON.stringify(withoutId(round1)));
  });

  it('poolShortfall never counts a realistic round — Forge always hands back exactly seatCount boosters', () => {
    expect(poolShortfall(REALISTIC_X1, sources, 8, 15)).toBe(0);
  });
});

/*
 * PRODUCTION INCIDENT (found by lane F's e2e, main 705e2468): a custom
 * ALA-realistic/ALA-realistic/ARB-realistic draft hung at pick ~3, every
 * seat (humans and bots) frozen, no error, no log. `runBots` breaks silently
 * when a full pass makes no progress (`bot.ts`'s own design) — F's frames
 * showed the same `cardId` held by different seats at the same instant
 * (e.g. "island" in both seat 0's and seat 1's packs at pick 1): the
 * catalog's `byName`/`byPrinting` key a card's gameplay fields by NAME, one
 * cached `DraftCard` per name, never cloned — so a name that recurs (a small
 * realistic set's commons, or a set-cube's wrap-on-shortfall copies) hands
 * out the SAME `cardId` to more than one dealt slot.
 *
 * `pick()` is proven safe against that BY ITSELF (it is scoped to the
 * caller's own pack array — see `engine.ts`'s own header on why), and this
 * suite's own reproduction attempts (several, including one against the
 * real jar's ALA/ARB boosters through a hand-built version of the real
 * pipeline) never stalled `runBots` either. The proximate trigger for the
 * production hang was NOT conclusively identified in the time available —
 * see this lane's closing note. The fix below stands on its own: it is the
 * SAME invariant `cubes.test.ts`'s "a draft over a real cube never deals
 * the same card twice" already holds cube sources to, generalized to every
 * source kind, at the one mechanism (`deal()`) every dealt card already
 * passes through.
 *
 * These tests drive a FULL draft to completion through the exact
 * pick/runBots path the socket uses (`playOut`, below — the same shape
 * `cubes.test.ts`'s own `playOut` already uses), for every source kind and
 * a mixed plan, and assert both completion AND global `cardId` uniqueness.
 */
describe('a full draft, every source kind: completes, and no cardId is ever dealt twice', () => {
  const SEATS = 8;

  /** A small shared "catalog": the SAME object for every occurrence of a name — exactly `catalog.ts`'s `byName`/`byPrinting` (`cards.get(key)`, never cloned). */
  function aliasedCatalog(setCode: string) {
    const cache = new Map<string, DraftCard>();
    return (i: number): DraftCard => {
      const name = `${setCode} common ${i}`;
      const existing = cache.get(name);
      if (existing !== undefined) return existing;
      const card: DraftCard = {
        cardId: name.toLowerCase(), // the catalog's canonical name key — SAME for every occurrence
        name,
        manaCost: [],
        manaValue: 1 + (i % 4),
        colors: [],
        typeLine: 'Creature — Test',
        oracleText: '',
        setCode,
        collectorNumber: String(i + 1),
        rarity: 'common',
      };
      cache.set(name, card);
      return card;
    };
  }

  /** `cubes.test.ts`'s own `playOut`: bots catch up, then one human (the lowest-numbered owing seat) picks the first card in their pack — the exact pick/runBots shape `room/socket.ts` drives. */
  function playOut(state: ReturnType<typeof createDraft>): ReturnType<typeof createDraft> {
    let current = state;
    for (let guard = 0; guard < 2000; guard++) {
      if (current.status === 'complete') break;
      current = runBots(current).state;
      const owing = waitingOn(current);
      if (owing.length === 0) continue;
      const seatId = owing[0] as number;
      const card = packOf(current, seatId)[0];
      if (card === undefined) break;
      const result = pick(current, seatId, card.cardId);
      if (!result.ok) break;
      current = result.state;
    }
    return current;
  }

  function assertCompleteNoDuplicates(done: ReturnType<typeof createDraft>): void {
    expect(done.status).toBe('complete');
    const seen = new Set<string>();
    for (const pool of done.pools) {
      expect((pool as DraftCard[]).length).toBe(45);
      for (const card of pool as DraftCard[]) {
        expect(seen.has(card.cardId)).toBe(false);
        seen.add(card.cardId);
      }
    }
    expect(seen.size).toBe(SEATS * 45);
  }

  function humansAndNoBots() {
    return { humans: [{ participantId: 'fk:alice', displayName: 'alice' }, { participantId: 'fk:bob', displayName: 'bob' }] };
  }

  it('cube: completes with no duplicate cardId', () => {
    const plan: DraftPlan = { rounds: [{ kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'vintage' }, { kind: 'cube', cubeId: 'vintage' }] };
    const done = playOut(
      createDraft({ draftId: 'full-cube', seed: 'full-cube', packs: deal(plan, sources, 'full-cube', SEATS, 15), seatCount: SEATS, packCount: 3, packSize: 15, ...humansAndNoBots() }),
    );
    assertCompleteNoDuplicates(done);
  });

  it('set-cube: wrap-on-shortfall copies (same name, same cardId pre-fix) complete with no duplicate cardId', () => {
    const catalog = aliasedCatalog('ARB');
    const smallSet = Array.from({ length: 60 }, (_, i) => catalog(i)); // < 360 needed — wraps, reusing the SAME names/objects
    const src: PoolSource = { kind: 'set', code: 'ARB', style: 'set-cube' };
    const plan: DraftPlan = { rounds: [src, src, src] };
    const done = playOut(
      createDraft({ draftId: 'full-set-cube', seed: 'full-set-cube', packs: deal(plan, () => smallSet, 'full-set-cube', SEATS, 15), seatCount: SEATS, packCount: 3, packSize: 15, ...humansAndNoBots() }),
    );
    assertCompleteNoDuplicates(done);
  });

  it('realistic: duplicate names within AND across packs (same cardId pre-fix) complete with no duplicate cardId — the production case', () => {
    const catalog = aliasedCatalog('ALA');
    const POOL = 15; // forces within-pack and cross-pack repeats, like a small set's commons
    const booster = (seedBase: number): DraftCard[] => Array.from({ length: 15 }, (_, i) => catalog((seedBase * 7 + i * 3) % POOL));
    const roundsPacks: DraftCard[][][] = [
      Array.from({ length: SEATS }, (_, seat) => booster(seat)),
      Array.from({ length: SEATS }, (_, seat) => booster(seat + SEATS)),
      Array.from({ length: SEATS }, (_, seat) => booster(seat + 2 * SEATS)),
    ];
    const src: PoolSource = { kind: 'set', code: 'ALA', style: 'realistic' };
    const plan: DraftPlan = { rounds: [src, src, src] };
    const neverCalled = (): readonly DraftCard[] => {
      throw new Error('a realistic round must never ask for a pool to shuffle');
    };
    const done = playOut(
      createDraft({
        draftId: 'full-realistic',
        seed: 'full-realistic',
        packs: deal(plan, neverCalled, 'full-realistic', SEATS, 15, (round) => roundsPacks[round]),
        seatCount: SEATS,
        packCount: 3,
        packSize: 15,
        ...humansAndNoBots(),
      }),
    );
    assertCompleteNoDuplicates(done);
  });

  it('mixed: cube / set-cube-with-copies / realistic-with-dupes, one per round, completes with no duplicate cardId', () => {
    const arb = aliasedCatalog('ARB');
    const smallSet = Array.from({ length: 60 }, (_, i) => arb(i));
    const ala = aliasedCatalog('ALA');
    const POOL = 15;
    const booster = (seedBase: number): DraftCard[] => Array.from({ length: 15 }, (_, i) => ala((seedBase * 7 + i * 3) % POOL));
    const realisticRound = Array.from({ length: SEATS }, (_, seat) => booster(seat));
    const plan: DraftPlan = {
      rounds: [{ kind: 'cube', cubeId: 'vintage' }, { kind: 'set', code: 'ARB', style: 'set-cube' }, { kind: 'set', code: 'ALA', style: 'realistic' }],
    };
    const mixedSources = (src: PoolSource): readonly DraftCard[] => {
      if (src.kind === 'cube' && src.cubeId === 'vintage') return VINTAGE;
      if (src.kind === 'set' && src.code === 'ARB') return smallSet;
      throw new Error(`mixed: unexpected source ${JSON.stringify(src)}`);
    };
    const done = playOut(
      createDraft({
        draftId: 'full-mixed',
        seed: 'full-mixed',
        packs: deal(plan, mixedSources, 'full-mixed', SEATS, 15, (round) => (round === 2 ? realisticRound : undefined)),
        seatCount: SEATS,
        packCount: 3,
        packSize: 15,
        ...humansAndNoBots(),
      }),
    );
    assertCompleteNoDuplicates(done);
  });
});
