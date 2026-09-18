/**
 * The deck gate: every deck a person supplies is checked before Forge sees it.
 *
 * ## One path for a drafted deck and a prebuilt one
 *
 * By the time a match starts, a drafted 45-card pool and a prebuilt 60-card
 * list are the same thing: `.dck` text. What differs is only the RULE the text
 * is checked against, so a seat is `{ deck, rules }` and there is exactly one
 * function from that to a verdict (`checkSeat`):
 *
 *   deck   `{ library: id }`  a Wave 7 library deck, by catalog id
 *          `{ dck: text }`    any `.dck` — a drafted deck, a pasted list
 *   rules  `{ kind: 'standard', format: date }`  `formatIssues` against the
 *                                                  frozen Standard pool
 *          `{ kind: 'draft', draftId }`           `deckIssues` against the
 *                                                  CALLER's own drafted pool
 *
 * Both arms parse the text with `parseDck`, build the deck with
 * `deckFromDeckFile`, and return `DeckIssue[]` from `@hadoku/deck` — the
 * validators that already exist, surfaced rather than re-written. Both arms end
 * in the same place: the text, byte for byte, as a seat's `deck` in play's own
 * `POST /api/play/matches` body. What is validated is what is sent.
 *
 * ## Why the draft arm checks only your own pool
 *
 * A drafted pool is hidden information until the draft is over, and a verdict
 * like "plays 1x X but drafted 0" says what someone drafted. So the pool is
 * found by the CALLER's derived identity — the same `identityFromHeaders` the
 * draft socket uses — and never by a seat number in the body. The consequence,
 * stated rather than hidden: a human opponent's drafted deck cannot be
 * submitted by someone else. It can be once decks arrive after launch; today
 * the bridge reads both seats' decks at boot (`play/README.md`, "Not built: the
 * warm spare").
 *
 * ## Nothing here knows about HTTP
 *
 * `parseStartRequest` and `checkSeat` take plain values and return plain
 * values, so the refusal is a unit test and not only an integration test.
 * `routes.ts` is the thin part.
 */

import { parseDck } from '@hadoku/carddata/dck';
import { deckFromDeckFile, deckIssues, formatIssues, type DeckIssue } from '@hadoku/deck';
import { libraryPoolMismatch, type LibraryDeck } from '@hadoku/deck/library';
import type { DraftCard } from '@hadoku/shared';

import { draftPoolEntries } from './draftPool.js';
import type { TablesLibrary } from './library.js';

/** Play's own cap on a `.dck` (`play/socket.ts` `parseStartBody`). */
export const MAX_DCK_BYTES = 64 * 1024;

export type DeckRef = { library: string } | { dck: string };
export type DeckRules = { kind: 'standard'; format: string } | { kind: 'draft'; draftId: string };

export interface SeatRequest {
	deck: DeckRef;
	rules: DeckRules;
}

export interface StartRequest {
	opponent: 'human' | 'ai';
	seats: [SeatRequest, SeatRequest];
}

/** A `DeckIssue` without the parsed card object: what the browser needs. */
export interface WireIssue {
	kind: DeckIssue['kind'];
	message: string;
	cardName: string | null;
	count: number | null;
	limit: number | null;
}

export interface SeatVerdict {
	deckName: string;
	/** The rule's display name: `Standard (2011-07-01)`, `your pool from amber-lantern-k7q4`. */
	rulesName: string;
	legal: boolean;
	/** Every fault, in `@hadoku/deck`'s reporting order. Empty means legal. */
	issues: WireIssue[];
	/**
	 * Something true about the choice that is not a fault in the deck: a
	 * library deck checked against a format other than the one it was built
	 * for (`libraryPoolMismatch`). Shown, never refused on.
	 */
	note: string | null;
	/** The `.dck` text that goes to Forge. Never sent back to the browser. */
	text: string;
}

/** A seat that could not be checked at all — an unknown id, not a bad deck. */
export interface SeatUnresolved {
	error: string;
}

/** Where the caller's drafted pool comes from. The route builds it from `DraftRooms`. */
export type DraftPoolLookup = (draftId: string) => { ok: true; pool: readonly DraftCard[] } | { ok: false; error: string };

export interface GateContext {
	library: TablesLibrary;
	/** Null when the server has no draft rooms (no cube pool loaded). */
	draftPool: DraftPoolLookup | null;
}

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function onlyKeys(x: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
	for (const key of Object.keys(x)) {
		if (!allowed.includes(key)) return `${where}: unknown field ${key}`;
	}
	return null;
}

function nonEmpty(x: unknown): x is string {
	return typeof x === 'string' && x.trim() !== '';
}

export function parseDeckRef(raw: unknown, where: string): Parse<DeckRef> {
	if (!isRecord(raw)) return { ok: false, error: `${where} is { library } or { dck }` };
	if ('library' in raw) {
		const extra = onlyKeys(raw, ['library'], where);
		if (extra !== null) return { ok: false, error: extra };
		if (!nonEmpty(raw.library)) return { ok: false, error: `${where}.library is a deck id` };
		return { ok: true, value: { library: raw.library } };
	}
	if ('dck' in raw) {
		const extra = onlyKeys(raw, ['dck'], where);
		if (extra !== null) return { ok: false, error: extra };
		if (!nonEmpty(raw.dck) || raw.dck.length > MAX_DCK_BYTES) {
			return { ok: false, error: `${where}.dck is .dck text (at most 64 KiB)` };
		}
		return { ok: true, value: { dck: raw.dck } };
	}
	return { ok: false, error: `${where} is { library } or { dck }` };
}

