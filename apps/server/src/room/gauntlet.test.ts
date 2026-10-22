import { describe, expect, it } from 'vitest';
import { GAUNTLET_DECKS, GAUNTLET_SNAKE, type GauntletSeatIndex } from '@hadoku/shared';

import {
	act,
	aiMove,
	choose,
	drawGauntlet,
	gameDecks,
	gameOver,
	gauntletEras,
	gauntletHoldsTable,
	newGauntlet,
	pickedDecks as picksOf,
	readyFor,
	resumeLockedGauntlet,
	startBanpick,
	viewOfGauntlet,
	type GauntletDeckInfo,
	type GauntletEraPool,
	type GauntletState,
} from './gauntlet.ts';

/** A seeded [0,1) — the same sequence every run. */
function seeded(seed = 7): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		return s / 2 ** 31;
	};
}

function era(id: string, family: string, decks: number): GauntletEraPool {
	return { id, family, title: `${family} ${id}`, decks: Array.from({ length: decks }, (_, i) => `${id}-d${i}`) };
}

const NOW = 1_760_000_000_000;

const ERAS: GauntletEraPool[] = [era('1998-07-01', 'standard', 6), era('2022-04-29', 'standard', 24), era('modern-2022-04-29', 'modern', 24), era('legacy-2005-08-20', 'legacy', 9)];

const HUMANS = [
	{ memberId: 'alice', name: 'Alice' },
	{ memberId: 'bob', name: 'Bob' },
] as const;
const VS_AI = [
	{ memberId: 'alice', name: 'Alice' },
	{ memberId: null, name: 'Sage' },
] as const;

function info(id: string): GauntletDeckInfo {
	return { id, name: id, archetype: id, pilot: 'p', colors: ['R'], main: [{ count: 60, name: 'Mountain' }], sideboard: [] };
}

function drawn(players: typeof HUMANS | typeof VS_AI = HUMANS, random = seeded()): GauntletState {
	const out = drawGauntlet(newGauntlet(), { players: [...players], eras: ERAS, now: NOW, options: {}, random });
	if (!out.ok) throw new Error(out.reason);
	return startBanpick(out.state);
}

/** The table seat a snake step's player is, given the coin flip. */
function seatOf(state: GauntletState, player: 'p1' | 'p2'): GauntletSeatIndex {
	const first = state.first!;
	return player === 'p1' ? first : ((1 - first) as GauntletSeatIndex);
}

function openDecks(state: GauntletState): string[] {
	return state.decks.filter((_, i) => state.marks[i] === null);
}

/** Run the whole snake, each act taking the first open deck. */
function banpickAll(state: GauntletState): GauntletState {
	let s = state;
	for (const step of GAUNTLET_SNAKE) {
		for (let n = 0; n < step.count; n++) {
			const out = act(s, seatOf(s, step.player), step.act, openDecks(s)[0]!);
			if (!out.ok) throw new Error(out.reason);
			s = out.state;
		}
	}
	return s;
}

