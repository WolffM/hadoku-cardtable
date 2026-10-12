/**
 * Test support: a recorded, REAL bridge transcript, a host that replays it, and
 * an oracle for what each seat must never see.
 *
 * ## `bridge-two-seats.ndjson`
 *
 * Exactly what `bridge/PlayBridge.java` (this lane's final version: match-id
 * stamps, per-seat client threads) wrote on stdout in one real match — nothing
 * edited, nothing invented. Recorded 2026-09-18 from the prebuilt fat jar of
 * Forge `2ad70eb4` (`~/.cache/cardtable-w8/forge-build/…`), match id
 * `m-transcript01`, two human seats, random precons ("Army of Entropy" v
 * "MTGA Eternal Thirst"), driven from a shell by writing these commands to the
 * bridge's stdin:
 *
 *   probe seat 0 ("Keep playing?")            → the real ask, callId s0-1
 *   reply  s0-1 true                          → probe answer true (default was false)
 *   act selectButtonOk, seats 0 and 1, ×3     → play first, keep, keep
 *   stop
 *
 * 31 lines: `ready`, 29 frames (every one parses as a forge-wire `ServerFrame`
 * — checked before it was committed), the `probe` result. Both seats' opening
 * syncs carry BOTH libraries and BOTH hands with names, which is why it is the
 * right input for the leak tests: it is Forge's unfiltered per-client stream.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BridgeCommand, BridgeLine, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from '../host.js';
import { TYPE, csvCardId, keyOf, type WireObj } from '../visibility.js';

export const TRANSCRIPT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'bridge-two-seats.ndjson');

export const TRANSCRIPT_MATCH = 'm-transcript01';

/**
 * `bridge-flying-seat1.ndjson` — the red `match.jvm.test.ts` run the manager hit, captured
 * by that test's `CARDTABLE_PLAY_DUMP` hook on 2026-09-18: "Spirit Flames" v
 * "Decay", seat 1's lines only (every `frame` for seat 1, plus `ready` and the
 * probe result), re-stamped `m-flying01`. Unedited otherwise.
 *
 * Seat 1 holds Abyssal Specter (card 96) and Foul Imp (card 100), whose faces
 * carry `Keywords: {t:'keywords', v:['Flying']}`, and has Bog Imp (card 99) in
 * its library, whose face's `AbilityText` is the bare string "Flying". The old
 * oracle collected only `str` values into `allowed`, so "Flying" became a
 * "secret" that the seat's own visible hand then legitimately carried: a false
 * positive, not a leak. See `secretsFor`.
 */
export const FLYING_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'bridge-flying-seat1.ndjson');
export const FLYING_MATCH = 'm-flying01';

/**
 * The lines as `HostEvents.line` receives them: the JVM host checks each line's
 * `match` stamp and strips it, so this does the same — and throws on a line
 * stamped for another match rather than replaying it.
 */
export function loadTranscript(file = TRANSCRIPT_FILE, matchId = TRANSCRIPT_MATCH): BridgeLine[] {
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => {
			const { match, ...line } = JSON.parse(l) as BridgeLine & { match: string };
			if (match !== matchId) throw new Error(`transcript line stamped for ${match}`);
			return line as BridgeLine;
		});
}

/** A host with no JVM: the test pushes recorded lines, and reads the commands sent. */
export class ReplayHost implements MatchHost {
	readonly commands: BridgeCommand[] = [];
	stopped = false;
	constructor(
		readonly matchId: string,
		readonly spec: MatchSpec,
		private readonly events: HostEvents,
	) {}
	push(...lines: BridgeLine[]): void {
		for (const line of lines) this.events.line(line);
	}
	exit(reason: string): void {
		this.events.exit(reason);
	}
	send(command: BridgeCommand): void {
		this.commands.push(command);
	}
	stop(): void {
		this.stopped = true;
	}
}

export function replayFactory(): { factory: MatchHostFactory; hosts: ReplayHost[] } {
	const hosts: ReplayHost[] = [];
	return {
		hosts,
		factory: (id, spec, events) => {
			const host = new ReplayHost(id, spec, events);
			hosts.push(host);
			return host;
		},
	};
}

/* ── The oracle ──────────────────────────────────────────────────────── */

