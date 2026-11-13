import { describe, expect, it, vi } from 'vitest';

import type { Look } from '@hadoku/platform-wire/look';

import { attachPeople, createPeople, personOf, type PeopleRooms } from './people.js';

const DISCORD = 'https://cdn.discordapp.com/avatars/1/abc.png';

/** prefs-api's `_avatar/resolve`, answering from `table`, counting what it was asked. */
function prefsApi(table: Record<string, unknown>) {
	const asked: string[][] = [];
	let down = false;
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		if (down) throw new Error('connect ECONNREFUSED');
		const { userIds } = JSON.parse(String(init?.body)) as { userIds: string[] };
		asked.push(userIds);
		const avatars = Object.fromEntries(userIds.map((id) => [id, table[id] ?? { source: 'sprite', name: null }]));
		return new Response(JSON.stringify({ avatars }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	};
	return {
		fetch,
		asked,
		goDown: () => {
			down = true;
		},
	};
}

describe('personOf', () => {
	it('carries a picture, what is worn and the name', () => {
		expect(personOf({ source: 'discord', url: DISCORD, sprite: 'sage', name: 'Ari', cosmetics: { effect: 'effect.glint', overlay: 'overlay.halo' } })).toEqual({
			name: 'Ari',
			sprite: 'sage',
			look: { picture: DISCORD, cosmetics: { effect: 'effect.glint', overlay: 'overlay.halo' } },
		});
	});

	it('draws the character when the picture is the character, or is not https', () => {
		expect(personOf({ source: 'sprite', url: DISCORD, name: 'Ari' }).look).toBeUndefined();
		expect(personOf({ source: 'upload', url: 'http://cdn.hadoku.me/a.png', name: 'Ari' }).look).toBeUndefined();
	});

	it('drops an item the catalogue does not know, and an unknown person has no name', () => {
		expect(personOf({ source: 'sprite', name: null, cosmetics: { overlay: 'overlay.not-a-thing' } })).toEqual({ name: null, sprite: null, look: undefined });
		expect(personOf(undefined)).toEqual({ name: null, sprite: null, look: undefined });
	});
});

describe('createPeople', () => {
	it('asks once for a burst, then answers from the cache until a fresh read is wanted', async () => {
		const api = prefsApi({ u1: { source: 'upload', url: DISCORD, name: 'Ari' } });
		const people = createPeople({ baseUrl: 'https://prefs.test/', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const [a, b] = await Promise.all([people.resolve(['u1', 'u2']), people.resolve(['u1'])]);
		expect(a.get('u1')?.look).toEqual({ picture: DISCORD });
		expect(a.get('u2')).toEqual({ name: null, sprite: null, look: undefined });
		expect(b.get('u1')?.name).toBe('Ari');
		expect(api.asked).toEqual([['u1', 'u2']]);
		await people.resolve(['u1'], { fresh: true });
		expect(api.asked).toEqual([['u1', 'u2'], ['u1']]);
	});

	it('expires after a minute', async () => {
		let now = 0;
		const api = prefsApi({});
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch, now: () => now });
		await people.resolve(['u1']);
		now = 59_000;
		await people.resolve(['u1']);
		now = 61_000;
		await people.resolve(['u1']);
		expect(api.asked).toHaveLength(2);
	});

	it('an outage answers nobody, is logged, and is not cached', async () => {
		const logged: Record<string, unknown>[] = [];
		const api = prefsApi({ u1: { source: 'upload', url: DISCORD, name: 'Ari' } });
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: (e) => logged.push(e), fetch: api.fetch });
		api.goDown();
		expect((await people.resolve(['u1'])).size).toBe(0);
		expect(logged).toEqual([expect.objectContaining({ evt: 'people-resolve-failed', ids: 1 })]);
		expect(people.peek('u1')).toBeUndefined();
	});

	it('without a key it calls nothing', async () => {
		const api = prefsApi({});
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: '', log: () => undefined, fetch: api.fetch });
		expect((await people.resolve(['u1'])).size).toBe(0);
		expect(api.asked).toEqual([]);
	});
});

