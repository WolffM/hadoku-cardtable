import { describe, expect, it, vi } from 'vitest';

import { emptyLoadout } from '@wolffm/prefs-client/cosmetics';
import { AVATAR_POOL } from '@wolffm/rooms-protocol';

import { createPrefsRowsStandIn } from './prefsRowsStandIn.js';

const USER_OF_KEY: Record<string, string> = { 'k-alice': 'u-alice', 'k-bob': 'u-bob' };
/** Everything the popout reads besides the avatar itself: nothing linked, uploaded or worn. */
const NOTHING_ELSE = {
	linked: {},
	upload: null,
	providers: { discord: false, steam: false },
	limits: { maxBytes: 0, minDimension: 0, maxDimension: 0, acceptedTypes: [], perDay: 0, outputSize: 0 },
	cosmetics: { owned: [], loadout: emptyLoadout() },
};
/** The registry's accounts, by userId: the ids the real one deals a character to. */
const NAME_OF: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob' };
const standIn = (draw: () => number = () => 0) => createPrefsRowsStandIn({ app: 'cardtable', serviceKey: 's-key', userOfKey: (k) => USER_OF_KEY[k] ?? null, nameOf: (id) => NAME_OF[id] ?? null, draw });

describe('GET /api/v1/_avatar', () => {
	it('deals a character from the pool to an account that never picked and keeps it — the same one resolve answers — leaving choice null', () => {
		const s = standIn(() => 0.99);
		const own = { status: 200, json: { avatar: { source: 'sprite', sprite: AVATAR_POOL.at(-1) }, choice: null, sprite: AVATAR_POOL.at(-1), ...NOTHING_ELSE } };
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toEqual(own);
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toEqual(own);
		expect(s.handle('POST', '/api/v1/_avatar/resolve', { key: 's-key' }, { userIds: ['u-alice'] })).toEqual({ status: 200, json: { avatars: { 'u-alice': { source: 'sprite', name: 'Alice', sprite: AVATAR_POOL.at(-1) } } } });
	});

	it('deals nothing to an id that is no account: resolve answers it with no character', () => {
		const s = standIn();
		expect(s.handle('POST', '/api/v1/_avatar/resolve', { key: 's-key' }, { userIds: ['u-closed', 'u-alice'] })).toEqual({
			status: 200,
			json: { avatars: { 'u-closed': { source: 'sprite', name: null }, 'u-alice': { source: 'sprite', name: 'Alice', sprite: AVATAR_POOL[0] } } },
		});
	});

	it('deals once per account, by Math.random unless a draw is injected, and a resolve that comes first deals it too', () => {
		let next = 0;
		const s = standIn(() => [0, 0.99][next++]!);
		expect(s.handle('POST', '/api/v1/_avatar/resolve', { key: 's-key' }, { userIds: ['u-bob'] })).toMatchObject({ json: { avatars: { 'u-bob': { sprite: AVATAR_POOL[0] } } } });
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-bob' }, null)).toMatchObject({ json: { sprite: AVATAR_POOL[0] } });
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toMatchObject({ json: { sprite: AVATAR_POOL.at(-1) } });
		const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
		try {
			const real = createPrefsRowsStandIn({ app: 'cardtable', serviceKey: 's-key', userOfKey: (k) => USER_OF_KEY[k] ?? null });
			expect(real.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toMatchObject({ json: { sprite: AVATAR_POOL.at(-1) } });
		} finally {
			spy.mockRestore();
		}
	});

	it('answers the character the key’s person was dressed in, by _stand-in/avatar, as their own account would', () => {
		const s = standIn();
		s.handle('PUT', '/api/v1/_stand-in/avatar', { key: null }, { userKey: 'k-alice', avatar: { source: 'sprite', sprite: 'wanderer', name: 'Alice' } });
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toEqual({
			status: 200,
			json: { avatar: { source: 'sprite', sprite: 'wanderer' }, choice: 'sprite', sprite: 'wanderer', ...NOTHING_ELSE },
		});
	});

	it('carries a picture source’s url too, and a different key sees a different person', () => {
		const s = standIn();
		s.handle('PUT', '/api/v1/_stand-in/avatar', { key: null }, { userKey: 'k-alice', avatar: { source: 'discord', url: 'https://cdn.example/a.png', sprite: 'wanderer', name: 'Alice' } });
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toEqual({
			status: 200,
			json: { avatar: { source: 'discord', url: 'https://cdn.example/a.png', sprite: 'wanderer' }, choice: 'discord', sprite: 'wanderer', ...NOTHING_ELSE },
		});
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-bob' }, null)).toEqual({
			status: 200,
			json: { avatar: { source: 'sprite', sprite: AVATAR_POOL[0] }, choice: null, sprite: AVATAR_POOL[0], ...NOTHING_ELSE },
		});
	});

	it('refuses a key that signs nobody in, and a caller with no key at all', () => {
		const s = standIn();
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-nobody' }, null)).toEqual({ status: 403, json: { error: 'Forbidden', message: 'No session' } });
		expect(s.handle('GET', '/api/v1/_avatar', { key: null }, null)).toEqual({ status: 403, json: { error: 'Forbidden', message: 'No session' } });
	});

	it('saves the popout’s own pick, by the caller’s session, and reads it back to them and to resolve', () => {
		const s = standIn();
		expect(s.handle('PUT', '/api/v1/_avatar', { key: 'k-alice' }, { sprite: 'rogue' })).toEqual({
			status: 200,
			json: { avatar: { source: 'sprite', sprite: 'rogue' }, choice: 'sprite', sprite: 'rogue', ...NOTHING_ELSE },
		});
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toMatchObject({ json: { sprite: 'rogue' } });
		expect(s.handle('POST', '/api/v1/_avatar/resolve', { key: 's-key' }, { userIds: ['u-alice'] })).toMatchObject({ json: { avatars: { 'u-alice': { sprite: 'rogue' } } } });
		expect(s.handle('PUT', '/api/v1/_avatar', { key: null }, { sprite: 'rogue' })).toEqual({ status: 403, json: { error: 'Forbidden', message: 'No session' } });
	});

	it('is this one GET, not swept up by the _service rows route or the other avatar routes', () => {
		const s = standIn();
		expect(s.handle('POST', '/api/v1/_avatar', { key: 'k-alice' }, null)).toBeNull();
		expect(s.handle('GET', '/api/v1/_avatar/resolve', { key: 's-key' }, { userIds: [] })).toBeNull();
	});
});