/** Every card id an ask Forge sent `seat` names — what Forge itself showed that seat, whatever zone it sits in. */
export function shownByAsks(lines: readonly BridgeLine[], seat: number): Set<number> {
	const out = new Set<number>();
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) node.forEach(walk);
		else if (typeof node === 'object' && node !== null) {
			const o = node as Record<string, unknown>;
			if (o.kind === 'card' && typeof o.id === 'number') out.add(o.id);
			Object.values(o).forEach(walk);
		}
	};
	for (const line of lines) {
		if (line.t === 'frame' && line.seat === seat && (line.frame as { kind?: unknown }).kind === 'ask') walk(line.frame);
	}
	return out;
}

type Table = Record<string, WireObj>;

/** Forge's apply rules, applied to one seat's RAW frames from the transcript. */
export function rawStatesOf(lines: readonly BridgeLine[], seat: number): Map<string, WireObj>[] {
	const state = new Map<string, WireObj>();
	const out: Map<string, WireObj>[] = [];
	const put = (table: Table, replace: boolean): void => {
		for (const [k, o] of Object.entries(table)) {
			const existing = state.get(k);
			// A delta for an object never created is skipped (NetworkGuiGame.applyDelta).
			if (!replace && existing === undefined) continue;
			const base: WireObj = replace || existing === undefined ? { _type: o._type, _id: o._id } : { ...existing };
			for (const [p, v] of Object.entries(o)) {
				if (p === '_type' || p === '_id') continue;
				if (v === null) delete base[p];
				else base[p] = v;
			}
			state.set(k, base);
		}
	};
	for (const line of lines) {
		if (line.t !== 'frame' || line.seat !== seat) continue;
		const f = line.frame as { method: string; payload?: Record<string, unknown> };
		if (f.method === 'setGameView') {
			state.clear();
			put(f.payload?.gameView as Table, true);
		} else if (f.method === 'applyDelta') {
			const packet = f.payload?.packet as { newObjects: Table; objectDeltas: Table };
			put(packet.newObjects, true);
			put(packet.objectDeltas, false);
		} else continue;
		out.push(new Map(state));
	}
	return out;
}

function ids(obj: WireObj | undefined, prop: string): number[] {
	const v = obj?.[prop] as { v?: { v: number }[] } | undefined;
	return Array.isArray(v?.v) ? v.v.map((x) => x.v) : [];
}

/** Every string that says WHICH card this is. */
export function identifyingStrings(state: ReadonlyMap<string, WireObj>, cardId: number): string[] {
	const out: string[] = [];
	const card = state.get(keyOf(TYPE.card, cardId));
	for (const prop of ['Name', 'OracleName']) {
		const v = card?.[prop] as { t: string; v: unknown } | undefined;
		if (v?.t === 'str' && typeof v.v === 'string' && v.v.length >= 4) out.push(v.v);
	}
	for (const obj of state.values()) {
		if (obj._type !== TYPE.cardState || csvCardId(obj._id) !== cardId) continue;
		for (const [prop, value] of Object.entries(obj)) {
			const v = value as { t?: string; v?: unknown } | null;
			if (prop !== '_type' && prop !== '_id' && v?.t === 'str' && typeof v.v === 'string' && v.v.length >= 4) {
				out.push(v.v);
			}
		}
	}
	return out;
}

/**
 * EVERY string a card's objects carry, at any depth — `str` values, but also
 * the members of `keywords`, `list`, `set` and `map` values and the token sets
 * of a `cardtype`. Tags (`t`) and enum class names (`c`) are the codec's own
 * vocabulary, not the card's, and are skipped.
 */
export function everyString(state: ReadonlyMap<string, WireObj>, cardId: number): string[] {
	const out: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node === 'string') out.push(node);
		else if (Array.isArray(node)) node.forEach(walk);
		else if (typeof node === 'object' && node !== null) {
			for (const [k, v] of Object.entries(node)) if (k !== 't' && k !== 'c') walk(v);
		}
	};
	walk(state.get(keyOf(TYPE.card, cardId)));
	for (const obj of state.values()) if (obj._type === TYPE.cardState && csvCardId(obj._id) === cardId) walk(obj);
	return out;
}

