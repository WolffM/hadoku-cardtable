/**
 * The Gauntlet: a pure state machine, stored on a Constructed room and driven
 * by `http/routes.ts` (`docs/planning/constructed-modes-plan.md`, "Gauntlet").
 *
 *   options → reveal → banpick → choose → playing → (choose → playing)* → done (→ options)
 *
 * - **options**: the leader's family/era (or random) are the room's mode
 *   options; each seat readies here, with the table seat's own Ready
 *   (`room/seats.ts`).
 * - **reveal**: both seats ready, so the era, ten distinct decks of it and the
 *   coin flip are drawn — once, and kept, so a reconnect replays the same
 *   reveal. Nothing can be acted on until the room starts the ban/pick.
 * - **banpick**: `GAUNTLET_SNAKE`, one deck per act. Out-of-turn acts, the
 *   wrong act and taken decks are refused.
 * - **choose**: before every game both seats secretly choose one of their own
 *   unplayed picks; once both have, the game is `playing`. A seat with one
 *   unplayed pick has nothing to choose.
 * - **playing**: one normal Forge match with the two chosen decks. The room's
 *   series says whether that game decided it — `gameOver` is told, never
 *   counts wins itself.
 * - **done**: the result, kept for the room to show. It holds nothing an
 *   unfinished Gauntlet does (`gauntletHoldsTable`), and a seat's next Ready
 *   begins a new one.
 *
 * A deck choice is its chooser's alone until its game is over (ruling 9):
 * `viewOfGauntlet` is the one place the state is shown to anyone, and it names
 * the game under way's decks only to the seat that chose each, and marks a
 * deck played only once its game is over.
 *
 * Every function returns a new state and never mutates its input. Randomness
 * is injected (`random`, [0, 1)), so the draw and the AI are reproducible in
 * tests.
 */

import {
	GAUNTLET_DECKS,
	GAUNTLET_PHASES,
	GAUNTLET_SNAKE,
	pickRandom,
	type GauntletAct,
	type GauntletDeck,
	type GauntletEra,
	type GauntletOptions,
	type GauntletPhase,
	type GauntletPlayer,
	type GauntletSeatIndex,
	type GauntletView,
} from '@hadoku/shared';

/** Where a drawn deck stands: null while open. */
type GauntletMark = { act: GauntletAct; by: GauntletSeatIndex } | null;

/** What the room stores. JSON all the way down. */
export interface GauntletState {
	phase: GauntletPhase;
	/** Fixed at the draw. */
	players: [GauntletPlayer, GauntletPlayer] | null;
	era: GauntletEra | null;
	/** When the reveal started, epoch ms; null before the draw. */
	revealAt: number | null;
	/** The coin flip: the table seat that is P1. */
	first: GauntletSeatIndex | null;
	/** The ten drawn deck ids, in draw order. */
	decks: string[];
	/** Aligned with `decks`. */
	marks: GauntletMark[];
	/** Into `GAUNTLET_SNAKE`; `taken` is how many decks the current step has taken. */
	stepIndex: number;
	taken: number;
	/** Every game whose decks have been revealed, by table seat, and its winner once it is over. */
	games: { decks: [string, string]; winner: GauntletSeatIndex | null }[];
	/** The hidden choices of the game about to be played. */
	choices: [string | null, string | null];
	winner: GauntletSeatIndex | null;
}

function isSeat(v: unknown): v is GauntletSeatIndex {
	return v === 0 || v === 1;
}

