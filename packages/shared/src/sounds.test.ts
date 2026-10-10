/*
 * The sound-builder schemas: `CellId`'s row/column pairing and `TAKE_FILE_RE`'s
 * traversal gate are the two properties load-bearing enough to need both a
 * valid and an invalid case each.
 */

import { describe, expect, it } from 'vitest';

import {
	AssignmentsSchema,
	CatalogueSchema,
	MAX_TAKES_PER_CELL,
	PutAssignmentBodySchema,
	SOUND_MATRIX,
	SOUND_ROLE_GROUPS,
	SOUND_ROLES,
	SOUND_SECTIONS,
	SoundTakeSchema,
	TAKE_FILE_RE,
	isCellId,
	parseCellId,
} from './sounds.ts';

const VALID_TAKE = {
	file: 'm-win/take-synth-1.ogg',
	sound: 'm-win',
	name: 'Victory',
	group: 'Victory',
	section: 'Moments',
	label: 'Victory · hand-rolled',
	seconds: 1.2,
	prompt: 'A triumphant chord.',
};

describe('CellId', () => {
	it('accepts a colour row paired with a paradigm column', () => {
		expect(isCellId('WU|spell')).toBe(true);
		expect(parseCellId('WU|spell')).toBe('WU|spell');
	});

	it('accepts a role paired with play', () => {
		expect(isCellId('g.draw|play')).toBe(true);
		expect(isCellId('g.cast.creature|play')).toBe(true);
	});

	it('rejects the retired m-* event ids', () => {
		expect(isCellId('m-draw|play')).toBe(false);
	});

	it('rejects a colour row paired with play', () => {
		expect(isCellId('WU|play')).toBe(false);
	});

	it('rejects a role paired with a paradigm column', () => {
		expect(isCellId('g.draw|spell')).toBe(false);
	});

	it('rejects a row that is neither a colour id nor a role id', () => {
		expect(isCellId('XX|spell')).toBe(false);
	});

	it('rejects a malformed id with no separator, or more than one', () => {
		expect(isCellId('WUspell')).toBe(false);
		expect(isCellId('WU|spell|extra')).toBe(false);
		expect(parseCellId('WU|spell')).not.toBeNull();
	});
});

describe('TAKE_FILE_RE', () => {
	it('matches a folder/take-suffix.ogg path, including dotted and library folders', () => {
		expect(TAKE_FILE_RE.test('m-win/take-synth-1.ogg')).toBe(true);
		// Source folders carry the colour code's own case (`BG.land`); the import
		// tool lowercases it for the served path, so only the lowercase form is
		// ever a valid `file`.
		expect(TAKE_FILE_RE.test('bg.land/take-1000.ogg')).toBe(true);
		expect(TAKE_FILE_RE.test('BG.land/take-1000.ogg')).toBe(false);
		expect(TAKE_FILE_RE.test('lib-water-wave/take-v1-4001.ogg')).toBe(true);
	});

	it('rejects traversal, absolute paths, and the wrong extension or stem', () => {
		expect(TAKE_FILE_RE.test('../etc/take-1.ogg')).toBe(false);
		expect(TAKE_FILE_RE.test('/etc/take-1.ogg')).toBe(false);
		expect(TAKE_FILE_RE.test('m-win/other-1.ogg')).toBe(false);
		expect(TAKE_FILE_RE.test('m-win/take-1.wav')).toBe(false);
		expect(TAKE_FILE_RE.test('m-win/take-1.ogg/../x')).toBe(false);
	});
});

describe('SoundTakeSchema', () => {
	it('parses a valid take', () => {
		expect(SoundTakeSchema.safeParse(VALID_TAKE).success).toBe(true);
	});

	it('rejects a take with a malformed file or an out-of-enum section', () => {
		expect(SoundTakeSchema.safeParse({ ...VALID_TAKE, file: 'bad file.ogg' }).success).toBe(false);
		expect(SoundTakeSchema.safeParse({ ...VALID_TAKE, section: 'Nonsense' }).success).toBe(false);
	});
});

describe('CatalogueSchema', () => {
	it('parses a list of valid takes', () => {
		expect(CatalogueSchema.safeParse({ takes: [VALID_TAKE] }).success).toBe(true);
	});

	it('rejects a take list containing one invalid entry', () => {
		expect(CatalogueSchema.safeParse({ takes: [VALID_TAKE, { ...VALID_TAKE, file: 'nope' }] }).success).toBe(false);
	});
});

describe('AssignmentsSchema', () => {
	it('parses cells keyed by valid CellIds', () => {
		const result = AssignmentsSchema.safeParse({
			cells: { 'g.win|play': ['m-win/take-synth-1.ogg'], 'WU|spell': [] },
			canEdit: true,
		});
		expect(result.success).toBe(true);
	});

	it('rejects a cells map with a malformed key', () => {
		const result = AssignmentsSchema.safeParse({ cells: { 'not-a-cell': [] }, canEdit: false });
		expect(result.success).toBe(false);
	});

	it('defaults gains to empty, and rejects a gain outside 0..2 or on a malformed key', () => {
		const parsed = AssignmentsSchema.parse({ cells: {}, canEdit: false });
		expect(parsed.gains).toEqual({});
		expect(AssignmentsSchema.safeParse({ cells: {}, gains: { 'g.win|play': 2.5 }, canEdit: false }).success).toBe(false);
		expect(AssignmentsSchema.safeParse({ cells: {}, gains: { 'nope|play': 1 }, canEdit: false }).success).toBe(false);
	});

	it('rejects a cell with more than MAX_TAKES_PER_CELL files', () => {
		const files = Array.from({ length: MAX_TAKES_PER_CELL + 1 }, (_, i) => `m-win/take-${i}.ogg`);
		const result = AssignmentsSchema.safeParse({ cells: { 'g.win|play': files }, canEdit: false });
		expect(result.success).toBe(false);
	});
});

describe('PutAssignmentBodySchema', () => {
	it('accepts a valid file list, including an empty one (clearing a cell)', () => {
		expect(PutAssignmentBodySchema.safeParse({ files: [] }).success).toBe(true);
		expect(PutAssignmentBodySchema.safeParse({ files: ['m-win/take-synth-1.ogg'] }).success).toBe(true);
	});

	it('rejects a file that is not a take path', () => {
		expect(PutAssignmentBodySchema.safeParse({ files: ['../../etc/passwd'] }).success).toBe(false);
	});
});

describe('SOUND_MATRIX', () => {
	it('carries 27 colour rows, with every mono colour having a land name', () => {
		expect(SOUND_MATRIX.colour).toHaveLength(27);
		for (const letter of ['W', 'U', 'B', 'R', 'G'] as const) {
			expect(SOUND_MATRIX.landNames[letter]).toBeTruthy();
		}
	});

	it('SOUND_ROLES indexes every grouped role once, ui roles on the ui bus', () => {
		const all = SOUND_ROLE_GROUPS.flatMap((g) => g.roles);
		expect(SOUND_ROLES.size).toBe(all.length);
		for (const r of all) expect(r.bus).toBe(r.id.startsWith('ui.') ? 'ui' : 'game');
	});

	it('SOUND_SECTIONS has exactly the four sections every SoundTake.section must be one of', () => {
		expect(SOUND_SECTIONS).toEqual(['Library', 'Land types', 'Moments', 'Colour sounds']);
	});
});
