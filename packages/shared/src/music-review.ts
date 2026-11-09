/*
 * The match-music review (`#/sounds/music`, `POST /api/sounds/music-review`).
 *
 * The operator, 2026-10-17: *"post it as a new route under /sounds/ i want to be able to go there, test,
 * then send the results for review later."* Fifteen slots, one per `MATCH_MUSIC_ROLES` cell; each offers
 * the takes the cell plays today plus the generated Music takes named `<code> · <description>`. A viewer
 * picks any number per slot — every pick goes in the cell, and a player whose slot holds more than one
 * chooses among them in sound settings (the operator, 2026-10-20) — rates any of them, notes any of them
 * (a note per track, the operator 2026-11-08: *"a popout textbox for each row rather than one textbox for the
 * entire color"*), and submits; a later session reads the submissions and sets the assignments by hand.
 *
 * `musicReviewSlots` is the one place a slot's candidates are worked out. The page draws from it and the
 * server validates a submission against it, so the two can never disagree on what was offered.
 */

import { z } from 'zod';

import { COLOUR_PAIRS, MONO_COLOUR_IDS, TAKE_FILE_RE, type SoundTake } from './sounds.ts';

/** The fifteen slot codes: the five mono colours, then the ten pairs in `COLOUR_PAIRS` order. */
export const MUSIC_REVIEW_CODES: readonly string[] = [...MONO_COLOUR_IDS, ...COLOUR_PAIRS];

/** `W` → `music.match.W|play`: the slot's key in a review, and the cell its picks go in. */
export function musicReviewCell(code: string): string {
	return `music.match.${code}|play`;
}

const REVIEW_CELLS: ReadonlySet<string> = new Set(MUSIC_REVIEW_CODES.map(musicReviewCell));

export interface MusicReviewCandidate {
	file: string;
	label: string;
	/** Assigned to the cell today. */
	current: boolean;
}

export interface MusicReviewSlot {
	code: string;
	cell: string;
	candidates: MusicReviewCandidate[];
}

/**
 * Every slot with its candidates: what its cell holds today first (only takes still in the catalogue), then the catalogue's Music takes whose name starts `<code> · `, in catalogue order.
 * `W · ` never matches `WU · `, so a mono slot never collects a pair's takes.
 */
export function musicReviewSlots(takes: readonly SoundTake[], cells: Readonly<Record<string, readonly string[]>>): MusicReviewSlot[] {
	const byFile = new Map(takes.map((t) => [t.file, t]));
	return MUSIC_REVIEW_CODES.map((code) => {
		const cell = musicReviewCell(code);
		const candidates: MusicReviewCandidate[] = [];
		const seen = new Set<string>();
		for (const file of cells[cell] ?? []) {
			const take = byFile.get(file);
			if (take === undefined || seen.has(file)) continue;
			seen.add(file);
			candidates.push({ file, label: take.label, current: true });
		}
		const prefix = `${code} · `;
		for (const take of takes) {
			if (take.section !== 'Music' || !take.name.startsWith(prefix) || seen.has(take.file)) continue;
			seen.add(take.file);
			candidates.push({ file: take.file, label: take.label, current: false });
		}
		return { code, cell, candidates };
	});
}

/** A quick verdict on one candidate. */
export const MUSIC_RATINGS = ['keep', 'maybe', 'no'] as const;
export type MusicRating = (typeof MUSIC_RATINGS)[number];

const TakeFileSchema = z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg');

/**
 * A review written before 2026-11-08 noted the slot (`note`), not a track. Its note goes on the one track the
 * slot rated or picked; a slot note that spoke of several tracks, or none, has no track to go on and is dropped.
 */
export function liftSlotNote(entry: unknown): unknown {
	if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
	const { note, ...rest } = entry as { note?: unknown; notes?: unknown; ratings?: unknown; picks?: unknown };
	if (typeof note !== 'string' || note.trim() === '' || rest.notes !== undefined) return rest;
	const ratings = typeof rest.ratings === 'object' && rest.ratings !== null ? Object.keys(rest.ratings) : [];
	const picks = Array.isArray(rest.picks) ? rest.picks.filter((f): f is string => typeof f === 'string') : [];
	const files = new Set([...ratings, ...picks]);
	return files.size === 1 ? { ...rest, notes: { [[...files][0]!]: note } } : rest;
}

