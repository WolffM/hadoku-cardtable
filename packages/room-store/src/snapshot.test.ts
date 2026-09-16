/*
 * Serialisation: the three containers, and the three deliberate absences.
 *
 * `JSON.stringify` renders a `Map` and a `Set` as `{}`, so the failure this file
 * guards against is silent — a room writes out, comes back with an empty roster,
 * and nothing anywhere throws.
 */

import { describe, expect, it } from 'vitest';
import { isDurableParticipantId, seatParticipant } from '@wolffm/rooms-protocol';
import {
  applySnapshot,
  decodeSnapshot,
  jsonCodec,
  snapshotRoom,
  SnapshotUnreadableError,
  STORE_VERSION,
  type RestoreContext,
  type RoomCodec,
  type RoomSnapshot,
} from './snapshot.ts';
import { makeClient, makeRoom } from './testkit.ts';

interface App {
  picks: number;
}

const codec: RoomCodec<App, { note: string }> = { app: jsonCodec<App>(7) };
const ctx: RestoreContext = { roomId: 'r1', restoreId: 'epoch-2', restoredAt: 5_000 };

function populated() {
  const room = makeRoom<App, { note: string }>('r1', { picks: 3 }, { capacity: 4, now: 1_000 });
  room.lastEventSeq = 42;
  room.leaderId = 'socket-fk:alice';
  room.clients.set('socket-a', makeClient('fk:alice', { note: 'a' }, { friendKey: 'SECRET-KEY-ALICE' }));
  room.clients.set('socket-b', makeClient('dev:bob', { note: 'b' }, { name: 'Bob', avatarId: 'av2' }));
  room.clients.set('socket-c', makeClient('eph:socket-c', { note: 'c' }));
  room.usedAvatars.add('av2');
  room.usedAvatars.add('av5');
  room.clientNames.set('fk:alice', 'Alice');
  room.clientNames.set('dev:bob', 'Bob');
  room.clientNames.set('eph:socket-c', 'Anon');
  seatParticipant(room.seats, 'fk:alice');
  seatParticipant(room.seats, 'dev:bob');
  seatParticipant(room.seats, 'eph:socket-c');
  return room;
}

describe('snapshotRoom — the three containers that are not JSON', () => {
  it('flattens clients, usedAvatars and clientNames, and survives JSON', () => {
    const room = populated();
    const snapshot = snapshotRoom(room, codec);

    // The naive failure: JSON.stringify on the live room renders all three as {}.
    const naive = JSON.parse(JSON.stringify(room)) as Record<string, unknown>;
    expect(naive.clients).toEqual({});
    expect(naive.usedAvatars).toEqual({});
    expect(naive.clientNames).toEqual({});

    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as RoomSnapshot;
    // Two durable members; the `eph:` one is not written (§4.2).
    expect(roundTripped.members.map((m) => m.participantId)).toEqual(['dev:bob', 'fk:alice']);
    expect(roundTripped.usedAvatars).toEqual(['av2', 'av5']);
    expect(roundTripped.clientNames).toEqual({ 'dev:bob': 'Bob', 'fk:alice': 'Alice' });
    expect(roundTripped.storeVersion).toBe(STORE_VERSION);
    expect(roundTripped.appVersion).toBe(7);
  });

  it('writes no clientId, no socketId and no friendKey — all three on purpose', () => {
    const room = populated();
    const text = JSON.stringify(snapshotRoom(room, codec));
    // friendKey is auth material. `ClientMeta.friendKey`'s own doc comment says
    // it must never reach a payload, and a file on disk is a payload.
    expect(text).not.toContain('SECRET-KEY-ALICE');
    expect(text).not.toContain('friendKey');
    expect(text).not.toContain('socketId');
    expect(text).not.toContain('clientId');
    // ...and the value is genuinely on the room, so the absence means something.
    expect(room.clients.get('socket-a')?.friendKey).toBe('SECRET-KEY-ALICE');
  });

  it('collapses two sockets for one refreshing participant into one member', () => {
    const room = makeRoom<App, { note: string }>('r1', { picks: 0 });
    room.clients.set('old', makeClient('fk:alice', { note: 'stale' }, { lastSeen: 100 }));
    room.clients.set('new', makeClient('fk:alice', { note: 'fresh' }, { lastSeen: 900 }));
    const snapshot = snapshotRoom(room, codec);
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.members[0]?.app).toEqual({ note: 'fresh' });
  });

  it('does not mutate the room it read', () => {
    const room = populated();
    const before = JSON.stringify(room.seats);
    snapshotRoom(room, codec);
    expect(JSON.stringify(room.seats)).toBe(before);
    expect(room.clients.size).toBe(3);
  });

  it('releases the seat an `eph:` participant held, and forgets it', () => {
    const room = populated();
    const snapshot = snapshotRoom(room, codec);
    const holders = snapshot.seats.seats
      .map((s) => s.occupant)
      .filter((o): o is { kind: 'human'; participantId: string } => o?.kind === 'human')
      .map((o) => o.participantId);
    expect(holders).toEqual(['fk:alice', 'dev:bob']);
    expect(holders.every(isDurableParticipantId)).toBe(true);
    expect(Object.keys(snapshot.seats.remembered)).not.toContain('eph:socket-c');
  });
});

