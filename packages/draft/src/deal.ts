/*
 * Turning a `DraftPlan` into packs, pure and seeded.
 *
 * `docs/planning/draft-pools-plan.md`'s Design: "the engine stops shuffling
 * and slicing; it passes what it is given" — this is where the shuffling and
 * slicing moved TO, out of `engine.ts`'s private `deal()` (which only ever
 * saw one pool) and into a function that can see a whole plan's three rounds,
 * each with its own source.
 *
 * ## One shuffled copy per source, not per round
 *
 * "Rounds that share a cube share one shuffled copy, so no card repeats" —
 * `docs/planning/wave73-2026-10-21.md` §A step 2. A plan's three rounds are
 * grouped by source identity (`sourceKey`); the first round to use a source
 * shuffles it once, and every later round sharing that source keeps slicing
 * the SAME shuffled array forward from where the previous round left off. Two
 * rounds of two DIFFERENT cubes in a custom plan never touch each other's
 * copies, so the "shards of Alara + Alara Reborn" case the operator asked for
 * composes for free.
 *
 * **Set-cube rounds share this exact mechanism** (wave 74 §E step 2): the
 * `sources` callback hands back the set's non-basic singleton list the same
 * way it hands back a cube's list, and `sourceKey` already keys a `'set'`
 * source by `code:style`, so two set-cube rounds of the same set share one
 * shuffled copy and a custom plan mixing cubes and set-cubes composes with no
 * extra code here.
 *
 * ## Never throws on a short pool
 *
 * A cube (or set-cube) too small for the pod wraps (`cursor.pos % size`)
 * rather than dealing short packs or throwing — the same behaviour
 * `engine.ts`'s old private `deal()` had, now exercised here. This is also
 * ruling 3's "a second copy of the set is added only when short": the FIRST
 * pass through the shuffled singleton list never repeats a name, and only a
 * round that would run past the end of that single pass starts seeing a name
 * again. `poolShortfall` answers "how short" as a value, for a caller that
 * wants to say so before dealing at all.
 *
 * ## Realistic rounds are not sliced from a pool at all
 *
 * A realistic round's packs are Forge's own booster collation
 * (`BoosterGenerator.getBoosterPack`), already seat-shaped — there is no flat
 * list to shuffle and slice. "Realistic boosters are fetched before `deal`
 * and passed in, so `deal` stays synchronous and seeded" (wave 74 §E step 2):
 * the caller resolves `ForgePools.boosters` (an async JVM round-trip) BEFORE
 * calling `deal`, and hands the already-dealt, already catalog-mapped packs
 * in through `realistic`, keyed by ROUND INDEX — not by source, since two
 * realistic rounds of the same set still get independently seeded boosters
 * (`seed + ':' + round`) and never share a cursor the way cube/set-cube
 * rounds do.
 */

import type { DraftCard, DraftPlan, PoolSource } from '@hadoku/shared';
import { derive, shuffle } from './rng.ts';

/** Every card a source could deal from — the plan's own say in where cards come from. Never called for a `realistic` round (see `RealisticPacks`). */
export type SourceCards = (src: PoolSource) => readonly DraftCard[];

/** A source's cards less the plan's `without`: what `deal` shuffles and `poolShortfall` counts. */
export function planPool(plan: DraftPlan, sources: SourceCards, src: PoolSource): readonly DraftCard[] {
  const pool = sources(src);
  if (plan.without === undefined || plan.without.length === 0) return pool;
  const without = new Set(plan.without);
  return pool.filter((card) => !without.has(card.name));
}

/**
 * Pre-fetched, catalog-mapped packs for one realistic round, `[seat][card]`
 * — the caller's own say in "what Forge dealt this round". `undefined` for a
 * round `deal` does not need this for (not `kind: 'set', style: 'realistic'`),
 * or an oversight the caller should not have made (handled as a thrown error
 * below, since dealing nothing for a seat is never a valid draft).
 */
export type RealisticPacks = (roundIndex: number) => readonly (readonly DraftCard[])[] | undefined;

/** A realistic round's own source (for a clearer error than a type-widened `undefined` read would give). */
function isRealistic(src: PoolSource): boolean {
  return src.kind === 'set' && src.style === 'realistic';
}

/** Two sources are the same deal — share one shuffled copy — iff this key matches. Never consulted for a realistic round. */
function sourceKey(src: PoolSource): string {
  return src.kind === 'cube' ? `cube:${src.cubeId}` : `set:${src.code}:${src.style}`;
}

interface Cursor {
  shuffled: readonly DraftCard[];
  pos: number;
}

