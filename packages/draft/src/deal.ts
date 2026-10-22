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
 * ## Never throws
 *
 * A cube too small for the pod wraps (`cursor.pos % size`) rather than
 * dealing short packs or throwing — the same behaviour `engine.ts`'s old
 * private `deal()` had, now exercised here. `poolShortfall` answers "how
 * short" as a value, for a caller that wants to say so before dealing at all.
 */

import type { DraftCard, DraftPlan, PoolSource } from '@hadoku/shared';
import { derive, shuffle } from './rng.ts';

/** Every card a source could deal from — the plan's own say in where cards come from. */
export type SourceCards = (src: PoolSource) => readonly DraftCard[];

/** Two sources are the same deal — share one shuffled copy — iff this key matches. */
function sourceKey(src: PoolSource): string {
  return src.kind === 'cube' ? `cube:${src.cubeId}` : `set:${src.code}:${src.style}`;
}

interface Cursor {
  shuffled: readonly DraftCard[];
  pos: number;
}

/**
 * Deal every pack for a plan, `[round][seat]`.
 *
 * Pure and seeded: the same seed, plan and sources give byte-identical packs
 * back. `seed` is usually the draft id, exactly as `engine.ts`'s own dealing
 * used to key off it — a bug report carries the same three strings that
 * reproduce it.
 */
export function deal(
  plan: DraftPlan,
  sources: SourceCards,
  seed: string,
  seatCount: number,
  packSize: number,
): DraftCard[][][] {
  const cursors = new Map<string, Cursor>();
  const rounds: DraftCard[][][] = [];

  for (const src of plan.rounds) {
    const key = sourceKey(src);
    let cursor = cursors.get(key);
    if (cursor === undefined) {
      const pool = sources(src);
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
      round.push(pack);
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
    const key = sourceKey(src);
    demand.set(key, (demand.get(key) ?? 0) + seatCount * packSize);
    if (!size.has(key)) size.set(key, sources(src).length);
  }
  let total = 0;
  for (const [key, needed] of demand) {
    total += Math.max(0, needed - (size.get(key) ?? 0));
  }
  return total;
}