describe('the eras a Gauntlet is drawn from', () => {
	it('offers only eras with at least ten library decks', () => {
		const offered = gauntletEras(
			[
				{ id: '1998-07-01', family: 'standard' },
				{ id: '2022-04-29', family: 'standard' },
				{ id: 'legacy-2005-08-20', family: 'legacy' },
			],
			[...Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, era: '1998-07-01' })), ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, era: '2022-04-29' })), { id: 'c', era: 'legacy-2005-08-20' }],
		);
		expect(offered.map((e) => e.id)).toEqual(['2022-04-29']);
		expect(offered[0]!.decks).toHaveLength(GAUNTLET_DECKS);
		expect(offered[0]!.title).toBe('Standard — 2022');
	});

	it('draws a random era only from the eligible ones, and refuses a chosen era below ten decks', () => {
		for (let seed = 1; seed < 40; seed++) {
			const out = drawGauntlet(newGauntlet(), { players: [...HUMANS], eras: ERAS, now: NOW, options: {}, random: seeded(seed) });
			expect(out.ok && ['2022-04-29', 'modern-2022-04-29'].includes(out.state.era!.id)).toBe(true);
		}
		const small = drawGauntlet(newGauntlet(), { players: [...HUMANS], eras: ERAS, now: NOW, options: { era: '1998-07-01' }, random: seeded() });
		expect(small).toEqual({ ok: false, reason: 'no-era' });
		const family = drawGauntlet(newGauntlet(), { players: [...HUMANS], eras: ERAS, now: NOW, options: { family: 'legacy' }, random: seeded() });
		expect(family).toEqual({ ok: false, reason: 'no-era' });
	});

	it('draws ten distinct decks of the era and a coin flip, and keeps them', () => {
		const s = drawGauntlet(newGauntlet(), { players: [...HUMANS], eras: ERAS, now: NOW, options: { family: 'modern' }, random: seeded(3) });
		if (!s.ok) throw new Error(s.reason);
		expect(s.state.phase).toBe('reveal');
		expect(s.state.era!.id).toBe('modern-2022-04-29');
		expect(new Set(s.state.decks).size).toBe(GAUNTLET_DECKS);
		expect(s.state.decks.every((d) => d.startsWith('modern-2022-04-29-'))).toBe(true);
		expect([0, 1]).toContain(s.state.first);
		expect(viewOfGauntlet(s.state, null, [false, false], info).revealAt, 'the reveal starts at the draw').toBe(NOW);
		// Both coin faces come up across seeds.
		const firsts = new Set(Array.from({ length: 20 }, (_, i) => drawn(HUMANS, seeded(i + 1)).first));
		expect(firsts).toEqual(new Set([0, 1]));
	});

	it('draws only once: a second draw is refused', () => {
		const s = drawn();
		expect(drawGauntlet(s, { players: [...HUMANS], eras: ERAS, now: NOW, options: {}, random: seeded() })).toEqual({ ok: false, reason: 'drawn' });
	});
});

describe('ready', () => {
	it('acts only in options', () => {
		const fresh = newGauntlet();
		expect(readyFor(fresh)).toEqual({ ok: true, state: fresh });
		expect(readyFor(drawn())).toEqual({ ok: false, reason: 'drawn' });
	});
});

describe('the ban/pick snake', () => {
	it('runs P1 ban, P2 ban · P1 pick 1, P2 pick 2 · P2 ban, P1 ban · P1 pick 2, P2 pick 1', () => {
		let s = drawn();
		const p1 = s.first!;
		const p2 = (1 - p1) as GauntletSeatIndex;
		const order: [GauntletSeatIndex, string][] = [];
		while (s.phase === 'banpick') {
			const step = viewOfGauntlet(s, null, [false, false], info).step!;
			order.push([step.seat, step.act]);
			const out = act(s, step.seat, step.act, openDecks(s)[0]!);
			if (!out.ok) throw new Error(out.reason);
			s = out.state;
		}
		expect(order).toEqual([
			[p1, 'ban'],
			[p2, 'ban'],
			[p1, 'pick'],
			[p2, 'pick'],
			[p2, 'pick'],
			[p2, 'ban'],
			[p1, 'ban'],
			[p1, 'pick'],
			[p1, 'pick'],
			[p2, 'pick'],
		]);
		expect(s.phase).toBe('choose');
		expect(picksOf(s, p1)).toHaveLength(3);
		expect(picksOf(s, p2)).toHaveLength(3);
		expect(s.marks.filter((m) => m?.act === 'ban')).toHaveLength(4);
	});

	it('refuses an act out of turn, the wrong act, a taken deck and a deck not drawn', () => {
		const s = drawn();
		const p1 = s.first!;
		const p2 = (1 - p1) as GauntletSeatIndex;
		const deck = s.decks[0]!;
		expect(act(s, p2, 'ban', deck)).toEqual({ ok: false, reason: 'not-your-turn' });
		expect(act(s, p1, 'pick', deck)).toEqual({ ok: false, reason: 'wrong-act' });
		expect(act(s, p1, 'ban', 'nope')).toEqual({ ok: false, reason: 'no-such-deck' });
		const banned = act(s, p1, 'ban', deck);
		if (!banned.ok) throw new Error(banned.reason);
		expect(act(banned.state, p2, 'ban', deck)).toEqual({ ok: false, reason: 'taken' });
	});

	it('refuses acts during the reveal', () => {
		const out = drawGauntlet(newGauntlet(), { players: [...HUMANS], eras: ERAS, now: NOW, options: {}, random: seeded() });
		if (!out.ok) throw new Error(out.reason);
		expect(act(out.state, out.state.first!, 'ban', out.state.decks[0]!)).toEqual({ ok: false, reason: 'not-banpick' });
	});
});

