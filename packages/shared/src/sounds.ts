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
 * the role ids (`SOUND_ROLES`), and `col` is one of the five paradigms (for a
 * colour row) or the literal `play` (for a role). `isCellId`/`parseCellId` are
 * the one place that pairing is checked — a colour row with `play`, or a role
 * with `spell`, is not a cell.
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
 * name. Ported from the operator-approved artifact
 * (`docs/handoff/snapshot/rows.json`, read-only reference — never read at
 * runtime by anything here).
 *
 * ## Roles are the generic layer
 *
 * `SOUND_ROLES` is every moment that makes a sound (`docs/planning/audio.md`).
 * A role's take always plays; a colour × paradigm take, when the event carries
 * one, mixes on top of it. Each role names the bus it plays on, so the mixer
 * can level interface, game and colour sounds against each other.
 */

import { z } from 'zod';

/* ── Rows, columns, roles — the one shared matrix ──────────────────── */

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

/** The mixer bus a sound plays on. Colour cells always play on `colour`. */
export type SoundBus = 'ui' | 'game' | 'colour' | 'music';

export interface SoundRole {
	readonly id: string;
	readonly name: string;
	readonly sub: string;
	readonly bus: Exclude<SoundBus, 'colour'>;
	/** Briefly lowers every other sound while it plays. */
	readonly duck?: boolean;
}

export interface SoundRoleGroup {
	readonly id: string;
	readonly name: string;
	readonly roles: readonly SoundRole[];
}

export interface ParadigmCol {
	readonly id: string;
	readonly name: string;
}

/**
 * The paradigm columns a colour-identity row carries. `basic` — a basic land —
 * is a mono row's only (the operator, 2026-10-10: *"split land and basic land
 * for mono colors"*): `land` is then every other land of that colour.
 */
export const PARADIGM_IDS = ['spell', 'creature', 'land', 'basic', 'artifact', 'artifact-creature'] as const;
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

const ui = (id: string, name: string, sub: string): SoundRole => ({ id, name, sub, bus: 'ui' });
const music = (id: string, name: string, sub: string): SoundRole => ({ id, name, sub, bus: 'music' });
const game = (id: string, name: string, sub: string, duck?: boolean): SoundRole =>
	duck === true ? { id, name, sub, bus: 'game', duck } : { id, name, sub, bus: 'game' };

