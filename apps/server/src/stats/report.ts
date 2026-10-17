/**
 * A finished match, as the game-stats store takes it (`@wolffm/prefs-client/games`'s
 * `MatchReport`): the start half captured when the room seated its players, the
 * end half read off the match (`facts.ts`). Pure — no clock, no I/O — so every
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

/** What a seat's deck is, folded once at the start from the `.dck` Forge was handed. */
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
 * The main deck's size, basics and colours. Colours fold the spells' costs
 * (`@hadoku/deck`'s `deckColorsByName` — the room screen's own pips), so a name
 * the cost map has no entry for, which every land is, adds no colour.
 */
export function summarizeDeck(
	text: string,
	name: string,
	costs: Readonly<Record<string, string>>,
	id?: string,
): DeckSummary {
	const main = parseDck(text).sections.get('main') ?? [];
	let cards = 0;
	let basicLands = 0;
	for (const entry of main) {
		cards += entry.count;
		if (isBasicLand(entry.card)) basicLands += entry.count;
	}
	return {
		name,
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
