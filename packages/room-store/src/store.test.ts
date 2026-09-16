/*
 * The two tiers, against the same contract.
 *
 * `MemoryRoomStore` is the default and `FileRoomStore` is the one that survives
 * a deploy, and the point of the interface is that swapping them changes
 * nothing. Most of what follows is therefore run against both.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRoomStore } from './fileStore.ts';
import { MemoryRoomStore, type RoomStore } from './store.ts';
import { STORE_VERSION, type RoomSnapshot } from './snapshot.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function snap(roomId: string, seq = 1): RoomSnapshot {
  return {
    storeVersion: STORE_VERSION,
    roomId,
    roomKey: `${roomId}-key`,
    lastEventSeq: seq,
    createdAt: 1,
    updatedAt: 2,
    members: [],
    usedAvatars: [],
    clientNames: {},
    seats: { capacity: null, seats: [], remembered: {}, reservations: {}, reservationTtlMs: 0 },
    app: { picks: ['Sol Ring'] },
    appVersion: 1,
  };
}

const tiers: Array<[string, () => RoomStore]> = [
  ['MemoryRoomStore', () => new MemoryRoomStore()],
  ['FileRoomStore', () => new FileRoomStore(tempDir())],
];

describe.each(tiers)('%s — the shared contract', (_name, make) => {
  it('round-trips, lists and removes', async () => {
    const store = make();
    expect(await store.load('r1')).toBeNull();
    expect(await store.list()).toEqual([]);

    await store.save(snap('r1', 7));
    await store.save(snap('r2', 9));
    expect(await store.list()).toEqual(['r1', 'r2']);
    expect((await store.load('r1'))?.lastEventSeq).toBe(7);

    await store.remove('r1');
    expect(await store.load('r1')).toBeNull();
    expect(await store.list()).toEqual(['r2']);
    // Removing something that is not there is not an error.
    await expect(store.remove('r1')).resolves.toBeUndefined();
  });

  it('overwrites rather than accumulating', async () => {
    const store = make();
    await store.save(snap('r1', 1));
    await store.save(snap('r1', 2));
    expect(await store.list()).toEqual(['r1']);
    expect((await store.load('r1'))?.lastEventSeq).toBe(2);
  });

  it('hands back a copy, so a caller cannot reach into what was written', async () => {
    const store = make();
    const written = snap('r1');
    await store.save(written);
    (written.app as { picks: string[] }).picks.push('mutated after save');

    const back = await store.load('r1');
    expect((back?.app as { picks: string[] }).picks).toEqual(['Sol Ring']);
    // ...and the other direction too.
    (back?.app as { picks: string[] }).picks.push('mutated after load');
    expect(((await store.load('r1'))?.app as { picks: string[] }).picks).toEqual(['Sol Ring']);
  });

  it('quarantines: the record leaves the live path and gains a distinct key', async () => {
    const store = make();
    await store.save(snap('r1', 5));
    expect(await store.listQuarantined()).toEqual([]);

    await store.quarantine('r1', 'store-version: have 1, found 2');
    expect(await store.load('r1')).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.listQuarantined()).toHaveLength(1);
    // Quarantining nothing is a no-op, not a crash.
    await expect(store.quarantine('r1', 'again')).resolves.toBeUndefined();
    expect(await store.listQuarantined()).toHaveLength(1);
  });

  it('has a synchronous write for the exit flush', async () => {
    const store = make();
    expect(typeof store.saveSync).toBe('function');
    store.saveSync?.(snap('r1', 11));
    expect((await store.load('r1'))?.lastEventSeq).toBe(11);
  });
});

describe('FileRoomStore — the parts that are about files', () => {
  it('never writes outside its directory, whatever the room id is', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    const nasty = '../../../etc/room-store-should-never-write-this';
    await store.save(snap(nasty));

    const written = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(written).toHaveLength(1);
    // base64url only: no dot, no slash, nothing a path separator could hide in.
    expect(written[0]?.slice(0, -'.json'.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolve(dir, written[0] as string).startsWith(resolve(dir))).toBe(true);
    expect(existsSync(resolve(dir, '../../../etc/room-store-should-never-write-this.json'))).toBe(
      false,
    );
    // ...and the id survives the round trip intact.
    expect(await store.list()).toEqual([nasty]);
    expect((await store.load(nasty))?.roomId).toBe(nasty);
  });

  it('handles a room id with colons, spaces and unicode', async () => {
    const store = new FileRoomStore(tempDir());
    const ids = ['fk:alice/room', 'pod one', 'ポッド-3', 'CON'];
    for (const id of ids) await store.save(snap(id));
    expect(await store.list()).toEqual([...ids].sort());
    for (const id of ids) expect((await store.load(id))?.roomId).toBe(id);
  });

  it('leaves no temp files behind, and the written file is valid JSON', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    await store.save(snap('r1'));
    store.saveSync(snap('r1', 2));
    const names = readdirSync(dir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(join(dir, names[0] as string), 'utf8')) as RoomSnapshot;
    expect(parsed.lastEventSeq).toBe(2);
  });

  it('throws on a file that exists and does not parse, rather than reading it as absent', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    await store.save(snap('r1'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, readdirSync(dir)[0] as string), 'not json at all', 'utf8');
    // Returning null here would make an unreadable snapshot look like a room
    // that was never persisted — and the next save would overwrite it.
    await expect(store.load('r1')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('preserves quarantined bytes exactly, and records why', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    await store.save(snap('r1', 3));
    const before = readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8');

    await store.quarantine('r1', 'codec: app blob is corrupt');
    const keys = await store.listQuarantined();
    expect(keys).toHaveLength(1);
    expect(store.readQuarantined(keys[0] as string)).toBe(before);
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([]);
    expect(
      readFileSync(join(store.quarantineDir, `${keys[0] as string}.reason.txt`), 'utf8'),
    ).toContain('codec');
  });

  it('creates its directory, and an empty or missing one lists as empty', async () => {
    const parent = tempDir();
    const nested = join(parent, 'a', 'b', 'rooms');
    const store = new FileRoomStore(nested);
    expect(existsSync(nested)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.listQuarantined()).toEqual([]);
    expect(store.listSync()).toEqual([]);
  });

  it('the quarantine subdirectory is not mistaken for a room', async () => {
    const dir = tempDir();
    const store = new FileRoomStore(dir);
    await store.save(snap('r1'));
    await store.save(snap('r2'));
    await store.quarantine('r1', 'why');
    expect(await store.list()).toEqual(['r2']);
    expect(store.listSync()).toEqual(['r2']);
  });
});