/**
 * Every dealt card instance gets a unique id WITHIN its draft — `cardId`
 * stamped with the exact `[round][seat][slot]` it was dealt into. Not a
 * per-source special case: this runs on every card `deal()` places into
 * `rounds`, cube/set-cube and realistic alike.
 *
 * Why this matters: `pools/catalog.ts`'s `byName`/`byPrinting` and
 * `pools/sets.ts`'s `cardsFor` all key a card's gameplay fields by NAME (one
 * `DraftCard` object per name, reused — `cards.get(key)`, never cloned), so
 * `cardId` there is the catalog's canonical name key. A set-cube's
 * wrap-on-shortfall (this file's own cursor) and a realistic round's own
 * duplicate-name boosters both then hand out the SAME name — and so the SAME
 * `cardId` — to more than one dealt slot, across different seats and
 * different packs. `pick()` is scoped to one seat's own pack array and is
 * provably safe either way, but nothing else in this codebase's own
 * invariant ("a draft never deals the same card twice" —
 * `cubes.test.ts`'s own assertion) can be trusted if `cardId` is not, in
 * fact, per-instance. Stamping it here, once, at the one place every dealt
 * card already passes through, is the fix at the mechanism rather than a
 * second one per source kind.
 */
function withDealtId(card: DraftCard, round: number, seat: number, slot: number): DraftCard {
  return { ...card, cardId: `${card.cardId}#${round}:${seat}:${slot}` };
}

/** Rarest first: a set's pack, opened (the operator, 2026-10-22: "when doing set realistic or set set-cube make sure to sort the pack by rarity"). */
const RARITY_ORDER: Record<DraftCard['rarity'], number> = { mythic: 0, rare: 1, special: 2, uncommon: 3, common: 4 };

/** A set's pack, rarest first, otherwise in the order it was dealt; a cube's pack as it was dealt. */
function opened(src: PoolSource, pack: readonly DraftCard[]): readonly DraftCard[] {
  return src.kind === 'set' ? [...pack].sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]) : pack;
}

/**
 * Deal every pack for a plan, `[round][seat]`.
 *
 * Pure and seeded: the same seed, plan, sources and `realistic` packs give
 * byte-identical packs back. `seed` is usually the draft id, exactly as
 * `engine.ts`'s own dealing used to key off it — a bug report carries the
 * same three strings that reproduce it.
 */
export function deal(
  plan: DraftPlan,
  sources: SourceCards,
  seed: string,
  seatCount: number,
  packSize: number,
  realistic?: RealisticPacks,
): DraftCard[][][] {
  const cursors = new Map<string, Cursor>();
  const rounds: DraftCard[][][] = [];

  for (let r = 0; r < plan.rounds.length; r++) {
    const src = plan.rounds[r] as PoolSource;

    if (isRealistic(src)) {
      const packs = realistic?.(r);
      if (packs === undefined) {
        throw new Error(`deal: round ${r} is a realistic set (no pool to shuffle) but no pre-fetched packs were supplied for it`);
      }
      if (packs.length !== seatCount) {
        throw new Error(`deal: round ${r}'s realistic packs have ${packs.length} seats, not ${seatCount}`);
      }
      rounds.push(packs.map((pack, s) => opened(src, pack).map((card, i) => withDealtId(card, r, s, i))));
      continue;
    }

    const key = sourceKey(src);
    let cursor = cursors.get(key);
    if (cursor === undefined) {
      const pool = planPool(plan, sources, src);
      if (pool.length === 0) throw new Error(`deal: source ${key} has no cards`);
      cursor = { shuffled: shuffle(pool, derive(seed, 'deal', key)), pos: 0 };
      cursors.set(key, cursor);
    }
    const size = cursor.shuffled.length;
    const round: DraftCard[][] = [];
    for (let s = 0; s < seatCount; s++) {
      const pack: DraftCard[] = [];
      for (let i = 0; i < packSize; i++) {
        pack.push(cursor.shuffled[cursor.pos % size] as DraftCard);
        cursor.pos++;
      }
      round.push(opened(src, pack).map((card, i) => withDealtId(card, r, s, i)));
    }
    rounds.push(round);
  }

  return rounds;
}

/**
 * How many cards short of a clean deal the plan is — 0 when every source is
 * big enough to cover the rounds that share it without wrapping.
 *
 * Grouped by `sourceKey`, same as `deal()`: two rounds of one cube need TWICE
 * the seats-times-pack-size before they run out of fresh cards, and this
 * counts the shortfall against that combined demand, not against each round
 * on its own.
 */
export function poolShortfall(plan: DraftPlan, sources: SourceCards, seatCount: number, packSize: number): number {
  const demand = new Map<string, number>();
  const size = new Map<string, number>();
  for (const src of plan.rounds) {
    if (isRealistic(src)) continue; // Forge always hands back exactly seatCount boosters — never short.
    const key = sourceKey(src);
    demand.set(key, (demand.get(key) ?? 0) + seatCount * packSize);
    if (!size.has(key)) size.set(key, planPool(plan, sources, src).length);
  }
  let total = 0;
  for (const [key, needed] of demand) {
    total += Math.max(0, needed - (size.get(key) ?? 0));
  }
  return total;
}