/** One slot's verdict: the takes picked for its cell, in the order picked; a rating and a note per take. */
export const MusicReviewEntrySchema = z.preprocess(
	liftSlotNote,
	z.object({
		picks: z.array(TakeFileSchema).default([]).transform((files) => [...new Set(files)]),
		ratings: z.record(TakeFileSchema, z.enum(MUSIC_RATINGS)).default({}),
		notes: z.record(TakeFileSchema, z.string().max(1000)).default({}),
	}),
);
export type MusicReviewEntry = z.output<typeof MusicReviewEntrySchema>;

/** `POST /api/sounds/music-review`. A slot left out is a slot not reviewed. */
export const MusicReviewBodySchema = z
	.object({ slots: z.record(z.string(), MusicReviewEntrySchema) })
	.superRefine((value, ctx) => {
		for (const key of Object.keys(value.slots)) {
			if (!REVIEW_CELLS.has(key)) ctx.addIssue({ code: 'custom', message: `not a match-music slot: ${key}`, path: ['slots', key] });
		}
	});
export type MusicReviewBody = z.output<typeof MusicReviewBodySchema>;

/**
 * The prefs-api app a person's review is stored under: one row per person (hadoku_site IDENTITY_MODEL
 * R12, cardtable#25). A new submission replaces the last one whole; no history is kept.
 */
export const MUSIC_REVIEW_APP_ID = 'cardtable-music-review';

/** A person's review, as their row holds it. Whose it is is the row's userId, never a field here. */
export const MusicReviewRecordSchema = z.object({
	at: z.string(),
	slots: z.record(z.string(), MusicReviewEntrySchema),
});
export type MusicReviewRecord = z.output<typeof MusicReviewRecordSchema>;

/** `GET /api/sounds/music-review/mine`: the viewer's submission, or null. */
export const MusicReviewMineSchema = z.object({ review: MusicReviewRecordSchema.nullable() });

/** `GET /api/sounds/music-review` (admin): every person's review, by userId. Names are looked up where shown. */
export const MusicReviewListSchema = z.object({
	reviews: z.array(MusicReviewRecordSchema.extend({ userId: z.string() })),
});
export type MusicReviewList = z.output<typeof MusicReviewListSchema>;

/**
 * Every pick, rating and note must name a candidate its slot offered. Returns the problems, empty when the
 * body is sound.
 */
export function musicReviewProblems(body: MusicReviewBody, slots: readonly MusicReviewSlot[]): string[] {
	const offered = new Map(slots.map((s) => [s.cell, new Set(s.candidates.map((c) => c.file))]));
	const problems: string[] = [];
	for (const [cell, entry] of Object.entries(body.slots)) {
		const files = offered.get(cell) ?? new Set<string>();
		for (const file of entry.picks) {
			if (!files.has(file)) problems.push(`${cell}: pick ${file} was not offered`);
		}
		for (const file of Object.keys(entry.ratings)) {
			if (!files.has(file)) problems.push(`${cell}: rating for ${file}, which was not offered`);
		}
		for (const file of Object.keys(entry.notes)) {
			if (!files.has(file)) problems.push(`${cell}: note for ${file}, which was not offered`);
		}
	}
	return problems;
}

/**
 * What an admin's submission does to the live cells: each reviewed slot keeps what it holds, gains its
 * picks in the order picked, and loses every take rated no (a no beats a pick of the same take). Only
 * the cells that change come back, so an unchanged slot is never rewritten.
 */
export function applyMusicReview(
	cells: Readonly<Record<string, readonly string[]>>,
	slots: Readonly<Record<string, MusicReviewEntry>>,
): Record<string, string[]> {
	const changed: Record<string, string[]> = {};
	for (const [cell, entry] of Object.entries(slots)) {
		const before = cells[cell] ?? [];
		const no = new Set(Object.entries(entry.ratings).flatMap(([file, r]) => (r === 'no' ? [file] : [])));
		const after = [...new Set([...before, ...entry.picks])].filter((f) => !no.has(f));
		if (after.length !== before.length || after.some((f, i) => f !== before[i])) changed[cell] = after;
	}
	return changed;
}
