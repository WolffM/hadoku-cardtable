/**
 * `handshakeTier` in isolation — split out of `room/socket.ts` (wave 110 §L), whose own
 * `socket.test.ts` already covers it indirectly through a real handshake.
 */
import { describe, expect, it } from 'vitest';

import { handshakeTier } from './socket-auth.ts';

describe('handshakeTier', () => {
	it('reads x-hadoku-tier off the handshake headers', () => {
		expect(handshakeTier({ 'x-hadoku-tier': 'friend' })).toBe('friend');
	});

	it('answers the floor tier when the header is absent', () => {
		expect(handshakeTier({})).toBe('public');
	});
});
