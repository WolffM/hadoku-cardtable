/**
 * The isolation check, over what each browser context actually received.
 *
 * The engine tests assert this over payloads the server BUILT
 * (`apps/server/src/room/socket.test.ts`, `apps/ui/src/draft/hiddenInfo.ts`).
 * This asserts it over payloads two real browsers RECEIVED, whole and
 * serialised, which is the claim nobody had watched hold with two people.
 *
 * Pure: it takes logs and returns a verdict, so it can be run against the live
 * capture in the spec and against committed fixtures in `isolation.test.ts`,
 * where it is shown to FAIL on a log with another seat's cards spliced in.
 *
 * ## The four rules
 *
 * 1. **Positional.** A card-shaped object may appear only at
 *    `view.viewer.pack[i]` or `view.viewer.pool[i]` — `findCardPaths`, the same
 *    walker the UI's hidden-info audit uses, over the whole envelope.
 * 2. **Whose seat.** Every view names the recipient's own seat and no other.
 * 3. **Disjoint at the same instant.** For every cursor both contexts
 *    received, the cards in one's envelope and the cards in the other's share
 *    nothing. A card is in exactly one pack or one pool at a time, so any
 *    overlap is one seat seeing the other's cards.
 * 4. **Gone once taken.** Once a card is in another seat's pool, no later
 *    envelope to this context contains it — checked as a quoted token in the
 *    RAW text, so a bare `"c123"` hidden in some field nobody named is caught
 *    too, not only a card-shaped object.
 *
 * Rules 3 and 4 need the other seat's log, which is why this takes all of
 * them at once.
 */

import { findCardPaths } from '../apps/ui/src/draft/hiddenInfo.ts';

import type { Envelope } from './frames.ts';

export const SERVER_TO_CLIENT = 'draft:s2c';

export interface SeatLog {
  /** A label for messages: `alice`. */
  name: string;
  /** The seat this context was given. Every view must name it. */
  seat: number;
  envelopes: readonly Envelope[];
}

export interface IsolationReport {
  ok: boolean;
  violations: string[];
  counts: {
    /** Server→client draft envelopes examined, all contexts. */
    envelopes: number;
    /** Of those, envelopes that carried a view. */
    views: number;
    /** Card-shaped objects found and position-checked. */
    cards: number;
    /** Same-cursor envelope pairs compared across contexts (rule 3). */
    pairs: number;
    /** Quoted-token probes of raw text for other seats' taken cards (rule 4). */
    probes: number;
  };
}

interface Card {
  cardId: string;
}

interface SeatViewer {
  kind: 'seat';
  seatId: number;
  pack: Card[];
  pool: Card[];
}

interface ViewLike {
  epoch: string;
  seq: number;
  viewer: SeatViewer | { kind: string };
}

function viewOf(msg: unknown): ViewLike | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const view = (msg as { view?: unknown }).view;
  if (typeof view !== 'object' || view === null) return null;
  return view as ViewLike;
}

function isSeat(viewer: ViewLike['viewer']): viewer is SeatViewer {
  return viewer.kind === 'seat';
}

function idsOf(view: ViewLike): Set<string> {
  if (!isSeat(view.viewer)) return new Set();
  return new Set([...view.viewer.pack, ...view.viewer.pool].map((c) => c.cardId));
}

const ALLOWED = ['$.view.viewer.pack[', '$.view.viewer.pool['];

export function draftEnvelopes(log: SeatLog): Envelope[] {
  return log.envelopes.filter((e) => e.dir === 'in' && e.event === SERVER_TO_CLIENT);
}

export function checkIsolation(logs: readonly SeatLog[]): IsolationReport {
  const violations: string[] = [];
  const counts = { envelopes: 0, views: 0, cards: 0, pairs: 0, probes: 0 };

  // Per context: cursor → { ids, raw } and the pool as it grew.
  const byCursor = new Map<string, Map<string, { ids: Set<string>; raw: string }>>();
  const poolHistory = new Map<string, { epoch: string; seq: number; pool: string[] }[]>();

  for (const log of logs) {
    const mine = new Map<string, { ids: Set<string>; raw: string }>();
    const pools: { epoch: string; seq: number; pool: string[] }[] = [];
    const envelopes = draftEnvelopes(log);
    if (envelopes.length === 0) violations.push(`${log.name}: received no draft envelopes at all`);

    envelopes.forEach((env, i) => {
      counts.envelopes += 1;
      const where = `${log.name} envelope #${i}`;

      // Rule 1 — over the whole envelope, not just the view.
      const paths = findCardPaths(env.msg);
      counts.cards += paths.length;
      for (const p of paths) {
        if (!ALLOWED.some((a) => p.startsWith(a))) violations.push(`${where}: card at ${p}`);
      }

      const view = viewOf(env.msg);
      if (view === null) return;
      counts.views += 1;

      // Rule 2.
      if (!isSeat(view.viewer)) {
        violations.push(`${where}: viewer is ${view.viewer.kind}, expected seat ${log.seat}`);
        return;
      }
      if (view.viewer.seatId !== log.seat) {
        violations.push(`${where}: view is for seat ${view.viewer.seatId}, expected ${log.seat}`);
      }

      const key = `${view.epoch}:${view.seq}`;
      mine.set(key, { ids: idsOf(view), raw: env.raw });
      pools.push({ epoch: view.epoch, seq: view.seq, pool: view.viewer.pool.map((c) => c.cardId) });
    });

    byCursor.set(log.name, mine);
    poolHistory.set(log.name, pools);
  }

  for (const a of logs) {
    for (const b of logs) {
      if (a === b) continue;
      const aByCursor = byCursor.get(a.name) ?? new Map();
      const bByCursor = byCursor.get(b.name) ?? new Map();

      // Rule 3 — ordered pairs, so each unordered pair is compared once.
      if (a.name < b.name) {
        for (const [key, av] of aByCursor) {
          const bv = bByCursor.get(key);
          if (bv === undefined) continue;
          counts.pairs += 1;
          const shared = [...av.ids].filter((id) => bv.ids.has(id));
          if (shared.length > 0) {
            violations.push(`${a.name} and ${b.name} both hold ${shared.join(',')} at cursor ${key}`);
          }
        }
      }

      // Rule 4 — every envelope to `a`, against `b`'s pool as it stood then.
      const bPools = poolHistory.get(b.name) ?? [];
      for (const env of draftEnvelopes(a)) {
        const view = viewOf(env.msg);
        if (view === null) continue;
        let taken: string[] = [];
        for (const p of bPools) {
          if (p.epoch === view.epoch && p.seq <= view.seq && p.pool.length >= taken.length) taken = p.pool;
        }
        for (const id of taken) {
          counts.probes += 1;
          if (env.raw.includes(`"${id}"`)) {
            violations.push(
              `${a.name} received ${id} at seq ${view.seq}, after ${b.name} had already taken it`,
            );
          }
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, counts };
}
