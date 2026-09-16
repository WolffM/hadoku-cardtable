/*
 * P6 §5's tests, minus the two that need a real draft and a real signal —
 * those are `draftRestore.test.ts` (§5.1) and `sigterm.test.ts` (§5.5).
 *
 * The two that matter most here are §5.4 (the restore/join race) and §5.6/§5.7
 * (quarantine), because both are safety controls of the kind that pass while
 * doing nothing. `mutation.md` in the closing note records what happens when
 * each guard is broken; if you are reading this because a test here looks
 * redundant, that is the answer.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  occupantOf,
  seatOf,
  seatParticipant,
  setSeatCapacity,
  unseatParticipant,
  type SeatTable,
} from '@wolffm/rooms-protocol';
import { evaluateRoom, type GCTimings } from '@wolffm/rooms-server';
import { ManualClock } from './clock.ts';
import {
  RoomPersistence,
  SaveBeforeLoadError,
  type PersistenceLog,
  type RoomPersistenceConfig,
} from './persistence.ts';
import { jsonCodec, STORE_VERSION, type RoomCodec, type RoomSnapshot } from './snapshot.ts';
import { MemoryRoomStore, type RoomStore } from './store.ts';
import { FileRoomStore } from './fileStore.ts';
import { makeClient } from './testkit.ts';

interface App {
  picks: string[];
}
const codec: RoomCodec<App> = { app: jsonCodec<App>(1) };
const createApp = (): App => ({ picks: [] });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'room-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function build(overrides: Partial<RoomPersistenceConfig<App>> = {}) {
  const clock = new ManualClock(1_000);
  const logs: PersistenceLog[] = [];
  const persistence = new RoomPersistence<App>({
    codec,
    createApp,
    clock,
    onLog: (e) => logs.push(e),
    ...overrides,
  });
  return { clock, logs, persistence };
}

/** A store that records every call, and can hold `load` open. */
class GatedStore implements RoomStore {
  readonly inner = new MemoryRoomStore();
  readonly calls: string[] = [];
  #gated = false;
  #waiters: Array<() => void> = [];

