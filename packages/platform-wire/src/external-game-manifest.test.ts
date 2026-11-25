import { describe, expect, it } from 'vitest';

import { DEFAULT_SEAT_REJOIN_GRACE_MS, EXTERNAL_GAME_MAX_SEATS, externalGameManifest, manifestPathOf } from './external-game-manifest.ts';

describe('externalGameManifest', () => {
	it('reads a solo-capable game and fills in the default seat hold', () => {
		expect(externalGameManifest.parse({ label: 'Crossover Cards', seats: { min: 1, max: 4 } })).toEqual({
			label: 'Crossover Cards',
			seats: { min: 1, max: 4 },
			seatRejoinGraceMs: DEFAULT_SEAT_REJOIN_GRACE_MS,
		});
	});

	it('keeps a hold the game names, and drops keys it does not know', () => {
		expect(externalGameManifest.parse({ label: 'Bomberman', seats: { min: 2, max: 10 }, seatRejoinGraceMs: 30_000, later: true })).toEqual({
			label: 'Bomberman',
			seats: { min: 2, max: 10 },
			seatRejoinGraceMs: 30_000,
		});
	});

	it.each([
		['no seats', { label: 'X' }],
		['an empty label', { label: '  ', seats: { min: 1, max: 2 } }],
		['zero seats', { label: 'X', seats: { min: 0, max: 2 } }],
		['min above max', { label: 'X', seats: { min: 3, max: 2 } }],
		['more seats than any host takes', { label: 'X', seats: { min: 2, max: EXTERNAL_GAME_MAX_SEATS + 1 } }],
		['a fractional seat', { label: 'X', seats: { min: 1.5, max: 2 } }],
		['a negative hold', { label: 'X', seats: { min: 1, max: 2 }, seatRejoinGraceMs: -1 }],
		['not an object', 'Crossover Cards'],
	])('refuses %s', (_why, raw) => {
		expect(externalGameManifest.safeParse(raw).success).toBe(false);
	});
});

describe('manifestPathOf', () => {
	it.each([
		['/games/crossover-cards/embed.js', '/games/crossover-cards/manifest.json'],
		['/bomberman/embed/bomberman-embed.js', '/bomberman/embed/manifest.json'],
	])('%s → %s', (embed, manifest) => {
		expect(manifestPathOf(embed)).toBe(manifest);
	});
});
