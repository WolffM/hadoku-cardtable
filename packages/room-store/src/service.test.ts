/*
 * P5 §8 — the service participant's crash semantics.
 *
 * The bar, from §1: *the process died and a new one will be started in its
 * place, and the room must still be there when it arrives.* Every test below is
 * one clause of that, and the clock is injected so `holdMs` being ten minutes
 * costs nothing.
 *
 * `evaluateRoom` here is the real one from `@wolffm/rooms-server`, not a stand-in
 * — §5.1's whole risk is that the shipped reaper's `room.clients.size === 0`
 * deletes a live game, and a reimplementation of it would prove nothing.
 */

import { describe, expect, it } from 'vitest';
import { seatParticipant, setSeatCapacity } from '@wolffm/rooms-protocol';
import { evaluateRoom, type ClientMeta, type GCTimings } from '@wolffm/rooms-server';
import { ManualClock } from './clock.ts';
import {
  createServiceLifecycle,
  DEFAULT_SERVICE_CONFIG,
  evaluateRoomWithService,
  ServiceLifecycle,
  ServiceRejection,
  SKIP,
  type ServiceConfig,
  type ServiceNotice,
} from './service.ts';
import { makeClient, makeRoom, RecordingPeer } from './testkit.ts';

interface Match {
  turn: number;
}

const PLAYERS = ['fk:p1', 'fk:p2', 'fk:p3', 'fk:p4'];
const TIMINGS: GCTimings = { idleMs: 60_000, emptyGraceMs: 120_000 };

const config: ServiceConfig = {
  ...DEFAULT_SERVICE_CONFIG,
  routes: (kind) => kind.startsWith('game/'),
};

function seatedRoom(now = 0) {
  const room = makeRoom<Match>('match-1', { turn: 3 }, { capacity: 4, now });
  setSeatCapacity(room.seats, 4);
  for (const pid of PLAYERS) {
    room.clients.set(`socket-${pid}`, makeClient(pid, undefined));
    seatParticipant(room.seats, pid, now);
  }
  return room;
}

function harness(now = 0, cfg: ServiceConfig = config) {
  const clock = new ManualClock(now);
  const room = seatedRoom(now);
  const notices: ServiceNotice[] = [];
  /** What each client was actually told, in order — the §5.3 assertion. */
  const perClient = new Map<string, string[]>();
  for (const pid of PLAYERS) perClient.set(pid, []);

  const lifecycle = createServiceLifecycle<Match>(room, cfg, {
    clock,
    onNotice: (n) => {
      notices.push(n);
      for (const client of room.clients.values()) {
        perClient.get(client.participantId)?.push(n.kind);
      }
    },
  }) as ServiceLifecycle<Match>;

  return { clock, room, notices, perClient, lifecycle };
}

/** Attach a peer all the way through the handshake. */
async function attached(h: ReturnType<typeof harness>, peerId = 'engine-1') {
  const peer = new RecordingPeer(peerId);
  const pending = h.lifecycle.attach(peer);
  expect(h.lifecycle.status()).toBe('attaching');
  h.lifecycle.ack(peerId);
  const session = await pending;
  return { peer, session };
}

describe('§8.1 — the room survives the peer vanishing', () => {
  it('nobody is evicted, no seat vacated, and the room is exempt from reaping', async () => {
    const h = harness();
    const { peer } = await attached(h);
    const seatsBefore = JSON.stringify(h.room.seats);
    const seqBefore = h.room.lastEventSeq;

    // The process dies. Nothing tells the room; the heartbeats simply stop.
    h.clock.advance(config.lossAfterMs + 1);

    expect(h.lifecycle.status()).toBe('lost');
    expect(h.room.clients.size).toBe(4);
    expect(JSON.stringify(h.room.seats)).toBe(seatsBefore);
    expect(h.room.lastEventSeq).toBe(seqBefore);
    expect(peer.closed).toEqual([]);

    // Exactly one service-lost notice, and every client got exactly one.
    expect(h.notices.filter((n) => n.kind === 'service-lost')).toHaveLength(1);
    for (const pid of PLAYERS) {
      expect(h.perClient.get(pid)?.filter((k) => k === 'service-lost')).toHaveLength(1);
    }

    // Now empty the room too — a redeploy of our own UI drops every socket.
    h.room.clients.clear();
    h.clock.advance(TIMINGS.emptyGraceMs + 1);
    // The shipped reaper alone WOULD destroy it. That is the hazard.
    expect(evaluateRoom(h.room, TIMINGS, h.clock.now()).shouldDestroy).toBe(true);
    // With the exemption applied it does not.
    expect(
      evaluateRoomWithService(h.room, TIMINGS, h.lifecycle, h.clock.now()).shouldDestroy,
    ).toBe(false);
    // `idle` and `empty` are facts about the room and still come back true.
    const verdict = evaluateRoomWithService(h.room, TIMINGS, h.lifecycle, h.clock.now());
    expect(verdict.empty).toBe(true);
    expect(verdict.idle).toBe(true);
  });
});