function isPair(v: unknown, item: (x: unknown) => boolean): boolean {
	return Array.isArray(v) && v.length === 2 && v.every(item);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isPlayer = (v: unknown): boolean =>
	typeof v === 'object' && v !== null && isString((v as GauntletPlayer).name) && ((v as GauntletPlayer).memberId === null || isString((v as GauntletPlayer).memberId));
const isMark = (v: unknown): boolean => v === null || (typeof v === 'object' && ((v as { act: unknown }).act === 'ban' || (v as { act: unknown }).act === 'pick') && isSeat((v as { by: unknown }).by));

/** A stored Gauntlet this build understands. The lobby quarantines a room whose record fails it. */
export function isGauntletState(v: unknown): v is GauntletState {
	if (typeof v !== 'object' || v === null) return false;
	const g = v as Record<string, unknown>;
	const era = g.era as Record<string, unknown> | null;
	return (
		(GAUNTLET_PHASES as readonly unknown[]).includes(g.phase) &&
		(g.players === null || isPair(g.players, isPlayer)) &&
		(era === null || (typeof era === 'object' && isString(era.id) && isString(era.family) && isString(era.title))) &&
		(g.first === null || isSeat(g.first)) &&
		Array.isArray(g.decks) &&
		g.decks.every(isString) &&
		Array.isArray(g.marks) &&
		g.marks.length === g.decks.length &&
		g.marks.every(isMark) &&
		Number.isInteger(g.stepIndex) &&
		Number.isInteger(g.taken) &&
		Array.isArray(g.games) &&
		(g.revealAt === null || Number.isInteger(g.revealAt)) &&
		g.games.every((x) => typeof x === 'object' && x !== null && isPair((x as { decks: unknown }).decks, isString) && ((x as { winner: unknown }).winner === null || isSeat((x as { winner: unknown }).winner))) &&
		isPair(g.choices, (x) => x === null || isString(x)) &&
		(g.winner === null || isSeat(g.winner))
	);
}

/** An era a Gauntlet can be drawn in, with its library decks. */
export interface GauntletEraPool extends GauntletEra {
	readonly decks: readonly string[];
}

/** What the view says about a deck besides its status: the room deck tile's and its peek's data. */
export type GauntletDeckInfo = Omit<GauntletDeck, 'status' | 'by' | 'played'>;

type GauntletRefusal =
	| 'drawn'
	| 'no-era'
	| 'not-banpick'
	| 'not-your-turn'
	| 'wrong-act'
	| 'no-such-deck'
	| 'taken'
	| 'not-choose'
	| 'not-yours'
	| 'played'
	| 'not-playing';

export type GauntletResult = { ok: true; state: GauntletState } | { ok: false; reason: GauntletRefusal };

const FAMILY_TITLES: Readonly<Record<string, string>> = { standard: 'Standard', modern: 'Modern', legacy: 'Legacy' };

function eraTitle(id: string, family: string): string {
	const year = /(\d{4})-\d{2}-\d{2}$/.exec(id)?.[1] ?? id;
	return `${FAMILY_TITLES[family] ?? family} — ${year}`;
}

/**
 * The eras a Gauntlet is offered and drawn in: every era of the library with
 * at least `GAUNTLET_DECKS` decks, in the library's own order. Fewer and the
 * draw could not deal ten distinct decks.
 */
export function gauntletEras(formats: readonly { id: string; family: string }[], decks: readonly { id: string; era: string }[]): GauntletEraPool[] {
	const byEra = new Map<string, string[]>();
	for (const d of decks) {
		const list = byEra.get(d.era);
		if (list === undefined) byEra.set(d.era, [d.id]);
		else list.push(d.id);
	}
	return formats.flatMap((f) => {
		const ids = byEra.get(f.id) ?? [];
		return ids.length >= GAUNTLET_DECKS ? [{ id: f.id, family: f.family, title: eraTitle(f.id, f.family), decks: ids }] : [];
	});
}

export function newGauntlet(): GauntletState {
	return {
		phase: 'options',
		players: null,
		era: null,
		revealAt: null,
		first: null,
		decks: [],
		marks: [],
		stepIndex: 0,
		taken: 0,
		games: [],
		choices: [null, null],
		winner: null,
	};
}

/** One of `items`, which is never empty where this is called. */
function pickOne<T>(items: readonly T[], random: () => number): T {
	return pickRandom(items, random)!;
}

/**
 * The Gauntlet a seat's Ready acts on: the one in options. After a decided
 * Gauntlet a Ready begins the next one: the result stays on screen until
 * somebody readies again.
 */
export function readyFor(state: GauntletState): GauntletResult {
	const from = state.phase === 'done' ? newGauntlet() : state;
	return from.phase === 'options' ? { ok: true, state: from } : { ok: false, reason: 'drawn' };
}

/**
 * From the draw until it is decided the Gauntlet's seats are fixed: nobody sits
 * or stands, and its decks are dealt. Before the draw, and once decided, the
 * table is the room's again (ruling 13).
 */
export function gauntletHoldsTable(state: GauntletState): boolean {
	return state.phase !== 'options' && state.phase !== 'done';
}

/**
 * Draw the era, ten distinct decks of it and the coin flip. With no options
 * the family is drawn first, then an era of it, as a new room's random era is
 * (`lobby.ts`'s `randomFormat`), so a family with many eras does not crowd the
 * others out.
 */
export function drawGauntlet(
	state: GauntletState,
	input: { players: [GauntletPlayer, GauntletPlayer]; eras: readonly GauntletEraPool[]; options: GauntletOptions; random: () => number; now: number },
): GauntletResult {
	if (state.phase !== 'options') return { ok: false, reason: 'drawn' };
	const { options, random } = input;
	const eligible = input.eras.filter(
		(e) => e.decks.length >= GAUNTLET_DECKS && (options.era === undefined || e.id === options.era) && (options.family === undefined || e.family === options.family),
	);
	if (eligible.length === 0) return { ok: false, reason: 'no-era' };
	const families = [...new Set(eligible.map((e) => e.family))];
	const family = pickOne(families, random);
	const pool = pickOne(
		eligible.filter((e) => e.family === family),
		random,
	);
	const deck = [...pool.decks];
	for (let i = 0; i < GAUNTLET_DECKS; i++) {
		const j = i + Math.min(deck.length - i - 1, Math.floor(random() * (deck.length - i)));
		[deck[i], deck[j]] = [deck[j]!, deck[i]!];
	}
	const decks = deck.slice(0, GAUNTLET_DECKS);
	return {
		ok: true,
		state: {
			...state,
			phase: 'reveal',
			players: input.players,
			era: { id: pool.id, family: pool.family, title: pool.title },
			revealAt: input.now,
			first: random() < 0.5 ? 0 : 1,
			decks,
			marks: decks.map(() => null),
			stepIndex: 0,
			taken: 0,
		},
	};
}

/** The reveal is over: the first step of the snake is open. */
export function startBanpick(state: GauntletState): GauntletState {
	return state.phase === 'reveal' ? { ...state, phase: 'banpick' } : state;
}

function stepSeat(state: GauntletState, player: 'p1' | 'p2'): GauntletSeatIndex {
	const first = state.first ?? 0;
	return player === 'p1' ? first : first === 0 ? 1 : 0;
}

function unplayedPicks(state: GauntletState, seat: GauntletSeatIndex): string[] {
	const played = new Set(state.games.flatMap((g) => g.decks));
	return state.decks.filter((d, i) => state.marks[i]?.act === 'pick' && state.marks[i]?.by === seat && !played.has(d));
}

/**
 * Into `choose` for the next game. A seat left with one unplayed pick has
 * nothing to choose and is given it; when both are, the game is revealed at
 * once.
 */
function enterChoose(state: GauntletState): GauntletState {
	const choices: [string | null, string | null] = [null, null];
	for (const seat of [0, 1] as const) {
		const left = unplayedPicks(state, seat);
		if (left.length === 1) choices[seat] = left[0]!;
	}
	return revealIfBoth({ ...state, phase: 'choose', choices });
}

function revealIfBoth(state: GauntletState): GauntletState {
	const [a, b] = state.choices;
	if (a === null || b === null) return state;
	return { ...state, phase: 'playing', games: [...state.games, { decks: [a, b], winner: null }], choices: [null, null] };
}

/** A seat bans or picks one deck. */
export function act(state: GauntletState, seat: GauntletSeatIndex, kind: GauntletAct, deckId: string): GauntletResult {
	if (state.phase !== 'banpick') return { ok: false, reason: 'not-banpick' };
	const step = GAUNTLET_SNAKE[state.stepIndex]!;
	if (stepSeat(state, step.player) !== seat) return { ok: false, reason: 'not-your-turn' };
	if (step.act !== kind) return { ok: false, reason: 'wrong-act' };
	const at = state.decks.indexOf(deckId);
	if (at < 0) return { ok: false, reason: 'no-such-deck' };
	if (state.marks[at] !== null) return { ok: false, reason: 'taken' };
	const marks = state.marks.map((m, i) => (i === at ? { act: kind, by: seat } : m));
	const taken = state.taken + 1;
	if (taken < step.count) return { ok: true, state: { ...state, marks, taken } };
	const stepIndex = state.stepIndex + 1;
	const next = { ...state, marks, stepIndex, taken: 0 };
	return { ok: true, state: stepIndex < GAUNTLET_SNAKE.length ? next : enterChoose(next) };
}

/** A seat's hidden choice of its deck for the next game. It may change its mind until both have chosen. */
export function choose(state: GauntletState, seat: GauntletSeatIndex, deckId: string): GauntletResult {
	if (state.phase !== 'choose') return { ok: false, reason: 'not-choose' };
	const at = state.decks.indexOf(deckId);
	const mark = at < 0 ? null : state.marks[at];
	if (mark?.act !== 'pick' || mark.by !== seat) return { ok: false, reason: 'not-yours' };
	if (state.games.some((g) => g.decks.includes(deckId))) return { ok: false, reason: 'played' };
	const choices: [string | null, string | null] = [...state.choices];
	choices[seat] = deckId;
	return { ok: true, state: revealIfBoth({ ...state, choices }) };
}

/** The decks the game under way is played with, by table seat; null unless `playing`. */
export function gameDecks(state: GauntletState): [string, string] | null {
	return state.phase === 'playing' ? (state.games.at(-1)?.decks ?? null) : null;
}

/** The game under way has ended. The room's series says whether it decided the match. */
export function gameOver(state: GauntletState, result: { seriesOver: boolean; winner: GauntletSeatIndex | null }): GauntletResult {
	if (state.phase !== 'playing') return { ok: false, reason: 'not-playing' };
	const played = { ...state, games: state.games.map((g, i) => (i === state.games.length - 1 ? { ...g, winner: result.winner } : g)) };
	if (result.seriesOver || unplayedPicks(played, 0).length === 0 || unplayedPicks(played, 1).length === 0) {
		// Decided: the result is kept.
		return { ok: true, state: { ...played, phase: 'done', winner: result.winner } };
	}
	return { ok: true, state: enterChoose(played) };
}

/** The AI's seat, or null in a Gauntlet between two people. */
export function aiSeat(state: GauntletState): GauntletSeatIndex | null {
	const at = state.players?.findIndex((p) => p.memberId === null) ?? -1;
	return at === 0 || at === 1 ? at : null;
}

/** The table seat a member holds in this Gauntlet, or null. */
export function seatOfMember(state: GauntletState, memberId: string): GauntletSeatIndex | null {
	const at = state.players?.findIndex((p) => p.memberId === memberId) ?? -1;
	return at === 0 || at === 1 ? at : null;
}

/** What the AI does next, chosen at random among what is open to it; null when it is not its move. */
export function aiMove(state: GauntletState, random: () => number): { kind: 'act'; act: GauntletAct; deck: string } | { kind: 'choose'; deck: string } | null {
	const seat = aiSeat(state);
	if (seat === null) return null;
	if (state.phase === 'banpick') {
		const step = GAUNTLET_SNAKE[state.stepIndex]!;
		if (stepSeat(state, step.player) !== seat) return null;
		const open = state.decks.filter((_, i) => state.marks[i] === null);
		return { kind: 'act', act: step.act, deck: pickOne(open, random) };
	}
	if (state.phase === 'choose' && state.choices[seat] === null) {
		return { kind: 'choose', deck: pickOne(unplayedPicks(state, seat), random) };
	}
	return null;
}

/** The game under way, while `playing`: the last of `games`, the one game that is not over. */
function underWay(state: GauntletState, index: number): boolean {
	return state.phase === 'playing' && index === state.games.length - 1;
}

/**
 * What `viewer` (a table seat, or null for anyone else in the room) is shown,
 * beside the table seats' Readys. The game under way names only the viewer's
 * own deck, and only a game that is over plays its decks: before then nothing
 * here depends on the other seat's choice.
 */
export function viewOfGauntlet(state: GauntletState, viewer: GauntletSeatIndex | null, ready: [boolean, boolean], deckInfo: (id: string) => GauntletDeckInfo): GauntletView {
	const played = new Set(state.games.flatMap((g, i) => (underWay(state, i) ? [] : g.decks)));
	const step = state.phase === 'banpick' ? GAUNTLET_SNAKE[state.stepIndex]! : null;
	return {
		phase: state.phase,
		you: viewer,
		players: state.players,
		ready,
		era: state.era,
		revealAt: state.revealAt,
		first: state.first,
		decks: state.decks.map((id, i) => {
			const mark = state.marks[i] ?? null;
			return {
				...deckInfo(id),
				status: mark === null ? 'open' : mark.act === 'ban' ? 'banned' : 'picked',
				by: mark?.by ?? null,
				played: played.has(id),
			};
		}),
		step: step === null ? null : { index: state.stepIndex, seat: stepSeat(state, step.player), act: step.act, count: step.count, taken: state.taken },
		games: state.games.map((g, i) => (underWay(state, i) ? { ...g, decks: [viewer === 0 ? g.decks[0] : null, viewer === 1 ? g.decks[1] : null] } : g)),
		choice:
			state.phase === 'choose'
				? { mine: viewer === null ? null : state.choices[viewer], chosen: [state.choices[0] !== null, state.choices[1] !== null] }
				: null,
		winner: state.winner,
	};
}
