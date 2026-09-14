/**
 * The committed fixtures, loaded and validated.
 *
 * These are lane C's contract with the draft engine: they are written against
 * the §B.5 envelope, and when the engine's schema lands it must accept them
 * unchanged. Nothing here is a mock of a network call — a fixture is a payload
 * the server would have sent, and the app consumes it by exactly the path a
 * real one would take.
 *
 * ## Two drafts, not one
 *
 * `fx-open` is seat 0 opening pack 1; `fx-mid` is pack 2 passing the other way
 * with one seat left on the clock. They are separate draft ids on purpose: a
 * singleton cube cannot deal the same physical card to two seats, so a fixture
 * that showed two seats' pools inside one draft id would be a payload the
 * engine could never emit.
 *
 * `fx-mid` ships twice — once as seat 3 and once as a spectator, same `seq`,
 * same seats, same counters. The spectator copy carries no cards at all. That
 * pair is the hidden-information split made visible, and `hiddenInfo.test.ts`
 * is what holds it.
 */

import seat0Pick1 from './fixtures/seat0-pack1-pick1.json';
import seat0Pick2 from './fixtures/seat0-pack1-pick2.json';
import seat0Pick3 from './fixtures/seat0-pack1-pick3.json';
import seat3Pack2 from './fixtures/seat3-pack2-pick5.json';
import spectatorPack2 from './fixtures/spectator-pack2-pick5.json';
import type { DraftView } from './types.ts';
import { expectDraftView } from './validate.ts';

export interface Fixture {
  /** Path under `src/draft/fixtures/`, so a failure names a real file. */
  file: string;
  /** What this payload is for, shown in the fixture picker. */
  label: string;
  raw: unknown;
}

/**
 * Every committed fixture, in the order a reader should meet them. The raw
 * values are deliberately untyped: `parseDraftView` is what turns JSON into a
 * `DraftView`, and letting the JSON import assert the type would skip it.
 */
export const FIXTURES: readonly Fixture[] = [
  { file: 'seat0-pack1-pick1.json', label: 'Seat 0 · pack 1 pick 1 — a fresh 15-card pack', raw: seat0Pick1 },
  { file: 'seat0-pack1-pick2.json', label: 'Seat 0 · pack 1 pick 2 — first card in the pool', raw: seat0Pick2 },
  { file: 'seat0-pack1-pick3.json', label: 'Seat 0 · pack 1 pick 3 — three seats still on the clock', raw: seat0Pick3 },
  { file: 'seat3-pack2-pick5.json', label: 'Seat 3 · pack 2 pick 5 — passing right, your turn alone', raw: seat3Pack2 },
  { file: 'spectator-pack2-pick5.json', label: 'Spectator · pack 2 pick 5 — no pack, no pool', raw: spectatorPack2 },
];

/** Validated payloads, in fixture order. Throws on a malformed fixture. */
export function loadFixtures(): DraftView[] {
  return FIXTURES.map((f) => expectDraftView(f.raw, f.file));
}

/**
 * The three `fx-open` payloads in `seq` order — a stream, so the app can show
 * that a later authoritative payload replaces an earlier one rather than
 * patching it.
 */
export function openingStream(): DraftView[] {
  return loadFixtures()
    .filter((v) => v.draftId === 'draft:fx-open')
    .sort((a, b) => a.seq - b.seq);
}
