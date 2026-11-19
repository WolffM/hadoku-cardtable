import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { MATCH_ID_PATTERN } from '@wolffm/prefs-client/games';

import { COUNTDOWN_MS, createStarts, type StartableRoom } from './starts.ts';

const room = (over: Partial<StartableRoom> = {}): StartableRoom => ({
  id: 'r-1',
  leader: 'lead',
  seats: ['ada', 'ai', null],
  members: [{ id: 'lead' }, { id: 'ada' }, { id: 'bo' }],
  ...over,
});

describe('starts', () => {
  it('a spectating leader starts; the first seated person hosts', () => {
    const s = createStarts({ now: () => 1_000 });
    const r = s.request(room(), 'lead');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.start.hostId, 'ada');
    assert.equal(r.start.startsInMs, COUNTDOWN_MS);
    assert.match(r.start.matchId, MATCH_ID_PATTERN);
    assert.equal(s.hostOf('r-1'), 'ada');
  });

  it('a seated caller hosts their own start', () => {
    const s = createStarts();
    const r = s.request(room({ seats: ['ada', 'bo'] }), 'bo');
    assert.equal(r.ok && r.start.hostId, 'bo');
  });

  it('refuses a spectator who is not the leader, and a room with nobody seated to host', () => {
    const s = createStarts();
    assert.deepEqual(s.request(room(), 'bo'), { ok: false, reason: 'not-allowed' });
    assert.deepEqual(s.request(room({ seats: ['ai', null] }), 'lead'), { ok: false, reason: 'no-player' });
  });

  it('a second press during the countdown answers the same start; it is gone at zero', () => {
    let t = 0;
    const s = createStarts({ now: () => t });
    const first = s.request(room(), 'lead');
    t = 1_000;
    const again = s.request(room(), 'ada');
    assert.ok(first.ok && again.ok);
    assert.equal(again.start.matchId, first.start.matchId);
    assert.equal(again.start.startsInMs, COUNTDOWN_MS - 1_000);
    assert.notEqual(s.view('r-1'), null);
    // At zero it is the host's match: a page loading now must not count down to it again.
    t = COUNTDOWN_MS;
    assert.equal(s.view('r-1'), null);
    // The host is remembered past the countdown: the relay takes the round's end from them.
    assert.equal(s.hostOf('r-1'), 'ada');
    s.forget('r-1');
    assert.equal(s.hostOf('r-1'), null);
  });

  it("numbers a room's starts and keeps its series; a press during the countdown is not a new round", () => {
    let t = 0;
    const s = createStarts({ now: () => t });
    const next = () => {
      const r = s.request(room(), 'lead');
      assert.ok(r.ok);
      return r.start;
    };
    const first = next();
    assert.equal(first.round, 0);
    assert.equal(next().round, 0);
    t = COUNTDOWN_MS;
    const second = next();
    t = 2 * COUNTDOWN_MS;
    const third = next();
    assert.deepEqual([second.round, third.round], [1, 2]);
    assert.deepEqual([second.series, third.series], [first.series, first.series]);
    assert.notEqual(second.seed, first.seed);
    // Another room runs on its own count.
    const other = s.request(room({ id: 'r-2' }), 'lead');
    assert.equal(other.ok && other.start.round, 0);
    // A room that is gone starts over.
    s.forget('r-1');
    t = 3 * COUNTDOWN_MS;
    assert.equal(next().round, 0);
  });
});
