/**
 * What a card noted during the draft is read in the match, against real Forge.
 *
 * Fourteen cards read their drafter's notes when they are played. Forge takes
 * the notes from the deck file's `DraftNotes` metadata (`DeckFileHeader.java:124`)
 * and hands them to the player as the match starts (`Match.java:361`). Each
 * test here starts a match from a `.dck` whose `DraftNotes` line is written the
 * way `@hadoku/deck`'s `serializeDraftNotes` writes a seat's notes, puts the
 * card on a scripted board, and reads what Forge then does with it.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/draft-notes \
 *   pnpm exec vitest run games/magic/server/src/play/draft-notes.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { withDraftNotes } from '@hadoku/deck';
import type { ServerFrame } from '@hadoku/forge-wire';
import { DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';
import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, finishMulligan, inOwnMain, passUntil, startScenario, toDeclareAttackers, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? "a drafted deck's notes are read in the match, against real Forge" : `a drafted deck's notes are read in the match, against real Forge — SKIPPED: ${available.reason}`;

const MOUNTAINS = Array.from({ length: 10 }, () => 'Mountain').join(';');
const lands = (name: string, n: number): string[] => Array.from({ length: n }, () => name);

/** A deck of Mountains whose `DraftNotes` are these, written as a drafted deck's are. */
function notedDeck(notes: Record<string, string[]>): string {
	return withDraftNotes(deck('Drafted', ['40 Mountain']), notes);
}

interface Board {
	hand?: string[];
	battlefield: string[];
	library?: string;
	theirs?: string[];
}

/** Seat 0's first main phase on a scripted board; seat 1 holds `theirs`. */
function board(b: Board): string {
	return `${[
		'turn=1',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		`humanhand=${(b.hand ?? []).join(';')}`,
		`humanbattlefield=${b.battlefield.join(';')}`,
		`humanlibrary=${b.library ?? MOUNTAINS}`,
		'humangraveyard=',
		'aihand=',
		`aibattlefield=${['Mountain', ...(b.theirs ?? [])].join(';')}`,
		`ailibrary=${MOUNTAINS}`,
		'aigraveyard=',
	].join('\n')}\n`;
}

async function start(notes: Record<string, string[]>, b: Board, reply?: (f: ServerFrame & Record<string, unknown>) => unknown): Promise<Scenario> {
	if (!available.ok) throw new Error('unreachable: the suite is skipped without a jar');
	const s = await startScenario(available.config, {
		seed: 2026,
		decks: [notedDeck(notes), deck('Mountains', ['40 Mountain'])],
		scenario: board(b),
		...(reply === undefined ? {} : { reply }),
	});
	await finishMulligan(s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'seat 0 to hold priority in its first main phase', 60_000, s);
	return s;
}

interface Face {
	power: number | undefined;
	toughness: number | undefined;
	keywords: string[];
}

/** A card's current face as seat 0 holds it on the wire. */
function faceOf(s: Scenario, id: number): Face {
	const state = s.state(0);
	const view = state.get(deltaKey(DELTA_TYPE.card, id));
	const current = view?.CurrentState as { v?: number } | undefined;
	const face = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
	return {
		power: (face?.Power as { v?: number } | undefined)?.v,
		toughness: (face?.Toughness as { v?: number } | undefined)?.v,
		keywords: ((face?.Keywords as { v?: string[] } | undefined)?.v ?? []).slice().sort(),
	};
}

function mine(s: Scenario, name: string, zone: 'Hand' | 'Battlefield' | 'Graveyard' = 'Battlefield') {
	return s.zone(0, zone).filter((c) => c.name === name);
}

function theirs(s: Scenario, name: string, zone: 'Battlefield' | 'Graveyard' = 'Battlefield') {
	return s.zone(1, zone).filter((c) => c.name === name);
}

function nameOf(s: Scenario, id: number): string {
	for (const seat of [0, 1]) for (const c of s.zone(seat, 'Battlefield')) if (c.id === id) return c.name;
	return `#${id}`;
}

function life(s: Scenario, seat: number): number | undefined {
	return (s.state(0).get(deltaKey(DELTA_TYPE.player, s.match.seats[seat]?.playerId ?? -1))?.Life as { v?: number } | undefined)?.v;
}

/**
 * Seat 0 plays `source` (a card in hand, or a permanent's ability) at the creature `target`. Returns
 * the names of every creature Forge offered as a legal target, and resolves once `done()`.
 */
