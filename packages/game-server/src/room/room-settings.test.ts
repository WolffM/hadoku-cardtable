/**
 * A plain room's settings (`plainRoomType`'s `settings`, `RoomLobby.setSettings`): declared by the
 * game, kept in the room file, read back on a restart, changed by the leader alone and refused under
 * a lock that holds. A real `RoomLobby` over a real store.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileRoomStore } from '@wolffm/rooms-server/store';
import { LIVE, choice, defineRoomSettings, toggle } from '@hadoku/platform-wire/room-settings';

import { MATCH_LIVE, RoomLobby, plainRoomType, type PlainRoomView, type PlatformRoomView, type RoomCreateInput, type RoomTypeHooks } from './lobby.ts';

const PLAIN = 'plain';
type View = PlatformRoomView & PlainRoomView;

const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'alice', userId: 'uid-alice' };
const BOB = { id: 'fk:bbbbbbbbbbbbbbbb', name: 'bob', userId: 'uid-bob' };

// bomberman's, the first relay game to declare any, plus a field with no lock.
const SETTINGS = defineRoomSettings({
	mode: choice(['classic', 'roguelike', 'sandbox'], 'classic', { label: 'Mode', lock: LIVE }),
	pickTimer: toggle(true, { label: 'Pick timer', lock: LIVE }),
	music: toggle(false, { label: 'Music' }),
});

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A lobby over `dir` whose rooms are live while `live` says so. `declare: false` is a game that declares none. */
async function lobbyOver(dir: string, opts: { live?: () => boolean; declare?: boolean; log?: (e: Record<string, unknown>) => void } = {}): Promise<RoomLobby<View, RoomCreateInput>> {
	const settings = opts.declare === false ? undefined : { spec: SETTINGS, locked: (_room: unknown, lock: string) => (lock === LIVE && opts.live?.() === true ? MATCH_LIVE : null) };
	const type = plainRoomType<RoomCreateInput>({ seats: 2, max: 4, ...(settings === undefined ? {} : { settings }) }) as unknown as RoomTypeHooks<unknown, RoomCreateInput>;
	const lobby = new RoomLobby<View, RoomCreateInput>({
		store: new FileRoomStore(dir),
		now: () => 1_800_000_000_000,
		log: opts.log ?? (() => {}),
		typeOf: (t) => (t === PLAIN ? type : undefined),
		watchpartyRoom: { name: 'Plain', gameType: PLAIN },
	});
	await lobby.open();
	return lobby;
}

/** The store's own file name for a room: its id in base64url (`FileRoomStore`). */
const fileOf = (dir: string, id: string): string => join(dir, `${Buffer.from(id, 'utf8').toString('base64url')}.json`);

async function freshDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'game-server-settings-'));
	dirs.push(dir);
	return dir;
}

async function roomIn(dir: string, opts: Parameters<typeof lobbyOver>[1] = {}): Promise<{ lobby: RoomLobby<View, RoomCreateInput>; id: string }> {
	const lobby = await lobbyOver(dir, opts);
	const made = lobby.create(ALICE, { name: 'Plain night', gameType: PLAIN });
	if (!made.ok) throw new Error(made.reason);
	lobby.join(made.room.id, BOB);
	return { lobby, id: made.room.id };
}

