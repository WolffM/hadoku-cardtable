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
	newGauntlet,
	setGauntletReady,
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

function picksOf(state: GauntletState, seat: GauntletSeatIndex): string[] {
	return state.decks.filter((_, i) => state.marks[i]?.act === 'pick' && state.marks[i]?.by === seat);
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
		expect(viewOfGauntlet(s.state, null, info).revealAt, 'the reveal starts at the draw').toBe(NOW);
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
	it('records each seat, and only in options', () => {
		let s = setGauntletReady(newGauntlet(), 0, true);
		expect(s.ok && s.state.ready).toEqual([true, false]);
		s = setGauntletReady(drawn(), 1, true);
		expect(s).toEqual({ ok: false, reason: 'drawn' });
	});
});

describe('the ban/pick snake', () => {
	it('runs P1 ban, P2 ban · P1 pick 1, P2 pick 2 · P2 ban, P1 ban · P1 pick 2, P2 pick 1', () => {
		let s = drawn();
		const p1 = s.first!;
		const p2 = (1 - p1) as GauntletSeatIndex;
		const order: [GauntletSeatIndex, string][] = [];
		while (s.phase === 'banpick') {
			const step = viewOfGauntlet(s, null, info).step!;
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
		expect(viewOfGauntlet(s, 0, info).choice).toEqual({ mine: a, chosen: [true, false] });
		expect(viewOfGauntlet(s, 1, info).choice).toEqual({ mine: null, chosen: [true, false] });
		const watcher = viewOfGauntlet(s, null, info);
		expect(watcher.choice).toEqual({ mine: null, chosen: [true, false] });
		expect(JSON.stringify(watcher)).not.toContain(`"mine":"${a}"`);
		expect(watcher.games).toEqual([]);
		const two = choose(s, 1, b);
		if (!two.ok) throw new Error(two.reason);
		s = two.state;
		expect(s.phase).toBe('playing');
		expect(gameDecks(s)).toEqual([a, b]);
		expect(viewOfGauntlet(s, null, info).games).toEqual([{ decks: [a, b], winner: null }]);
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
		expect(viewOfGauntlet(s, null, info).decks.filter((d) => d.played)).toHaveLength(6);
		after = gameOver(s, { seriesOver: true, winner: 0 });
		if (!after.ok) throw new Error(after.reason);
		expect(after.state.phase).toBe('done');
		expect(after.state.winner).toBe(0);
		expect(viewOfGauntlet(after.state, null, info).games.map((g) => g.winner), 'each game keeps its winner: 2-1').toEqual([0, 1, 0]);
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

describe('the AI seat', () => {
	it('bans, picks and chooses on its own turns only, at random among what is open', () => {
		let s = drawn(VS_AI, seeded(11));
		const random = seeded(5);
		let aiActs = 0;
		while (s.phase === 'banpick') {
			const move = aiMove(s, random);
			const step = viewOfGauntlet(s, null, info).step!;
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
		expect(viewOfGauntlet(chosen.state, 0, info).choice).toEqual({ mine: null, chosen: [false, true] });
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
		const view = viewOfGauntlet(s, 0, info);
		expect(view.decks).toHaveLength(GAUNTLET_DECKS);
		expect(view.decks[0]).toMatchObject({ id: deck, status: 'banned', by: s.first, played: false, colors: ['R'] });
		expect(view.decks[1]).toMatchObject({ status: 'open', by: null });
		expect(view.players).toEqual(HUMANS);
		expect(view.you).toBe(0);
		expect(view.era?.id).toBe(s.era!.id);
	});
});
