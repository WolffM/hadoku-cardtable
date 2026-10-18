/*
 * The match-music review: which takes a slot offers, and what a submission may say.
 *
 * The catalogue below is copied, entry for entry, from the production `catalogue.json` and
 * `assignments.json` of 2026-10-17 (fifteen of the operator's own tracks assigned, three generated
 * takes per slot named `<code> · <description>`), trimmed to the slots the cases need.
 */

import { describe, expect, it } from 'vitest';

import {
	MUSIC_REVIEW_CODES,
	MusicReviewBodySchema,
	MusicReviewRecordSchema,
	isChiptuneName,
	musicReviewCell,
	musicReviewProblems,
	musicReviewSlots,
} from './music-review.ts';
import { CatalogueSchema, MATCH_MUSIC_ROLES } from './sounds.ts';

const music = (slug: string, name: string, prompt: string) => ({
	file: `music-${slug}/take-1.ogg`,
	sound: `music-${slug}`,
	name,
	group: 'Music',
	section: 'Music',
	label: name,
	seconds: 120,
	prompt,
});

const OWN = 'the operator’s own track';
const GEN = 'Generated locally with ACE-Step 1.5 XL-sft (MIT weights), seed 20700, 50 steps, cfg 7';

const CATALOGUE = CatalogueSchema.parse({
	takes: [
		music('dawnlight-sanctum', 'Dawnlight Sanctum', `Dawnlight Sanctum, ${OWN}`),
		music('statute-of-gears', 'Statute of Gears', `Statute of Gears, ${OWN}`),
		music('w-heraldic-fanfare', 'W · heraldic fanfare', GEN),
		music('w-tavern-jig', 'W · tavern jig', GEN),
		music('w-baroque-trumpet', 'W · baroque trumpet', GEN),
		music('wu-16-bit-sky-kingdom', 'WU · 16-bit sky kingdom', GEN),
		music('wu-lighthouse-march', 'WU · lighthouse march', GEN),
		music('wu-clockwork-senate', 'WU · clockwork senate', GEN),
		{
			file: 'wu/take-v1-4000.ogg',
			sound: 'WU',
			name: 'Azorius',
			group: 'Azorius',
			section: 'Colour sounds',
			label: 'Azorius · 1a',
			seconds: 1.1,
			prompt: 'A rising bell chord.',
		},
	],
}).takes;

const CELLS = {
	'music.match.W|play': ['music-dawnlight-sanctum/take-1.ogg'],
	'music.match.WU|play': ['music-statute-of-gears/take-1.ogg'],
};

describe('musicReviewSlots', () => {
	const slots = musicReviewSlots(CATALOGUE, CELLS);

	it('is the fifteen match-music cells, monos first, then the pairs in canonical order', () => {
		expect(MUSIC_REVIEW_CODES).toEqual(['W', 'U', 'B', 'R', 'G', 'WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU']);
		expect(slots.map((s) => s.cell)).toEqual(MATCH_MUSIC_ROLES.map((r) => `${r}|play`));
	});

	it('offers the current take first, then that code’s generated takes, and never a pair’s takes on a mono', () => {
		const w = slots.find((s) => s.code === 'W')!;
		expect(w.candidates).toEqual([
			{ file: 'music-dawnlight-sanctum/take-1.ogg', label: 'Dawnlight Sanctum', current: true },
			{ file: 'music-w-heraldic-fanfare/take-1.ogg', label: 'W · heraldic fanfare', current: false },
			{ file: 'music-w-tavern-jig/take-1.ogg', label: 'W · tavern jig', current: false },
			{ file: 'music-w-baroque-trumpet/take-1.ogg', label: 'W · baroque trumpet', current: false },
		]);
		const wu = slots.find((s) => s.code === 'WU')!;
		expect(wu.candidates.map((c) => c.label)).toEqual([
			'Statute of Gears',
			'WU · 16-bit sky kingdom',
			'WU · lighthouse march',
			'WU · clockwork senate',
		]);
	});

	it('lists a generated take once when it is also the current one', () => {
		const slot = musicReviewSlots(CATALOGUE, { 'music.match.W|play': ['music-w-tavern-jig/take-1.ogg'] })[0]!;
		expect(slot.candidates.map((c) => [c.label, c.current])).toEqual([
			['W · tavern jig', true],
			['W · heraldic fanfare', false],
			['W · baroque trumpet', false],
		]);
	});

	it('skips an assigned file the catalogue no longer has, and a slot with nothing is empty', () => {
		const slots2 = musicReviewSlots(CATALOGUE, { 'music.match.U|play': ['music-gone/take-1.ogg'] });
		expect(slots2.find((s) => s.code === 'U')!.candidates).toEqual([]);
	});
});

