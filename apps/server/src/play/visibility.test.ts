/**
 * Hidden information, asserted over whole serialised payloads of REAL data.
 *
 * The stream is `apps/ui/src/play/fixtures/tierc-game1-seq1-27.json`: the
 * first 27 `DeltaPacket`s a real Forge client received in a real two-player
 * match (provenance in `apps/ui/src/play/fixtures.ts`). It is Forge's
 * unfiltered stream — the opponent's hand arrives with names — which is what
 * makes it the right input: it is exactly what this projector exists to cut.
 *
 * Both seats are projected from it. Forge builds every client's packets by
 * walking the same shared `GameView` (`visibility.ts`'s header), so one
 * client's stream carries both players' secrets and serves as the raw input
 * for either viewer.
 *
 * ## The leak assertion is over bytes, not fields
 *
 * For each viewer, the "secrets" are every identifying string (card `Name`,
 * `OracleName`, and every string property on the card's faces — `ImageKey`,
 * `OracleText`, set code …) of every card that sat in the OTHER seat's hand at
 * any point, minus any string that also appears on a card the viewer was
 * allowed to see (both decks can hold a Mountain). Then `JSON.stringify` of
 * every frame the viewer received — exactly what `emit` puts on the socket —
 * must contain none of them. Two guards keep that from being vacuous: the
 * secret set is non-empty, and the RAW stream contains every secret.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApplyDeltaSchema, GameEventListSchema, safeParseServerFrame } from '@hadoku/forge-wire';

import {
	TYPE,
	cardVisibility,
	createProjector,
	csvCardId,
	keyOf,
	type DeltaPacketJson,
	type StateFrame,
	type WireObj,
} from './visibility.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../../ui/src/play/fixtures/tierc-game1-seq1-27.json');
const EVENTS_FIXTURE = resolve(
	HERE,
	'../../../../packages/forge-wire/src/events/fixtures/GameEventCardChangeZone.json',
);

/** Seat 0 is "Bob" (player id 0), seat 1 is "Alice" (player id 1) — `fixtures.ts`. */
const PLAYERS = [0, 1] as const;

/** The fixture's packets as `applyDelta` frames, annotations stripped. */
export function fixtureFrames(): StateFrame[] {
	const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>[];
	return raw.map((p) => {
		const packet: DeltaPacketJson = {
			seq: p.seq as number,
			checksum: p.checksum as number,
			checksumProperties: p.checksumProperties as number[],
			newObjects: p.newObjects as DeltaPacketJson['newObjects'],
			objectDeltas: p.objectDeltas as DeltaPacketJson['objectDeltas'],
			events: p.events as unknown[],
		};
		return { kind: 'notify', method: 'applyDelta', payload: { packet } } as StateFrame;
	});
}

/** Forge's apply rules, for reading states back in the test. */
function fold(frames: readonly StateFrame[]): Map<string, WireObj> {
	const state = new Map<string, WireObj>();
	for (const frame of frames) {
		if (frame.method !== 'applyDelta') continue;
		const { newObjects, objectDeltas } = frame.payload.packet;
		for (const [k, o] of Object.entries(newObjects)) {
			const clean: WireObj = { _type: o._type, _id: o._id };
			for (const [p, v] of Object.entries(o)) if (v !== null && p !== '_type' && p !== '_id') clean[p] = v;
			state.set(k, clean);
		}
		for (const [k, d] of Object.entries(objectDeltas)) {
			const cur = state.get(k);
			if (cur === undefined) continue;
			const next = { ...cur };
			for (const [p, v] of Object.entries(d)) {
				if (p === '_type' || p === '_id') continue;
				if (v === null) delete next[p];
				else next[p] = v;
			}
			state.set(k, next);
		}
	}
	return state;
}

function handOf(state: ReadonlyMap<string, WireObj>, playerId: number): number[] {
	const hand = state.get(keyOf(TYPE.player, playerId))?.Hand as { v: { v: number }[] } | undefined;
	return hand === undefined ? [] : hand.v.map((x) => x.v);
}

/** Every string that says WHICH card this is: the card's names and all of its faces' strings. */
function identifyingStrings(state: ReadonlyMap<string, WireObj>, cardId: number): string[] {
	const out: string[] = [];
	const card = state.get(keyOf(TYPE.card, cardId));
	for (const prop of ['Name', 'OracleName']) {
		const v = card?.[prop] as { t: string; v: unknown } | undefined;
		if (v?.t === 'str' && typeof v.v === 'string' && v.v !== '') out.push(v.v);
	}
	for (const obj of state.values()) {
		if (obj._type !== TYPE.cardState || csvCardId(obj._id) !== cardId) continue;
		for (const [prop, value] of Object.entries(obj)) {
			const v = value as { t?: string; v?: unknown } | null;
			// Only strings long enough to be a real signal: a one-letter set of
			// colours or an empty rules text would match anything.
			if (prop !== '_type' && prop !== '_id' && v?.t === 'str' && typeof v.v === 'string' && v.v.length >= 4) {
				out.push(v.v);
			}
		}
	}
	return out;
}