describe('choosing each game deck', () => {
	it('reveals both choices together, and hides the other seat’s until then', () => {
		let s = banpickAll(drawn());
		const a = picksOf(s, 0)[0]!;
		const b = picksOf(s, 1)[1]!;
		const one = choose(s, 0, a);
		if (!one.ok) throw new Error(one.reason);
		s = one.state;
		expect(s.phase).toBe('choose');
		expect(viewOfGauntlet(s, 0, [false, false], info).choice).toEqual({ mine: a, chosen: [true, false] });
		expect(viewOfGauntlet(s, 1, [false, false], info).choice).toEqual({ mine: null, chosen: [true, false] });
		const watcher = viewOfGauntlet(s, null, [false, false], info);
		expect(watcher.choice).toEqual({ mine: null, chosen: [true, false] });
		expect(JSON.stringify(watcher)).not.toContain(`"mine":"${a}"`);
		expect(watcher.games).toEqual([]);
		const two = choose(s, 1, b);
		if (!two.ok) throw new Error(two.reason);
		s = two.state;
		expect(s.phase).toBe('playing');
		expect(gameDecks(s)).toEqual([a, b]);
		expect(viewOfGauntlet(s, null, [false, false], info).games, 'revealed to the table, never to the room').toEqual([{ decks: [null, null], winner: null }]);
	});

	it('refuses a deck that is not the seat’s own pick', () => {
		const s = banpickAll(drawn());
		expect(choose(s, 0, picksOf(s, 1)[0]!)).toEqual({ ok: false, reason: 'not-yours' });
		const banned = s.decks.find((_, i) => s.marks[i]?.act === 'ban')!;
		expect(choose(s, 0, banned)).toEqual({ ok: false, reason: 'not-yours' });
	});

	it('plays each deck once: a played deck cannot be chosen again, and game 3 plays the last ones', () => {
		let s = banpickAll(drawn());
		const play = (a: string, b: string): void => {
			const one = choose(s, 0, a);
			if (!one.ok) throw new Error(one.reason);
			const two = choose(one.state, 1, b);
			if (!two.ok) throw new Error(two.reason);
			s = two.state;
		};
		const [a1, a2, a3] = picksOf(s, 0);
		const [b1, b2, b3] = picksOf(s, 1);
		play(a1!, b1!);
		let after = gameOver(s, { seriesOver: false, winner: 0 });
		if (!after.ok) throw new Error(after.reason);
		s = after.state;
		expect(s.phase).toBe('choose');
		expect(choose(s, 0, a1!)).toEqual({ ok: false, reason: 'played' });
		play(a2!, b2!);
		after = gameOver(s, { seriesOver: false, winner: 1 });
		if (!after.ok) throw new Error(after.reason);
		s = after.state;
		// One unplayed deck each: nothing to choose, so game 3 is dealt at once.
		expect(s.phase).toBe('playing');
		expect(gameDecks(s)).toEqual([a3, b3]);
		expect(viewOfGauntlet(s, null, [false, false], info).decks.filter((d) => d.played), 'game 3’s decks are played once it is over').toHaveLength(4);
		after = gameOver(s, { seriesOver: true, winner: 0 });
		if (!after.ok) throw new Error(after.reason);
		expect(after.state.phase).toBe('done');
		expect(after.state.winner).toBe(0);
		expect(viewOfGauntlet(after.state, null, [false, false], info).games.map((g) => g.winner), 'each game keeps its winner: 2-1').toEqual([0, 1, 0]);
	});

	it('ends after two games when the series is decided', () => {
		let s = banpickAll(drawn());
		for (const seat of [0, 1] as const) {
			const out = choose(s, seat, picksOf(s, seat)[0]!);
			if (!out.ok) throw new Error(out.reason);
			s = out.state;
		}
		const after = gameOver(s, { seriesOver: true, winner: 1 });
		expect(after.ok && after.state.phase).toBe('done');
	});
});