export function parseRules(raw: unknown, where: string): Parse<DeckRules> {
	if (!isRecord(raw)) return { ok: false, error: `${where} is { kind: 'standard', format } or { kind: 'draft', draftId }` };
	if (raw.kind === 'standard') {
		const extra = onlyKeys(raw, ['kind', 'format'], where);
		if (extra !== null) return { ok: false, error: extra };
		if (!nonEmpty(raw.format)) return { ok: false, error: `${where}.format is a format id` };
		return { ok: true, value: { kind: 'standard', format: raw.format } };
	}
	if (raw.kind === 'draft') {
		const extra = onlyKeys(raw, ['kind', 'draftId'], where);
		if (extra !== null) return { ok: false, error: extra };
		if (!nonEmpty(raw.draftId)) return { ok: false, error: `${where}.draftId is a pod id` };
		return { ok: true, value: { kind: 'draft', draftId: raw.draftId } };
	}
	return { ok: false, error: `${where}.kind is 'standard' or 'draft'` };
}

export function parseSeatRequest(raw: unknown, where: string): Parse<SeatRequest> {
	if (!isRecord(raw)) return { ok: false, error: `${where} is { deck, rules }` };
	const extra = onlyKeys(raw, ['deck', 'rules'], where);
	if (extra !== null) return { ok: false, error: extra };
	const deck = parseDeckRef(raw.deck, `${where}.deck`);
	if (!deck.ok) return deck;
	const rules = parseRules(raw.rules, `${where}.rules`);
	if (!rules.ok) return rules;
	return { ok: true, value: { deck: deck.value, rules: rules.value } };
}

/** The product's start body: `{ opponent?, seats: [{ deck, rules }, { deck, rules }] }`. */
export function parseStartRequest(raw: unknown): Parse<StartRequest> {
	if (!isRecord(raw)) return { ok: false, error: 'body must be an object' };
	const extra = onlyKeys(raw, ['opponent', 'seats'], 'body');
	if (extra !== null) return { ok: false, error: extra };
	const opponent = raw.opponent ?? 'human';
	if (opponent !== 'human' && opponent !== 'ai') return { ok: false, error: "opponent is 'human' or 'ai'" };
	if (!Array.isArray(raw.seats) || raw.seats.length !== 2) return { ok: false, error: 'seats is a two-element array' };
	const first = parseSeatRequest(raw.seats[0], 'seats[0]');
	if (!first.ok) return first;
	const second = parseSeatRequest(raw.seats[1], 'seats[1]');
	if (!second.ok) return second;
	return { ok: true, value: { opponent, seats: [first.value, second.value] } };
}

function wireIssue(issue: DeckIssue): WireIssue {
	return { kind: issue.kind, message: issue.message, cardName: issue.cardName, count: issue.count, limit: issue.limit };
}

/**
 * The one check. A seat in, a verdict or an unresolved reference out.
 *
 * The deck is always rebuilt from the text that will be sent — for a library
 * deck too, rather than trusting the parse done at boot — so there is no way
 * for the checked deck and the forwarded file to be two different things.
 */
export function checkSeat(seat: SeatRequest, ctx: GateContext): SeatVerdict | SeatUnresolved {
	let text: string;
	let libraryDeck: LibraryDeck | null = null;
	if ('library' in seat.deck) {
		const found = ctx.library.deck(seat.deck.library);
		if (found === undefined) return { error: `no library deck ${JSON.stringify(seat.deck.library)}` };
		text = found.text;
		libraryDeck = found.deck;
	} else {
		text = seat.deck.dck;
	}
	const deck = deckFromDeckFile(parseDck(text));
	const deckName = deck.name === '' ? 'Unnamed deck' : deck.name;

	if (seat.rules.kind === 'standard') {
		const format = ctx.library.format(seat.rules.format);
		if (format === undefined) return { error: `no format ${JSON.stringify(seat.rules.format)}` };
		const issues = formatIssues(deck, format.pool).map(wireIssue);
		return {
			deckName,
			rulesName: format.pool.name,
			legal: issues.length === 0,
			issues,
			note: libraryDeck === null ? null : libraryPoolMismatch(libraryDeck, format.pool),
			text,
		};
	}

	if (ctx.draftPool === null) return { error: 'this server has no draft rooms' };
	const pool = ctx.draftPool(seat.rules.draftId);
	if (!pool.ok) return { error: pool.error };
	const issues = deckIssues(deck, draftPoolEntries(pool.pool)).map(wireIssue);
	return {
		deckName,
		rulesName: `your pool from ${seat.rules.draftId}`,
		legal: issues.length === 0,
		issues,
		note: null,
		text,
	};
}

/** The sentence a refusal leads with: which seat, which deck, which card first. */
export function refusalLine(seat: number, verdict: SeatVerdict): string {
	const first = verdict.issues[0];
	const why = first === undefined ? 'no issues' : first.message;
	const more = verdict.issues.length > 1 ? ` (and ${verdict.issues.length - 1} more)` : '';
	return `Seat ${seat + 1}'s deck ${JSON.stringify(verdict.deckName)} is not legal in ${verdict.rulesName}: ${why}${more}`;
}

/** A verdict without the `.dck` text: what goes back to the browser. */
export function publicVerdict(verdict: SeatVerdict): Omit<SeatVerdict, 'text'> {
	const { text: _text, ...rest } = verdict;
	return rest;
}
