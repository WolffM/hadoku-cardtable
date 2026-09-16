/*
 * The file tier.
 *
 * One JSON file per room in a directory, written atomically, with a
 * `quarantine/` subdirectory for records this build cannot read.
 *
 * ## Room ids are base64url, not the room id
 *
 * A room id arrives from a join payload. `<dir>/<roomId>.json` with a roomId of
 * `../../.ssh/authorized_keys` writes outside the directory, and a roomId of
 * `CON` or one containing `:` is unwriteable on some filesystems and fine on
 * others — which is the worst kind of bug, because it only appears in
 * production. base64url of the id removes the whole class: the alphabet is
 * `A-Za-z0-9-_`, it is reversible so `list()` still returns real room ids, and
 * it cannot contain a separator or a dot.
 *
 * ## Writes are atomic
 *
 * Write a temp file, `fsync` it, rename over the target. A rename within a
 * directory is atomic on POSIX, so a reader never sees half a snapshot and a
 * crash mid-write leaves the previous snapshot intact rather than a truncated
 * file. Without it, the failure mode is precisely the one §4.5 is about: a file
 * that parses far enough to look plausible.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RoomSnapshot } from './snapshot.ts';
import type { RoomStore } from './store.ts';

const SUFFIX = '.json';
const QUARANTINE_DIR = 'quarantine';

function keyFor(roomId: string): string {
  return Buffer.from(roomId, 'utf8').toString('base64url');
}

function roomIdFor(key: string): string {
  return Buffer.from(key, 'base64url').toString('utf8');
}

export interface FileRoomStoreOptions {
  /**
   * Overrides the clock used to name quarantine files. Only there so a test can
   * make the name deterministic; the store itself has no other use for time.
   */
  now?: () => number;
}

export class FileRoomStore implements RoomStore {
  readonly dir: string;
  readonly quarantineDir: string;
  #now: () => number;

  constructor(dir: string, opts: FileRoomStoreOptions = {}) {
    this.dir = dir;
    this.quarantineDir = join(dir, QUARANTINE_DIR);
    this.#now = opts.now ?? (() => Date.now());
    mkdirSync(this.dir, { recursive: true });
  }

  #path(roomId: string): string {
    return join(this.dir, keyFor(roomId) + SUFFIX);
  }

  /**
   * Read a snapshot, or null when there is none.
   *
   * THROWS on a file that exists and does not parse. Deliberately: returning
   * null there would make an unreadable snapshot indistinguishable from a room
   * that was never persisted, and the room would boot empty and then be
   * overwritten by the next debounced save — losing the bytes that a human could
   * still have recovered something from. The caller catches and quarantines.
   */
  async load(roomId: string): Promise<RoomSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.#path(roomId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(text) as RoomSnapshot;
  }

  async save(snapshot: RoomSnapshot): Promise<void> {
    this.saveSync(snapshot);
  }

  saveSync(snapshot: RoomSnapshot): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.#path(snapshot.roomId);
    const tmp = `${target}.${process.pid}.${this.#now()}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(snapshot));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }

  async remove(roomId: string): Promise<void> {
    await rm(this.#path(roomId), { force: true });
  }

  removeSync(roomId: string): void {
    rmSync(this.#path(roomId), { force: true });
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((n) => n.endsWith(SUFFIX) && !n.endsWith('.tmp'))
      .map((n) => roomIdFor(n.slice(0, -SUFFIX.length)))
      .sort();
  }

  /**
   * Move the record aside by RENAME, so the bytes are preserved exactly.
   *
   * Not "read, re-serialise, write elsewhere": the thing being set aside is by
   * definition something this build could not parse, so anything that goes
   * through a parser would lose whatever a human might still recover. A rename
   * also makes the room invisible to the next `load` in the same operation,
   * rather than leaving a window where it boots twice.
   */
  async quarantine(roomId: string, reason: string): Promise<void> {
    const source = this.#path(roomId);
    if (!existsSync(source)) return;
    await mkdir(this.quarantineDir, { recursive: true });
    const name = `${keyFor(roomId)}.${this.#now()}${SUFFIX}`;
    await rename(source, join(this.quarantineDir, name));
    await writeFile(join(this.quarantineDir, `${name}.reason.txt`), `${reason}\n`, 'utf8');
  }

  async listQuarantined(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.quarantineDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((n) => n.endsWith(SUFFIX)).sort();
  }

  /** The raw bytes of a quarantined record, exactly as they were set aside. */
  readQuarantined(name: string): string {
    return readFileSync(join(this.quarantineDir, name), 'utf8');
  }

  /** Every room id this store holds, read synchronously. For the exit flush. */
  listSync(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.endsWith(SUFFIX) && !n.endsWith('.tmp'))
      .map((n) => roomIdFor(n.slice(0, -SUFFIX.length)))
      .sort();
  }
}
