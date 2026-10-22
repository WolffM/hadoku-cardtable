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
 *          `{ kind: 'free' }`                     the `.dck` shape only — Free
 *                                                  pick plays any deck
 *
 * Both arms parse the text with `parseDck`, build the deck with
 * `deckFromDeckFile`, and return `DeckIssue[]` from `@hadoku/deck` — the
 * validators that already exist, surfaced rather than re-written. Both arms end
 * in the same place: the text, byte for byte, as a seat's `deck` in play's own
 * `POST /api/play/matches` body. What is validated is what is sent.
 *
 * "What is sent" is the whole file, and Forge reads more of a `.dck` than
 * `main` and `sideboard`, with a slightly different reader. So both arms also
 * refuse the TEXT wherever the two readers would see two different decks
 * (`dckShapeIssues`) — Wave 11 found three such files that a real Forge
 * launched as a different deck from the one this gate had passed.
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
import { deckFromDeckFile, deckIssues, formatIssues, isBasicLand, type Deck, type DeckIssue, poolEntries } from '@hadoku/deck';
import { libraryPoolMismatch, type LibraryDeck } from '@hadoku/deck/library';
import { MAX_DCK_BYTES, type DraftCard } from '@hadoku/shared';

import { FREE_PICK } from '../room/lobby.js';
import type { TablesLibrary } from './library.js';

export type DeckRef = { library: string } | { dck: string };
export type DeckRules = { kind: 'standard'; format: string } | { kind: 'draft'; draftId: string } | { kind: 'free' };

export interface SeatRequest {
	deck: DeckRef;
	rules: DeckRules;
}

export interface StartRequest {
	opponent: 'human' | 'ai';
	seats: [SeatRequest, SeatRequest];
}

/**
 * What is wrong with the `.dck` TEXT, as opposed to the deck it describes: the
 * places where our reader and Forge's would read one file as two decks.
 */
export type ShapeIssueKind = 'no-metadata' | 'unchecked-section' | 'ambiguous-character';

/** A `DeckIssue` without the parsed card object: what the browser needs. */
export interface WireIssue {
	kind: DeckIssue['kind'] | ShapeIssueKind;
	message: string;
	cardName: string | null;
	count: number | null;
	limit: number | null;
}

