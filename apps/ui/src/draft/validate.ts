/**
 * A structural validator for the §B.5 envelope.
 *
 * ## Why this exists at all
 *
 * The wave plan gives lane B `packages/shared` and a Zod schema for this
 * envelope. Lane B was not dispatched (its registry prerequisite failed), so
 * the schema does not exist and these fixtures have nothing to validate
 * against. Shipping unvalidated JSON and calling the done-when satisfied would
 * be exactly the vacuous gate this project's tracker keeps catching, so the
 * fixtures are validated here instead — by a checker written from the same
 * prose contract, with no Zod dependency.
 *
 * **This is a placeholder with a deletion condition.** When lane B lands its
 * schema, replace `parseDraftView` with that schema's `parse` and keep the
 * tests. If the fixtures then fail, the fixtures are wrong — that is lane C's
 * bug, which the wave plan says out loud.
 *
 * Errors accumulate and are returned with a JSON path. A validator that throws
 * on the first problem tells you one thing per run about a file with fifteen
 * cards in it.
 */

import type { DraftCard, DraftSeatView, DraftView, ManaColor, Rarity } from './types.ts';

const COLORS: readonly string[] = ['W', 'U', 'B', 'R', 'G'];
const RARITIES: readonly string[] = ['common', 'uncommon', 'rare', 'mythic', 'special'];

export interface ValidationFailure {
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationFailure[] };

class Checker {
  readonly errors: ValidationFailure[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  /** Returns the value when it is a plain object, else records and returns null. */
  object(path: string, v: unknown): Record<string, unknown> | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, `expected an object, got ${describe(v)}`);
      return null;
    }
    return v as Record<string, unknown>;
  }

  array(path: string, v: unknown): unknown[] | null {
    if (!Array.isArray(v)) {
      this.fail(path, `expected an array, got ${describe(v)}`);
      return null;
    }
    return v;
  }

  string(path: string, v: unknown): string | null {
    if (typeof v !== 'string') {
      this.fail(path, `expected a string, got ${describe(v)}`);
      return null;
    }
    return v;
  }

  /** Non-negative safe integer. Every count and index on this envelope is one. */
  int(path: string, v: unknown, min = 0): number | null {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      this.fail(path, `expected an integer, got ${describe(v)}`);
      return null;
    }
    if (v < min) {
      this.fail(path, `expected >= ${min}, got ${v}`);
      return null;
    }
    return v;
  }

  literal<T extends string>(path: string, v: unknown, allowed: readonly T[]): T | null {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.fail(path, `expected one of ${allowed.join(' | ')}, got ${describe(v)}`);
      return null;
    }
    return v as T;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function checkCard(c: Checker, path: string, raw: unknown): void {
  const o = c.object(path, raw);
  if (!o) return;

  c.string(`${path}.cardId`, o.cardId);
  c.string(`${path}.name`, o.name);
  c.string(`${path}.typeLine`, o.typeLine);
  c.string(`${path}.oracleText`, o.oracleText);
  c.string(`${path}.setCode`, o.setCode);
  c.string(`${path}.collectorNumber`, o.collectorNumber);
  c.int(`${path}.manaValue`, o.manaValue);
  c.literal<Rarity>(`${path}.rarity`, o.rarity, RARITIES as readonly Rarity[]);

  const cost = c.array(`${path}.manaCost`, o.manaCost);
  if (cost) {
    cost.forEach((sym, i) => {
      c.string(`${path}.manaCost[${i}]`, sym);
    });
  }

  const colors = c.array(`${path}.colors`, o.colors);
  if (colors) {
    colors.forEach((col, i) => {
      c.literal<ManaColor>(`${path}.colors[${i}]`, col, COLORS as readonly ManaColor[]);
    });
  }

  for (const opt of ['power', 'toughness', 'loyalty'] as const) {
    if (o[opt] !== undefined) c.string(`${path}.${opt}`, o[opt]);
  }

  // D13's control, at the payload boundary rather than only in the type. A
  // fixture that grows an image field fails here even though TypeScript would
  // have let the extra property through a JSON import.
  for (const banned of ['imageUris', 'image_uris', 'imageUrl', 'image', 'art', 'artCrop']) {
    if (banned in o) {
      c.fail(`${path}.${banned}`, 'card payloads must never carry an image reference (D13)');
    }
  }
}