describe('§8.2 / §5.3 — re-attach pushes a full state, and no delta crosses the loss', () => {
  it('a replacement within holdMs is accepted and resyncs every client', async () => {
    const h = harness();
    const first = await attached(h, 'engine-1');

    // Deltas flow normally before the loss, once a snapshot has opened the window.
    first.session.publishSnapshot(() => ({ turn: h.room.app.turn }));
    expect(h.lifecycle.publishDelta({ turn: 4 }).ok).toBe(true);

    h.clock.advance(config.lossAfterMs + 1);
    expect(h.lifecycle.status()).toBe('lost');

    // §5.3: the stream does not resume. A delta offered now is refused.
    const acrossBoundary = h.lifecycle.publishDelta({ turn: 5 });
    expect(acrossBoundary.ok).toBe(false);
    if (!acrossBoundary.ok) expect(acrossBoundary.error.code).toBe('service-unavailable');

    // A replacement attaches well inside the hold.
    h.clock.advance(60_000);
    const second = await attached(h, 'engine-2');
    expect(h.lifecycle.status()).toBe('attached');
    expect(h.lifecycle.peerId()).toBe('engine-2');

    // Still refused — `attached` is not enough; a full state has to land first.
    const beforeSnapshot = h.lifecycle.publishDelta({ turn: 6 });
    expect(beforeSnapshot.ok).toBe(false);
    if (!beforeSnapshot.ok) expect(beforeSnapshot.error.code).toBe('delta-before-snapshot');

    // §5.6: the replacement was handed the roster and the seats, not asked to guess.
    expect(second.session.roster.map((c: ClientMeta<unknown>) => c.participantId).sort()).toEqual(
      [...PLAYERS].sort(),
    );
    expect(second.session.seats).toBe(h.room.seats);
    expect(second.peer.ofType('service/attach')).toHaveLength(1);

    second.session.publishSnapshot((client) => ({ you: client.participantId, turn: 6 }));
    expect(h.lifecycle.lastSnapshot()).toHaveLength(4);
    // ...and only then do deltas resume.
    expect(h.lifecycle.publishDelta({ turn: 7 }).ok).toBe(true);
  });

  it('a per-recipient snapshot can SKIP a client, and carries only its own slice', async () => {
    const h = harness();
    const { session } = await attached(h);
    session.publishSnapshot((client) =>
      client.participantId === 'fk:p4' ? SKIP : { you: client.participantId },
    );
    const built = h.lifecycle.lastSnapshot();
    expect(built).toHaveLength(3);
    for (const { client, payload } of built) {
      expect(JSON.stringify(payload)).toContain(client.participantId);
      for (const other of PLAYERS.filter((p) => p !== client.participantId)) {
        expect(JSON.stringify(payload)).not.toContain(other);
      }
    }
  });
});

