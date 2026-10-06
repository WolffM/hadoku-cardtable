/*
 * The sound-builder wire contract: the catalogue of recorded takes, the
 * assignment matrix that maps a cell to the takes that may play for it, and
 * the one shared row/column/event constant both the server and the builder
 * screen read.
 *
 * ## Server-hosted, never bundled
 *
 * Audio bytes live under the server's `CARDTABLE_SOUNDS_DIR` and are never
 * committed, never mirrored into the UI bundle. This file carries no audio —
 * only the shape of the catalogue entries that point at it (`SoundTake.file`)
 * and the row/column metadata the builder draws its grid from.
 *
 * ## `CellId` is a grammar, not a free string
 *
 * `<row>|<col>`, where `row` is one of the 27 colour-identity ids or one of
 * the 13 event ids, and `col` is one of the five paradigms (for a colour row)
 * or the literal `play` (for an event row). `isCellId`/`parseCellId` are the
 * one place that pairing is checked — a colour row with `play`, or an event
 * row with `spell`, is not a cell.
 *
 * ## `TAKE_FILE_RE` is the traversal gate
 *
 * `^[a-z0-9][a-z0-9.\-]*` then `/take-[a-z0-9-]+\.ogg$` — the folder segment MUST
 * start with a letter or digit, which is what rules out `..` and an absolute
 * path by construction (neither starts with `[a-z0-9]`), and the character
 * class excludes `/` entirely, so no encoded or literal slash can smuggle a
 * second path segment through either half. The server's take-serving route
 * re-checks a resolved path stays inside its directory as a second,
 * independent gate — belt and suspenders, not either/or.
 *
 * ## The matrix duplicates Magic's own colour-pie nomenclature, on purpose
 *
 * `SOUND_MATRIX` is the one constant both lanes read: 26 colour identities (5
 * mono, 10 guild, 10 three-colour, one four-plus) plus colourless, each
 * paradigm a mono identity's Land cell is relabelled with its basic land
 * name, and 13 game-moment events. Ported from the operator-approved artifact
 * (`docs/handoff/snapshot/rows.json`, read-only reference — never read at
 * runtime by anything here).
 */

import { z } from 'zod';

/* ── Rows, columns, events — the one shared matrix ──────────────────── */

/** A colour-identity row's grouping. Mirrors the artifact's own `family` tag. */
export type ColourFamily = 'mono' | 'guild' | 'shard' | 'wedge' | 'four' | 'extra';

/** One of the five mana letters, or `C` for colourless. */
export type ManaPip = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

export interface ColourRow {
	readonly id: string;
	readonly name: string;
	readonly sub: string;
	readonly family: ColourFamily;
	/** Colour pips to draw for this row's swatch. */
	readonly colours: readonly ManaPip[];
}

export interface EventRow {
	readonly id: string;
	readonly name: string;
	readonly sub: string;
}

export interface ParadigmCol {
	readonly id: string;
	readonly name: string;
}

/** The five paradigm columns a colour-identity row carries. */
export const PARADIGM_IDS = ['spell', 'creature', 'land', 'artifact', 'artifact-creature'] as const;
export type ParadigmId = (typeof PARADIGM_IDS)[number];

/** The 27 colour-identity rows: 5 mono, 10 guild, 10 three-colour, four-plus, colourless. */
export const COLOUR_IDS = [
	'W',
	'U',
	'B',
	'R',
	'G',
	'WU',
	'UB',
	'BR',
	'RG',
	'GW',
	'WB',
	'UR',
	'BG',
	'RW',
	'GU',
	'GWU',
	'WUB',
	'UBR',
	'BRG',
	'RGW',
	'WBG',
	'URW',
	'BGU',
	'RWB',
	'GUR',
	'WUBRG',
	'C',
] as const;
export type ColourId = (typeof COLOUR_IDS)[number];

/** The 13 game-moment events, each with a single `play` column. */
export const EVENT_IDS = [
	'm-draw',
	'm-shuffle',
	'm-tapcard',
	'm-resolve',
	'm-attack',
	'm-block',
	'm-damage',
	'm-damage-player',
	'm-dies',
	'm-phase',
	'm-turn',
	'm-win',
	'm-lose',
] as const;
export type EventId = (typeof EVENT_IDS)[number];

/** `<ColourId>|<ParadigmId>` or `<EventId>|play`. Validated by `isCellId`. */
export type CellId = `${ColourId}|${ParadigmId}` | `${EventId}|play`;

/**
 * Display names, families, colour pips and mono land names — one constant,
 * read by both the server (import's catalogue build) and the builder screen
 * (the grid it draws). Ported verbatim from the operator-approved artifact's
 * own matrix.
 */