describe('a plain room’s settings', () => {
	it('a new room shows every field at its default', async () => {
		const { lobby, id } = await roomIn(await freshDir());
		expect(lobby.get(id)!.settings).toEqual({ mode: 'classic', pickTimer: true, music: false });
	});

	it('the leader changes some; the rest stay, and the room file keeps them across a restart', async () => {
		const dir = await freshDir();
		const logged: Record<string, unknown>[] = [];
		const { lobby, id } = await roomIn(dir, { log: (e) => logged.push(e) });
		const changed = lobby.setSettings(id, ALICE.id, { mode: 'sandbox' });
		expect(changed.ok && changed.room.settings).toEqual({ mode: 'sandbox', pickTimer: true, music: false });
		expect(logged.filter((e) => e.event === 'room-settings')).toEqual([{ event: 'room-settings', roomId: id, settings: { mode: 'sandbox', pickTimer: true, music: false } }]);
		const file = JSON.parse(await readFile(fileOf(dir, id), 'utf8')) as { app: { game: unknown } };
		expect(file.app.game).toEqual({ settings: { mode: 'sandbox', pickTimer: true, music: false } });
		const again = await lobbyOver(dir);
		expect(again.get(id)!.settings).toEqual({ mode: 'sandbox', pickTimer: true, music: false });
	});

	it('a value that does not move writes nothing', async () => {
		const logged: Record<string, unknown>[] = [];
		const { lobby, id } = await roomIn(await freshDir(), { log: (e) => logged.push(e) });
		expect(lobby.setSettings(id, ALICE.id, { mode: 'classic' }).ok).toBe(true);
		expect(logged.some((e) => e.event === 'room-settings')).toBe(false);
	});

	it('only the leader changes them, and no such room is no such room', async () => {
		const { lobby, id } = await roomIn(await freshDir());
		expect(lobby.setSettings(id, BOB.id, { mode: 'sandbox' })).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setSettings('r-000000000000', ALICE.id, { mode: 'sandbox' })).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.get(id)!.settings!.mode).toBe('classic');
	});

	it('a LIVE field waits for the lobby; a field with no lock does not', async () => {
		let live = true;
		const { lobby, id } = await roomIn(await freshDir(), { live: () => live });
		expect(lobby.setSettings(id, ALICE.id, { mode: 'sandbox' })).toEqual({ ok: false, reason: MATCH_LIVE });
		expect(lobby.setSettings(id, ALICE.id, { music: true, pickTimer: false })).toEqual({ ok: false, reason: MATCH_LIVE });
		expect(lobby.setSettings(id, ALICE.id, { music: true }).ok).toBe(true);
		live = false;
		expect(lobby.setSettings(id, ALICE.id, { mode: 'sandbox' }).ok).toBe(true);
		expect(lobby.get(id)!.settings).toEqual({ mode: 'sandbox', pickTimer: true, music: true });
	});

	it('a room of a game that declares none has no settings to change', async () => {
		const { lobby, id } = await roomIn(await freshDir(), { declare: false });
		expect(lobby.get(id)!.settings).toBeUndefined();
		expect(lobby.setSettings(id, ALICE.id, { mode: 'sandbox' })).toEqual({ ok: false, reason: 'no-settings' });
	});
});

describe('a plain room file', () => {
	/** A room written by a build before its game declared settings: an empty game part. */
	async function withGamePart(game: unknown): Promise<{ dir: string; id: string }> {
		const dir = await freshDir();
		const { id } = await roomIn(dir, { declare: false });
		const file = JSON.parse(await readFile(fileOf(dir, id), 'utf8')) as { app: { game: unknown } };
		expect(file.app.game).toEqual({});
		file.app.game = game;
		await writeFile(fileOf(dir, id), JSON.stringify(file));
		return { dir, id };
	}

	it('from before the game declared settings reads back on the defaults', async () => {
		const { dir, id } = await withGamePart({});
		expect((await lobbyOver(dir)).get(id)!.settings).toEqual(SETTINGS.defaults());
	});

	it('missing a field reads it on its default', async () => {
		const { dir, id } = await withGamePart({ settings: { mode: 'roguelike' } });
		expect((await lobbyOver(dir)).get(id)!.settings).toEqual({ mode: 'roguelike', pickTimer: true, music: false });
	});

	it.each([[{ settings: { mode: 'chess' } }], [{ settings: { lives: 3 } }], [{ settings: 'classic' }]])('holding settings the game never declared (%j) is quarantined, not half-read', async (game) => {
		const { dir, id } = await withGamePart(game);
		const logged: Record<string, unknown>[] = [];
		const lobby = await lobbyOver(dir, { log: (e) => logged.push(e) });
		expect(lobby.get(id)).toBeUndefined();
		expect(logged).toContainEqual({ event: 'room-quarantined', roomId: id, reason: expect.stringContaining('app.game.settings is invalid') });
	});
});