export interface SeatVerdict {
	deckName: string;
	/** The rule's display name: `Standard (EMN)`, `your pool from amber-lantern-k7q4`. */
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

function parseRules(raw: unknown, where: string): Parse<DeckRules> {
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

/** The sections a deck is checked in. Everything else is refused if it holds a card. */
const CHECKED_SECTIONS: ReadonlySet<string> = new Set(['metadata', 'main', 'sideboard']);

/** The Unicode spaces and the BOM: JS's `trim` strips them, Java's does not. */
const JS_ONLY_BLANKS: ReadonlySet<number> = new Set([
	0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029,
	0x202f, 0x205f, 0x3000, 0xfeff,
]);

/**
 * Characters on which `parseDck` and Forge's reader disagree about where a line
 * or a section starts. Java's `String.trim` (FileSection.java:108,
 * DeckSection.java:79) strips every char <= U+0020 and nothing else; JS's
 * `trim` strips the ASCII blanks plus the Unicode spaces and the BOM. So
 * `[main\u0001]` is Forge's Main and our unknown section, and a line
 * `\u00A0[junk]` is our section header and Forge's card line — either way the
 * cards after it are checked by one reader and played by the other. Tab, LF,
 * CR and space are trimmed identically by both, and are all a `.dck` needs.
 *
 * Returns the first such character in a line, or null.
 */
function ambiguousCharacter(line: string): string | null {
	for (const ch of line) {
		const c = ch.codePointAt(0) ?? 0;
		// Java trims every C0 control; JS only tab, LF, VT, FF and CR — and VT/FF are not something a .dck needs.
		if ((c < 0x20 && c !== 0x09 && c !== 0x0d) || JS_ONLY_BLANKS.has(c)) return ch;
	}
	return null;
}

function codepoint(ch: string): string {
	return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Everything about the TEXT that would make Forge play a different deck from
 * the one `formatIssues`/`deckIssues` checked, or not load it at all.
 *
 * `checkSeat` validates `main` and `sideboard`, but it forwards the whole file,
 * and Forge reads more of it than that:
 *
 *   - Any other section Forge recognises — `[Planes]`, `[Avatar]`,
 *     `[Schemes]`, `[Conspiracy]`, … — is read, and `Deck.normalizeDeferredSections`
 *     (Deck.java:341-378) MOVES every card that does not belong there into
 *     `Main` (`DeckSection.matchingSection`, DeckSection.java:58-74). A legal
 *     60 plus `[Planes]\n4 Jace, the Mind Sculptor` is a 64-card deck with
 *     four Jaces in Forge and a legal one to us. `[Commander]` is read too.
 *     Forge matches section names with `compareToIgnoreCase`
 *     (DeckSection.java:81), which folds `\u0130`→`i` and `\u017F`→`s` where JS's
 *     `toLowerCase` does not, so the whitelist is on OUR key and anything
 *     outside it that holds a card is refused rather than guessed at.
 *   - `DeckSerializer.readDeckMetadata` (DeckSerializer.java:28) looks up
 *     `metadata` case-SENSITIVELY. Without an exact `[metadata]` line Forge's
 *     deck is null, and the bridge fails the match after the JVM is committed
 *     (`PlayBridge.parseDeck`).
 *   - the characters `ambiguousCharacter` finds, above.
 */
function dckShapeIssues(text: string, file: ReturnType<typeof parseDck>): WireIssue[] {
	const issues: WireIssue[] = [];

	const lines = text.split(/\r?\n/);
	for (const [i, line] of lines.entries()) {
		const ch = ambiguousCharacter(line);
		if (ch === null) continue;
		const shown = JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}…` : line);
		issues.push({
			kind: 'ambiguous-character',
			message: `line ${i + 1} (${shown}) contains ${codepoint(ch)}, which Forge's reader and ours would read differently`,
			cardName: null,
			count: null,
			limit: null,
		});
		break;
	}

	if (!lines.some((l) => l.trim() === '[metadata]')) {
		issues.push({
			kind: 'no-metadata',
			message: 'the file has no [metadata] section (lowercase, as Forge requires), so Forge would not load it',
			cardName: null,
			count: null,
			limit: null,
		});
	}

	for (const [section, entries] of file.sections) {
		if (CHECKED_SECTIONS.has(section)) continue;
		const first = entries[0];
		if (first === undefined) continue;
		const total = entries.reduce((n, e) => n + e.count, 0);
		issues.push({
			kind: 'unchecked-section',
			message:
				`plays ${first.count}x ${first.card.name} in [${section}]` +
				`${entries.length > 1 ? ` (${total} cards in all)` : ''}, which is not the main deck or sideboard — ` +
				'Forge would read it, and move ordinary cards from it into the main deck',
			cardName: first.card.name,
			count: total,
			limit: 0,
		});
	}

	return issues;
}

/**
 * A deck read from a `.dck`, with its basic lands moved from `main` into the
 * basics pile — the shape `@hadoku/deck`'s draft model gives a deck built in the
 * browser, where basics come from the table rather than the pool.
 *
 * A `.dck` has no basics section: `toDeckFile` merges the pile into `main` on
 * export, so `deckFromDeckFile` reads a drafted deck's 17 Islands back as
 * `main` cards (and says so, "nothing to split back out"). `deckIssues` then
 * counts them against the drafted pool — `plays 17x Island but drafted 0` —
 * and no drafted deck with lands could ever be played.
 *
 * The split is by `isBasicLand`, Forge's own five names and no second list, so
 * only what `setBasicLand` would have accepted leaves `main`. Everything else
 * stays pool-checked: a non-basic land, `Wastes`, anything the caller did not
 * draft. It moves entries between two piles of the CHECKED deck and never
 * touches the text, so the maindeck size is unchanged and the file Forge plays
 * is still the file checked. Sideboard basics stay in the sideboard, and so in
 * pool accounting: the browser never writes one there.
 */