  /** Hold every subsequent `load` open until `release`. */
  gateLoad(): void {
    this.#gated = true;
  }
  release(): void {
    this.#gated = false;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  async load(roomId: string): Promise<RoomSnapshot | null> {
    this.calls.push(`load:${roomId}`);
    if (this.#gated) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.inner.load(roomId);
  }
  async save(snapshot: RoomSnapshot): Promise<void> {
    this.calls.push(`save:${snapshot.roomId}`);
    return this.inner.save(snapshot);
  }
  saveSync(snapshot: RoomSnapshot): void {
    this.calls.push(`saveSync:${snapshot.roomId}`);
    this.inner.saveSync(snapshot);
  }
  async remove(roomId: string): Promise<void> {
    this.calls.push(`remove:${roomId}`);
    return this.inner.remove(roomId);
  }
  async list(): Promise<string[]> {
    this.calls.push('list');
    return this.inner.list();
  }
  async quarantine(roomId: string, reason: string): Promise<void> {
    this.calls.push(`quarantine:${roomId}`);
    return this.inner.quarantine(roomId, reason);
  }
  async listQuarantined(): Promise<string[]> {
    return this.inner.listQuarantined();
  }
}

describe('§4.1 — restore beats the first join, it does not race it', () => {
  it('§5.4 concurrent joins share ONE load and get ONE room, the restored one', async () => {
    const store = new GatedStore();
    await store.inner.save({
      storeVersion: STORE_VERSION,
      roomId: 'r1',
      roomKey: 'k',
      lastEventSeq: 99,
      createdAt: 10,
      updatedAt: 20,
      members: [],
      usedAvatars: [],
      clientNames: {},
      seats: { capacity: 4, seats: [], remembered: {}, reservations: {}, reservationTtlMs: 0 },
      app: { picks: ['restored'] },
      appVersion: 1,
    });
    store.calls.length = 0;
    store.gateLoad();

    const { persistence } = build({ store });
    const joins = [
      persistence.loadOrCreate('r1', 'k'),
      persistence.loadOrCreate('r1', 'k'),
      persistence.loadOrCreate('r1', 'k'),
    ];
    // Everything a join could do arrives while the load is still in flight.
    expect(persistence.loadState('r1')).toBe('restoring');
    // The guard that catches the case the in-flight dedupe cannot: a host that
    // creates or writes rooms by some other path entirely.
    await expect(persistence.save('r1')).rejects.toBeInstanceOf(SaveBeforeLoadError);
    const callsBeforeLoadResolved = [...store.calls];

    store.release();
    const rooms = await Promise.all(joins);

    // Exactly one room object, shared by all three joiners.
    expect(rooms[0]).toBe(rooms[1]);
    expect(rooms[1]).toBe(rooms[2]);
    expect(persistence.registry.size).toBe(1);
    // It is the restored one, not a fresh empty room under the same id.
    expect(rooms[0]?.app).toEqual({ picks: ['restored'] });
    expect(rooms[0]?.lastEventSeq).toBe(99);
    // Exactly one load, and no save at all before it completed. This is the
    // assertion the whole rule exists for: a save here overwrites the draft.
    expect(callsBeforeLoadResolved).toEqual(['load:r1']);
    expect(store.calls.filter((c) => c.startsWith('save'))).toEqual([]);
  });

  it('refuses a save for a room whose snapshot has not been loaded', async () => {
    const { persistence } = build();
    expect(persistence.loadState('never-seen')).toBe('absent');
    await expect(persistence.save('never-seen')).rejects.toBeInstanceOf(SaveBeforeLoadError);
    await expect(persistence.save('never-seen')).rejects.toThrow(/load state is 'absent'/);
  });

  it('allows a save once the load has completed', async () => {
    const store = new MemoryRoomStore();
    const { persistence } = build({ store });
    const room = await persistence.loadOrCreate('r1', 'k');
    room.app.picks.push('a');
    await expect(persistence.save('r1')).resolves.toBeUndefined();
    expect(await store.list()).toEqual(['r1']);
  });
});

describe('§4.5 — an unreadable snapshot is quarantined, never half-applied', () => {
  it('§5.6 a corrupt app blob: the room boots fresh, the bytes survive, one log', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    const throwing: RoomCodec<App> = {
      app: {
        version: 1,
        serialize: (a) => a,
        deserialize: (raw) => {
          const r = raw as { picks?: unknown };
          if (!Array.isArray(r.picks)) throw new Error('app blob is corrupt');
          return { picks: r.picks as string[] };
        },
      },
    };

    const first = new RoomPersistence<App>({ store, codec: throwing, createApp });
    const room = await first.loadOrCreate('r1', 'k');
    room.app.picks.push('Black Lotus');
    await first.save('r1');

    // Corrupt the app blob in place, exactly as a bad write would.
    const name = readdirSync(dir).find((n) => n.endsWith('.json')) as string;
    const original = readFileSync(join(dir, name), 'utf8');
    const corrupted = JSON.stringify({
      ...(JSON.parse(original) as RoomSnapshot),
      app: { picks: 'not-an-array' },
    });
    writeFileSync(join(dir, name), corrupted, 'utf8');

    const logs: PersistenceLog[] = [];
    const second = new RoomPersistence<App>({
      store: new FileRoomStore(dir),
      codec: throwing,
      createApp,
      onLog: (e) => logs.push(e),
    });
    const rebooted = await second.loadOrCreate('r1', 'k');

    // The room boots as if the snapshot did not exist.
    expect(rebooted.app).toEqual({ picks: [] });
    expect(second.loadState('r1')).toBe('ready');
    // Exactly one error logged.
    const quarantines = logs.filter((l) => l.event === 'snapshot-quarantined');
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]?.reason).toContain('codec');
    // The bytes are set aside INTACT, under a distinct key.
    const quarantined = await second.store.listQuarantined();
    expect(quarantined).toHaveLength(1);
    expect((second.store as FileRoomStore).readQuarantined(quarantined[0] as string)).toBe(
      corrupted,
    );
    // ...and the live path no longer sees it.
    expect(await second.store.load('r1')).toBeNull();
  });

  it('§5.7 a future storeVersion is quarantined, not guessed at', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    const first = new RoomPersistence<App>({ store, codec, createApp });
    const room = await first.loadOrCreate('r1', 'k');
    room.app.picks.push('Sol Ring');
    await first.save('r1');

    const name = readdirSync(dir).find((n) => n.endsWith('.json')) as string;
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RoomSnapshot;
    writeFileSync(
      join(dir, name),
      JSON.stringify({ ...raw, storeVersion: STORE_VERSION + 1 }),
      'utf8',
    );

    const logs: PersistenceLog[] = [];
    const second = new RoomPersistence<App>({
      store: new FileRoomStore(dir),
      codec,
      createApp,
      onLog: (e) => logs.push(e),
    });
    const rebooted = await second.loadOrCreate('r1', 'k');
    expect(rebooted.app).toEqual({ picks: [] });
    const quarantines = logs.filter((l) => l.event === 'snapshot-quarantined');
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]?.reason).toContain('store-version');
    expect(await second.store.listQuarantined()).toHaveLength(1);
  });

  it('a file that does not parse at all is quarantined rather than read as absent', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    const first = new RoomPersistence<App>({ store, codec, createApp });
    await first.loadOrCreate('r1', 'k');
    await first.save('r1');
    const name = readdirSync(dir).find((n) => n.endsWith('.json')) as string;
    writeFileSync(join(dir, name), '{ this is not json', 'utf8');

    const logs: PersistenceLog[] = [];
    const second = new RoomPersistence<App>({
      store: new FileRoomStore(dir),
      codec,
      createApp,
      onLog: (e) => logs.push(e),
    });
    await second.loadOrCreate('r1', 'k');
    expect(logs.filter((l) => l.event === 'snapshot-quarantined')).toHaveLength(1);
    expect((second.store as FileRoomStore).readQuarantined(
      (await second.store.listQuarantined())[0] as string,
    )).toBe('{ this is not json');
  });
});