describe('MusicReviewBodySchema and musicReviewProblems', () => {
	const slots = musicReviewSlots(CATALOGUE, CELLS);
	const W = musicReviewCell('W');

	it('fills a slot’s defaults', () => {
		expect(MusicReviewBodySchema.parse({ slots: { [W]: {} } })).toEqual({ slots: { [W]: { picks: { normal: null, chiptune: null }, ratings: {}, note: '' } } });
	});

	it('refuses a slot that is not a match-music cell', () => {
		expect(MusicReviewBodySchema.safeParse({ slots: { 'music.lobby|play': {} } }).success).toBe(false);
		expect(MusicReviewBodySchema.safeParse({ slots: { 'g.draw|play': {} } }).success).toBe(false);
	});

	it('refuses an unknown rating and an over-long note', () => {
		expect(MusicReviewBodySchema.safeParse({ slots: { [W]: { ratings: { 'music-w-tavern-jig/take-1.ogg': 'love' } } } }).success).toBe(false);
		expect(MusicReviewBodySchema.safeParse({ slots: { [W]: { note: 'x'.repeat(1001) } } }).success).toBe(false);
	});

	it('accepts a pick per lane and ratings among the slot’s candidates; one take may hold both lanes', () => {
		const body = MusicReviewBodySchema.parse({
			slots: {
				[W]: {
					picks: { normal: 'music-w-tavern-jig/take-1.ogg', chiptune: 'music-w-heraldic-fanfare/take-1.ogg' },
					ratings: { 'music-dawnlight-sanctum/take-1.ogg': 'no' },
					note: 'jig',
				},
			},
		});
		expect(musicReviewProblems(body, slots)).toEqual([]);
		const both = MusicReviewBodySchema.parse({
			slots: { [W]: { picks: { normal: 'music-w-tavern-jig/take-1.ogg', chiptune: 'music-w-tavern-jig/take-1.ogg' } } },
		});
		expect(musicReviewProblems(both, slots)).toEqual([]);
		expect(MusicReviewBodySchema.parse({ slots: { [W]: { picks: { chiptune: 'music-w-tavern-jig/take-1.ogg' } } } }).slots[W]!.picks).toEqual({
			normal: null,
			chiptune: 'music-w-tavern-jig/take-1.ogg',
		});
	});

	it('names a lane pick or a rating its slot never offered', () => {
		const body = MusicReviewBodySchema.parse({
			slots: {
				[W]: {
					picks: { normal: 'music-wu-clockwork-senate/take-1.ogg', chiptune: 'music-wu-lighthouse-march/take-1.ogg' },
					ratings: { 'wu/take-v1-4000.ogg': 'keep' },
				},
			},
		});
		expect(musicReviewProblems(body, slots)).toEqual([
			`${W}: normal pick music-wu-clockwork-senate/take-1.ogg was not offered`,
			`${W}: chiptune pick music-wu-lighthouse-march/take-1.ogg was not offered`,
			`${W}: rating for wu/take-v1-4000.ogg, which was not offered`,
		]);
	});

	it('reads a line written before the two lanes: its one pick is the normal lane', () => {
		// The first line of production's music-reviews.jsonl shape, 2026-10-17.
		const old = MusicReviewRecordSchema.parse({
			at: '2026-10-17T20:00:00.000Z',
			userId: 'u1',
			name: 'Op',
			slots: { [W]: { pick: 'music-w-tavern-jig/take-1.ogg', ratings: {}, note: '' }, [musicReviewCell('U')]: { pick: null, ratings: {}, note: 'meh' } },
		});
		expect(old.slots[W]!.picks).toEqual({ normal: 'music-w-tavern-jig/take-1.ogg', chiptune: null });
		expect(old.slots[musicReviewCell('U')]!.picks).toEqual({ normal: null, chiptune: null });
		expect(old.slots[W]).not.toHaveProperty('pick');
		expect(MusicReviewBodySchema.safeParse({ slots: { [W]: { pick: '../../etc/passwd' } } }).success).toBe(false);
	});
});

describe('isChiptuneName', () => {
	it('marks a name that says 16-bit, however it is spelled, and nothing else', () => {
		expect(['WU · 16-bit sky kingdom', 'W · 16 bit castle', 'B · 16BIT crypt'].map(isChiptuneName)).toEqual([true, true, true]);
		expect(['W · tavern jig', 'Statute of Gears', 'R · 160 bpm'].map(isChiptuneName)).toEqual([false, false, false]);
	});
});
