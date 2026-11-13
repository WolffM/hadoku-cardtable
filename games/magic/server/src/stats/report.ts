/**
 * A finished match, as the game-stats store takes it (`@wolffm/prefs-client/games`'s
 * `MatchReport`): the start half read from the room that started the match and
 * the match's own spec, the end half read off the match (`facts.ts`). Pure — no clock, no I/O — so every
 * stat this server records is a unit test.
 *
 * Every key here is a stat name in the store and stays stable: the store
 * aggregates by key across every match ever recorded, so renaming one splits
 * its history in two.
 */

import { parseDck } from '@hadoku/carddata/dck';
import { deckColorsByName, isBasicLand, type DeckColor } from '@hadoku/deck';
import { MATCH_ID_PATTERN, STAT_LIMITS, type MatchReport, type MatchSeatReport, type StatAttrs, type StatCounters } from '@wolffm/prefs-client/games';

import type { MatchFacts, SeatFacts } from './facts.js';

/** What a seat's deck is, folded from the `.dck` Forge was handed. */
export interface DeckSummary {
	name: string;
	/** The library deck's catalog id; absent for a pasted or drafted list. */
	id?: string;
	colors: DeckColor[];
	cards: number;
	basicLands: number;
}

export interface SeatStart {
	kind: 'user' | 'guest' | 'bot';
	/** The player's own key — required for `user`, and held in memory only. */
	userKey?: string;
	displayName?: string;
	avatarId?: string;
	deck: DeckSummary | null;
}

export interface MatchStart {
	/** The rating pool. */
	mode: string;
	roomId?: string;
	startedAt: number;
	attrs: StatAttrs;
	seats: SeatStart[];
}

/**
 * The deck's name, and its main deck's size, basics and colours — all read off
 * the `.dck` text Forge was handed. The name is its `Name=`, as the gate names
 * a deck. Colours fold the spells' costs (`@hadoku/deck`'s `deckColorsByName`
 * — the room screen's own pips), so a name the cost map has no entry for,
 * which every land is, adds no colour.
 */
export function summarizeDeck(text: string, costs: Readonly<Record<string, string>>, id?: string): DeckSummary {
	const file = parseDck(text);
	const main = file.sections.get('main') ?? [];
	let cards = 0;
	let basicLands = 0;
	for (const entry of main) {
		cards += entry.count;
		if (isBasicLand(entry.card)) basicLands += entry.count;
	}
	return {
		name: file.name === null || file.name === '' ? 'Unnamed deck' : file.name,
		...(id === undefined ? {} : { id }),
		colors: deckColorsByName(
			main.map((e) => e.card.name),
			costs,
		),
		cards,
		basicLands,
	};
}

const clip = (s: string): string => s.slice(0, STAT_LIMITS.stringLength);

/**
 * The accounts that are not players: `Bella` and every `wp-` name are test
 * identities. The operator, 2026-10-16: *"leaderboard does not count games
 * against Bella, wp-, or Forge-AI. we should keep the logs, but they should
 * not impact the leaderboard"*.
 */
const TEST_ACCOUNT = /^(Bella$|wp-)/;

/**
 * A match ranks only when every seat is a signed-in player: one with Forge's
 * AI, a guest or a test account in it is reported unrated, so the store keeps
 * it in every history and moves no rating or board with it.
 */
const ranks = (seat: MatchSeatReport): boolean => seat.kind === 'user' && !TEST_ACCOUNT.test(seat.displayName ?? '');

function seatAttrs(start: SeatStart | undefined, facts: SeatFacts): StatAttrs {
	const attrs: StatAttrs = {};
	const deck = start?.deck;
	if (deck !== null && deck !== undefined) {
		attrs.deck = clip(deck.name);
		if (deck.id !== undefined) attrs.deckId = clip(deck.id);
		attrs.colors = deck.colors;
	}
	if (start?.avatarId !== undefined) attrs.avatar = clip(start.avatarId);
	if (facts.onPlay !== undefined) attrs.onPlay = facts.onPlay;
	return attrs;
}