describe('§4.2 / §4.3 — durable tiers, and seats held with zero sockets', () => {
  it('§4.3 a restored seat is still held though nobody has a socket', async () => {
    const store = new MemoryRoomStore();
    const { persistence } = build({ store });
    const room = await persistence.loadOrCreate('r1', 'k');
    setSeatCapacity(room.seats, 4);
    room.clients.set('s1', makeClient('fk:alice', undefined));
    seatParticipant(room.seats, 'fk:alice', 1_000);
    expect(seatOf(room.seats, 'fk:alice')).toBe(0);
    await persistence.save('r1');

    const { persistence: rebooted } = build({ store });
    const back = await rebooted.loadOrCreate('r1', 'k');
    expect(back.clients.size).toBe(0);
    expect(occupantOf(back.seats, 0)).toEqual({ kind: 'human', participantId: 'fk:alice' });
    expect(rebooted.membersOf('r1').map((m) => m.participantId)).toEqual(['fk:alice']);
  });

  it('§5.3 an `eph:` participant is not restored and its seat becomes claimable', async () => {
    const store = new MemoryRoomStore();
    const { persistence } = build({ store });
    const room = await persistence.loadOrCreate('r1', 'k');
    setSeatCapacity(room.seats, 3);
    for (const pid of ['fk:alice', 'fk:bob', 'eph:socket-zz']) {
      room.clients.set(`s-${pid}`, makeClient(pid, undefined));
      seatParticipant(room.seats, pid, 1_000);
    }
    expect(seatOf(room.seats, 'eph:socket-zz')).toBe(2);
    await persistence.save('r1');

    const { persistence: rebooted } = build({ store });
    const back = await rebooted.loadOrCreate('r1', 'k');

    // Two participants back, one seat released.
    expect(rebooted.membersOf('r1').map((m) => m.participantId).sort()).toEqual([
      'fk:alice',
      'fk:bob',
    ]);
    expect(occupantOf(back.seats, 2)).toBeNull();
    // ...and the released seat is claimable by someone new.
    expect(seatParticipant(back.seats, 'fk:carol', 2_000)).toBe(2);
    expect(occupantOf(back.seats, 2)).toEqual({ kind: 'human', participantId: 'fk:carol' });
  });

  it('§5.2 a refresh does not vacate a seat across a restart — sampled at each step', async () => {
    const store = new MemoryRoomStore();
    const ttl = 10 * 60_000;
    const samples: Array<{ step: string; seat0: ReturnType<typeof occupantOf>; reserved?: string }> =
      [];
    const sample = (step: string, seats: SeatTable) => {
      samples.push({
        step,
        seat0: occupantOf(seats, 0),
        reserved: seats.reservations[0]?.participantId,
      });
    };

    const { clock, persistence } = build({ store });
    const room = await persistence.loadOrCreate('r1', 'k');
    setSeatCapacity(room.seats, 4);
    room.seats.reservationTtlMs = ttl;
    room.clients.set('socket-A', makeClient('fk:alice', undefined));
    seatParticipant(room.seats, 'fk:alice', clock.now());
    sample('joined', room.seats);

    // The refresh: the old socket drops and the host releases WITH a hold.
    room.clients.delete('socket-A');
    unseatParticipant(room.seats, 'fk:alice', { hold: true, now: clock.now() });
    sample('socket-dropped', room.seats);
    await persistence.save('r1');

    // The restart.
    clock.advance(30_000);
    const { persistence: rebooted } = build({ store });
    const back = await rebooted.loadOrCreate('r1', 'k');
    sample('restarted', back.seats);

    // Someone else tries for the seat during the gap.
    const carolSeat = seatParticipant(back.seats, 'fk:carol', 31_000);
    sample('carol-tried', back.seats);
    expect(carolSeat).not.toBe(0);

    // Alice comes back on a brand new socket.
    back.clients.set('socket-B', makeClient('fk:alice', undefined));
    expect(seatParticipant(back.seats, 'fk:alice', 32_000)).toBe(0);
    sample('alice-back', back.seats);

    // At NO step was seat 0 held by, or promised to, anyone but Alice.
    expect(samples.map((s) => s.step)).toEqual([
      'joined',
      'socket-dropped',
      'restarted',
      'carol-tried',
      'alice-back',
    ]);
    for (const s of samples) {
      if (s.seat0 !== null) expect(s.seat0).toEqual({ kind: 'human', participantId: 'fk:alice' });
      if (s.reserved !== undefined) expect(s.reserved).toBe('fk:alice');
      // Never both empty AND unreserved: that is the window a seat is lost in.
      expect(s.seat0 !== null || s.reserved === 'fk:alice').toBe(true);
    }
  });
});