interface Run {
	emitted: StateFrame[];
	/** Card ids that were in the opponent's hand at some step, and hidden from this viewer then. */
	opponentHandCards: Set<number>;
	/** Card ids the viewer was allowed to see in full at some step. */
	everVisible: Set<number>;
	/** Raw state after each packet. */
	rawStates: Map<string, WireObj>[];
}

function runViewer(viewer: number, frames: readonly StateFrame[]): Run {
	const projector = createProjector(viewer);
	const opponent = PLAYERS.find((p) => p !== viewer) as number;
	const emitted: StateFrame[] = [];
	const opponentHandCards = new Set<number>();
	const everVisible = new Set<number>();
	const rawStates: Map<string, WireObj>[] = [];
	for (let i = 0; i < frames.length; i++) {
		emitted.push(projector.project(frames[i] as StateFrame));
		const raw = fold(frames.slice(0, i + 1));
		rawStates.push(raw);
		for (const id of handOf(raw, opponent)) opponentHandCards.add(id);
		for (const obj of raw.values()) {
			if (obj._type === TYPE.card && projector.visibilityOf(obj._id) === 'full') everVisible.add(obj._id);
		}
	}
	return { emitted, opponentHandCards, everVisible, rawStates };
}

describe('the committed Tier C stream is real, unfiltered Forge output', () => {
	const frames = fixtureFrames();

	it('parses as forge-wire applyDelta frames, all 27', () => {
		expect(frames).toHaveLength(27);
		for (const frame of frames) expect(ApplyDeltaSchema.safeParse(frame).success).toBe(true);
	});

	it("carries the opponent's hand WITH names — the leak this module exists to cut", () => {
		const raw = fold(frames);
		const aliceHand = handOf(raw, 1);
		expect(aliceHand.length).toBeGreaterThan(0);
		const named = aliceHand.filter((id) => identifyingStrings(raw, id).length > 0);
		expect(named.length).toBe(aliceHand.length);
	});
});

describe.each(PLAYERS)('seat with Forge player %i', (viewer) => {
	const frames = fixtureFrames();
	const run = runViewer(viewer, frames);
	const opponent = PLAYERS.find((p) => p !== viewer) as number;
	const transcript = run.emitted.map((f) => JSON.stringify(f)).join('\n');
	const rawTranscript = frames.map((f) => JSON.stringify(f)).join('\n');

	const finalRaw = run.rawStates[run.rawStates.length - 1] as Map<string, WireObj>;
	const allowed = new Set<string>();
	for (const id of run.everVisible) for (const s of identifyingStrings(finalRaw, id)) allowed.add(s);
	const secrets = new Set<string>();
	for (const id of run.opponentHandCards) {
		if (run.everVisible.has(id)) continue; // cast later, so it was shown to everyone
		for (const s of identifyingStrings(finalRaw, id)) if (!allowed.has(s)) secrets.add(s);
	}

	it('has secrets to keep, and the raw stream really does carry every one of them', () => {
		expect(secrets.size).toBeGreaterThan(0);
		for (const secret of secrets) expect(rawTranscript.includes(JSON.stringify(secret))).toBe(true);
	});

	it("never puts one byte of the other seat's hand in this seat's serialised payloads", () => {
		const leaked = [...secrets].filter((s) => transcript.includes(JSON.stringify(s)));
		expect(leaked).toEqual([]);
	});

	it('sends a hidden card as existence and ownership only, and never one of its faces', () => {
		const offences: string[] = [];
		const projector = createProjector(viewer);
		for (const frame of frames) {
			const out = projector.project(frame);
			if (out.method !== 'applyDelta') continue;
			const { newObjects, objectDeltas } = out.payload.packet;
			for (const [key, obj] of [...Object.entries(newObjects), ...Object.entries(objectDeltas)]) {
				const cardId = obj._type === TYPE.card ? obj._id : obj._type === TYPE.cardState ? csvCardId(obj._id) : null;
				if (cardId === null || projector.visibilityOf(cardId) !== 'hidden') continue;
				if (obj._type === TYPE.cardState) {
					// Only a wipe (every property null) may name a hidden card's face.
					const live = Object.entries(obj).filter(([p, v]) => p !== '_type' && p !== '_id' && v !== null);
					if (live.length > 0) offences.push(`face ${key} of hidden card ${cardId}`);
					continue;
				}
				const extra = Object.keys(obj).filter(
					(p) => !['_type', '_id', 'Owner', 'Controller', 'Zone', 'HiddenId'].includes(p),
				);
				if (extra.length > 0) offences.push(`hidden card ${cardId}: ${extra.join(',')}`);
			}
		}
		expect(offences).toEqual([]);
	});

	it('still tells the viewer how many cards the opponent holds', () => {
		const projected = fold(run.emitted);
		expect(handOf(projected, opponent)).toEqual(handOf(finalRaw, opponent));
	});

	it('shows the viewer every card of their own hand by name, including the ones drawn from a hidden library', () => {
		const projected = fold(run.emitted);
		const mine = handOf(finalRaw, viewer);
		expect(mine.length).toBeGreaterThan(0);
		for (const id of mine) {
			expect(identifyingStrings(projected, id)).toEqual(identifyingStrings(finalRaw, id));
		}
	});

	it('leaves every public card exactly as Forge sent it', () => {
		const projected = fold(run.emitted);
		for (const obj of finalRaw.values()) {
			if (obj._type !== TYPE.card) continue;
			if (run.everVisible.has(obj._id) && cardVisibility(finalRaw, { byCard: new Map() }, obj._id, viewer) === 'full') {
				expect(projected.get(keyOf(TYPE.card, obj._id))).toEqual(obj);
			}
		}
	});

	it('emits frames a browser accepts: every one parses as a forge-wire ServerFrame', () => {
		for (const frame of run.emitted) {
			const parsed = safeParseServerFrame(frame);
			expect(parsed.ok ? [] : parsed.errors.slice(0, 3)).toEqual([]);
		}
	});

	it('zeroes the checksum, which was computed over the unredacted state', () => {
		for (const frame of run.emitted) {
			if (frame.method !== 'applyDelta') continue;
			expect(frame.payload.packet.checksum).toBe(0);
			expect(frame.payload.packet.checksumProperties).toEqual([]);
		}
	});
});

