/*
 * A seat's art pins: which printing each of its cards is drawn as, decided once at match start from
 * its player's art rules (`users/document.ts`'s `art`: a hand pick per card name, and "always use
 * oldest art"), and written into the match spec (`ForgeSeatSpec.artPins`) so the recording's header
 * carries them and a replay draws what the match drew. `art-ids.ts` reads them for the faces each
 * seat OWNS; the operator's settled order (`docs/planning/wave125-2026-11-23.md`, "Settled"):
 *
 *   1. a drafted deck still in its tournament: its drafted printing, locked: the seat gets no pins;
 *   2. otherwise the player's hand pick for the card;
 *   3. then "always use oldest art", when on: the card's oldest paper printing (`printingsOf`'s first);
 *   4. then the default printing (no pin: `art-ids.ts` decides as it always did).
 *
 * A pick is honoured only when it IS a printing of that card (`printingsOf`), so a document can
 * never draw one card as another's picture. An AI seat, a seat with no player or no deck, a player
 * with no rules: no pins.
 *
 * It never delays a start. The documents are read in-process off local disk (`UserStore.get`) while
 * the JVM boots; {@link pinArtAtStart} gives the read {@link ART_PINS_BUDGET_MS}, and a document that
 * fails or is not read by then is default art for that seat, logged once. Pins that arrive after
 * the first face was drawn are dropped too (`art-ids.ts`'s seal), so a board never changes its art
 * mid-game.
 */
import { parseDck } from '@hadoku/carddata/dck';
import type { JsonLog } from '@hadoku/service-kernel/log';

import { printingsOf, type CatalogLike } from '../pools/catalog.js';
import type { ArtRules, MagicUserStore } from '../users/index.js';
import { normaliseName } from '@hadoku/carddata';
import { artPinKey, artPinsSealed } from './art-ids.js';
import type { ArtPins, ForgeSeatSpec } from './forge-spec.js';

/** One seat, as the start path knows it. */
export interface ArtPinSeat {
	/** The seated player's account, or null for the AI and an unheld seat. */
	userId: string | null;
	/** Its `.dck` text, or null for a random precon. */
	deck: string | null;
	/** A drafted deck whose tournament is still running: its drafted printings are locked. */
	locked: boolean;
}

/** A person's art rules, read in-process (`UserStore.get(userId)` then `.art`); undefined when they have none. */
export type ArtRulesReader = (userId: string) => Promise<ArtRules | undefined>;

/** The reader over the per-person store (`magicUserStore()` in the server): a person's `art`, read in-process. */
export function artRulesOf(store: Pick<MagicUserStore, 'get'>): ArtRulesReader {
	return async (userId) => (await store.get(userId)).art;
}

export interface ArtPinsDeps {
	read: ArtRulesReader;
	catalog: CatalogLike | null;
	/** How long a document may take before its seat starts with default art. Default {@link ART_PINS_BUDGET_MS}. */
	budgetMs?: number;
	log?: JsonLog;
	now?: () => number;
}

/**
 * The read's whole allowance. Far under a JVM's boot (seconds: the window between a match's start
 * and its first face), and far over a local JSON read (well under a millisecond each; the report
 * that landed this has the measured p50/p95).
 */
export const ART_PINS_BUDGET_MS = 1_000;

const TIMED_OUT = Symbol('timed-out');

/** Every card name a deck's lines name, main and sideboard, once each. */
function deckNames(deck: string): string[] {
	const names = new Set<string>();
	for (const entries of parseDck(deck).sections.values()) for (const { card } of entries) names.add(card.name);
	return [...names];
}

/**
 * One seat's pins from its player's rules, in the settled order (see the header); undefined when
 * no card of its deck is pinned.
 */
export function pinsFor(deck: string, rules: ArtRules, catalog: CatalogLike | null): ArtPins | undefined {
	if (catalog === null) return undefined;
	const pins: Record<string, string> = {};
	for (const name of deckNames(deck)) {
		const key = artPinKey(catalog, name);
		if (key in pins) continue;
		const printings = printingsOf(catalog, name)?.printings;
		if (printings === undefined || printings.length === 0) continue;
		const pick = rules.picks[key] ?? rules.picks[normaliseName(name)];
		const picked = pick === undefined ? undefined : printings.find((p) => p.scryfallId === pick);
		const id = picked?.scryfallId ?? (rules.oldest ? printings[0]!.scryfallId : undefined);
		if (id !== undefined) pins[key] = id;
	}
	return Object.keys(pins).length === 0 ? undefined : pins;
}

/** Each seat's pins, by seat; a seat whose document fails or is not read within the budget gets none, logged once. */
export async function resolveArtPins(seats: readonly ArtPinSeat[], deps: ArtPinsDeps): Promise<(ArtPins | undefined)[]> {
	const log = deps.log ?? (() => undefined);
	const budget = deps.budgetMs ?? ART_PINS_BUDGET_MS;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<typeof TIMED_OUT>((done) => {
		timer = setTimeout(() => done(TIMED_OUT), budget);
		timer.unref();
	});
	try {
		return await Promise.all(
			seats.map(async (seat, at): Promise<ArtPins | undefined> => {
				if (seat.locked || seat.userId === null || seat.deck === null) return undefined;
				let rules: ArtRules | undefined | typeof TIMED_OUT;
				try {
					rules = await Promise.race([deps.read(seat.userId), deadline]);
				} catch (err) {
					log({ evt: 'art-pins-default', seat: at, reason: 'unreadable', detail: (err as Error).message });
					return undefined;
				}
				if (rules === TIMED_OUT) {
					log({ evt: 'art-pins-default', seat: at, reason: 'timeout', budgetMs: budget });
					return undefined;
				}
				return rules === undefined ? undefined : pinsFor(seat.deck, rules, deps.catalog);
			}),
		);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Write each seat's pins into the spec's own seats, in place, unless a face has been drawn from them
 * already (then nothing is written and the match keeps its default art). True when written.
 */
export function applyArtPins(seats: ForgeSeatSpec[], pins: readonly (ArtPins | undefined)[]): boolean {
	if (artPinsSealed(seats)) return false;
	for (const [at, seat] of seats.entries()) {
		const own = pins[at];
		if (own !== undefined) seat.artPins = own;
	}
	return true;
}

/**
 * The start path's one call: resolve the seats' pins and write them into `spec`, while the JVM
 * boots. Never throws and never awaited by a start. Logs how long it took, and whether it came in
 * before the first face.
 */
export async function pinArtAtStart(matchId: string, spec: { seats: ForgeSeatSpec[] }, seats: readonly ArtPinSeat[], deps: ArtPinsDeps): Promise<void> {
	const log = deps.log ?? (() => undefined);
	const now = deps.now ?? (() => performance.now());
	const started = now();
	try {
		const pins = await resolveArtPins(seats, deps);
		const pinned = pins.map((p) => (p === undefined ? 0 : Object.keys(p).length));
		if (pinned.every((count) => count === 0)) return;
		const applied = applyArtPins(spec.seats, pins);
		log({ evt: applied ? 'art-pins' : 'art-pins-late', matchId, pinned, ms: Math.round((now() - started) * 100) / 100 });
	} catch (err) {
		log({ evt: 'art-pins-failed', matchId, detail: (err as Error).message });
	}
}