function checkSeat(c: Checker, path: string, raw: unknown, expectedId: number): void {
  const o = c.object(path, raw);
  if (!o) return;

  const id = c.int(`${path}.id`, o.id);
  if (id !== null && id !== expectedId) {
    c.fail(`${path}.id`, `seats[] index IS the SeatId: expected ${expectedId}, got ${id}`);
  }
  c.string(`${path}.displayName`, o.displayName);
  c.int(`${path}.pickedCount`, o.pickedCount);

  if (o.occupant !== null) {
    const occ = c.object(`${path}.occupant`, o.occupant);
    if (occ) {
      const kind = c.literal(`${path}.occupant.kind`, occ.kind, ['human', 'bot'] as const);
      if (kind === 'human') c.string(`${path}.occupant.participantId`, occ.participantId);
      if (kind === 'bot') {
        const botId = c.string(`${path}.occupant.botId`, occ.botId);
        // `padWithBots` mints positional ids so a re-pad is deterministic.
        if (botId !== null && botId !== `bot:${expectedId}`) {
          c.fail(`${path}.occupant.botId`, `bot ids are positional: expected bot:${expectedId}, got ${botId}`);
        }
      }
    }
  }

  // The leak this whole lane is about.
  for (const banned of ['pool', 'picked', 'picks', 'pack']) {
    if (banned in o) {
      c.fail(`${path}.${banned}`, `a seat summary carries a count, never cards — found "${banned}"`);
    }
  }
}

/** Validate one payload. On success the value is the same object, typed. */
export function parseDraftView(raw: unknown): ParseResult<DraftView> {
  const c = new Checker();
  const o = c.object('$', raw);
  if (!o) return { ok: false, errors: c.errors };

  c.string('$.draftId', o.draftId);
  c.int('$.seq', o.seq, 1);
  const packCount = c.int('$.packCount', o.packCount, 1);
  const packNumber = c.int('$.packNumber', o.packNumber, 1);
  c.int('$.pickNumber', o.pickNumber, 1);
  const packSize = c.int('$.packSize', o.packSize, 1);
  c.literal('$.passDirection', o.passDirection, ['left', 'right'] as const);

  if (packNumber !== null && packCount !== null && packNumber > packCount) {
    c.fail('$.packNumber', `pack ${packNumber} of ${packCount} is out of range`);
  }

  if (o.capacity !== null) c.int('$.capacity', o.capacity, 1);

  const seats = c.array('$.seats', o.seats);
  if (seats) {
    seats.forEach((s, i) => checkSeat(c, `$.seats[${i}]`, s, i));
    if (typeof o.capacity === 'number' && seats.length > o.capacity) {
      c.fail('$.seats', `${seats.length} seats exceeds capacity ${o.capacity}`);
    }
  }

  const waiting = c.array('$.waitingOn', o.waitingOn);
  if (waiting) {
    waiting.forEach((id, i) => {
      const n = c.int(`$.waitingOn[${i}]`, id);
      if (n !== null && seats && n >= seats.length) {
        c.fail(`$.waitingOn[${i}]`, `seat ${n} does not exist`);
      }
    });
    if (new Set(waiting).size !== waiting.length) {
      c.fail('$.waitingOn', 'duplicate seat ids');
    }
  }

  const viewer = c.object('$.viewer', o.viewer);
  if (viewer) {
    const kind = c.literal('$.viewer.kind', viewer.kind, ['seat', 'spectator'] as const);
    if (kind === 'spectator') {
      for (const banned of ['pack', 'pool', 'seatId']) {
        if (banned in viewer) {
          c.fail(`$.viewer.${banned}`, `a spectator payload carries no "${banned}"`);
        }
      }
    } else if (kind === 'seat') {
      const seatId = c.int('$.viewer.seatId', viewer.seatId);
      if (seatId !== null && seats && seatId >= seats.length) {
        c.fail('$.viewer.seatId', `seat ${seatId} does not exist`);
      }
      const pack = c.array('$.viewer.pack', viewer.pack);
      if (pack) {
        pack.forEach((card, i) => checkCard(c, `$.viewer.pack[${i}]`, card));
        if (packSize !== null && pack.length > packSize) {
          c.fail('$.viewer.pack', `${pack.length} cards exceeds pack size ${packSize}`);
        }
      }
      const pool = c.array('$.viewer.pool', viewer.pool);
      if (pool) pool.forEach((card, i) => checkCard(c, `$.viewer.pool[${i}]`, card));

      // The viewer's own summary must agree with the pool it was handed.
      if (pool && seats && seatId !== null) {
        const own = seats[seatId] as DraftSeatView | undefined;
        if (own && own.pickedCount !== pool.length) {
          c.fail(
            '$.viewer.pool',
            `pool has ${pool.length} cards but seats[${seatId}].pickedCount is ${own.pickedCount}`,
          );
        }
      }

      // Two copies of one card are two cardIds. A repeated id means the engine
      // (or the fixture) lost track of which physical card was picked.
      if (pack && pool) {
        const ids = [...pack, ...pool].map((card) => (card as DraftCard).cardId);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length > 0) {
          c.fail('$.viewer', `duplicate cardId(s): ${[...new Set(dupes)].join(', ')}`);
        }
      }
    }
  }

  return c.errors.length === 0
    ? { ok: true, value: raw as DraftView }
    : { ok: false, errors: c.errors };
}

/** Throwing wrapper for call sites that cannot carry on — app boot, mostly. */
export function expectDraftView(raw: unknown, label: string): DraftView {
  const result = parseDraftView(raw);
  if (result.ok) return result.value;
  const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
  throw new Error(`${label} is not a valid draft payload:\n${detail}`);
}