/**
 * What a viewer must never receive, defined from ZONES and independently of
 * `visibility.ts`: every identifying string of every card that sat in the
 * opponent's hand or sideboard or in any library at every observed step, minus
 * any string that the viewer may legitimately see on a card they saw (on the
 * table, in a graveyard or exile, or in their own hand or sideboard) — two
 * decks can both hold a Mountain, and a Bog Imp's whole rules text, "Flying",
 * is a keyword on every other flyer in view.
 *
 * `allowed` is taken from `everyString`, not from `identifyingStrings`: a string
 * the viewer can see ANYWHERE on a visible card, in any value shape, cannot be
 * a secret. It was once `str` values only, and a visible card's
 * `Keywords: ['Flying']` then read as a leak of a hidden card's
 * `AbilityText: "Flying"` (`FLYING_FILE`). The secrets themselves are still
 * every `str` a hidden card carries, so the check is not weakened for anything
 * that actually names a hidden card.
 *
 * `shown` is the cards Forge itself put in front of the viewer while their
 * zone stayed hidden — a reveal, a look at an opponent's hand — read from the
 * raw stream by {@link shownByAsks}. A seat that was shown bob's hand by
 * Thoughtseize was told those cards by Forge, so they are not its secrets.
 */
export function secretsFor(
	states: readonly Map<string, WireObj>[],
	viewer: number,
	shown: ReadonlySet<number> = new Set(),
): {
	secrets: Set<string>;
	hiddenCards: Set<number>;
} {
	const everShown = new Set<number>(shown);
	const everHidden = new Set<number>();
	for (const state of states) {
		for (const obj of state.values()) {
			if (obj._type !== TYPE.player) continue;
			const mine = obj._id === viewer;
			for (const prop of ['Battlefield', 'Graveyard', 'Exile', 'Command']) for (const id of ids(obj, prop)) everShown.add(id);
			// A sideboard is the owner's to know and nobody else's. Precons can list a card in
			// both [Main] and [Sideboard] ("Arcane Tempo": Beacon Bolt, The Mirari Conjecture),
			// and the owner's named sideboard copy once read as a leak of the library copy.
			for (const zone of ['Hand', 'Sideboard']) for (const id of ids(obj, zone)) (mine ? everShown : everHidden).add(id);
			for (const id of ids(obj, 'Library')) everHidden.add(id);
		}
	}
	const last = states[states.length - 1] ?? new Map<string, WireObj>();
	const allowed = new Set<string>();
	// A shown card is read where it last existed: a card the viewer held and that
	// then left the game — an opening hand a scenario replaced, a token — is gone
	// from the last state, and the viewer still saw it.
	const unread = new Set(everShown);
	for (let at = states.length - 1; at >= 0 && unread.size > 0; at--) {
		const state = states[at]!;
		for (const id of [...unread]) {
			if (!state.has(keyOf(TYPE.card, id))) continue;
			unread.delete(id);
			for (const s of everyString(state, id)) allowed.add(s);
		}
	}
	const hiddenCards = new Set([...everHidden].filter((id) => !everShown.has(id)));
	const secrets = new Set<string>();
	for (const id of hiddenCards) for (const s of identifyingStrings(last, id)) if (!allowed.has(s)) secrets.add(s);
	return { secrets, hiddenCards };
}

/**
 * Secrets whose JSON spelling occurs in the text as a VALUE. An object KEY is
 * the wire's own vocabulary, not a card's: split card "Life // Death" has the
 * face name "Life", and every PlayerView carries `"Life":{"t":"int",…}`. A
 * key's closing quote is followed by optional whitespace and `:`, a value's is
 * not, and every occurrence is checked, so a key earlier in the text cannot
 * hide a value later on.
 *
 * A button's label is the wire's vocabulary too: Forge's own "Cancel" on
 * `updateButtons` is not the counterspell Cancel in a library (match.jvm's
 * variety run, seed 833507925, run 38298019713).
 */
export function leaked(secrets: Iterable<string>, text: string): string[] {
	return [...secrets].filter((s) => {
		const needle = JSON.stringify(s);
		const colon = /\s*:/y;
		for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
			colon.lastIndex = at + needle.length;
			if (colon.test(text)) continue;
			if (/"label[12]"\s*:\s*$/.test(text.slice(Math.max(0, at - 16), at))) continue;
			return true;
		}
		return false;
	});
}
