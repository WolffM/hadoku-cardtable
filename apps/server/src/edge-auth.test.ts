import { describe, expect, it } from 'vitest';
import { assertFloor, rankOf } from './edge-auth.ts';

describe('the tier floor', () => {
	it('admits a member above public and below friend', () => {
		expect(rankOf('member')).toBeGreaterThan(rankOf('public'));
		expect(rankOf('member')).toBeLessThan(rankOf('friend'));
	});

	it('accepts member and friend floors', () => {
		expect(assertFloor('member')).toBe('member');
		expect(assertFloor('friend')).toBe('friend');
	});

	it('refuses to boot on a floor it does not know, or on public', () => {
		// An unknown tier ranks as public, so such a floor would admit everyone.
		expect(() => assertFloor('visitor')).toThrow(/not a tier floor/);
		expect(() => assertFloor('public')).toThrow(/not a tier floor/);
	});
});
