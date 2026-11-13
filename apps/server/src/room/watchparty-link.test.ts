/**
 * `watchpartyRoomId` in isolation — split out of `room/lobby.ts` (wave 110 §L), whose
 * own `http/rooms.test.ts` already covers it indirectly through `POST /api/rooms/watchparty`.
 */
import { describe, expect, it } from 'vitest';

import { watchpartyRoomId } from './watchparty-link.ts';

describe('watchpartyRoomId', () => {
	it('is deterministic: the same watchparty room always binds to the same cardtable room', () => {
		expect(watchpartyRoomId('movie-night')).toBe(watchpartyRoomId('movie-night'));
	});

	it('differs for different watchparty rooms', () => {
		expect(watchpartyRoomId('movie-night')).not.toBe(watchpartyRoomId('game-night'));
	});

	it('is `wp-` plus 20 hex chars, never the watchparty name itself (never a credential, if one were passed)', () => {
		const id = watchpartyRoomId('some-leader-key-aabbccddeeff00112233');
		expect(id).toMatch(/^wp-[0-9a-f]{20}$/);
		expect(id).not.toContain('leader-key');
	});
});
