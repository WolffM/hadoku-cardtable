/*
 * A format pool, frozen to JSON, so a test can validate real decks without the
 * 183 MB card corpus.
 *
 * ## Why this file exists at all
 *
 * `standardPoolAt(date, index)` needs a `PrintingIndex`, and a `PrintingIndex`
 * is built from `packages/carddata/data/cards.jsonl` — 183 MB, gitignored,
 * absent in CI. A test that needs it is a test that does not run, and a test
 * that SKIPS when it is missing is worse than none: it is a green gate that
 * checks nothing, and this repo has already found five of those.
 *
 * So the pool is computed once against the real corpus and committed as data.
 * The committed fixture is not a hand-written prop — every name in it came out
 * of `standardPoolAt` run over the real cards, and the file says which command
 * produced it. Same posture, and the same reason, as
 * `packages/carddata/src/formats/standard-pool.json`, whose `$comment` spells
 * it out: *"the unit tests run against a hand-built index because
 * data/cards.jsonl is gitignored and absent in CI, so this file is the
 * corpus-scale evidence … and a diff here is a regression."*
 *
 * The two artefacts do different jobs and both are needed. `standard-pool.json`
 * is a report ABOUT `standardPoolAt` — counts, agreement with Scryfall, ban
 * matching. A fixture here is the pool ITSELF, card by card, so the deck
 * validator can be run against it.
 *
 * ## Why it is a plain object and not a carddata import
 *
 * `@hadoku/carddata/formats` is node-only: `standard.ts` imports `resolve.ts`
 * (standard.ts:69), which imports `node:fs`, `node:readline` and `node:path`
 * (resolve.ts:32-34). `@hadoku/deck` is bundled into the browser, so nothing
 * here may reach it. This file therefore re-declares the handful of fields a
 * pool needs as its own shape and validates them at the boundary. The producer
 * side — `build-pool-fixture.ts`, a node script nothing imports — is where
 * `standardPoolAt` is actually called.
 *
 * That is not duplication for its own sake: it is the same "pool is an
 * argument, never an import" rule `format.ts` is built on, applied one level
 * out.
 */

import type { FormatPool } from '../format.ts';

/** A `standardPoolAt` result, reduced to what a legality check needs. */
export interface PoolFixture {
  /** The date the pool was asked for, `YYYY-MM-DD`. */
  readonly date: string;
  /** Forge's name for the snapshot in force, e.g. `Standard (MBS)`. */
  readonly name: string;
  /** The snapshot's own effective date, which may be earlier than `date`. */
  readonly effective: string;
  /** The Forge format file the snapshot was transcribed from. */
  readonly source: string;
  /** Legal sets, upper-cased Scryfall codes, in Forge's order. */
  readonly sets: readonly string[];
  /** Banned card names, exactly as Forge writes them. */
  readonly banned: readonly string[];
  /** Every legal card name, as Scryfall spells it, sorted. Bans excluded. */
  readonly cards: readonly string[];
}

/**
 * As much of a `standardPoolAt` success as a fixture needs, declared
 * structurally rather than imported.
 *
 * `@hadoku/carddata/formats`'s `StandardPool` satisfies this by shape, so the
 * producer passes one straight in and TypeScript checks the fit at the call
 * site — but this file still imports nothing from a node-only module, which is
 * the whole point of the paragraph above. If `StandardPool` ever stops carrying
 * one of these fields the call site fails to compile, which is the failure we
 * want and where we want it.
 */
export interface StandardPoolLike {
  readonly format: {
    readonly name: string;
    readonly effective: string;
    readonly source: string;
    readonly setList: readonly string[];
    readonly banned: readonly string[];
  };
  readonly cards: readonly { readonly name: string }[];
}

/**
 * Reduce a `standardPoolAt` answer to the fixture shape.
 *
 * Lives here, beside the reader, so the freezing and the thawing are one file
 * apart from nothing. `build-pool-fixture.ts` calls it to write the committed
 * JSON and `validate-library.ts` calls it to build a pool from the live corpus,
 * which means the hermetic test and the real-corpus run go through ONE
 * conversion. Two would be two chances to disagree, and a green test beside a
 * red measurement is worse than either alone.
 */
