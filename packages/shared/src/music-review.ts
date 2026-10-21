/*
 * The match-music review (`#/sounds/music`, `POST /api/sounds/music-review`).
 *
 * The operator, 2026-10-17: *"post it as a new route under /sounds/ i want to be able to go there, test,
 * then send the results for review later."* Fifteen slots, one per `MATCH_MUSIC_ROLES` cell; each offers
 * the takes the cell plays today plus the generated Music takes named `<code> · <description>`. A viewer
 * picks any number per slot — every pick goes in the cell, and a player whose slot holds more than one
 * chooses among them in sound settings (the operator, 2026-10-20) — rates any of them, notes the slot, and
 * submits; a later session reads the submissions and sets the assignments by hand.
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
 * One slot's verdict: the takes picked for its cell, in the order picked. Lines written before
 * 2026-10-20 carry a single `pick`, or a `{ normal, chiptune }` pair from the two-lane review; both read
 * as the list of what they picked, so `music-reviews.jsonl` is never rewritten to keep up.
 */
export const MusicReviewEntrySchema = z.preprocess(
	(v) => {
		if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
		const { pick, picks, ...rest } = v as Record<string, unknown>;
		const lanes = typeof picks === 'object' && picks !== null && !Array.isArray(picks) ? Object.values(picks) : null;
		const list = lanes ?? picks ?? (pick === undefined ? undefined : [pick]);
		return { ...rest, picks: Array.isArray(list) ? [...new Set(list.filter((f) => f !== null))] : list };
	},
	z.object({
		picks: z.array(TakeFileSchema).default([]),
		ratings: z.record(TakeFileSchema, z.enum(MUSIC_RATINGS)).default({}),
		note: z.string().max(1000).default(''),
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

/** One line of `music-reviews.jsonl`: who, when, and what they sent. */
export const MusicReviewRecordSchema = z.object({
	at: z.string(),
	userId: z.string(),
	name: z.string().nullable(),
	slots: z.record(z.string(), MusicReviewEntrySchema),
});
export type MusicReviewRecord = z.output<typeof MusicReviewRecordSchema>;

/** `GET /api/sounds/music-review/mine`: the viewer's latest submission, or null. */
export const MusicReviewMineSchema = z.object({ review: MusicReviewRecordSchema.nullable() });

/**
 * Every pick and rating must name a candidate its slot offered. Returns the problems, empty when the
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
	}
	return problems;
}