async function playAt(s: Scenario, source: number, target: string, done: () => boolean): Promise<string[]> {
	const from = s.sent.length;
	s.select(0, source);
	let offered: string[] | null = null;
	await waitUntil(() => {
		s.answerAsks();
		if (offered === null) {
			const frame = s.sent.slice(from).find((x) => x.seat === 0 && x.envelope.frame.method === 'setSelectables')?.envelope.frame as { cards?: { id: number }[] } | undefined;
			if (frame === undefined) return false;
			offered = (frame.cards ?? []).map((c) => nameOf(s, c.id)).sort();
			const aimed = [...s.zone(0, 'Battlefield'), ...s.zone(1, 'Battlefield')].find((c) => c.name === target);
			if (aimed === undefined) throw new Error(`no ${target} to aim at`);
			s.select(0, aimed.id);
		}
		return done() && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
	}, `seat 0's play at ${target} to resolve`, 60_000, s);
	return offered ?? [];
}

/**
 * Seat 0 casts `name` from hand and goes along with everything its trigger then puts to it, once
 * each: yes to a question on the prompt bar, the first card of a selection Forge opens, OK to close
 * it, and every other ask answered plainly, until `done()`. Returns the names of the cards each
 * selection offered.
 */
async function castGoingAlong(s: Scenario, name: string, done: () => boolean): Promise<string[][]> {
	const card = mine(s, name, 'Hand')[0];
	if (card === undefined) throw new Error(`no ${name} in hand`);
	const from = s.sent.length;
	s.select(0, card.id);
	let pressed = -1;
	let picked = from;
	const offered: string[][] = [];
	await waitUntil(() => {
		s.answerAsks();
		const selection = s.sent.findIndex((x, i) => i > picked && x.seat === 0 && x.envelope.frame.method === 'setSelectables');
		if (selection !== -1) {
			picked = selection;
			const ids = ((s.sent[selection]!.envelope.frame as { cards?: { id: number }[] }).cards ?? []).map((c) => c.id);
			offered.push(ids.map((id) => s.zone(0, 'Hand').find((c) => c.id === id)?.name ?? `#${id}`));
			if (ids[0] !== undefined) s.select(0, ids[0]);
		}
		const at = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
		const bar = s.buttons(0);
		const priority = s.prompt(0).startsWith('Priority:');
		if (at > pressed && !priority && bar?.enable1 === true) {
			pressed = at;
			s.ok(0);
		}
		return done() && priority && /^Stack: Empty$/m.test(s.prompt(0)) && bar?.enable1 === true;
	}, `seat 0's ${name} and its trigger to resolve`, 60_000, s);
	return offered;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Lurking Automaton and Pyretic Hunter enter with the highest number noted for them, Cogwork Grinder with one counter a card it removed',
		async () => {
			const s = await start(
				{ 'Lurking Automaton': ['3', '7'], 'Pyretic Hunter': ['5', '2'], 'Cogwork Grinder': ['Island', 'Borborygmos, Enraged', 'Island'] },
				{ hand: ['Lurking Automaton', 'Pyretic Hunter', 'Cogwork Grinder'], battlefield: lands('Mountain', 16) },
			);
			try {
				for (const name of ['Lurking Automaton', 'Pyretic Hunter', 'Cogwork Grinder']) await castNamed(s, 0, name);
				const sizes = Object.fromEntries(['Lurking Automaton', 'Pyretic Hunter', 'Cogwork Grinder'].map((name) => [name, mine(s, name).map((c) => faceOf(s, c.id).power)]));
				console.log(`[draft-notes.jvm] counters: ${JSON.stringify(sizes)}`);
				expect(sizes).toEqual({ 'Lurking Automaton': [7], 'Pyretic Hunter': [5], 'Cogwork Grinder': [3] });
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'with nothing noted, Lurking Automaton enters with no counters and dies, and Spire Phantasm draws nothing',
		async () => {
			const s = await start({}, { hand: ['Lurking Automaton', 'Spire Phantasm'], battlefield: [...lands('Mountain', 6), ...lands('Island', 6)] });
			try {
				await castNamed(s, 0, 'Lurking Automaton');
				await waitUntil(() => mine(s, 'Lurking Automaton', 'Graveyard').length === 1, 'the Automaton with no counters to die', 20_000, s);
				await castNamed(s, 0, 'Spire Phantasm');
				expect(mine(s, 'Spire Phantasm')).toHaveLength(1);
				expect(s.zone(0, 'Hand')).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Noble Banneret and the creature it noted get +1/+1 and lifelink, Paliano Vanguard pumps the type it noted, Animus of Predation has the keywords it noted',
		async () => {
			const s = await start(
				{ 'Noble Banneret': ['Grizzly Bears'], 'Paliano Vanguard': ['Bear'], 'Animus of Predation': ['Flying,First Strike'] },
				{ battlefield: ['Noble Banneret', 'Paliano Vanguard', 'Animus of Predation', 'Grizzly Bears', 'Raging Goblin', 'Mountain'] },
			);
			try {
				const face = (name: string): Face => faceOf(s, mine(s, name)[0]!.id);
				console.log(`[draft-notes.jvm] statics: ${JSON.stringify(Object.fromEntries(['Noble Banneret', 'Paliano Vanguard', 'Animus of Predation', 'Grizzly Bears', 'Raging Goblin'].map((n) => [n, face(n)])))}`);
				// Banneret 3/3 and the Bears it noted get +1/+1 and lifelink; the Bears are a Bear, so the Vanguard adds one more.
				expect(face('Noble Banneret')).toEqual({ power: 4, toughness: 4, keywords: ['Lifelink'] });
				expect(face('Grizzly Bears')).toEqual({ power: 4, toughness: 4, keywords: ['Lifelink'] });
				// Neither noted by name nor of a noted type.
				expect(face('Raging Goblin')).toEqual({ power: 1, toughness: 1, keywords: ['Haste'] });
				expect(face('Paliano Vanguard')).toEqual({ power: 2, toughness: 2, keywords: [] });
				expect(face('Animus of Predation')).toEqual({ power: 4, toughness: 4, keywords: ['First Strike', 'Flying'] });
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Regicide may target only a creature of a noted colour, Custodi Peacekeeper only power up to its highest number, and Garbage Fire deals its highest number',
		async () => {
			const s = await start(
				{ 'Custodi Peacekeeper': ['1', '2'], 'Garbage Fire': ['2', '3'], Regicide: ['blue,black,red'] },
				{
					hand: ['Regicide', 'Garbage Fire', 'Garbage Fire'],
					battlefield: ['Custodi Peacekeeper', ...lands('Plains', 2), ...lands('Swamp', 2), ...lands('Mountain', 8)],
					theirs: ['Grizzly Bears', 'Hill Giant', 'Giant Spider', 'Wind Drake'],
				},
			);
			try {
				// Hill Giant is red and Wind Drake blue; the Bears and the Spider are green, the Peacekeeper white.
				const regicide = await playAt(s, mine(s, 'Regicide', 'Hand')[0]!.id, 'Wind Drake', () => theirs(s, 'Wind Drake', 'Graveyard').length === 1);
				expect(regicide).toEqual(['Hill Giant', 'Wind Drake']);

				// Power two or less: not the 3/3 Hill Giant.
				const tapped = await playAt(s, mine(s, 'Custodi Peacekeeper')[0]!.id, 'Grizzly Bears', () => theirs(s, 'Grizzly Bears')[0]?.tapped === true);
				expect(tapped).toEqual(['Custodi Peacekeeper', 'Giant Spider', 'Grizzly Bears']);

				// Three damage: the 3/3 dies, the 2/4 does not.
				await playAt(s, mine(s, 'Garbage Fire', 'Hand')[0]!.id, 'Hill Giant', () => theirs(s, 'Hill Giant', 'Graveyard').length === 1);
				await playAt(s, mine(s, 'Garbage Fire', 'Hand')[0]!.id, 'Giant Spider', () => mine(s, 'Garbage Fire', 'Graveyard').length === 2);
				expect(theirs(s, 'Giant Spider')).toHaveLength(1);
				expect(theirs(s, 'Giant Spider', 'Graveyard')).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Spire Phantasm draws for a right guess, Smuggler Captain fetches the card it noted, Aether Searcher casts the card it noted for nothing',
		async () => {
			const s = await start(
				{ 'Spire Phantasm': ['Shock'], 'Smuggler Captain': ['Shock'], 'Aether Searcher': ['Grizzly Bears'] },
				{
					hand: ['Spire Phantasm', 'Smuggler Captain', 'Aether Searcher', 'Grizzly Bears'],
					battlefield: [...lands('Island', 6), ...lands('Swamp', 6), ...lands('Mountain', 8)],
					library: `Mountain;Mountain;Shock;${MOUNTAINS}`,
				},
			);
			try {
				await castNamed(s, 0, 'Spire Phantasm');
				await waitUntil(() => { s.answerAsks(); return mine(s, 'Mountain', 'Hand').length === 1; }, 'the Phantasm to draw the Mountain on top', 20_000, s);

				// A library of Mountains and one Shock: the noted Shock is the only card the search offers.
				const asked = s.asks.length;
				await castGoingAlong(s, 'Smuggler Captain', () => mine(s, 'Shock', 'Hand').length === 1);
				const search = s.asks.slice(asked).find((a) => a.method === 'chooseSingleEntityForEffect') as { optionList?: unknown[] } | undefined;
				expect(search?.optionList).toHaveLength(1);
				expect(mine(s, 'Smuggler Captain')).toHaveLength(1);

				// The hand holds the Bears, the Shock and the Mountain: only the noted Bears may be chosen.
				const offered = await castGoingAlong(s, 'Aether Searcher', () => mine(s, 'Grizzly Bears').length === 1);
				expect(offered).toEqual([['Grizzly Bears']]);
				expect(mine(s, 'Aether Searcher')).toHaveLength(1);
				// Twenty lands: the Phantasm, the Captain and the Searcher cost fifteen, so the Bears' two were never paid.
				expect(s.zone(0, 'Battlefield').filter((c) => c.land && c.tapped)).toHaveLength(15);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Paliano, the High City makes mana of the noted colours only, and Cogwork Tracker attacks',
		async () => {
			const isColourAsk = (f: { method?: string; message?: unknown }): boolean => f.method === 'getChoices' && /Select Mana to Produce/.test(String(f.message));
			const s = await start(
				{ 'Paliano, the High City': ['white,blue,black'], 'Cogwork Tracker': ['3'] },
				{ hand: ['Savannah Lions', 'Raging Goblin', 'Llanowar Elves'], battlefield: ['Paliano, the High City', 'Cogwork Tracker'] },
				(f) => (isColourAsk(f) ? [(f.choices as { key: string; label: string }[]).find((c) => /white/i.test(c.label))?.key] : undefined),
			);
			try {
				// Forge's own question when Paliano is tapped, not the priority highlight: that scan is bounded
				// (`AvailableActions`, 50 ms a card) and offers every card it never reached, which a loaded claw-9
				// did here (run 44845468480: the Goblin and the Elves highlighted as well).
				const paliano = mine(s, 'Paliano, the High City')[0]!;
				s.select(0, paliano.id);
				await waitUntil(() => { s.answerAsks(); return s.asks.some(isColourAsk) && mine(s, 'Paliano, the High City')[0]?.tapped === true; }, 'Paliano to ask its colour and tap', 30_000, s);
				const colours = (s.asks.filter(isColourAsk) as unknown as { choices: { label: string }[] }[]).map((a) => a.choices.map((c) => c.label.toLowerCase()).sort());
				console.log(`[draft-notes.jvm] Paliano's colour asks: ${JSON.stringify(colours)}`);
				expect(colours, 'Paliano offers the noted colours only, once').toEqual([['black', 'blue', 'white']]);
				await castNamed(s, 0, 'Savannah Lions');
				expect(mine(s, 'Savannah Lions')).toHaveLength(1);

				// "Attacks each combat if able": Forge refuses a declaration that leaves the Tracker home.
				await toDeclareAttackers(s, 0);
				const refusals = (): number => s.sent.filter((x) => x.seat === 0 && (x.envelope.frame as { message?: string }).message === 'Attack declaration invalid').length;
				expect(refusals()).toBe(0);
				s.ok(0);
				await waitUntil(() => refusals() === 1, 'Forge to refuse an attack without the Tracker', 20_000, s);
				expect(life(s, 1)).toBe(20);

				const prompted = (): number => s.sent.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage').length;
				await waitUntil(() => /^Select creatures to attack/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true, 'the declaration to be open again', 20_000, s);
				const before = prompted();
				s.select(0, mine(s, 'Cogwork Tracker')[0]!.id);
				await waitUntil(() => prompted() > before && s.buttons(0)?.enable1 === true, 'the Tracker to be declared', 20_000, s);
				s.ok(0);
				await passUntil(s, () => life(s, 1) === 16, 'the Tracker to hit for four', 60_000);
				expect(refusals()).toBe(1);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