export function splitBasicLands(deck: Deck): Deck {
	return {
		...deck,
		main: deck.main.filter((e) => !isBasicLand(e.card)),
		basics: [...deck.basics, ...deck.main.filter((e) => isBasicLand(e.card))],
	};
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
	const file = parseDck(text);
	const shape = dckShapeIssues(text, file);
	const deck = deckFromDeckFile(file);
	const deckName = deck.name === '' ? 'Unnamed deck' : deck.name;

	if (seat.rules.kind === 'standard') {
		const format = ctx.library.format(seat.rules.format);
		if (format === undefined) return { error: `no format ${JSON.stringify(seat.rules.format)}` };
		const issues = [...shape, ...formatIssues(deck, format.pool).map(wireIssue)];
		return {
			deckName,
			rulesName: format.pool.name,
			legal: issues.length === 0,
			issues,
			note: libraryDeck === null ? null : libraryPoolMismatch(libraryDeck, format.pool),
			text,
		};
	}

	if (seat.rules.kind === 'free') {
		return { deckName, rulesName: 'Free pick', legal: shape.length === 0, issues: shape, note: null, text };
	}

	if (ctx.draftPool === null) return { error: 'this server has no draft rooms' };
	const pool = ctx.draftPool(seat.rules.draftId);
	if (!pool.ok) return { error: pool.error };
	// Basics are exempt from the POOL check only. The Standard arm above keeps
	// checking every land against the format pool.
	const issues = [...shape, ...deckIssues(splitBasicLands(deck), poolEntries(pool.pool)).map(wireIssue)];
	return {
		deckName,
		rulesName: `your pool from ${seat.rules.draftId}`,
		legal: issues.length === 0,
		issues,
		note: null,
		text,
	};
}

/**
 * The sentence a refusal leads with: which seat, which deck, which card first.
 * An issue that names a card leads over one that does not (a character on
 * line 39 is the cause; the card it smuggled is what the player recognises).
 */
export function refusalLine(seat: number, verdict: SeatVerdict): string {
	const first = verdict.issues.find((i) => i.cardName !== null) ?? verdict.issues[0];
	const why = first === undefined ? 'no issues' : first.message;
	const more = verdict.issues.length > 1 ? ` (and ${verdict.issues.length - 1} more)` : '';
	return `Seat ${seat + 1}'s deck ${JSON.stringify(verdict.deckName)} is not legal in ${verdict.rulesName}: ${why}${more}`;
}

/**
 * Which library decks an era offers: its OWN collection's decks that are legal
 * in it, by `checkSeat`, so the picker's filter is the gate's own answer.
 *
 * Its own collection only (operator, 2026-10-09: *"every year of modern has the
 * same decks"*). Modern and Legacy pools only grow, so legality alone offered
 * modern-2016 127 decks — every Modern-legal Standard deck since 2004 first, in
 * catalog order — and the year's own twelve were lost at the bottom. A deck from
 * another era can still be loaded and is still checked; it is just not offered.
 * Free pick (`FREE_PICK`) offers the whole library.
 *
 * One call instead of one `POST /check` per deck: at 338 decks the browser was
 * paying ~3.5 s of round trips per era for work that takes the gate well under
 * a second. An unknown era resolves nothing, and says so once.
 */
export function legalLibraryDecks(format: string, ctx: GateContext): { ids: string[] } | SeatUnresolved {
	const free = format === FREE_PICK;
	if (!free && ctx.library.format(format) === undefined) return { error: `no format ${JSON.stringify(format)}` };
	const rules: DeckRules = free ? { kind: 'free' } : { kind: 'standard', format };
	const ids: string[] = [];
	for (const d of ctx.library.decks) {
		if (!free && d.era !== format) continue;
		const v = checkSeat({ deck: { library: d.id }, rules }, ctx);
		if ('error' in v) return v;
		if (v.legal) ids.push(d.id);
	}
	return { ids };
}

/** A verdict without the `.dck` text: what goes back to the browser. */
export function publicVerdict(verdict: SeatVerdict): Omit<SeatVerdict, 'text'> {
	const { text: _text, ...rest } = verdict;
	return rest;
}