describe('the events arm', () => {
	it('is dropped whole — a real GameEventCardChangeZone names the card that was drawn', () => {
		const events = JSON.parse(readFileSync(EVENTS_FIXTURE, 'utf8')) as unknown[];
		expect(GameEventListSchema.safeParse(events).success).toBe(true);
		const draw = JSON.stringify(events[0]);
		expect(draw).toContain('"Library"');
		expect(draw).toContain('"name":"Mountain"');

		const frames = fixtureFrames();
		const first = frames[0] as Extract<StateFrame, { method: 'applyDelta' }>;
		const withEvents: StateFrame = {
			...first,
			payload: { packet: { ...first.payload.packet, events } },
		};
		const out = createProjector(0).project(withEvents) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(out.payload.packet.events).toEqual([]);
	});
});

describe('setGameView', () => {
	it('is projected as a whole table, with the same rules', () => {
		const frames = fixtureFrames();
		const raw = fold(frames);
		const gameView = Object.fromEntries(raw);
		const out = createProjector(0).project({
			kind: 'notify',
			method: 'setGameView',
			payload: { gameView, sequenceNumber: 27 },
		});
		expect(out.method).toBe('setGameView');
		const table = (out as Extract<StateFrame, { method: 'setGameView' }>).payload.gameView;
		for (const id of handOf(raw, 1)) {
			expect(Object.keys(table[keyOf(TYPE.card, id)] ?? {}).sort()).toEqual(
				expect.not.arrayContaining(['Name', 'OracleName']),
			);
		}
		const parsed = safeParseServerFrame(out);
		expect(parsed.ok ? [] : parsed.errors.slice(0, 3)).toEqual([]);
	});
});

describe('a face-down permanent (real battlefield card, turned face down)', () => {
	it('shows the table its face-down face and nothing of the card underneath; its controller sees it all', () => {
		const frames = fixtureFrames();
		const raw = fold(frames);
		// A real card on player 1's battlefield, with the one property that
		// makes it a morph flipped on. Its faces are the real captured faces.
		const bf = (raw.get(keyOf(TYPE.player, 1))?.Battlefield as { v: { v: number }[] }).v.map((x) => x.v);
		const cardId = bf[0] as number;
		const card = raw.get(keyOf(TYPE.card, cardId)) as WireObj;
		const faceDown = { ...card, Facedown: { t: 'bool', v: true } };
		const table = { ...Object.fromEntries(raw), [keyOf(TYPE.card, cardId)]: faceDown };
		const frame: StateFrame = { kind: 'notify', method: 'setGameView', payload: { gameView: table, sequenceNumber: 1 } };

		const opp = createProjector(0);
		const oppOut = (opp.project(frame) as Extract<StateFrame, { method: 'setGameView' }>).payload.gameView;
		expect(opp.visibilityOf(cardId)).toBe('faceOnly');
		const seen = oppOut[keyOf(TYPE.card, cardId)] as WireObj;
		expect(seen.Name).toBeUndefined();
		expect(seen.Facedown).toEqual({ t: 'bool', v: true });
		const faces = Object.values(oppOut).filter((o) => o._type === TYPE.cardState && csvCardId(o._id) === cardId);
		expect(faces.length).toBeLessThanOrEqual(1);

		const own = createProjector(1);
		own.project(frame);
		expect(own.visibilityOf(cardId)).toBe('full');
	});
});

