/**
 * "The match went quiet" waits on match traffic, not on the sockets' own heartbeats.
 *
 *   node --test match-traffic.test.ts
 *
 * Every page keeps several clocks running whether the match moves or not: engine.io's ping
 * (`2`/`3`), the room's `time_ping`/`time_pong`, the session's `session:beat` and its ack, and the
 * board's own `forge:client` reports. Two pages' worth of those, at the phases they happened to
 * start on, left no 2 s gap in a whole minute (play.spec.ts, claw runs 43172905161 and 43186922144:
 * widest gap 1992 ms and 1897 ms with no match frame at all after the coin toss), so a wait that
 * counted every frame never saw the match go quiet. The packets below are those runs' own shapes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RawCapture } from './frames.ts';
import { matchTraffic } from './play/frames.ts';

const at = (t: number, dir: 'in' | 'out', text: string): RawCapture => ({ t, dir, via: 'ws', text });

/** One page's heartbeats for `ms`, every clock on its own phase. */
function heartbeats(from: number, ms: number, phase: number): RawCapture[] {
  const out: RawCapture[] = [];
  for (let t = from; t < from + ms; t += 5_000) {
    out.push(at(t + phase, 'out', '42/room,["time_ping",{}]'));
    out.push(at(t + phase + 2, 'in', '42/room,["time_pong",{"server_time":1794468700000}]'));
    out.push(at(t + phase + 1_940, 'in', '42["session:beat"]'));
    out.push(at(t + phase + 1_941, 'out', '437[]'));
    out.push(at(t + phase + 3_100, 'out', '42["forge:client",{"matchId":"m-1","kind":"perf","data":{"what":"work","n":1}}]'));
    out.push(at(t + phase + 3_200, 'in', '42["room-feed:changed",{"list":true}]'));
  }
  for (let t = from; t < from + ms; t += 25_000) {
    out.push(at(t + phase + 700, 'in', '2'));
    out.push(at(t + phase + 701, 'out', '3'));
  }
  return out.sort((a, b) => a.t - b.t);
}

test('a minute of heartbeats is no match traffic', () => {
  assert.equal(matchTraffic(heartbeats(0, 60_000, 0)), 0);
  assert.equal(matchTraffic(heartbeats(0, 60_000, 1_234)), 0);
});

test('what the server tells a seat about its match, and what the seat acts, is', () => {
  const match = [
    at(0, 'in', '430[{"matchId":"m-1","seat":1,"playerId":1,"cursor":null,"frames":[]}]'),
    at(1, 'in', '42["forge:seats",{"matchId":"m-1","seats":[]}]'),
    at(2, 'in', '42["forge:s2c",{"matchId":"m-1","cursor":{"epoch":"e","seq":7},"frame":{"kind":"notify","method":"showPromptMessage","message":"Waiting for e2e-alice..."}}]'),
    at(3, 'out', '42["forge:c2s",{"matchId":"m-1","frame":{"kind":"reply","callId":"c1","result":true}}]'),
  ];
  assert.equal(matchTraffic(match), 4);
  assert.equal(matchTraffic([...heartbeats(0, 60_000, 0), ...match]), 4);
});

test('a long-polling body counts each match packet in it, and none of its heartbeats', () => {
  const body = ['42["forge:s2c",{"matchId":"m-1","frame":{"kind":"notify","method":"applyDelta"}}]', '42["session:beat"]', '42["forge:seats",{"matchId":"m-1","seats":[]}]'].join('\u001e');
  assert.equal(matchTraffic([{ t: 0, dir: 'in', via: 'polling', text: body }]), 2);
});

test('the wait sees the match go quiet while the heartbeats run on', () => {
  // Both pages' clocks, at the phases that left no 2 s gap in run 43172905161.
  const pages = [heartbeats(0, 60_000, 0), heartbeats(0, 60_000, 1_000)];
  const times = [...new Set(pages.flat().map((c) => c.t))].sort((a, b) => a - b);
  let widest = 0;
  for (let i = 1; i < times.length; i++) widest = Math.max(widest, times[i]! - times[i - 1]!);
  assert.ok(widest < 2_000, `the heartbeats alone leave no 2 s gap (widest ${widest} ms)`);
  // What the wait reads: the count at every heartbeat is the count at the start.
  const counts = new Set(times.map((t) => pages.map((p) => matchTraffic(p.filter((c) => c.t <= t))).join()));
  assert.deepEqual([...counts], ['0,0']);
});
