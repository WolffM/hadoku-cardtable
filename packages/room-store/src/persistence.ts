/*
 * The part that has to be right: when a room is loaded, when it is written, and
 * what happens when those two race.
 *
 * `snapshot.ts` is serialisation and `store.ts`/`fileStore.ts` are storage. This
 * file is the four rules from `docs/requests/P6_PERSISTENCE.md` §4 that make the
 * difference between persistence and a slow way to lose a draft:
 *
 *   §4.1  restore beats the first join — it does not race it
 *   §4.4  a deploy flushes
 *   §4.5  an unreadable snapshot is quarantined, never half-applied
 *   §4.6  persistence and the reaper agree
 *
 * ## The failure §4.1 prevents, spelled out
 *
 * The server boots. A refreshing browser reconnects before the restore pass has
 * read the store. The room is created fresh and empty under the same `roomId`.
 * The next debounced save overwrites a 45-minute draft with an empty room. Once,
 * silently, unrecoverably — nothing logs, nothing throws, and the file on disk is
 * a perfectly valid snapshot of nothing.
 *
 * Two guards, and both are needed:
 *
 *   1. `loadOrCreate` is ONE step. Concurrent calls for the same `roomId` share
 *      the in-flight load rather than each creating a room; a room in the
 *      `restoring` state queues joins instead of creating a second room under
 *      the same id.
 *   2. `save()` for a `roomId` whose snapshot has not yet loaded is REFUSED,
 *      with a typed error. This is the guard that catches the case guard 1
 *      cannot: a host that creates rooms by some other path entirely.
 *
 * Guard 2 is the one that looks redundant and is not. If it ever starts looking
 * redundant again, `persistence.test.ts` has a test whose only job is to fail
 * when it is removed.
 */

import { RoomRegistry, type CoreRoomState } from '@wolffm/rooms-server';
import { systemClock, type Clock, type TimerHandle } from './clock.ts';
import {
  applySnapshot,
  decodeSnapshot,
  snapshotRoom,
  SnapshotUnreadableError,
  type RestoreContext,
  type RestoredMember,
  type RoomCodec,
  type RoomSnapshot,
} from './snapshot.ts';
import { MemoryRoomStore, type RoomStore } from './store.ts';

/** Where a room is in the load-or-create step. */
export type RoomLoadState =
  /** Never asked for. A `save` is refused. */
  | 'absent'
  /** The load is in flight. Joins queue; a `save` is refused. */
  | 'restoring'
  /** Loaded (or created fresh). Saves are allowed. */
  | 'ready';

export interface PersistOptions {
  /** Coalesce bursts of mutations. */
  debounceMs: number;
  /** ...but never go longer than this unsaved. */
  maxIntervalMs: number;
  /** §4.4. Default true. */
  flushOnSignal: boolean;
  /** How long `shutdown()` waits for the async flush before giving up. */
  flushDeadlineMs: number;
}

export const DEFAULT_PERSIST: PersistOptions = {
  debounceMs: 1_000,
  maxIntervalMs: 15_000,
  flushOnSignal: true,
  flushDeadlineMs: 5_000,
};

export type PersistenceLog =
  | { level: 'warn'; event: 'snapshot-quarantined'; roomId: string; reason: string }
  | { level: 'info'; event: 'room-restored'; roomId: string; members: number; seq: number }
  | { level: 'warn'; event: 'flush-failed'; roomId: string; reason: string };

export interface RoomPersistenceConfig<TApp, TClient = unknown> {
  /** Default: an in-memory store. Nothing changes for a host that omits it. */
  store?: RoomStore;
  codec: RoomCodec<TApp, TClient>;
  /** Builds `TApp` for a room with no snapshot. Same contract as `RoomRegistry`. */
  createApp: (now: number) => TApp;
  clock?: Clock;
  persist?: Partial<PersistOptions>;
  onLog?: (entry: PersistenceLog) => void;
  /**
   * Makes the epoch stamped on a restore. Injected only so a test can assert
   * exactly which value came back; the default is a random id.
   */
  newEpoch?: () => string;
}

