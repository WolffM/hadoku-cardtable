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
	musicReviewCell,
	musicReviewProblems,
	musicReviewSlots,
} from './music-review.ts';
import { CatalogueSchema, MATCH_MUSIC_ROLES, SOUND_ROLES, isCellId } from './sounds.ts';

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

	it('a slot’s picks go in its own match role’s cell', () => {
		expect(musicReviewCell('W')).toBe('music.match.W|play');
		for (const code of MUSIC_REVIEW_CODES) {
			const cell = musicReviewCell(code);
			expect(isCellId(cell)).toBe(true);
			expect(SOUND_ROLES.get(cell.replace(/\|play$/, ''))?.bus).toBe('music');
		}
	});

	it('offers every take the cell holds today as current, in the cell’s order', () => {
		const slot = musicReviewSlots(CATALOGUE, {
			'music.match.WU|play': ['music-statute-of-gears/take-1.ogg', 'music-wu-16-bit-sky-kingdom/take-1.ogg'],
		}).find((s) => s.code === 'WU')!;
		expect(slot.candidates.map((c) => [c.label, c.current])).toEqual([
			['Statute of Gears', true],
			['WU · 16-bit sky kingdom', true],
			['WU · lighthouse march', false],
			['WU · clockwork senate', false],
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
		expect(MusicReviewBodySchema.parse({ slots: { [W]: {} } })).toEqual({ slots: { [W]: { picks: [], ratings: {}, notes: {} } } });
	});

	it('refuses a slot that is not a match-music cell', () => {
		expect(MusicReviewBodySchema.safeParse({ slots: { 'music.lobby|play': {} } }).success).toBe(false);
		expect(MusicReviewBodySchema.safeParse({ slots: { 'g.draw|play': {} } }).success).toBe(false);
	});

	it('refuses an unknown rating and an over-long note', () => {
		expect(MusicReviewBodySchema.safeParse({ slots: { [W]: { ratings: { 'music-w-tavern-jig/take-1.ogg': 'love' } } } }).success).toBe(false);
		expect(MusicReviewBodySchema.safeParse({ slots: { [W]: { notes: { 'music-w-tavern-jig/take-1.ogg': 'x'.repeat(1001) } } } }).success).toBe(false);
	});

	it('accepts any number of picks and ratings among the slot’s candidates', () => {
		const body = MusicReviewBodySchema.parse({
			slots: {
				[W]: {
					picks: ['music-w-tavern-jig/take-1.ogg', 'music-w-heraldic-fanfare/take-1.ogg'],
					ratings: { 'music-dawnlight-sanctum/take-1.ogg': 'no' },
					notes: { 'music-w-tavern-jig/take-1.ogg': 'jig' },
				},
			},
		});
		expect(musicReviewProblems(body, slots)).toEqual([]);
		expect(body.slots[W]!.picks).toEqual(['music-w-tavern-jig/take-1.ogg', 'music-w-heraldic-fanfare/take-1.ogg']);
	});

	it('names a pick, a rating or a note its slot never offered', () => {
		const body = MusicReviewBodySchema.parse({
			slots: {
				[W]: {
					picks: ['music-wu-clockwork-senate/take-1.ogg', 'music-wu-lighthouse-march/take-1.ogg'],
					ratings: { 'wu/take-v1-4000.ogg': 'keep' },
					notes: { 'wu/take-v1-4000.ogg': 'senate' },
				},
			},
		});
		expect(musicReviewProblems(body, slots)).toEqual([
			`${W}: pick music-wu-clockwork-senate/take-1.ogg was not offered`,
			`${W}: pick music-wu-lighthouse-march/take-1.ogg was not offered`,
			`${W}: rating for wu/take-v1-4000.ogg, which was not offered`,
			`${W}: note for wu/take-v1-4000.ogg, which was not offered`,
		]);
	});

	it('a review from before 2026-11-08 puts its slot note on the one track it rated or picked, and drops one about several or none', () => {
		const JIG = 'music-w-tavern-jig/take-1.ogg';
		const FANFARE = 'music-w-heraldic-fanfare/take-1.ogg';
		const record = MusicReviewRecordSchema.parse({
			at: '2026-11-09T01:29:37.603Z',
			slots: {
				[W]: { picks: [], ratings: { [JIG]: 'maybe' }, note: 'too much noise' },
				[musicReviewCell('WU')]: { picks: [], ratings: {}, note: 'none of these' },
				[musicReviewCell('U')]: { picks: [JIG], ratings: { [FANFARE]: 'no' }, note: 'which?' },
				[musicReviewCell('B')]: { picks: [JIG], ratings: { [JIG]: 'keep' }, note: 'take it' },
			},
		});
		expect(record.slots[W]).toEqual({ picks: [], ratings: { [JIG]: 'maybe' }, notes: { [JIG]: 'too much noise' } });
		expect(record.slots[musicReviewCell('WU')]).toEqual({ picks: [], ratings: {}, notes: {} });
		expect(record.slots[musicReviewCell('U')]!.notes).toEqual({});
		expect(record.slots[musicReviewCell('B')]!.notes).toEqual({ [JIG]: 'take it' });
	});

	it('dedupes a slot’s picks, keeping the order picked', () => {
		const body = MusicReviewBodySchema.parse({
			slots: { [W]: { picks: ['music-w-tavern-jig/take-1.ogg', 'music-w-heraldic-fanfare/take-1.ogg', 'music-w-tavern-jig/take-1.ogg'] } },
		});
		expect(body.slots[W]!.picks).toEqual(['music-w-tavern-jig/take-1.ogg', 'music-w-heraldic-fanfare/take-1.ogg']);
	});

	it('a stored review carries no name and no userId: whose it is is the row’s', () => {
		const rec = MusicReviewRecordSchema.parse({ at: '2026-10-31T00:00:00.000Z', userId: 'u1', name: 'Op', slots: {} });
		expect(rec).toEqual({ at: '2026-10-31T00:00:00.000Z', slots: {} });
	});
});