export const SOUND_MATRIX: {
	readonly paradigms: readonly ParadigmCol[];
	readonly landNames: Readonly<Record<'W' | 'U' | 'B' | 'R' | 'G', string>>;
	readonly colour: readonly ColourRow[];
	readonly events: readonly EventRow[];
} = {
	paradigms: [
		{ id: 'spell', name: 'Spell' },
		{ id: 'creature', name: 'Creature' },
		{ id: 'land', name: 'Land' },
		{ id: 'artifact', name: 'Artifact' },
		{ id: 'artifact-creature', name: 'Artifact creature' },
	],
	landNames: { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' },
	colour: [
		{ id: 'W', name: 'White', sub: 'Mono white', family: 'mono', colours: ['W'] },
		{ id: 'U', name: 'Blue', sub: 'Mono blue', family: 'mono', colours: ['U'] },
		{ id: 'B', name: 'Black', sub: 'Mono black', family: 'mono', colours: ['B'] },
		{ id: 'R', name: 'Red', sub: 'Mono red', family: 'mono', colours: ['R'] },
		{ id: 'G', name: 'Green', sub: 'Mono green', family: 'mono', colours: ['G'] },
		{ id: 'WU', name: 'Azorius', sub: 'White · Blue', family: 'guild', colours: ['W', 'U'] },
		{ id: 'UB', name: 'Dimir', sub: 'Blue · Black', family: 'guild', colours: ['U', 'B'] },
		{ id: 'BR', name: 'Rakdos', sub: 'Black · Red', family: 'guild', colours: ['B', 'R'] },
		{ id: 'RG', name: 'Gruul', sub: 'Red · Green', family: 'guild', colours: ['R', 'G'] },
		{ id: 'GW', name: 'Selesnya', sub: 'Green · White', family: 'guild', colours: ['G', 'W'] },
		{ id: 'WB', name: 'Orzhov', sub: 'White · Black', family: 'guild', colours: ['W', 'B'] },
		{ id: 'UR', name: 'Izzet', sub: 'Blue · Red', family: 'guild', colours: ['U', 'R'] },
		{ id: 'BG', name: 'Golgari', sub: 'Black · Green', family: 'guild', colours: ['B', 'G'] },
		{ id: 'RW', name: 'Boros', sub: 'Red · White', family: 'guild', colours: ['R', 'W'] },
		{ id: 'GU', name: 'Simic', sub: 'Green · Blue', family: 'guild', colours: ['G', 'U'] },
		{ id: 'GWU', name: 'Bant', sub: 'Green · White · Blue', family: 'shard', colours: ['G', 'W', 'U'] },
		{ id: 'WUB', name: 'Esper', sub: 'White · Blue · Black', family: 'shard', colours: ['W', 'U', 'B'] },
		{ id: 'UBR', name: 'Grixis', sub: 'Blue · Black · Red', family: 'shard', colours: ['U', 'B', 'R'] },
		{ id: 'BRG', name: 'Jund', sub: 'Black · Red · Green', family: 'shard', colours: ['B', 'R', 'G'] },
		{ id: 'RGW', name: 'Naya', sub: 'Red · Green · White', family: 'shard', colours: ['R', 'G', 'W'] },
		{ id: 'WBG', name: 'Abzan', sub: 'White · Black · Green', family: 'wedge', colours: ['W', 'B', 'G'] },
		{ id: 'URW', name: 'Jeskai', sub: 'Blue · Red · White', family: 'wedge', colours: ['U', 'R', 'W'] },
		{ id: 'BGU', name: 'Sultai', sub: 'Black · Green · Blue', family: 'wedge', colours: ['B', 'G', 'U'] },
		{ id: 'RWB', name: 'Mardu', sub: 'Red · White · Black', family: 'wedge', colours: ['R', 'W', 'B'] },
		{ id: 'GUR', name: 'Temur', sub: 'Green · Blue · Red', family: 'wedge', colours: ['G', 'U', 'R'] },
		{
			id: 'WUBRG',
			name: 'Four colours or more',
			sub: 'Any four, or all five',
			family: 'four',
			colours: ['W', 'U', 'B', 'R', 'G'],
		},
		{ id: 'C', name: 'Colourless', sub: 'Artifacts and Eldrazi (suggested 27th)', family: 'extra', colours: ['C'] },
	],
	events: [
		{ id: 'm-draw', name: 'Draw a card', sub: 'A card moves from library to hand.' },
		{ id: 'm-shuffle', name: 'Shuffle', sub: 'A library is shuffled.' },
		{ id: 'm-tapcard', name: 'Tap or untap a card', sub: 'Any permanent turning sideways or back.' },
		{ id: 'm-resolve', name: 'Spell resolves', sub: 'The top of the stack resolves.' },
		{ id: 'm-attack', name: 'Creature attacks', sub: 'An attacker is declared.' },
		{ id: 'm-block', name: 'Block', sub: 'A blocker is assigned.' },
		{ id: 'm-damage', name: 'Damage to a creature', sub: 'Combat or spell damage to a creature.' },
		{ id: 'm-damage-player', name: 'Damage to a player or planeswalker', sub: 'A face or a planeswalker is hit.' },
		{ id: 'm-dies', name: 'Creature dies', sub: 'A creature goes to the graveyard.' },
		{ id: 'm-phase', name: 'Phase change', sub: 'The game moves to the next step.' },
		{ id: 'm-turn', name: 'Your turn', sub: 'Your turn begins.' },
		{ id: 'm-win', name: 'Victory', sub: 'You win the game.' },
		{ id: 'm-lose', name: 'Defeat', sub: 'You lose the game.' },
	],
};

const COLOUR_ID_SET: ReadonlySet<string> = new Set(COLOUR_IDS);
const EVENT_ID_SET: ReadonlySet<string> = new Set(EVENT_IDS);
const PARADIGM_ID_SET: ReadonlySet<string> = new Set(PARADIGM_IDS);

/**
 * Parse a raw string as a `CellId`, enforcing the row/column pairing: a
 * colour row only with a paradigm column, an event row only with `play`.
 * Returns `null` rather than throwing — every caller is a validation site.
 */
export function parseCellId(raw: string): CellId | null {
	const i = raw.indexOf('|');
	if (i < 0 || raw.indexOf('|', i + 1) !== -1) return null;
	const row = raw.slice(0, i);
	const col = raw.slice(i + 1);
	if (row === '' || col === '') return null;
	if (COLOUR_ID_SET.has(row)) return PARADIGM_ID_SET.has(col) ? (raw as CellId) : null;
	if (EVENT_ID_SET.has(row)) return col === 'play' ? (raw as CellId) : null;
	return null;
}

export function isCellId(raw: string): raw is CellId {
	return parseCellId(raw) !== null;
}

/* ── Takes and the catalogue ────────────────────────────────────────── */

/**
 * A take's file path, relative to the server's `takes/` directory:
 * `<folder>/take-<suffix>.ogg`. The folder segment starts with a letter or
 * digit — see the module header for why that is the traversal gate, not an
 * incidental restriction.
 */
export const TAKE_FILE_RE = /^[a-z0-9][a-z0-9.-]*\/take-[a-z0-9-]+\.ogg$/;

/** The four bins the builder's pill tray groups takes into. */
export const SOUND_SECTIONS = ['Library', 'Land types', 'Moments', 'Colour sounds'] as const;
export type SoundSection = (typeof SOUND_SECTIONS)[number];

/** The most takes a single cell may hold. The builder's bin has no such cap. */
export const MAX_TAKES_PER_CELL = 32;

export const SoundTakeSchema = z.object({
	file: z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg'),
	/** The pill's grouping key — a colour id, an event id, a land-type id, or a library id. */
	sound: z.string().min(1),
	name: z.string().min(1),
	group: z.string().min(1),
	section: z.enum(SOUND_SECTIONS),
	label: z.string().min(1),
	seconds: z.number().positive(),
	prompt: z.string().min(1),
});
export type SoundTake = z.infer<typeof SoundTakeSchema>;

export const CatalogueSchema = z.object({
	takes: z.array(SoundTakeSchema),
});
export type Catalogue = z.infer<typeof CatalogueSchema>;

/* ── Assignments ─────────────────────────────────────────────────────── */

const CellsSchema = z.record(z.string(), z.array(z.string()).max(MAX_TAKES_PER_CELL));

const AssignmentsObjectSchema = z.object({
	cells: CellsSchema,
	canEdit: z.boolean(),
});

/**
 * `{ cells, canEdit }`. Every key of `cells` must be a valid `CellId` — Zod's
 * `z.record` validates each VALUE against its schema but not the key against
 * anything stronger than `z.string()`, so the pairing rule is re-checked here
 * with `superRefine` rather than silently trusted.
 */
export const AssignmentsSchema = AssignmentsObjectSchema.superRefine((value, ctx) => {
	for (const key of Object.keys(value.cells)) {
		if (!isCellId(key)) {
			ctx.addIssue({ code: 'custom', message: `not a valid cell id: ${key}`, path: ['cells', key] });
		}
	}
});
export type Assignments = z.infer<typeof AssignmentsObjectSchema>;

export const PutAssignmentBodySchema = z.object({
	files: z.array(z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg')).max(MAX_TAKES_PER_CELL),
});
export type PutAssignmentBody = z.infer<typeof PutAssignmentBodySchema>;