export function fixtureFromStandardPool(date: string, pool: StandardPoolLike): PoolFixture {
  return {
    date,
    name: pool.format.name,
    effective: pool.format.effective,
    source: pool.format.source,
    sets: [...pool.format.setList],
    banned: [...pool.format.banned],
    // `standardPoolAt` returns `cards` name-sorted, so the committed file is
    // stable across runs and a diff in it is a real change.
    cards: pool.cards.map((c) => c.name),
  };
}

/** Thrown when a fixture file is not a usable pool. */
export class PoolFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolFixtureError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function field(source: Record<string, unknown>, key: string): unknown {
  return source[key];
}

function requireString(source: Record<string, unknown>, key: string, faults: string[]): string {
  const value = field(source, key);
  if (typeof value !== 'string' || value.length === 0) {
    faults.push(`\`${key}\` must be a non-empty string`);
    return '';
  }
  return value;
}

function requireStringArray(
  source: Record<string, unknown>,
  key: string,
  faults: string[],
): string[] {
  const value = field(source, key);
  if (!Array.isArray(value)) {
    faults.push(`\`${key}\` must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string' || item.length === 0) {
      faults.push(`\`${key}[${i}]\` must be a non-empty string`);
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * Read a fixture out of already-parsed JSON, or refuse with every fault named.
 *
 * Validated rather than cast, because the fixture is a **generated** file: the
 * failure mode worth catching is a generator change that quietly drops a field,
 * and a cast would turn that into `undefined` flowing into a `Set` and a pool
 * that silently contains nothing. An empty pool makes every deck fail with 20
 * `not-in-pool` issues, which reads exactly like a bad decklist — the wrong
 * diagnosis, loudly.
 *
 * Unknown keys are ignored on purpose: the generated file carries `$comment`,
 * `generatedAt` and `counts` for humans, and a reader that rejected those would
 * make the file unannotatable.
 */
export function parsePoolFixture(json: unknown): PoolFixture {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new PoolFixtureError('pool fixture must be a JSON object');
  }
  const raw = json as Record<string, unknown>;
  const faults: string[] = [];

  const date = requireString(raw, 'date', faults);
  if (date.length > 0 && !ISO_DATE.test(date)) {
    faults.push(`\`date\` must be YYYY-MM-DD, not ${JSON.stringify(date)}`);
  }
  const name = requireString(raw, 'name', faults);
  const effective = requireString(raw, 'effective', faults);
  const source = requireString(raw, 'source', faults);
  const sets = requireStringArray(raw, 'sets', faults);
  const banned = requireStringArray(raw, 'banned', faults);
  const cards = requireStringArray(raw, 'cards', faults);

  if (faults.length === 0 && cards.length === 0) {
    // A pool with no cards passes every shape check and fails every deck. It
    // has never been a legitimate answer for a date the table can answer at
    // all, so it is a generator fault, not a format with nothing in it.
    faults.push('`cards` is empty, which no real Standard pool is');
  }
  if (faults.length > 0) {
    throw new PoolFixtureError(`pool fixture is unusable: ${faults.join('; ')}`);
  }

  return { date, name, effective, source, sets, banned, cards };
}

/**
 * The fixture as a `FormatPool` `formatIssues` can validate against.
 *
 * `banned` is carried across even though `standardPoolAt` has already removed
 * banned cards from `cards`. Without it a banned card reports `not-in-pool`
 * — *"which is not in Standard"* — and with it the deck reports `banned`,
 * *"which Standard bans"*. Those are different facts and the second one is the
 * true one; a player whose Jace reads "not in Standard" will go looking for a
 * rotation that never happened.
 *
 * Everything else is left at `format.ts`'s defaults, which are Forge's
 * `Constructed` row: 60 minimum, 15 sideboard, 4 copies. Standard has had no
 * restricted list since 2003 and the snapshots this library uses carry none.
 */
export function poolFromFixture(fixture: PoolFixture): FormatPool {
  return {
    name: fixture.name,
    legal: new Set(fixture.cards),
    banned: new Set(fixture.banned),
  };
}
