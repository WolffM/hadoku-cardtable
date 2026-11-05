import { describe, expect, it, vi } from 'vitest';

import type { Look } from '@hadoku/shared';

import { attachLooks, createPeople, personOf, type LookRooms } from './people.js';

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
			look: { picture: DISCORD, cosmetics: { effect: 'effect.glint', overlay: 'overlay.halo' } },
		});
	});

	it('draws the character when the picture is the character, or is not https', () => {
		expect(personOf({ source: 'sprite', url: DISCORD, name: 'Ari' }).look).toBeUndefined();
		expect(personOf({ source: 'upload', url: 'http://cdn.hadoku.me/a.png', name: 'Ari' }).look).toBeUndefined();
	});

	it('drops an item the catalogue does not know, and an unknown person has no name', () => {
		expect(personOf({ source: 'sprite', name: null, cosmetics: { overlay: 'overlay.not-a-thing' } })).toEqual({ name: null, look: undefined });
		expect(personOf(undefined)).toEqual({ name: null, look: undefined });
	});
});

describe('createPeople', () => {
	it('asks once for a burst, then answers from the cache until a fresh read is wanted', async () => {
		const api = prefsApi({ u1: { source: 'upload', url: DISCORD, name: 'Ari' } });
		const people = createPeople({ baseUrl: 'https://prefs.test/', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const [a, b] = await Promise.all([people.resolve(['u1', 'u2']), people.resolve(['u1'])]);
		expect(a.get('u1')?.look).toEqual({ picture: DISCORD });
		expect(a.get('u2')).toEqual({ name: null, look: undefined });
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
	const renamed: { id: string; name: string }[] = [];
	const rooms: LookRooms = {
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
		rename: (caller) => renamed.push(caller),
	};
	return { rooms, looks, renamed, change: () => listeners.forEach((l) => l('r-1')) };
}

describe('attachLooks', () => {
	it('sets each member’s look when their room changes, and names a member a restart left unnamed', async () => {
		const api = prefsApi({
			u1: { source: 'discord', url: DISCORD, name: 'Ari', cosmetics: { overlay: 'overlay.halo' } },
			u2: { source: 'sprite', name: 'Bo' },
		});
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const room = oneRoom([
			{ id: 'fk:1', userId: 'u1', name: 'friend' },
			{ id: 'fk:2', userId: 'u2', name: 'Bo' },
			{ id: 'eph:3', userId: null, name: 'friend' },
		]);
		const looks = attachLooks(room.rooms, people, 'friend');
		room.change();
		await vi.waitFor(() => expect(room.looks.has('fk:2')).toBe(true));
		looks.stop();
		expect(room.looks.get('fk:1')).toEqual({ picture: DISCORD, cosmetics: { overlay: 'overlay.halo' } });
		expect(room.looks.get('fk:2')).toBeUndefined();
		expect(room.looks.has('eph:3')).toBe(false);
		expect(room.renamed).toEqual([{ id: 'fk:1', name: 'Ari' }]);
	});

	it('a refresh reads the one member again, past the cache', async () => {
		const api = prefsApi({ u1: { source: 'sprite', name: 'Ari' } });
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch });
		const room = oneRoom([
			{ id: 'fk:1', userId: 'u1', name: 'Ari' },
			{ id: 'fk:2', userId: 'u2', name: 'Bo' },
		]);
		const looks = attachLooks(room.rooms, people, 'friend');
		await people.resolve(['u1', 'u2']);
		await looks.refresh('r-1', 'fk:1');
		expect(api.asked).toEqual([['u1', 'u2'], ['u1']]);
		looks.stop();
	});

	it('every minute, reads every open room again in one batch, so a change made away from the room reaches it', async () => {
		let now = 0;
		const table: Record<string, unknown> = { u1: { source: 'sprite', name: 'Ari' } };
		const api = prefsApi(table);
		const people = createPeople({ baseUrl: 'https://prefs.test', serviceKey: 'k', log: () => undefined, fetch: api.fetch, now: () => now });
		const room = oneRoom([
			{ id: 'fk:1', userId: 'u1', name: 'Ari' },
			{ id: 'fk:2', userId: 'u2', name: 'Bo' },
		]);
		const looks = attachLooks(room.rooms, people, 'friend');
		await looks.sweep();
		expect(room.looks.get('fk:1')).toBeUndefined();
		table.u1 = { source: 'upload', url: DISCORD, name: 'Ari', cosmetics: { effect: 'effect.aura' } };
		now = 61_000;
		await looks.sweep();
		expect(room.looks.get('fk:1')).toEqual({ picture: DISCORD, cosmetics: { effect: 'effect.aura' } });
		expect(api.asked).toEqual([['u1', 'u2'], ['u1', 'u2']]);
		looks.stop();
	});
});
