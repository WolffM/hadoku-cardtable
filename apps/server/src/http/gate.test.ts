/**
 * The draft arm of the deck gate, with basic lands in the deck.
 *
 * A drafted pool is not a deck until you add lands, and the lands come from
 * the table, not the pool. Before Wave 13 D the gate read a drafted deck's
 * `.dck` back with its basics in `main` and counted them against the drafted
 * pool, so every drafted deck with lands was refused — "plays 17x Island but
 * drafted 0". These tests pin the exemption and its edges: basics are exempt
 * from the POOL check and from nothing else, and the Standard arm is untouched.
 *
 * The pool and the deck are `gate-fixture.ts`'s. `gate.jvm.test.ts` hands the
 * accepted text to a real Forge.
 */

import { describe, expect, it } from 'vitest';
import { parseDck, type CardRequest } from '@hadoku/carddata/dck';
import { BASIC_LAND_NAMES, basicLand, deckFromDeckFile, deckIssues, isBasicLand } from '@hadoku/deck';

import { draftPoolEntries } from './draftPool.js';
import { DRAFT, POOL, POWER_2012, UW_DELVER, ctx, drafted, draftedDeckText, library } from './gate-fixture.js';
import { checkSeat, refusalLine, splitBasicLands, type SeatVerdict } from './gate.js';

/** Put `line` at the top of the main section, as a hand-edited file would. */
function withMain(text: string, line: string): string {
	const at = text.search(/^\[main\]$/im);
	const end = text.indexOf('\n', at) + 1;
	return `${text.slice(0, end)}${line}\n${text.slice(end)}`;
}

describe('a drafted deck with basic lands', () => {
	it('the pool really is 45 drafted cards and no basics', () => {
		expect(POOL).toHaveLength(45);
		expect(POOL.some((c) => BASIC_LAND_NAMES.includes(c.name))).toBe(false);
	});

	it('is legal with 17 Islands, and the text checked is the text sent', () => {
		const text = draftedDeckText();
		expect(text).toMatch(/^17 Island$/m);
		const v = checkSeat(drafted(text), ctx) as SeatVerdict;
		expect(v).toMatchObject({
			deckName: `Cube draft ${DRAFT}`,
			rulesName: `your pool from ${DRAFT}`,
			legal: true,
			issues: [],
			note: null,
		});
		expect(v.text).toBe(text);
	});

	it('still refuses a non-basic the caller did not draft, by name', () => {
		const v = checkSeat(drafted(withMain(draftedDeckText(), '1 Black Lotus|LEA')), ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues).toEqual([
			{ kind: 'more-copies-than-drafted', message: 'plays 1x Black Lotus but drafted 0', cardName: 'Black Lotus', count: 1, limit: 0 },
		]);
		expect(refusalLine(0, v)).toBe(
			`Seat 1's deck "Cube draft ${DRAFT}" is not legal in your pool from ${DRAFT}: plays 1x Black Lotus but drafted 0`,
		);
	});

	it('exempts only Forge\'s five: an undrafted land outside them is pool-checked', () => {
		const v = checkSeat(drafted(withMain(draftedDeckText(), '1 Wastes')), ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues.map((i) => [i.kind, i.cardName])).toEqual([['more-copies-than-drafted', 'Wastes']]);
	});

	it('does not let the lands count twice or vanish: a 23-card deck plus 17 Islands is 40', () => {
		const deck = splitBasicLands(deckFromDeckFile(parseDck(draftedDeckText())));
		expect(deck.basics.map((e) => [e.count, e.card.name])).toEqual([[17, 'Island']]);
		expect(deck.main.some((e) => isBasicLand(e.card))).toBe(false);
		expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(23);
		// And one Island short is under the floor, so the lands are counted as maindeck.
		const short = checkSeat(drafted(draftedDeckText().replace(/^17 Island$/m, '16 Island')), ctx) as SeatVerdict;
		expect(short.issues.map((i) => i.message)).toEqual(['maindeck has 39 cards, needs at least 40']);
	});

	it('still refuses a non-basic in the basics pile', () => {
		const deck = splitBasicLands(deckFromDeckFile(parseDck(draftedDeckText())));
		const notABasic: CardRequest = { ...basicLand('Island'), name: 'Tolarian Academy' };
		const issues = deckIssues({ ...deck, basics: [...deck.basics, { count: 1, card: notABasic }] }, draftPoolEntries(POOL));
		expect(issues.map((i) => [i.kind, i.message])).toEqual([
			['not-a-basic-land', 'Tolarian Academy is in the basics pile but is not a basic land'],
		]);
	});
});

describe('the Standard arm is unchanged', () => {
	it('still refuses a land that is not in the format pool', () => {
		const base = library.deck(UW_DELVER)?.text ?? '';
		const standard = (dck: string) => ({ deck: { dck }, rules: { kind: 'standard' as const, format: POWER_2012 } });
		expect((checkSeat(standard(base), ctx) as SeatVerdict).legal).toBe(true);
		const v = checkSeat(standard(withMain(base, '4 Hallowed Fountain|RTR')), ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues.map((i) => [i.kind, i.cardName])).toContainEqual(['not-in-pool', 'Hallowed Fountain']);
	});
});