describe('§4.6 — persistence and the reaper agree', () => {
  const timings: GCTimings = { idleMs: 60_000, emptyGraceMs: 120_000 };

  it('a room restored after a long outage is not instantly reap-eligible', async () => {
    const store = new MemoryRoomStore();
    const { persistence } = build({ store });
    const room = await persistence.loadOrCreate('r1', 'k');
    room.updatedAt = 1_000;
    await persistence.save('r1');

    // Five hours pass with the server down.
    const late = new ManualClock(1_000 + 5 * 3_600_000);
    const rebooted = new RoomPersistence<App>({ store, codec, createApp, clock: late });
    const back = await rebooted.loadOrCreate('r1', 'k');

    // Inheriting `updatedAt` would make this true immediately — `evaluateRoom`
    // computes `now - room.updatedAt` and the room has no clients.
    expect(back.clients.size).toBe(0);
    expect(evaluateRoom(back, timings, late.now()).shouldDestroy).toBe(false);
    expect(back.updatedAt).toBe(late.now());
    // The grace period starts now, and still expires on schedule.
    expect(evaluateRoom(back, timings, late.now() + 120_001).shouldDestroy).toBe(true);
  });

  it('§5.9 destroying a room removes its snapshot, so the next boot does not resurrect it', async () => {
    const store = new MemoryRoomStore();
    const { persistence } = build({ store });
    const room = await persistence.loadOrCreate('r1', 'k');
    room.app.picks.push('Sol Ring');
    await persistence.save('r1');
    expect(await store.list()).toEqual(['r1']);

    await persistence.destroy('r1');
    expect(await store.list()).toEqual([]);
    expect(persistence.registry.size).toBe(0);
    expect(persistence.loadState('r1')).toBe('absent');

    const { persistence: rebooted } = build({ store });
    const back = await rebooted.loadOrCreate('r1', 'k');
    expect(back.app).toEqual({ picks: [] });
  });
});