function seatCounters(start: SeatStart | undefined, facts: SeatFacts): StatCounters {
	const counters: StatCounters = {};
	const deck = start?.deck;
	if (deck !== null && deck !== undefined) {
		counters.colorCount = deck.colors.length;
		counters.cardsInDeck = deck.cards;
		counters.basicLandsInDeck = deck.basicLands;
	}
	if (facts.mulligans !== undefined) counters.mulligans = facts.mulligans;
	if (facts.end !== null) {
		counters.lifeEnd = facts.end.life;
		counters.poisonEnd = facts.end.poison;
		counters.libraryEnd = facts.end.library;
		counters.handEnd = facts.end.hand;
		counters.graveyardEnd = facts.end.graveyard;
		counters.exileEnd = facts.end.exile;
		counters.permanentsEnd = facts.end.permanents;
		counters.landsEnd = facts.end.lands;
		counters.creaturesEnd = facts.end.creatures;
	}
	if (facts.play !== null) Object.assign(counters, facts.play);
	return counters;
}

/**
 * The report, or null when the match id cannot be one (the store's own
 * pattern) — a match id is minted by `newMatchId` and always fits, so null
 * means a test or a resumed record handed in something else.
 */
export function buildMatchReport(facts: MatchFacts, start: MatchStart): MatchReport | null {
	if (!MATCH_ID_PATTERN.test(facts.matchId)) return null;
	const attrs: StatAttrs = { ...start.attrs };
	if (facts.endReason !== null) attrs.endReason = facts.endReason;
	const counters: StatCounters = { durationMs: Math.max(0, facts.endedAt - start.startedAt) };
	if (facts.turns !== null) counters.turns = facts.turns;

	const seats: MatchSeatReport[] = facts.seats.map((f) => {
		const s = start.seats[f.seat];
		const kind = s?.kind ?? (f.ai ? 'bot' : 'guest');
		return {
			seat: f.seat,
			kind,
			...(kind === 'user' && s?.userKey !== undefined ? { userKey: s.userKey } : {}),
			displayName: clip(s?.displayName ?? f.name),
			placement: f.placement,
			attrs: seatAttrs(s, f),
			counters: seatCounters(s, f),
		};
	});

	return {
		matchId: facts.matchId,
		mode: start.mode,
		rated: seats.every(ranks),
		...(start.roomId === undefined ? {} : { roomId: start.roomId }),
		startedAt: start.startedAt,
		endedAt: facts.endedAt,
		attrs,
		counters,
		seats,
	};
}

/** The rating pool a series result is recorded in, apart from its games' own (`constructed`), so no game counts twice. */
const SERIES_STATS_MODE = 'constructed-series';

/** A series' seat, as `buildSeriesReport` takes it: who it was, already resolved to a stats kind. */
export interface SeriesSeatStart {
	kind: 'user' | 'guest' | 'bot';
	userKey?: string;
	displayName: string;
}

export interface SeriesStart {
	roomId: string;
	mode: string;
	bestOf: 1 | 3;
	seats: [SeriesSeatStart, SeriesSeatStart];
	wins: [number, number];
	/** Every game's match id, in order; the first keys the report. */
	games: string[];
	winner: 0 | 1 | null;
	endedAt: number;
}

/**
 * A series as one report: each seat placed by the series' winner (both first
 * when it has none), its game wins counted, and the score, mode and length as
 * match attrs. Keyed `<first game>-series`, so a resend is the store's no-op.
 */
export function buildSeriesReport(series: SeriesStart): MatchReport | null {
	const matchId = `${series.games[0] ?? ''}-series`;
	if (!MATCH_ID_PATTERN.test(matchId)) return null;
	const seats: MatchSeatReport[] = series.seats.map((s, seat) => ({
		seat,
		kind: s.kind,
		...(s.kind === 'user' && s.userKey !== undefined ? { userKey: s.userKey } : {}),
		displayName: clip(s.displayName),
		placement: series.winner === null || series.winner === seat ? 1 : 2,
		counters: { wins: series.wins[seat] ?? 0 },
	}));
	return {
		matchId,
		mode: SERIES_STATS_MODE,
		rated: seats.every(ranks),
		roomId: series.roomId,
		endedAt: series.endedAt,
		attrs: {
			mode: series.mode,
			bestOf: series.bestOf,
			score: `${String(series.wins[0])}-${String(series.wins[1])}`,
			opponent: series.seats.some((s) => s.kind === 'bot') ? 'bot' : 'human',
		},
		counters: { games: series.games.length },
		seats,
	};
}