/** A room registry with one room, recording what was set on it. */
function oneRoom(members: { id: string; userId: string | null; name: string }[]) {
	const listeners: ((roomId: string) => void)[] = [];
	const looks = new Map<string, Look | undefined>();
	const avatars = new Map<string, string | null>();
	const renamed: { id: string; name: string }[] = [];
	const rooms: PeopleRooms = {
		onChange: (l) => {
			listeners.push(l);
			return () => undefined;
		},
		offered: () => [{ id: 'r-1' }],
		get: (id) => (id === 'r-1' ? { members } : undefined),
		usersOf: (id) => (id === 'r-1' ? members.flatMap((m) => (m.userId === null ? [] : [{ memberId: m.id, userId: m.userId }])) : []),
		setLook: (_roomId, memberId, look) => {
			looks.set(memberId, look);
			return true;
		},
		setAvatar: (_roomId, memberId, avatarId) => {
			avatars.set(memberId, avatarId);
			return true;
		},
		rename: (caller) => renamed.push(caller),
	};
	return { rooms, looks, avatars, renamed, change: () => listeners.forEach((l) => l('r-1')) };
}

describe('attachPeople', () => {
	it('writes each member’s account onto the room when it changes: name, character and look', async () => {
		const api = prefsApi({
			u1: { source: 'discord', url: DISCORD, name: 'Ari', sprite: 'wanderer', cosmetics: { overlay: 'overlay.halo' } },
			u2: { source: 'sprite', name: 'Bo' },
		});
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const room = oneRoom([
			{ id: 'fk:1', userId: 'u1', name: 'friend' },
			{ id: 'fk:2', userId: 'u2', name: 'friend' },
			{ id: 'eph:3', userId: null, name: 'friend' },
		]);
		const stop = attachPeople(room.rooms, people).stop;
		room.change();
		await vi.waitFor(() => expect(room.looks.has('fk:2')).toBe(true));
		stop();
		expect(room.looks.get('fk:1')).toEqual({ picture: DISCORD, cosmetics: { overlay: 'overlay.halo' } });
		expect(room.looks.get('fk:2')).toBeUndefined();
		expect(room.looks.has('eph:3')).toBe(false);
		expect(room.renamed).toEqual([
			{ id: 'fk:1', name: 'Ari' },
			{ id: 'fk:2', name: 'Bo' },
		]);
		expect([...room.avatars]).toEqual([['fk:1', 'wanderer']]);
	});

	it('a person coming into a room is read fresh, past an answer the cache still holds', async () => {
		const table: Record<string, unknown> = { u1: { source: 'sprite', name: 'Ari' } };
		const api = prefsApi(table);
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const room = oneRoom([{ id: 'fk:1', userId: 'u1', name: 'friend' }]);
		const { arrived, stop } = attachPeople(room.rooms, people);
		await people.resolve(['u1']);
		table.u1 = { source: 'sprite', name: 'Ari', sprite: 'rogue' };
		await arrived('r-1', 'fk:1', 'u1');
		stop();
		expect([...room.avatars]).toEqual([['fk:1', 'rogue']]);
	});

	it('the boot’s sweep names every open room’s members in one batch, and an account the lookup cannot name keeps its name', async () => {
		const api = prefsApi({ u1: { source: 'sprite', name: 'Ari' } });
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const room = oneRoom([
			{ id: 'fk:1', userId: 'u1', name: 'friend' },
			{ id: 'fk:2', userId: 'u2', name: 'Bo' },
		]);
		const { sweep, stop } = attachPeople(room.rooms, people);
		await sweep();
		stop();
		expect(api.asked).toEqual([['u1', 'u2']]);
		expect(room.renamed).toEqual([{ id: 'fk:1', name: 'Ari' }]);
	});
});