describe('the debounce', () => {
  it('coalesces a burst into one write', async () => {
    const store = new GatedStore();
    const { clock, persistence } = build({ store, persist: { debounceMs: 500 } });
    const room = await persistence.loadOrCreate('r1', 'k');
    store.calls.length = 0;
    for (let i = 0; i < 20; i++) {
      room.app.picks.push(`c${i}`);
      persistence.markDirty('r1');
      clock.advance(10);
    }
    clock.advance(500);
    await Promise.resolve();
    expect(store.calls.filter((c) => c.startsWith('save'))).toHaveLength(1);
  });

  it('never goes longer than maxIntervalMs unsaved, however steady the stream', async () => {
    const store = new GatedStore();
    const { clock, persistence } = build({
      store,
      persist: { debounceMs: 1_000, maxIntervalMs: 3_000 },
    });
    const room = await persistence.loadOrCreate('r1', 'k');
    store.calls.length = 0;
    // A pick every 200ms forever: a debounce alone is starved and never fires.
    for (let i = 0; i < 40; i++) {
      room.app.picks.push(`c${i}`);
      persistence.markDirty('r1');
      clock.advance(200);
      await Promise.resolve();
    }
    const saves = store.calls.filter((c) => c.startsWith('save')).length;
    expect(saves).toBeGreaterThanOrEqual(2);
    expect(saves).toBeLessThanOrEqual(4);
  });
});

describe('§5.8 — the default changes nothing', () => {
  it('constructs the memory tier, touches no filesystem, and behaves identically', async () => {
    const dir = tempDir();
    const { persistence } = build();
    expect(persistence.store).toBeInstanceOf(MemoryRoomStore);

    // A full room lifecycle with no store configured.
    const room = await persistence.loadOrCreate('r1', 'k');
    setSeatCapacity(room.seats, 2);
    room.clients.set('s1', makeClient('fk:alice', undefined));
    seatParticipant(room.seats, 'fk:alice', 1_000);
    room.app.picks.push('Sol Ring');
    persistence.markDirty('r1');
    await persistence.flushAll();
    await persistence.destroy('r1');

    // Nothing was written anywhere on disk. (A negative over one directory, not
    // over the whole filesystem — the positive claim is the instanceof above.)
    expect(readdirSync(dir)).toEqual([]);
    expect(await persistence.store.list()).toEqual([]);
  });

  it('flushOnSignal: false installs nothing at all', () => {
    const before = process.listenerCount('SIGTERM');
    const { persistence } = build({ persist: { flushOnSignal: false } });
    const uninstall = persistence.installSignalHandlers(['SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    uninstall();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('a restore with no snapshot is just a create', async () => {
    const { persistence } = build();
    const room = await persistence.loadOrCreate('fresh', 'k');
    expect(room.app).toEqual({ picks: [] });
    expect(room.leaderId).toBeNull();
    expect(persistence.membersOf('fresh')).toEqual([]);
    expect(persistence.loadState('fresh')).toBe('ready');
  });
});
