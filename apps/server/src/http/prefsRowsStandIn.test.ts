import { describe, expect, it } from 'vitest';

import { emptyLoadout } from '@wolffm/prefs-client/cosmetics';

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
const standIn = () => createPrefsRowsStandIn({ app: 'cardtable', serviceKey: 's-key', userOfKey: (k) => USER_OF_KEY[k] ?? null });

describe('GET /api/v1/_avatar', () => {
	it('answers nobody picked, before anything is set', () => {
		const s = standIn();
		expect(s.handle('GET', '/api/v1/_avatar', { key: 'k-alice' }, null)).toEqual({
			status: 200,
			json: { avatar: { source: 'sprite' }, choice: null, sprite: null, ...NOTHING_ELSE },
		});
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
			json: { avatar: { source: 'sprite' }, choice: null, sprite: null, ...NOTHING_ELSE },
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