/** Thrown by `save` for a room whose snapshot has not been loaded. §4.1. */
export class SaveBeforeLoadError extends Error {
  readonly roomId: string;
  readonly state: RoomLoadState;
  constructor(roomId: string, state: RoomLoadState) {
    super(`refusing to save room ${roomId}: load state is '${state}', not 'ready'`);
    this.name = 'SaveBeforeLoadError';
    this.roomId = roomId;
    this.state = state;
  }
}

interface RoomEntry<TClient> {
  state: RoomLoadState;
  /** The incarnation id — fresh at create AND at every restore. */
  epoch: string;
  members: Array<RestoredMember<TClient>>;
  dirty: boolean;
  /** When the room first went dirty in the current window. */
  dirtySince: number;
  timer: TimerHandle | null;
}

let epochCounter = 0;
function defaultEpoch(): string {
  // Unique per room incarnation within a process, and across processes: the
  // random half covers a restart, the counter covers two restores in the same
  // millisecond. `classifySeq` only asks that it change when the room is
  // rebuilt and not otherwise.
  return `e${Date.now().toString(36)}-${(++epochCounter).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export class RoomPersistence<TApp, TClient = unknown> {
  readonly registry: RoomRegistry<TApp, TClient>;
  readonly store: RoomStore;
  readonly options: PersistOptions;

  #codec: RoomCodec<TApp, TClient>;
  #clock: Clock;
  #onLog: (entry: PersistenceLog) => void;
  #newEpoch: () => string;
  #entries = new Map<string, RoomEntry<TClient>>();
  #loading = new Map<string, Promise<CoreRoomState<TApp, TClient>>>();

  constructor(config: RoomPersistenceConfig<TApp, TClient>) {
    this.registry = new RoomRegistry<TApp, TClient>(config.createApp);
    this.store = config.store ?? new MemoryRoomStore();
    this.options = { ...DEFAULT_PERSIST, ...config.persist };
    this.#codec = config.codec;
    this.#clock = config.clock ?? systemClock;
    this.#onLog = config.onLog ?? (() => {});
    this.#newEpoch = config.newEpoch ?? defaultEpoch;
  }

  /** `'absent' | 'restoring' | 'ready'` for a room id. */
  loadState(roomId: string): RoomLoadState {
    return this.#entries.get(roomId)?.state ?? 'absent';
  }

  /**
   * The room's current incarnation id.
   *
   * Fresh on create and fresh on every restore, never reused. This is what a
   * host stamps on its envelopes as `SeqCursor.epoch` so a client that was
   * holding seq 500 against the old incarnation gets `epoch-change` and
   * refetches, rather than reading the restored room's lower sequence numbers as
   * an endless stream of duplicates.
   */
  epochOf(roomId: string): string | undefined {
    return this.#entries.get(roomId)?.epoch;
  }

  /**
   * Durable members recovered from the snapshot, for rooms that were restored.
   *
   * NOT in `room.clients` — §4.3. A restored participant has no socket at all,
   * and `clients` is keyed by the ephemeral `clientId`, so there is nothing to
   * key them under. Their seats are still theirs. The host merges these back
   * onto a `ClientMeta` when the participant actually reconnects.
   */
  membersOf(roomId: string): ReadonlyArray<RestoredMember<TClient>> {
    return this.#entries.get(roomId)?.members ?? [];
  }

  /**
   * §4.1. Get the room for `roomId`, loading its snapshot first — as one step.
   *
   * Concurrent callers share the in-flight load and all receive the SAME room
   * object. A second call arriving mid-restore does not create a second room; it
   * waits for the first.
   */
  async loadOrCreate(roomId: string, roomKey: string): Promise<CoreRoomState<TApp, TClient>> {
    const inFlight = this.#loading.get(roomId);
    if (inFlight !== undefined) return inFlight;

    const existing = this.registry.get(roomId);
    if (existing !== undefined && this.loadState(roomId) === 'ready') return existing;

    const work = this.#loadAndCreate(roomId, roomKey);
    this.#loading.set(roomId, work);
    try {
      return await work;
    } finally {
      this.#loading.delete(roomId);
    }
  }

  async #loadAndCreate(roomId: string, roomKey: string): Promise<CoreRoomState<TApp, TClient>> {
    const entry: RoomEntry<TClient> = {
      state: 'restoring',
      epoch: this.#newEpoch(),
      members: [],
      dirty: false,
      dirtySince: 0,
      timer: null,
    };
    this.#entries.set(roomId, entry);

    let snapshot: RoomSnapshot | null;
    try {
      snapshot = await this.store.load(roomId);
    } catch (err) {
      // A record that exists and cannot be read at all. Same treatment as one
      // that decodes badly: set it aside intact, log once, boot as if absent.
      await this.#quarantine(roomId, `load threw: ${String(err)}`);
      snapshot = null;
    }

    const now = this.#clock.now();
    const room = this.registry.seed(roomId, roomKey);
    // `seed` stamps `Date.now()` directly. Restamp from OUR clock so every
    // timestamp the reaper compares comes from one source — otherwise a host
    // running an injected clock has rooms whose ages are nonsense.
    room.createdAt = now;
    room.updatedAt = now;

    if (snapshot !== null) {
      const ctx: RestoreContext = { roomId, restoreId: entry.epoch, restoredAt: now };
      try {
        // Decode FIRST, apply second. Everything that can fail has failed before
        // the room is touched — §4.5's "never half-applied", structurally.
        const decoded = decodeSnapshot(snapshot, this.#codec, ctx);
        applySnapshot(room, decoded, now);
        entry.members = decoded.members;
        this.#onLog({
          level: 'info',
          event: 'room-restored',
          roomId,
          members: decoded.members.length,
          seq: decoded.lastEventSeq,
        });
      } catch (err) {
        const reason =
          err instanceof SnapshotUnreadableError ? `${err.reason}: ${err.message}` : String(err);
        await this.#quarantine(roomId, reason);
        // The room the host gets is the freshly seeded one, untouched by the
        // failed decode. It boots as if the snapshot did not exist.
      }
    }

    entry.state = 'ready';
    return room;
  }

  async #quarantine(roomId: string, reason: string): Promise<void> {
    try {
      await this.store.quarantine(roomId, reason);
    } catch (err) {
      // A store that cannot quarantine must still not resurrect the record, so
      // the boot continues without it — but this is loud, because the bytes are
      // now at risk of being overwritten by the next save.
      this.#onLog({
        level: 'warn',
        event: 'flush-failed',
        roomId,
        reason: `quarantine failed: ${String(err)}`,
      });
    }
    this.#onLog({ level: 'warn', event: 'snapshot-quarantined', roomId, reason });
  }

  /**
   * The room changed. Schedule a write.
   *
   * Debounced by `debounceMs` so a burst of picks is one write, but never more
   * than `maxIntervalMs` behind — a debounce alone can be starved indefinitely
   * by a steady stream of mutations, which is exactly what a draft is.
   */
  markDirty(roomId: string): void {
    const entry = this.#entries.get(roomId);
    if (entry === undefined) return;
    const now = this.#clock.now();
    if (!entry.dirty) {
      entry.dirty = true;
      entry.dirtySince = now;
    }
    if (entry.timer !== null) this.#clock.clearTimer(entry.timer);
    const sinceFirst = now - entry.dirtySince;
    const wait = Math.max(0, Math.min(this.options.debounceMs, this.options.maxIntervalMs - sinceFirst));
    entry.timer = this.#clock.setTimer(() => {
      entry.timer = null;
      void this.save(roomId).catch((err: unknown) => {
        this.#onLog({ level: 'warn', event: 'flush-failed', roomId, reason: String(err) });
      });
    }, wait);
  }

  /** Room ids with unwritten changes. */
  dirtyRooms(): string[] {
    const out: string[] = [];
    for (const [roomId, entry] of this.#entries) if (entry.dirty) out.push(roomId);
    return out.sort();
  }

  /**
   * Write a room now.
   *
   * §4.1: refused unless the room's load state is `ready`. A `restoring` room's
   * snapshot has not been read yet, and writing over it is how a 45-minute draft
   * becomes an empty room.
   */
  async save(roomId: string): Promise<void> {
    const snapshot = this.#prepareSave(roomId);
    if (snapshot === null) return;
    await this.store.save(snapshot);
  }

  /** The synchronous half of `save`, for the exit path. §4.4. */
  saveSync(roomId: string): void {
    const snapshot = this.#prepareSave(roomId);
    if (snapshot === null) return;
    if (this.store.saveSync === undefined) {
      throw new Error(`store has no saveSync; cannot flush room ${roomId} synchronously`);
    }
    this.store.saveSync(snapshot);
  }

  #prepareSave(roomId: string) {
    const state = this.loadState(roomId);
    if (state !== 'ready') throw new SaveBeforeLoadError(roomId, state);
    const room = this.registry.get(roomId);
    if (room === undefined) return null;
    const entry = this.#entries.get(roomId);
    if (entry !== undefined) {
      entry.dirty = false;
      if (entry.timer !== null) {
        this.#clock.clearTimer(entry.timer);
        entry.timer = null;
      }
    }
    return snapshotRoom(room, this.#codec);
  }

  /**
   * §4.6. Destroy a room and REMOVE its snapshot.
   *
   * Both halves, always together. A reaper that destroys the room object without
   * calling `remove()` fills the store with dead rooms, and the next boot
   * faithfully resurrects every one of them.
   */
  async destroy(roomId: string): Promise<void> {
    const entry = this.#entries.get(roomId);
    if (entry?.timer != null) this.#clock.clearTimer(entry.timer);
    this.#entries.delete(roomId);
    this.registry.delete(roomId);
    await this.store.remove(roomId);
  }

  /** Write every dirty room. Returns the ids written. */
  async flushAll(): Promise<string[]> {
    const written: string[] = [];
    for (const roomId of this.dirtyRooms()) {
      try {
        await this.save(roomId);
        written.push(roomId);
      } catch (err) {
        this.#onLog({ level: 'warn', event: 'flush-failed', roomId, reason: String(err) });
      }
    }
    return written;
  }

  /** The synchronous flush the signal handler runs. §4.4. */
  flushAllSync(): string[] {
    const written: string[] = [];
    for (const roomId of this.dirtyRooms()) {
      try {
        this.saveSync(roomId);
        written.push(roomId);
      } catch (err) {
        this.#onLog({ level: 'warn', event: 'flush-failed', roomId, reason: String(err) });
      }
    }
    return written;
  }

  /**
   * §4.4. Flush every dirty room, bounded by a deadline.
   *
   * Prefers the synchronous path when the store has one, because a signal
   * handler that awaits a promise races the process exit — the event loop may
   * never get another turn. The async path exists for a tier that cannot write
   * synchronously (a Redis one), and it is the deadline that makes it safe: a
   * deploy that hangs forever waiting for a flush is a worse outage than a deploy
   * that loses `debounceMs` of state.
   */
  async shutdown(): Promise<string[]> {
    if (this.store.saveSync !== undefined) return this.flushAllSync();
    const deadline = new Promise<string[]>((resolve) => {
      this.#clock.setTimer(() => resolve([]), this.options.flushDeadlineMs);
    });
    return Promise.race([this.flushAll(), deadline]);
  }

  /**
   * Wire `SIGTERM`/`SIGINT` to the flush. §4.4's motivating event is a deploy.
   *
   * Returns the uninstaller. The handler does NOT call `process.exit` — it
   * flushes and re-raises the default disposition, so a host with its own
   * shutdown sequence keeps it and a host with none still exits.
   */
  installSignalHandlers(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): () => void {
    if (!this.options.flushOnSignal) return () => {};
    const uninstall: Array<() => void> = [];
    for (const signal of signals) {
      const handler = () => {
        this.flushAllSync();
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      };
      process.on(signal, handler);
      uninstall.push(() => process.removeListener(signal, handler));
    }
    return () => {
      for (const off of uninstall) off();
    };
  }
}
