/**
 * `avatarIdOf` in isolation — split out of `room/lobby.ts` (wave 110 §L), whose own
 * `lobby.test.ts`/`http/rooms.test.ts` already cover it indirectly through `setAvatar`.
 * This is the direct unit coverage a platform file gets to stand on its own, with no
 * Magic room fixture behind it.
 */
import { describe, expect, it } from 'vitest';

import { avatarIdOf } from './avatar.ts';

describe('avatarIdOf', () => {
	it('passes through a non-blank string unchanged', () => {
		expect(avatarIdOf('discord:12345')).toBe('discord:12345');
	});

	it('trims surrounding whitespace', () => {
		expect(avatarIdOf('  spaced  ')).toBe('spaced');
	});

	it('is undefined for null, undefined, and a non-string value', () => {
		expect(avatarIdOf(null)).toBeUndefined();
		expect(avatarIdOf(undefined)).toBeUndefined();
		expect(avatarIdOf(42)).toBeUndefined();
		expect(avatarIdOf({ not: 'a string' })).toBeUndefined();
	});

	it('is undefined for an empty or all-whitespace string — the broken-image bug this function exists to stop', () => {
		expect(avatarIdOf('')).toBeUndefined();
		expect(avatarIdOf('   ')).toBeUndefined();
	});

	it('is undefined past AVATAR_ID_MAX (32) characters, and defined right at it', () => {
		expect(avatarIdOf('a'.repeat(32))).toBe('a'.repeat(32));
		expect(avatarIdOf('a'.repeat(33))).toBeUndefined();
	});
});
