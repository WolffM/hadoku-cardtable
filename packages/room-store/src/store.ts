/*
 * The store interface and its in-memory tier.
 *
 * Shaped after watchparty's own `chatRepo` pattern — an interface with a memory
 * tier, a file tier and room for a Redis tier behind it, chosen by config, with
 * the memory tier as the always-present base. **Nothing in the interface names a
 * backend**, which is the property that makes a third tier someone else's twenty
 * lines rather than a change here.
 *
 * In-memory is the default, so a host that does not opt in gets exactly what it
 * had: no filesystem, no network, no behaviour change.
 */

import type { RoomSnapshot } from './snapshot.ts';

export interface RoomStore {
  load(roomId: string): Promise<RoomSnapshot | null>;
  save(snapshot: RoomSnapshot): Promise<void>;
  remove(roomId: string): Promise<void>;
  /** Room ids known to the store, for an eager restore at boot. */
  list(): Promise<string[]>;
  /**
   * Set a room's record aside INTACT under a distinct key, and make `load`
   * behave as if it were not there. §4.5.
   *
   * On the interface rather than bolted on per tier, because a tier that cannot
   * quarantine cannot implement the one rule that keeps a half-read snapshot
   * from being applied — and that is the rule the whole store is refused over.
   */
  quarantine(roomId: string, reason: string): Promise<void>;
  /** Quarantine keys. Diagnostic; the boot path never reads them. */
  listQuarantined(): Promise<string[]>;
  /**
   * Optional synchronous write, used by the SIGTERM flush (§4.4).
   *
   * A signal handler that awaits a promise races the process exit. A tier that
   * can write synchronously says so here; the flush falls back to the async path
   * under a deadline for one that cannot.
   */
  saveSync?(snapshot: RoomSnapshot): void;
}

function clone(snapshot: RoomSnapshot): RoomSnapshot {
  return structuredClone(snapshot);
}

/**
 * The default tier. Survives nothing, which is the point: it changes no
 * behaviour for a host that never asked for persistence, while still exercising
 * every code path a real tier does — so the load-or-create logic, the debounce
 * and the quarantine are not untested in the default configuration.
 *
 * Stores clones, so a caller mutating a room after `save` cannot reach into what
 * was written. A file tier gets that for free from serialisation; the memory
 * tier has to do it on purpose, and a memory tier that aliased would make the
 * two tiers behave differently under exactly the debounce this package exists
 * to make safe.
 */
export class MemoryRoomStore implements RoomStore {
  #rooms = new Map<string, RoomSnapshot>();
  #quarantined = new Map<string, { snapshot: RoomSnapshot; reason: string }>();

  async load(roomId: string): Promise<RoomSnapshot | null> {
    const found = this.#rooms.get(roomId);
    return found ? clone(found) : null;
  }

  async save(snapshot: RoomSnapshot): Promise<void> {
    this.saveSync(snapshot);
  }

  saveSync(snapshot: RoomSnapshot): void {
    this.#rooms.set(snapshot.roomId, clone(snapshot));
  }

  async remove(roomId: string): Promise<void> {
    this.#rooms.delete(roomId);
  }

  async list(): Promise<string[]> {
    return [...this.#rooms.keys()].sort();
  }

  async quarantine(roomId: string, reason: string): Promise<void> {
    const found = this.#rooms.get(roomId);
    if (found === undefined) return;
    this.#rooms.delete(roomId);
    this.#quarantined.set(`${roomId}#${this.#quarantined.size}`, { snapshot: found, reason });
  }

  async listQuarantined(): Promise<string[]> {
    return [...this.#quarantined.keys()].sort();
  }

  /** The record set aside under `key`, exactly as it was stored. */
  quarantinedRecord(key: string): { snapshot: RoomSnapshot; reason: string } | undefined {
    return this.#quarantined.get(key);
  }
}