describe('§8.3 / §4 — an action while not attached is a typed rejection that changes nothing', () => {
  it('rejects, mutates no room state, and tells nobody else', async () => {
    const h = harness();
    await attached(h);
    h.clock.advance(config.lossAfterMs + 1);
    expect(h.lifecycle.status()).toBe('lost');

    const seqBefore = h.room.lastEventSeq;
    const updatedBefore = h.room.updatedAt;
    const appBefore = JSON.stringify(h.room.app);
    const noticesBefore = h.notices.length;

    const result = h.lifecycle.routeAction('game/play-land', { cardId: 'c1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('service-unavailable');
      expect(result.error.status).toBe('lost');
      expect(result.error.message).toContain('was not applied');
    }
    // Never silently dropped, never queued, never applied by the room itself.
    expect(h.room.lastEventSeq).toBe(seqBefore);
    expect(h.room.updatedAt).toBe(updatedBefore);
    expect(JSON.stringify(h.room.app)).toBe(appBefore);
    expect(h.notices).toHaveLength(noticesBefore);
    expect(h.lifecycle.counts.rejectedActions).toBe(1);
  });

  it('routes to the peer when attached, and says so when a kind is not routed', async () => {
    const h = harness();
    const { peer } = await attached(h);
    expect(h.lifecycle.routeAction('game/play-land', { cardId: 'c1' }).ok).toBe(true);
    expect(peer.ofType('service/action')).toHaveLength(1);

    const notOurs = h.lifecycle.routeAction('chat/send', { text: 'hi' });
    expect(notOurs.ok).toBe(false);
    if (!notOurs.ok) expect(notOurs.error.code).toBe('not-service-routed');
    expect(peer.ofType('service/action')).toHaveLength(1);
  });

  it('rejects an action while detached, before any service ever attached', () => {
    const h = harness();
    expect(h.lifecycle.status()).toBe('detached');
    const result = h.lifecycle.routeAction('game/play-land', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe('detached');
  });
});

describe('§8.4 / §5.5 — exactly one service per room', () => {
  it('a second attach while attached is rejected and the first peer is untouched', async () => {
    const h = harness();
    const { peer } = await attached(h, 'engine-1');

    await expect(h.lifecycle.attach(new RecordingPeer('engine-2'))).rejects.toBeInstanceOf(
      ServiceRejection,
    );
    expect(h.lifecycle.status()).toBe('attached');
    expect(h.lifecycle.peerId()).toBe('engine-1');
    expect(peer.closed).toEqual([]);
  });

  it('a second attach while a handshake is in flight is rejected too', async () => {
    const h = harness();
    const pending = h.lifecycle.attach(new RecordingPeer('engine-1'));
    await expect(h.lifecycle.attach(new RecordingPeer('engine-2'))).rejects.toMatchObject({
      code: 'service-already-attached',
      status: 'attaching',
    });
    h.lifecycle.ack('engine-1');
    await expect(pending).resolves.toMatchObject({ serviceId: 'engine-1' });
  });

  it('an attach while lost IS accepted — that is the replacement path', async () => {
    const h = harness();
    await attached(h, 'engine-1');
    h.clock.advance(config.lossAfterMs + 1);
    expect(h.lifecycle.status()).toBe('lost');
    const { session } = await attached(h, 'engine-2');
    expect(session.serviceId).toBe('engine-2');
    expect(h.lifecycle.status()).toBe('attached');
  });

  it('a handshake that times out does not cost the room the rest of its hold', async () => {
    const h = harness(0, { ...config, attachTimeoutMs: 2_000 });
    await attached(h, 'engine-1');
    h.clock.advance(config.lossAfterMs + 1);
    // The notice carries the exact instant of the transition; `clock.now()`
    // after the advance is a millisecond late and the hold is measured from the
    // transition, not from when the test noticed it.
    const lostAt = (h.notices.find((n) => n.kind === 'service-lost') as ServiceNotice).at;

    const doomed = h.lifecycle.attach(new RecordingPeer('engine-2'));
    h.clock.advance(2_001);
    await expect(doomed).rejects.toMatchObject({ code: 'attach-timeout' });

    // Back in `lost`, still exempt, and the hold still expires on the ORIGINAL
    // schedule rather than being restarted or abandoned.
    expect(h.lifecycle.status()).toBe('lost');
    expect(h.lifecycle.isReapExempt()).toBe(true);
    h.clock.advance(lostAt + config.holdMs - h.clock.now() - 1);
    expect(h.lifecycle.status()).toBe('lost');
    h.clock.advance(2);
    expect(h.lifecycle.status()).toBe('detached');
  });
});

describe('§8.5 — heartbeat hysteresis', () => {
  it('a peer that misses beats and resumes never enters lost, and nobody is told', async () => {
    const h = harness();
    await attached(h);
    const noticesAfterAttach = h.notices.length;

    // lossAfterMs / heartbeatMs is 3; miss two beats, then resume.
    for (let i = 0; i < 10; i++) {
      h.clock.advance(config.heartbeatMs * 2);
      h.lifecycle.heartbeat();
    }
    expect(h.lifecycle.status()).toBe('attached');
    expect(h.notices).toHaveLength(noticesAfterAttach);
    expect(h.lifecycle.counts.lost).toBe(0);
  });

  it('a peer that stops entirely enters lost within lossAfterMs', async () => {
    const h = harness();
    await attached(h);
    h.clock.advance(config.lossAfterMs - 1);
    expect(h.lifecycle.status()).toBe('attached');
    h.clock.advance(2);
    expect(h.lifecycle.status()).toBe('lost');
    expect(h.lifecycle.counts.lost).toBe(1);
  });
});

describe('§8.6 / §8.7 — a clean detach is not a crash, and a hold expires', () => {
  it('detach(shutdown) says something different and is reap-eligible at once', async () => {
    const h = harness();
    const { peer } = await attached(h);
    h.lifecycle.detach('shutdown');

    expect(h.lifecycle.status()).toBe('detached');
    expect(h.notices.at(-1)).toMatchObject({ kind: 'service-detached', reason: 'shutdown' });
    expect(h.notices.filter((n) => n.kind === 'service-lost')).toHaveLength(0);
    expect(peer.closed).toEqual(['shutdown']);

    h.room.clients.clear();
    h.clock.advance(TIMINGS.emptyGraceMs + 1);
    // No hold, no exemption: the normal rules apply straight away.
    expect(h.lifecycle.isReapExempt()).toBe(false);
    expect(
      evaluateRoomWithService(h.room, TIMINGS, h.lifecycle, h.clock.now()).shouldDestroy,
    ).toBe(true);
  });

  it('§8.7 holdMs elapsing with no re-attach drops the room to detached', async () => {
    const h = harness();
    await attached(h);
    h.clock.advance(config.lossAfterMs + 1);
    expect(h.lifecycle.status()).toBe('lost');
    const lostAt = (h.notices.find((n) => n.kind === 'service-lost') as ServiceNotice).at;

    h.clock.advance(lostAt + config.holdMs - h.clock.now() - 1);
    expect(h.lifecycle.status()).toBe('lost');
    expect(h.lifecycle.isReapExempt()).toBe(true);

    h.clock.advance(2);
    expect(h.lifecycle.status()).toBe('detached');
    expect(h.lifecycle.isReapExempt()).toBe(false);

    h.room.clients.clear();
    h.clock.advance(TIMINGS.emptyGraceMs + 1);
    expect(
      evaluateRoomWithService(h.room, TIMINGS, h.lifecycle, h.clock.now()).shouldDestroy,
    ).toBe(true);
  });

  it('a handshake in flight is settled, not abandoned, when the room detaches', async () => {
    const h = harness();
    const pending = h.lifecycle.attach(new RecordingPeer('engine-1'));
    h.lifecycle.detach('handoff');
    await expect(pending).rejects.toMatchObject({ code: 'service-unavailable' });
    expect(h.lifecycle.status()).toBe('detached');
  });
});

describe('§6 — with the service config undefined, none of it exists', () => {
  it('builds no lifecycle, schedules no timer, and changes no reaping decision', () => {
    const clock = new ManualClock(0);
    const room = seatedRoom();
    const lifecycle = createServiceLifecycle<Match>(room, undefined, { clock });

    expect(lifecycle).toBeNull();
    expect(clock.pending).toBe(0);

    room.clients.clear();
    clock.advance(TIMINGS.emptyGraceMs + 1);
    // Identical to the shipped reaper, decision for decision.
    const plain = evaluateRoom(room, TIMINGS, clock.now());
    expect(evaluateRoomWithService(room, TIMINGS, lifecycle, clock.now())).toEqual(plain);
    expect(evaluateRoomWithService(room, TIMINGS, null, clock.now()).shouldDestroy).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('a room with a service configured schedules nothing until a peer attaches', () => {
    const clock = new ManualClock(0);
    const room = seatedRoom();
    const lifecycle = createServiceLifecycle<Match>(room, config, { clock });
    expect(lifecycle?.status()).toBe('detached');
    expect(clock.pending).toBe(0);
    expect(lifecycle?.isReapExempt()).toBe(false);
  });
});