describe('decodeSnapshot — nothing is applied until everything decodes', () => {
  it('restores the containers and leaves clients empty (§4.3)', () => {
    const snapshot = snapshotRoom(populated(), codec);
    const decoded = decodeSnapshot(snapshot, codec, ctx);
    const fresh = makeRoom<App, { note: string }>('r1', { picks: 0 }, { now: 9_000 });
    applySnapshot(fresh, decoded, 9_000);

    expect(fresh.clients.size).toBe(0);
    expect(fresh.usedAvatars).toBeInstanceOf(Set);
    expect([...fresh.usedAvatars]).toEqual(['av2', 'av5']);
    expect(fresh.clientNames).toBeInstanceOf(Map);
    expect(fresh.clientNames.get('fk:alice')).toBe('Alice');
    expect(fresh.app).toEqual({ picks: 3 });
    expect(fresh.lastEventSeq).toBe(42);
  });

  it('does not restore leaderId — it names a socket that no longer exists', () => {
    const snapshot = snapshotRoom(populated(), codec) as unknown as Record<string, unknown>;
    expect(snapshot.leaderId).toBeUndefined();
    const decoded = decodeSnapshot(snapshot as unknown as RoomSnapshot, codec, ctx);
    const fresh = makeRoom<App, { note: string }>('r1', { picks: 0 });
    fresh.leaderId = 'socket-stale';
    applySnapshot(fresh, decoded, 9_000);
    expect(fresh.leaderId).toBeNull();
  });

  it('stamps a fresh emptiness clock rather than inheriting updatedAt (§4.6)', () => {
    const snapshot = snapshotRoom(populated(), codec);
    expect(snapshot.updatedAt).toBe(1_000);
    const fresh = makeRoom<App, { note: string }>('r1', { picks: 0 });
    applySnapshot(fresh, decodeSnapshot(snapshot, codec, ctx), 9_000_000);
    expect(fresh.createdAt).toBe(1_000);
    expect(fresh.updatedAt).toBe(9_000_000);
  });

  it('hands the restore context to the codec, so an epoch can be stamped', () => {
    const seen: RestoreContext[] = [];
    const stamping: RoomCodec<App> = {
      app: {
        version: 1,
        serialize: (a) => a,
        deserialize: (raw, _v, c) => {
          seen.push(c);
          return raw as App;
        },
      },
    };
    const snapshot = snapshotRoom(makeRoom<App>('r1', { picks: 1 }), stamping);
    decodeSnapshot(snapshot, stamping, ctx);
    expect(seen).toEqual([ctx]);
  });

  it('refuses a storeVersion it does not understand (§4.5)', () => {
    const snapshot = { ...snapshotRoom(populated(), codec), storeVersion: STORE_VERSION + 1 };
    expect(() => decodeSnapshot(snapshot, codec, ctx)).toThrowError(SnapshotUnreadableError);
    try {
      decodeSnapshot(snapshot, codec, ctx);
    } catch (err) {
      expect((err as SnapshotUnreadableError).reason).toBe('store-version');
    }
  });

  it('refuses a record that is not shaped like a snapshot', () => {
    const snapshot = snapshotRoom(populated(), codec) as unknown as Record<string, unknown>;
    delete snapshot.seats;
    try {
      decodeSnapshot(snapshot as unknown as RoomSnapshot, codec, ctx);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as SnapshotUnreadableError).reason).toBe('malformed');
    }
  });

  it('turns a throwing host codec into a quarantine, not a crash', () => {
    const bad: RoomCodec<App> = {
      app: {
        version: 1,
        serialize: (a) => a,
        deserialize: () => {
          throw new Error('app blob is corrupt');
        },
      },
    };
    const snapshot = snapshotRoom(makeRoom<App>('r1', { picks: 1 }), { app: jsonCodec<App>() });
    try {
      decodeSnapshot(snapshot, bad, ctx);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotUnreadableError);
      expect((err as SnapshotUnreadableError).reason).toBe('codec');
    }
  });

  it('leaves the target room untouched when the codec throws — no half-apply', () => {
    const bad: RoomCodec<App> = {
      app: {
        version: 1,
        serialize: (a) => a,
        deserialize: () => {
          throw new Error('nope');
        },
      },
    };
    const snapshot = snapshotRoom(populated(), codec);
    const target = makeRoom<App, { note: string }>('r1', { picks: 0 }, { now: 3 });
    const before = JSON.stringify({
      app: target.app,
      seq: target.lastEventSeq,
      names: [...target.clientNames],
      avatars: [...target.usedAvatars],
      seats: target.seats,
    });
    expect(() => {
      applySnapshot(target, decodeSnapshot(snapshot, bad, ctx), 3);
    }).toThrowError(SnapshotUnreadableError);
    expect(
      JSON.stringify({
        app: target.app,
        seq: target.lastEventSeq,
        names: [...target.clientNames],
        avatars: [...target.usedAvatars],
        seats: target.seats,
      }),
    ).toBe(before);
  });

  it('drops an `eph:` member that another writer put in the snapshot', () => {
    const snapshot = snapshotRoom(populated(), codec);
    snapshot.members.push({
      participantId: 'eph:socket-zz',
      joinedAt: 0,
      lastSeen: 0,
      app: { note: 'z' },
    });
    snapshot.seats.seats[3] = { id: 3, occupant: { kind: 'human', participantId: 'eph:socket-zz' } };
    const decoded = decodeSnapshot(snapshot, codec, ctx);
    expect(decoded.members.map((m) => m.participantId)).toEqual(['dev:bob', 'fk:alice']);
    expect(decoded.seats.seats[3]?.occupant).toBeNull();
  });
});
