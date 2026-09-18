/**
 * The isolation check is shown to bite — against fixtures only.
 *
 *   node --test isolation.test.ts
 *
 * No browser and no server: this runs the checker the spec uses over a REAL
 * captured log (`fixtures/two-seat-captures.json`, cut by `make-fixture.ts`),
 * then over copies of that log with another seat's cards spliced in, each at
 * the raw-text level — the captured frame is re-serialised with the change, so
 * the checker sees exactly what a browser would have received had the server
 * leaked. The real server is never weakened to produce a failure.
 *
 * A green run of the spec means something only if every mutation here is RED.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { envelopesOf, eventsIn, type RawCapture } from './frames.ts';
import { checkIsolation, draftEnvelopes, SERVER_TO_CLIENT, type SeatLog } from './isolation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  seats: { alice: number; bob: number };
  alice: RawCapture[];
  bob: RawCapture[];
}

interface Card {
  cardId: string;
  name: string;
}
interface SeatViewer {
  kind: 'seat';
  seatId: number;
  pack: Card[];
  pool: Card[];
}
interface View {
  epoch: string;
  seq: number;
  seats: Record<string, unknown>[];
  viewer: SeatViewer;
  [extra: string]: unknown;
}
interface Msg {
  type: string;
  view: View;
}

function load(): Fixture {
  return JSON.parse(readFileSync(resolve(HERE, 'fixtures', 'two-seat-captures.json'), 'utf8')) as Fixture;
}

function logs(f: Fixture): SeatLog[] {
  return [
    { name: 'alice', seat: f.seats.alice, envelopes: envelopesOf(f.alice) },
    { name: 'bob', seat: f.seats.bob, envelopes: envelopesOf(f.bob) },
  ];
}

/** Indices of the captures that carry a server→client draft view. */
function viewCaptures(captures: readonly RawCapture[]): number[] {
  return captures.flatMap((c, i) =>
    eventsIn(c).some((e) => e.dir === 'in' && e.event === SERVER_TO_CLIENT) ? [i] : [],
  );
}

function msgAt(capture: RawCapture): Msg {
  const [, payload] = JSON.parse(capture.text.slice(2)) as [string, Msg];
  return payload;
}

/** Rewrite one captured frame, re-serialising it the way socket.io would. */
function rewrite(capture: RawCapture, edit: (msg: Msg) => void): RawCapture {
  assert.ok(capture.text.startsWith('42["draft:s2c",'), 'only a websocket draft frame is rewritten');
  const [event, payload] = JSON.parse(capture.text.slice(2)) as [string, Msg];
  edit(payload);
  return { ...capture, text: `42${JSON.stringify([event, payload])}` };
}

/** A capture of alice's and bob's at the same cursor, for splicing. */
function sameCursor(f: Fixture): { a: number; b: number } {
  for (const a of viewCaptures(f.alice)) {
    const av = msgAt(f.alice[a]).view;
    for (const b of viewCaptures(f.bob)) {
      const bv = msgAt(f.bob[b]).view;
      if (av.epoch === bv.epoch && av.seq === bv.seq && bv.viewer.pack.length > 0) return { a, b };
    }
  }
  throw new Error('fixture has no shared cursor with a pack — regenerate it');
}

/** An alice capture strictly after a moment bob already had a card in his pool. */
function afterBobTook(f: Fixture): { a: number; card: Card } {
  for (const b of viewCaptures(f.bob)) {
    const bv = msgAt(f.bob[b]).view;
    const card = bv.viewer.pool[0];
    if (card === undefined) continue;
    for (const a of viewCaptures(f.alice)) {
      const av = msgAt(f.alice[a]).view;
      if (av.epoch === bv.epoch && av.seq > bv.seq) return { a, card };
    }
  }
  throw new Error('fixture has no alice frame after bob took a card — regenerate it');
}

function withAlice(f: Fixture, index: number, capture: RawCapture): Fixture {
  const alice = [...f.alice];
  alice[index] = capture;
  return { ...f, alice };
}