type ManaColour = Exclude<ManaPip, 'C'>;
const MONO_COLOURS: readonly ManaColour[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * The ten colour pairs, in the order (and spelling) of `COLOUR_IDS`'s guild rows: each pair written the way
 * Magic writes it, allied pairs clockwise round the wheel (WU UB BR RG GW), then enemy pairs (WB UR BG RW GU).
 * `colourPair` turns any two colours, in either order, into this spelling.
 */
export const COLOUR_PAIRS = ['WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU'] as const;
export type ColourPair = (typeof COLOUR_PAIRS)[number];

/** The canonical spelling of the pair `a` and `b` make; `null` for one colour twice. */
export function colourPair(a: ManaColour, b: ManaColour): ColourPair | null {
	return COLOUR_PAIRS.find((p) => p === `${a}${b}` || p === `${b}${a}`) ?? null;
}

/**
 * The music a match plays for its viewer's deck colours — the operator, 2026-10-16 and 2026-10-17: a mono
 * deck plays its colour, a two-colour deck its pair, a three-colour deck one of the three pairs inside it,
 * and four or more any of them (`apps/ui/src/sound/match-music.ts`). A pair is spelled as in `COLOUR_PAIRS`.
 */
export function matchMusicRole<K extends ManaColour | ColourPair>(colours: K): `music.match.${K}` {
	return `music.match.${colours}`;
}

/** Every per-colour match music role: the five mono, then the ten pairs. */
export const MATCH_MUSIC_ROLES: readonly string[] = [
	...MONO_COLOURS.map((c) => matchMusicRole(c)),
	...COLOUR_PAIRS.map((p) => matchMusicRole(p)),
];

/**
 * The two styles a match slot's music comes in — the operator, 2026-10-18: *"2 tracks for every slot. one
 * 'normal' and one 16-bit"*, and *"by default normal, and players can select 16-bit from the options"*. The
 * music review picks one take per style (`./music-review.ts`), the player's setting picks the style
 * (`apps/ui/src/sound/mute.ts`), and the slot itself is still chosen by the deck's colours.
 */
export const MUSIC_STYLES = ['normal', 'chiptune'] as const;
export type MusicStyle = (typeof MUSIC_STYLES)[number];

/** `music.match.W` in a style: itself for normal, `music.match.W.16bit` for 16-bit. */
export function matchMusicStyleRole(role: string, style: MusicStyle): string {
	return style === 'chiptune' ? `${role}.16bit` : role;
}

const COLOUR_NAME: Readonly<Record<ManaColour, string>> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/** A match slot's normal role, then its 16-bit one, listed next to it in the builder. */
function withChiptune(normal: SoundRole): SoundRole[] {
	return [
		normal,
		music(
			matchMusicStyleRole(normal.id, 'chiptune'),
			`${normal.name}, 16-bit`,
			`Plays instead of ${normal.name.toLowerCase()} for a player who picked 16-bit music; that track plays when this one has no take.`,
		),
	];
}

/** Every role, grouped the way the builder lists them. */
export const SOUND_ROLE_GROUPS: readonly SoundRoleGroup[] = [
	{
		id: 'interface',
		name: 'Interface',
		roles: [
			ui('ui.hover-card', 'Hover a card', 'The pointer arrives on a card. Fires constantly; keep it faint.'),
			ui('ui.select', 'Select', 'A click that took effect.'),
			ui('ui.lift', 'Pick up a card', 'A press-drag takes a card in hand.'),
			ui('ui.place', 'Put a card down', 'A drag lands somewhere it may.'),
			ui('ui.deny', 'Refused', 'An illegal drop, target or control.'),
			ui('ui.target', 'Target locks', 'A targeting arrow settles on a target.'),
			ui('ui.pass', 'Pass / OK', 'Pass priority, OK, end turn.'),
			// Was "Your move", which read as the start of a turn (the operator, 2026-10-10); `g.turn-mine` is that.
			ui('ui.prompt', 'Decision needed', 'A question opens for you: the coin toss, a mulligan, a target, a yes or no.'),
			ui('ui.priority', 'Priority back to you', 'You hold priority again: a later window of your own turn, or any window on theirs.'),
			ui('ui.inspect', 'Inspect', 'The expanded card view opens.'),
			ui('ui.draft-pick', 'Draft pick', 'A pick is taken in the draft.'),
		],
	},
	{
		id: 'stack',
		name: 'Casting and the stack',
		roles: [
			game('g.cast.creature', 'Cast a creature', 'A creature spell goes on the stack. Quiet, colourless.'),
			game('g.cast.instant', 'Cast an instant', 'An instant goes on the stack.'),
			game('g.cast.sorcery', 'Cast a sorcery', 'A sorcery goes on the stack.'),
			game('g.cast.artifact', 'Cast an artifact', 'An artifact spell goes on the stack.'),
			game('g.cast.enchantment', 'Cast an enchantment', 'An enchantment spell goes on the stack.'),
			game('g.cast.planeswalker', 'Cast a planeswalker', 'A planeswalker spell goes on the stack.'),
			game('g.cast.battle', 'Cast a battle', 'A battle spell goes on the stack.'),
			game('g.ability', 'Ability', 'An activated or triggered ability goes on the stack.'),
			game('g.resolve', 'Resolves', 'The top of the stack resolves.'),
			game('g.counter', 'Countered', 'A spell leaves the stack without resolving.'),
		],
	},
	{
		id: 'battlefield',
		name: 'On the battlefield',
		roles: [
			game('g.land', 'Play a land', 'You play a land from your hand. Its colour cell (its land, or its basic) plays on top.'),
			game('g.creature', 'Creature voice', "A creature resolves. The colour layer is the colour's creature cell."),
			// Not lands: a played land is `g.land` alone. "Lands on the table" read as the card type (the operator, 2026-10-11).
			game('g.enter', 'Hits the table', 'Any other permanent arrives: the thud after a creature’s voice, an artifact, an enchantment.'),
			game('g.token', 'Token appears', 'A token is created.'),
			game('g.tap', 'Tap', 'A permanent turns sideways. Untapping plays it backwards.'),
			game('g.counter-on', 'Counter added', 'A +1/+1, loyalty or other counter is put on.'),
			game('g.counter-off', 'Counter removed', 'A counter comes off.'),
			game('g.attach', 'Attach', 'An aura or equipment attaches.'),
			game('g.transform', 'Transform', 'A card flips or transforms.'),
		],
	},
	{
		id: 'zones',
		name: 'Cards moving',
		roles: [
			game('g.draw', 'Draw', 'A card moves from library to hand.'),
			game('g.shuffle', 'Shuffle', 'A library is shuffled.'),
			game('g.dies', 'Creature dies', 'A creature goes to the graveyard.'),
			game('g.destroy', 'Destroyed', 'A non-creature permanent goes to the graveyard.'),
			game('g.exile', 'Exile', 'A card is exiled.'),
			game('g.bounce', 'Returned to hand', 'A permanent returns to its owner’s hand.'),
			game('g.discard', 'Discard', 'A card is discarded.'),
			game('g.mill', 'Mill', 'Cards go from library to graveyard.'),
			game('g.reanimate', 'Reanimate', 'A card returns from the graveyard to the battlefield.'),
		],
	},
	{
		id: 'combat',
		name: 'Combat and life',
		roles: [
			game('g.attack', 'Attack', 'Attackers are declared.'),
			game('g.block', 'Block', 'Blockers are declared.'),
			game('g.damage', 'Damage to a creature', 'A creature takes damage.'),
			game('g.damage-player', 'Damage to a player', 'A player or planeswalker loses life to damage.'),
			game('g.charge', 'Charge at a player', 'An unblocked attacker launches at the player it hits. Louder and lower the more damage it deals.'),
			game('g.crash', 'Creatures collide', 'The blow of a creature ramming another, or a player: plays on top of the damage. Louder and lower the more damage.'),
			game('g.crumble', 'Cracks and crumbles', 'A creature killed by damage cracks and crumbles to dust: plays on top of Creature dies.'),
			game('g.lifegain', 'Life gain', 'A player gains life.'),
		],
	},
	{
		id: 'turn',
		name: 'Turn and game',
		roles: [
			game('g.match-start', 'Game start', 'Both players are ready and the room starts the match, before the coin toss.', true),
			// The id predates `g.match-start`; it stays so the operator's placements keep their cell.
			game('g.game-start', 'Coin toss', 'The coin flips to settle who goes first, on both screens.'),
			game('g.mulligan', 'Mulligan', 'A hand goes back.'),
			game('g.turn-mine', 'Your turn', 'Your turn begins.', true),
			game('g.phase', 'Phase change', 'The game moves to the next step.'),
			game('g.win', 'Victory', 'You win the game.', true),
			game('g.lose', 'Defeat', 'You lose the game.', true),
		],
	},
	{
		id: 'music',
		name: 'Music',
		roles: [
			music('music.lobby', 'Lobby and draft', 'Loops on the room list, in a draft and while building a deck.'),
			music('music.match', 'In a match', 'Loops for the length of a game.'),
			...MONO_COLOURS.flatMap((colour) => {
				const name = COLOUR_NAME[colour];
				return withChiptune(music(matchMusicRole(colour), `In a match: ${name}`, `Loops for a game played with a ${name} deck.`));
			}),
			...COLOUR_PAIRS.flatMap((pair) => {
				const name = `${COLOUR_NAME[pair[0] as ManaColour]}-${COLOUR_NAME[pair[1] as ManaColour]}`;
				return withChiptune(
					music(
						matchMusicRole(pair),
						`In a match: ${name}`,
						`Loops for a game played with a ${name} deck, and sometimes with a three-colour deck that holds both.`,
					),
				);
			}),
		],
	},
];

/** Every role by id. */
export const SOUND_ROLES: ReadonlyMap<string, SoundRole> = new Map(
	SOUND_ROLE_GROUPS.flatMap((g) => g.roles.map((r) => [r.id, r] as const)),
);

/**
 * Events that play another role's take backwards and so have no cell of their own. Untap is always Tap
 * reversed (the operator, 2026-10-15: *"untap should always be the reverse of tap, doesn't need its own sound"*).
 */
export const REVERSED_ROLES: Readonly<Record<string, string>> = { 'g.untap': 'g.tap' };

/** `<ColourId>|<ParadigmId>` or `<role id>|play`. Validated by `isCellId`. */
export type CellId = `${ColourId}|${ParadigmId}` | `${string}|play`;

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
} = {
	paradigms: [
		{ id: 'spell', name: 'Spell' },
		{ id: 'creature', name: 'Creature' },
		{ id: 'land', name: 'Land' },
		{ id: 'basic', name: 'Basic land' },
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
};

const COLOUR_ID_SET: ReadonlySet<string> = new Set(COLOUR_IDS);
const PARADIGM_ID_SET: ReadonlySet<string> = new Set(PARADIGM_IDS);
/** The rows that carry a `basic` cell: one basic land each. */
export const MONO_COLOUR_IDS: readonly ColourId[] = ['W', 'U', 'B', 'R', 'G'];
const MONO_SET: ReadonlySet<string> = new Set(MONO_COLOUR_IDS);

/** The columns only the colourless row carries: an artifact sounds the same whatever its colours (2026-10-10). */
const COLOURLESS_ONLY: ReadonlySet<string> = new Set(['artifact', 'artifact-creature']);

/**
 * Whether a colour row carries this paradigm column: `basic` is a mono row's
 * only, `artifact` and `artifact-creature` the colourless row's only (the
 * operator: *"artifact & artifact creature do not need seperate sounds in color
 * identities. just the colorless versions are fine"*), every other column is
 * every row's.
 */
export function rowHasParadigm(row: string, paradigm: string): boolean {
	if (!PARADIGM_ID_SET.has(paradigm)) return false;
	if (paradigm === 'basic') return MONO_SET.has(row);
	if (COLOURLESS_ONLY.has(paradigm)) return row === 'C';
	return true;
}

/**
 * Parse a raw string as a `CellId`, enforcing the row/column pairing: a
 * colour row only with a paradigm column, a role only with `play`.
 * Returns `null` rather than throwing — every caller is a validation site.
 */
export function parseCellId(raw: string): CellId | null {
	const i = raw.indexOf('|');
	if (i < 0 || raw.indexOf('|', i + 1) !== -1) return null;
	const row = raw.slice(0, i);
	const col = raw.slice(i + 1);
	if (row === '' || col === '') return null;
	if (COLOUR_ID_SET.has(row)) return rowHasParadigm(row, col) ? (raw as CellId) : null;
	if (SOUND_ROLES.has(row)) return col === 'play' ? (raw as CellId) : null;
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

/** The five bins the builder's pill tray groups takes into. */
export const SOUND_SECTIONS = ['Library', 'Land types', 'Moments', 'Colour sounds', 'Music'] as const;
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

/** A cell's level relative to the others, 0..2; a missing entry is 1. */
export const GainSchema = z.number().min(0).max(2);
const GainsSchema = z.record(z.string(), GainSchema);

const AssignmentsObjectSchema = z.object({
	cells: CellsSchema,
	gains: GainsSchema.default({}),
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
	for (const key of Object.keys(value.gains)) {
		if (!isCellId(key)) {
			ctx.addIssue({ code: 'custom', message: `not a valid cell id: ${key}`, path: ['gains', key] });
		}
	}
});
export type Assignments = z.output<typeof AssignmentsObjectSchema>;

export const PutAssignmentBodySchema = z.object({
	files: z.array(z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg')).max(MAX_TAKES_PER_CELL),
	/** Omitted leaves the stored gain as it is. */
	gain: GainSchema.optional(),
});
export type PutAssignmentBody = z.infer<typeof PutAssignmentBodySchema>;

/**
 * Why a take was retired from the catalogue (the operator, 2026-10-10: *"some
 * sounds are broken and dont need to exist anymore. some sounds are just bad"*).
 * `broken` is a defect — silence, a glitch, a cut — and points at generation or
 * finishing; `bad` is taste, and points at the prompt. Both are logged, as
 * feedback for the next batch.
 */
export const RETIRE_REASONS = ['bad', 'broken'] as const;
export type RetireReason = (typeof RETIRE_REASONS)[number];

/** `POST /api/sounds/retire`. */
export const RetireBodySchema = z.object({
	file: z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg'),
	reason: z.enum(RETIRE_REASONS),
});
export type RetireBody = z.infer<typeof RetireBodySchema>;

/**
 * A mark on a take, set from the picker (the operator, 2026-10-10: *"i need a
 * way to mark sounds as keep but not assign them … middle mouse for keep and
 * right click for delete … we'll do the actual delete harvesting manually
 * later"*). Only a label: nothing is removed. Stored in `marks.json`.
 */
export const SOUND_MARKS = ['keep', 'trash'] as const;
export type SoundMark = (typeof SOUND_MARKS)[number];
export const MarksSchema = z.object({ marks: z.record(z.string().regex(TAKE_FILE_RE), z.enum(SOUND_MARKS)) });
/** `PUT /api/sounds/marks`: `mark: null` clears it. */
export const PutMarkBodySchema = z.object({
	file: z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg'),
	mark: z.enum(SOUND_MARKS).nullable(),
});

/** `POST /api/sounds/restore`: undo the last retirement of a file. */
export const RestoreBodySchema = z.object({
	file: z.string().regex(TAKE_FILE_RE, 'file must be <folder>/take-<suffix>.ogg'),
});