/**
 * A tournament's `locked` deck policy (docs/planning/tournament-mode-plan.md's
 * Design, refined by the operator 2026-10-22: *"we can play gauntlet
 * tournament with locked deck after the first draft"*): an entrant's FIRST
 * match runs the full Gauntlet, and whatever its draft (banpick) produces for
 * them — their fixed PICK SET, not just what is still unplayed — is captured
 * and replayed for every later match, skipping the draw and the banpick
 * entirely.
 */
describe('a tournament’s locked Gauntlet', () => {
	it('pickedDecks is the full pick set, fixed the instant banpick ends — unlike unplayedPicks, it never shrinks as games are played', () => {
		let s = banpickAll(drawn());
		const p0 = picksOf(s, 0);
		const p1 = picksOf(s, 1);
		expect(p0).toHaveLength(3);
		expect(p1).toHaveLength(3);
		const played = choose(s, 0, p0[0]!);
		if (!played.ok) throw new Error(played.reason);
		const two = choose(played.state, 1, p1[0]!);
		if (!two.ok) throw new Error(two.reason);
		s = two.state;
		const after = gameOver(s, { seriesOver: false, winner: 0 });
		if (!after.ok) throw new Error(after.reason);
		// A deck already played is still in `pickedDecks` — it is the captured
		// SET, not "what is left to choose from" (that is `unplayedPicks`,
		// which `gameOver`'s own behaviour above already proves shrinks).
		expect(picksOf(after.state, 0)).toEqual(p0);
		expect(picksOf(after.state, 1)).toEqual(p1);
	});

	it('resumeLockedGauntlet starts straight in choose, with each seat’s stored picks and no banpick at all', () => {
		const first = banpickAll(drawn());
		const picks: [string[], string[]] = [picksOf(first, 0), picksOf(first, 1)];
		const resumed = resumeLockedGauntlet({ players: [...HUMANS], era: first.era!, picks, now: NOW });
		expect(resumed.phase).toBe('choose');
		expect(resumed.marks.filter((m) => m?.act === 'ban')).toEqual([]);
		expect(picksOf(resumed, 0)).toEqual(picks[0]);
		expect(picksOf(resumed, 1)).toEqual(picks[1]);

		// Plays exactly like a freshly-banpicked Gauntlet from here: choose, play, gameOver.
		const a = choose(resumed, 0, picks[0][0]!);
		if (!a.ok) throw new Error(a.reason);
		const b = choose(a.state, 1, picks[1][0]!);
		if (!b.ok) throw new Error(b.reason);
		expect(b.state.phase).toBe('playing');
		expect(gameDecks(b.state)).toEqual([picks[0][0], picks[1][0]]);
	});

	it('an AI entrant’s resumed Gauntlet still moves on its own, from its own stored picks', () => {
		const first = banpickAll(drawn(VS_AI));
		const picks: [string[], string[]] = [picksOf(first, 0), picksOf(first, 1)];
		const resumed = resumeLockedGauntlet({ players: [...VS_AI], era: first.era!, picks, now: NOW });
		const seat = resumed.players!.findIndex((p) => p.memberId === null) as GauntletSeatIndex;
		const move = aiMove(resumed, seeded());
		expect(move).toEqual({ kind: 'choose', deck: expect.any(String) });
		expect(picks[seat]).toContain((move as { deck: string }).deck);
	});
});

