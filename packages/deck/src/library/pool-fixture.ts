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
 *
 * ## Why it carries mana costs and colours as well as names
 *
 * Wave 26 §D: *"decks should have their corresponding mana symbols."* A deck's
 * colours are a fold over its own card list, and a frozen pool of NAMES cannot
 * be folded — so every deck in the library was uncolourable while the cube's
 * draft pool, which carries `colors` and `manaCost` per card, was not. The two
 * maps below close that, keyed by name so the fixture stays a list plus two
 * lookups rather than becoming a list of card objects; `cards` is untouched and
 * `poolFromFixture` reads none of it, so nothing about legality moved.
 */

import { DECK_COLORS } from '../colors.ts';
import { poolNameKeys, type FormatPool } from '../format.ts';

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
  /**
   * Scryfall's own `mana_cost` per card, e.g. `Huntmaster of the Fells` →
   * `{2}{R}{G}`. Cards with no cost — every land — are absent rather than
   * mapped to `""`, which is what keeps the map to roughly the size of the
   * spells.
   *
   * Keyed by every name the card answers to (`poolNameKeys`), exactly as
   * `poolFromFixture` keys `legal`, so a decklist's `Huntmaster of the Fells`
   * resolves without the caller knowing that Scryfall spells it
   * `Front // Back`. That is the same loss `poolNameKeys`' own comment records
   * having made every Innistrad-era deck illegal once.
   *
   * Here because **a deck's colours are a fold over its own card list** and,
   * until it was, nothing downstream of a frozen pool could compute one: the
   * fixtures held names and nothing else. The COST rather than only
   * {@link colors} because Phyrexian mana makes the two disagree — Gut Shot is
   * `colors: ["R"]` with cost `{R/P}`, and the Mono Green Infect deck in the
   * M13 library plays five such cards, so a fold over `colors` calls a
   * mono-green deck five-coloured.
   */
  readonly manaCost: Readonly<Record<string, string>>;
  /**
   * Scryfall's `colors` per card, as WUBRG-ordered letters: `GR`, `W`, and so
   * on. Colourless cards are absent, for the same reason lands are absent from
   * {@link manaCost}.
   *
   * This is the card's colour as the rules define it, which is NOT the same
   * question as "what does this deck need to cast it" — see {@link manaCost}.
   * Both are carried because both are asked.
   */
  readonly colors: Readonly<Record<string, string>>;
  /**
   * Names a deck may hold one copy of. Type 2 kept a restricted list until
   * 1996 and, before 1995-11, allowed one of each legendary card; both are
   * this one rule, so a snapshot with Forge's `RestrictedLegendary:true` adds
   * every legendary card in the pool to its `Restricted:` names. Absent when
   * the snapshot has neither, which is every era from 1997 on.
   */
  readonly restricted?: readonly string[];
}

/** A projected Scryfall record, read as data and nothing more. */
type Printing = Readonly<Record<string, unknown>>;

/**
 * The front face of a two-faced printing, or `null` for an ordinary card.
 *
 * Needed because a `transform` card carries NO top-level `mana_cost` and no
 * top-level `colors` at all — both live on the faces. Verified against the
 * corpus: `Huntmaster of the Fells // Ravager of the Fells` has neither field
 * at the top level, and its front face has `{2}{R}{G}` / `["G","R"]`.
 */
function frontFace(printing: Printing): Printing | null {
  const faces = printing['card_faces'];
  if (!Array.isArray(faces) || faces.length === 0) return null;
  const front: unknown = faces[0];
  return typeof front === 'object' && front !== null ? (front as Printing) : null;
}

function manaCostOf(printing: Printing): string {
  const own = printing['mana_cost'];
  if (typeof own === 'string' && own.length > 0) return own;
  const face = frontFace(printing)?.['mana_cost'];
  return typeof face === 'string' ? face : '';
}

function isLegendary(printing: Printing): boolean {
  const own = printing['type_line'];
  const face = frontFace(printing)?.['type_line'];
  const line = typeof own === 'string' ? own : typeof face === 'string' ? face : '';
  return /\bLegendary\b/.test(line);
}