test('the real captured log passes, and the check examined something', () => {
  const f = load();
  const report = checkIsolation(logs(f));
  console.log('real log:', JSON.stringify(report.counts));
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.ok(report.counts.views >= 16, `views ${report.counts.views}`);
  assert.ok(report.counts.pairs >= 1, `pairs ${report.counts.pairs}`);
  assert.ok(report.counts.probes >= 1, `probes ${report.counts.probes}`);
  assert.ok(report.counts.cards > 100, `cards ${report.counts.cards}`);
});

test("MUTATION: bob's pack spliced into alice's frame at the same cursor → FAILS", () => {
  const f = load();
  const { a, b } = sameCursor(f);
  const bobPack = msgAt(f.bob[b]).view.viewer.pack;
  const mutated = withAlice(f, a, rewrite(f.alice[a], (m) => (m.view.viewer.pack = bobPack)));
  const report = checkIsolation(logs(mutated));
  console.log('pack spliced:', report.violations.length, 'violations —', report.violations[0]);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes('both hold')));
});

test("MUTATION: one of bob's pack cards added to alice's pool → FAILS", () => {
  const f = load();
  const { a, b } = sameCursor(f);
  const card = msgAt(f.bob[b]).view.viewer.pack[0];
  const mutated = withAlice(f, a, rewrite(f.alice[a], (m) => m.view.viewer.pool.push(card)));
  const report = checkIsolation(logs(mutated));
  console.log('pool spliced:', report.violations.length, 'violations —', report.violations[0]);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes(`both hold ${card.cardId}`)));
});

test("MUTATION: bob's card riding in a seat row nobody named → FAILS (positional)", () => {
  const f = load();
  const { a, b } = sameCursor(f);
  const card = msgAt(f.bob[b]).view.viewer.pack[0];
  const mutated = withAlice(
    f,
    a,
    rewrite(f.alice[a], (m) => {
      m.view.seats[1].lastPick = card;
    }),
  );
  const report = checkIsolation(logs(mutated));
  console.log('seat-row card:', report.violations.length, 'violations —', report.violations[0]);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes('card at $.view.seats[1].lastPick')));
});

test("MUTATION: a bare id of a card bob already took, in a debug field → FAILS (raw text)", () => {
  const f = load();
  const { a, card } = afterBobTook(f);
  const mutated = withAlice(
    f,
    a,
    rewrite(f.alice[a], (m) => {
      m.view.debug = { lastPassed: card.cardId };
    }),
  );
  const report = checkIsolation(logs(mutated));
  console.log('bare id:', report.violations.length, 'violations —', report.violations[0]);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes(`received ${card.cardId}`)));
});

test("MUTATION: alice's frame addressed to bob's seat → FAILS", () => {
  const f = load();
  const [a] = viewCaptures(f.alice);
  const mutated = withAlice(f, a, rewrite(f.alice[a], (m) => (m.view.viewer.seatId = f.seats.bob)));
  const report = checkIsolation(logs(mutated));
  console.log('wrong seat:', report.violations.length, 'violations —', report.violations[0]);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes(`view is for seat ${f.seats.bob}`)));
});

test('MUTATION: a context that received nothing does not pass by default → FAILS', () => {
  const f = load();
  const report = checkIsolation(logs({ ...f, alice: [] }));
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes('alice: received no draft envelopes')));
});

test('a polling body carrying the same packets parses to the same envelopes', () => {
  // socket.io's long-polling transport joins packets with U+001E. The spec's
  // live runs happened to receive every draft envelope over the websocket, so
  // the polling branch is exercised here, on real packet text.
  const f = load();
  const frames = viewCaptures(f.alice).slice(0, 3).map((i) => f.alice[i]);
  const body: RawCapture = { t: 0, dir: 'in', via: 'polling', text: ['3', ...frames.map((c) => c.text)].join('\u001e') };
  const fromPolling = eventsIn(body).map((e) => e.raw);
  const fromWs = frames.flatMap((c) => eventsIn(c)).map((e) => e.raw);
  assert.equal(fromPolling.length, 3);
  assert.deepEqual(fromPolling, fromWs);
  assert.equal(draftEnvelopes({ name: 'x', seat: 0, envelopes: eventsIn(body) }).length, 3);
});