/*
 * Wave 32, Q10 — `creatureCount`, the fact behind *"no creatures, no block"*
 * (`auto.ts` `skipEmptyBlockStop`). Over the REAL stream, packet by packet, against
 * a count taken independently off the folded raw state.
 */
describe('creatureCount (Q10)', () => {
	function expectedCreatures(state: ReadonlyMap<string, WireObj>, playerId: number): number {
		const bf = state.get(keyOf(TYPE.player, playerId))?.Battlefield as { v: { v: number }[] } | undefined;
		let n = 0;
		for (const { v: id } of bf?.v ?? []) {
			const card = state.get(keyOf(TYPE.card, id));
			const ordinal = (card?.CurrentState as { v?: number } | undefined)?.v ?? 0;
			const type = state.get(keyOf(TYPE.cardState, id * 16 + ordinal))?.Type as { core?: string[] } | undefined;
			if (type?.core?.includes('Creature') === true) n += 1;
		}
		return n;
	}

	it('is null before the viewer is named, and tracks the battlefield after every packet', () => {
		const frames = fixtureFrames();
		for (const viewer of PLAYERS) {
			const projector = createProjector();
			expect(projector.creatureCount()).toBeNull();
			projector.setViewer(viewer);
			const counts: number[] = [];
			frames.forEach((frame, i) => {
				projector.project(frame);
				const expected = expectedCreatures(fold(frames.slice(0, i + 1)), viewer);
				expect(projector.creatureCount(), `viewer ${viewer} after packet ${i}`).toBe(expected);
				counts.push(expected);
			});
			// Not vacuous: the stream has the seat with no creature AND with one.
			expect(counts.some((n) => n === 0), `viewer ${viewer} never had none`).toBe(true);
			expect(counts.some((n) => n > 0), `viewer ${viewer} never had one`).toBe(true);
		}
	});

	it('counts a card whose face is not known as a creature — when in doubt, the player is asked', () => {
		const projector = createProjector(0);
		projector.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: {
				packet: {
					seq: 1,
					checksum: 0,
					checksumProperties: [],
					newObjects: {
						[keyOf(TYPE.player, 0)]: { _type: TYPE.player, _id: 0, Battlefield: { t: 'list', v: [{ t: 'int', v: 77 }] } },
					},
					objectDeltas: {},
					events: [],
				},
			},
		} as StateFrame);
		expect(projector.creatureCount()).toBe(1);
	});
});

describe('stackTopActivator (Q17)', () => {
	it('is the activating player of the TOP stack item, and null for an empty or unknown stack', () => {
		const projector = createProjector(0);
		expect(projector.stackTopActivator()).toBeNull();
		const game = keyOf(TYPE.game, 1);
		const item = (id: number, who: number) => ({ _type: TYPE.stackItem, _id: id, ActivatingPlayer: { t: 'int', v: who } });
		const frame = (stack: number[], items: Record<string, WireObj>): StateFrame =>
			({
				kind: 'notify',
				method: 'applyDelta',
				payload: {
					packet: {
						seq: 1,
						checksum: 0,
						checksumProperties: [],
						newObjects: { [game]: { _type: TYPE.game, _id: 1 }, ...items },
						objectDeltas: { [game]: { _type: TYPE.game, _id: 1, Stack: { t: 'list', v: stack.map((v) => ({ t: 'int', v })) } } },
						events: [],
					},
				},
			}) as StateFrame;
		projector.project(frame([], {}));
		expect(projector.stackTopActivator()).toBeNull();
		// Top first: item 9 is on top, and it is player 1's.
		projector.project(frame([9, 5], { [keyOf(TYPE.stackItem, 9)]: item(9, 1), [keyOf(TYPE.stackItem, 5)]: item(5, 0) }));
		expect(projector.stackTopActivator()).toBe(1);
		// An item the state does not know says nothing.
		projector.project(frame([77], {}));
		expect(projector.stackTopActivator()).toBeNull();
	});
});