/** Ruling 13.4: a decided Gauntlet keeps its result and nothing an unfinished one holds. */
describe('a decided Gauntlet', () => {
	function decided(): GauntletState {
		let g = banpickAll(drawn());
		for (const seat of [0, 1] as const) {
			const out = choose(g, seat, picksOf(g, seat)[0]!);
			if (!out.ok) throw new Error(out.reason);
			g = out.state;
		}
		const over = gameOver(g, { seriesOver: true, winner: 1 });
		if (!over.ok) throw new Error(over.reason);
		return over.state;
	}

	it('keeps its games and winner', () => {
		const done = decided();
		expect(done.phase).toBe('done');
		expect(done.winner).toBe(1);
		expect(done.games).toHaveLength(1);
	});

	it('holds the table from the draw until it is decided, and not before or after', () => {
		expect(gauntletHoldsTable(newGauntlet())).toBe(false);
		expect(gauntletHoldsTable(drawn())).toBe(true);
		expect(gauntletHoldsTable(banpickAll(drawn()))).toBe(true);
		expect(gauntletHoldsTable(decided())).toBe(false);
	});

	it('a Ready after it is decided begins a new Gauntlet', () => {
		expect(readyFor(decided())).toEqual({ ok: true, state: newGauntlet() });
	});
});

describe('a deck choice is its chooser’s alone until its game is over', () => {
	/** Every state from `seat`'s choice of `deck` to the end of game 1, the other seat choosing its first pick. */
	function game1(seat: GauntletSeatIndex, deck: string): GauntletState[] {
		const start = banpickAll(drawn());
		const other = (1 - seat) as GauntletSeatIndex;
		const one = choose(start, seat, deck);
		if (!one.ok) throw new Error(one.reason);
		const two = choose(one.state, other, picksOf(start, other)[0]!);
		if (!two.ok) throw new Error(two.reason);
		const over = gameOver(two.state, { seriesOver: false, winner: seat });
		if (!over.ok) throw new Error(over.reason);
		return [one.state, two.state, over.state];
	}

	it('the other seat and a watcher are shown the same thing whichever deck a seat chose, until its game is over', () => {
		const start = banpickAll(drawn());
		for (const seat of [0, 1] as const) {
			const other = (1 - seat) as GauntletSeatIndex;
			const runs = picksOf(start, seat).map((deck) => game1(seat, deck));
			for (const viewer of [other, null]) {
				for (const [step, phase] of [[0, 'choose'], [1, 'playing']] as const) {
					const seen = runs.map((run) => viewOfGauntlet(run[step]!, viewer, [false, false], info));
					expect(seen[0]!.phase).toBe(phase);
					expect(seen[1], `seat ${seat}'s choice, seen by ${String(viewer)} in ${phase}`).toEqual(seen[0]);
					expect(seen[2], `seat ${seat}'s choice, seen by ${String(viewer)} in ${phase}`).toEqual(seen[0]);
				}
				const after = runs.map((run) => viewOfGauntlet(run[2]!, viewer, [false, false], info));
				expect(after[1], 'once the game is over its decks are on record').not.toEqual(after[0]);
			}
		}
	});

	it('in the game a seat sees its own deck and not the other’s, and no deck is played until the game is over', () => {
		const start = banpickAll(drawn());
		const a = picksOf(start, 0)[1]!;
		const b = picksOf(start, 1)[0]!;
		const [, playing, over] = game1(0, a);
		expect(viewOfGauntlet(playing!, 0, [false, false], info).games).toEqual([{ decks: [a, null], winner: null }]);
		expect(viewOfGauntlet(playing!, 1, [false, false], info).games).toEqual([{ decks: [null, b], winner: null }]);
		expect(viewOfGauntlet(playing!, null, [false, false], info).games).toEqual([{ decks: [null, null], winner: null }]);
		for (const viewer of [0, 1, null] as const) {
			expect(viewOfGauntlet(playing!, viewer, [false, false], info).decks.filter((d) => d.played), `nothing played yet, for ${String(viewer)}`).toEqual([]);
			const after = viewOfGauntlet(over!, viewer, [false, false], info);
			expect(after.phase).toBe('choose');
			expect(after.games).toEqual([{ decks: [a, b], winner: 0 }]);
			expect(after.decks.filter((d) => d.played).map((d) => d.id), `both played decks, for ${String(viewer)}`).toEqual(start.decks.filter((d) => d === a || d === b));
		}
	});
});