function colorsOf(printing: Printing): string {
  const own = printing['colors'];
  const face = frontFace(printing)?.['colors'];
  const raw = Array.isArray(own) ? own : Array.isArray(face) ? face : [];
  const held = new Set(raw.filter((c): c is string => typeof c === 'string'));
  return DECK_COLORS.filter((c) => held.has(c)).join('');
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
    readonly restricted?: readonly string[];
    readonly restrictedLegendary?: boolean;
  };
  readonly cards: readonly {
    readonly name: string;
    /**
     * The representative printing, `GameplayCard`-shaped — i.e. a projected
     * Scryfall record, read for its `mana_cost` and `colors` and nothing else.
     * `PoolCard.printing` satisfies this, and a `Record<string, unknown>` is
     * all the shape this file is willing to claim about it.
     */
    readonly printing: Printing;
  }[];
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
  // Built in `pool.cards` order, which `standardPoolAt` name-sorts, so the two
  // maps come out in the same order as `cards` and a diff in the committed file
  // is a real change rather than a re-serialisation.
  const manaCost: Record<string, string> = {};
  const colors: Record<string, string> = {};
  for (const card of pool.cards) {
    const cost = manaCostOf(card.printing);
    const colour = colorsOf(card.printing);
    for (const key of poolNameKeys(card.name)) {
      if (cost.length > 0) manaCost[key] = cost;
      if (colour.length > 0) colors[key] = colour;
    }
  }
  const restricted = [
    ...(pool.format.restricted ?? []),
    ...(pool.format.restrictedLegendary === true ? pool.cards.filter((c) => isLegendary(c.printing)).map((c) => c.name) : []),
  ];
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
    manaCost,
    colors,
    ...(restricted.length > 0 ? { restricted } : {}),
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
 * Read a map of `name → string`, tolerating its absence.
 *
 * Absence is NOT a fault, unlike every field above, and the difference is
 * deliberate: `cards`, `sets` and `banned` are what a legality check reads, so a
 * generator that drops one must be refused loudly. `manaCost` and `colors` are
 * an enrichment nothing legal depends on — a pool with no cost map still
 * validates every deck identically — and a parser that refused a fixture over
 * them would take the whole format picker down (`http/library.ts` drops a pool
 * it cannot parse) to hide a missing set of mana symbols. A present-but-wrong
 * map is still a fault, because that is a generator that believes it emitted
 * something.
 *
 * What keeps the absence from being silent is a test rather than a throw:
 * `apps/ui/src/components/DeckView.test.ts` asserts every committed fixture
 * carries both maps and that they cover the real decklists.
 */
function optionalStringMap(
  source: Record<string, unknown>,
  key: string,
  faults: string[],
): Record<string, string> {
  const value = field(source, key);
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    faults.push(`\`${key}\` must be an object of strings`);
    return {};
  }
  // Checked in place and handed back as parsed: any fault fails the whole fixture, so a
  // copy would only cost time — a Legacy pool's map is some 30,000 names, and copying
  // them key by key was most of what reading the library at boot cost.
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string' || item.length === 0) {
      faults.push(`\`${key}[${JSON.stringify(name)}]\` must be a non-empty string`);
    }
  }
  return value as Record<string, string>;
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
  const manaCost = optionalStringMap(raw, 'manaCost', faults);
  const colors = optionalStringMap(raw, 'colors', faults);
  const restricted = raw['restricted'] === undefined ? undefined : requireStringArray(raw, 'restricted', faults);

  if (faults.length === 0 && cards.length === 0) {
    // A pool with no cards passes every shape check and fails every deck. It
    // has never been a legitimate answer for a date the table can answer at
    // all, so it is a generator fault, not a format with nothing in it.
    faults.push('`cards` is empty, which no real Standard pool is');
  }
  if (faults.length > 0) {
    throw new PoolFixtureError(`pool fixture is unusable: ${faults.join('; ')}`);
  }

  return { date, name, effective, source, sets, banned, cards, manaCost, colors, ...(restricted === undefined ? {} : { restricted }) };
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
 * `restricted` is Type 2's one-copy list (with every legendary card added
 * where the era had that rule — see {@link PoolFixture.restricted}); empty for
 * every era from 1997 on. Everything else is left at `format.ts`'s defaults,
 * which are Forge's `Constructed` row: 60 minimum, 15 sideboard, 4 copies.
 */
/**
 * Snow-covered basics, under the same ordinary names `isBasicLand` already
 * exempts from the copy limit (`deck.ts`'s five, Wastes deliberately excluded).
 *
 * Forge's own `canHaveAnyNumberOf` tests `isBasicLand()`, which is TYPE-based
 * (`CardType.isBasicLand`, forge-core `CardType.java:520`) — a snow basic's
 * type line is `Basic Snow Land — Mountain`, so Forge exempts it exactly as it
 * does `Mountain`. `@hadoku/deck`'s own `isBasicLand` is name-based and
 * deliberately narrow (five names, "and notably not Wastes"), so it does not
 * know these five exist. Rather than widen that general rule for one era's
 * decks, the pool builder — which already supplies `anyNumberOf` for
 * format-specific exemptions like Relentless Rats — supplies these too. Found
 * transcribing the 2008 power-summer era (wave 34 lane D): Coldsnap was legal
 * there and five of its twelve decks play more than four of one snow basic
 * (Michael Jacob's Red Deck Wins plays 22 Snow-Covered Mountain, load-bearing
 * for Skred). Harmless for every other era, none of which has Coldsnap in its
 * legal sets.
 */
const SNOW_BASIC_LAND_NAMES: readonly string[] = [
  'Snow-Covered Plains',
  'Snow-Covered Island',
  'Snow-Covered Swamp',
  'Snow-Covered Mountain',
  'Snow-Covered Forest',
];

export function poolFromFixture(fixture: PoolFixture): FormatPool {
  return {
    name: fixture.name,
    // Front faces included: a decklist names `Huntmaster of the Fells`, the
    // frozen pool holds `Huntmaster of the Fells // Ravager of the Fells`.
    // See `poolNameKeys`.
    legal: new Set(fixture.cards.flatMap(poolNameKeys)),
    banned: new Set(fixture.banned),
    restricted: new Set((fixture.restricted ?? []).flatMap(poolNameKeys)),
    anyNumberOf: new Set(SNOW_BASIC_LAND_NAMES),
  };
}