describe('the AI seat', () => {
	it('bans, picks and chooses on its own turns only, at random among what is open', () => {
		let s = drawn(VS_AI, seeded(11));
		const random = seeded(5);
		let aiActs = 0;
		while (s.phase === 'banpick') {
			const move = aiMove(s, random);
			const step = viewOfGauntlet(s, null, [false, false], info).step!;
			if (step.seat === 1) {
				expect(move).not.toBeNull();
				expect(move!.kind).toBe('act');
				const out = act(s, 1, step.act, move!.deck);
				if (!out.ok) throw new Error(out.reason);
				s = out.state;
				aiActs += 1;
			} else {
				expect(move).toBeNull();
				const out = act(s, 0, step.act, openDecks(s)[0]!);
				if (!out.ok) throw new Error(out.reason);
				s = out.state;
			}
		}
		expect(aiActs).toBe(5);
		const move = aiMove(s, random);
		expect(move?.kind).toBe('choose');
		expect(picksOf(s, 1)).toContain(move!.deck);
		const chosen = choose(s, 1, move!.deck);
		if (!chosen.ok) throw new Error(chosen.reason);
		// Its choice made, the AI waits on the human.
		expect(aiMove(chosen.state, random)).toBeNull();
		expect(viewOfGauntlet(chosen.state, 0, [false, false], info).choice).toEqual({ mine: null, chosen: [false, true] });
	});

	it('has no move in a game between humans', () => {
		const s = drawn();
		expect(aiMove(s, seeded())).toBeNull();
	});

	it('acts at random: different draws pick different decks', () => {
		let s = drawn(VS_AI, seeded(100));
		if (s.first === 0) {
			const out = act(s, 0, 'ban', s.decks[0]!);
			if (!out.ok) throw new Error(out.reason);
			s = out.state;
		}
		const picks = new Set(Array.from({ length: 12 }, (_, i) => aiMove(s, seeded(i + 1))!.deck));
		expect(picks.size).toBeGreaterThan(1);
	});
});

describe('the view', () => {
	it('names the decks with their tile data and status', () => {
		let s = drawn();
		const deck = s.decks[0]!;
		const out = act(s, s.first!, 'ban', deck);
		if (!out.ok) throw new Error(out.reason);
		s = out.state;
		const view = viewOfGauntlet(s, 0, [false, false], info);
		expect(view.decks).toHaveLength(GAUNTLET_DECKS);
		expect(view.decks[0]).toMatchObject({ id: deck, status: 'banned', by: s.first, played: false, colors: ['R'] });
		expect(view.decks[1]).toMatchObject({ status: 'open', by: null });
		expect(view.players).toEqual(HUMANS);
		expect(view.you).toBe(0);
		expect(view.era?.id).toBe(s.era!.id);
	});
});
