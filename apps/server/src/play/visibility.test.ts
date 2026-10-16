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
	foldFrames,
	keyOf,
	type DeltaPacketJson,
	type StateFrame,
	type WireObj,
} from './visibility.js';
import { leaked } from './fixtures/transcript.js';

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

/**
 * Wave 49 §A — `stackTargetSpells`, `PlayBridge.java`'s own addition. Passed
 * through UNREDACTED (`visibility.ts`'s own note on `project`): both ids
 * name stack items, and the Stack zone is in `PUBLIC_ZONES`, so there is
 * nothing a card redaction elsewhere in the same frame has not already hid.
 */
describe('stackTargetSpells (wave 49 §A)', () => {
	it('setGameView: passed through exactly, present or absent', () => {
		const frames = fixtureFrames();
		const raw = fold(frames);
		const gameView = Object.fromEntries(raw);
		const withPairs = createProjector(0).project({
			kind: 'notify',
			method: 'setGameView',
			payload: { gameView, sequenceNumber: 27, stackTargetSpells: [[50, 49]] },
		}) as Extract<StateFrame, { method: 'setGameView' }>;
		expect(withPairs.payload.stackTargetSpells).toEqual([[50, 49]]);

		const without = createProjector(0).project({
			kind: 'notify',
			method: 'setGameView',
			payload: { gameView, sequenceNumber: 27 },
		}) as Extract<StateFrame, { method: 'setGameView' }>;
		expect(without.payload.stackTargetSpells).toBeUndefined();
	});

	it('applyDelta: passed through exactly, present or absent', () => {
		const frames = fixtureFrames();
		const first = frames[0] as Extract<StateFrame, { method: 'applyDelta' }>;
		const withPairs: StateFrame = { ...first, payload: { ...first.payload, stackTargetSpells: [[50, 49]] } };
		const out = createProjector(0).project(withPairs) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(out.payload.stackTargetSpells).toEqual([[50, 49]]);

		const without = createProjector(0).project(first) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(without.payload.stackTargetSpells).toBeUndefined();
	});
});

describe('pendingTriggers', () => {
	it("keeps a waiting trigger of a card this seat sees, drops one of a card it may not see (its words name the card)", () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const ids = (pid: number, zone: string) => ((raw.get(keyOf(TYPE.player, pid))?.[zone] as { v: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
		const onField = ids(1, 'Battlefield')[0]!;
		const inTheirHand = ids(1, 'Hand')[0]!;
		const pending = [
			{ id: 900, hostCard: onField, controller: 1, key: 'seen' },
			{ id: 901, hostCard: inTheirHand, controller: 1, key: 'hidden' },
		];
		const out = createProjector(0).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1, pendingTriggers: pending } }) as Extract<
			StateFrame,
			{ method: 'setGameView' }
		>;
		expect(out.payload.pendingTriggers?.map((t) => t.key)).toEqual(['seen']);
		const owner = createProjector(1).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1, pendingTriggers: pending } }) as Extract<
			StateFrame,
			{ method: 'setGameView' }
		>;
		expect(owner.payload.pendingTriggers?.map((t) => t.key)).toEqual(['seen', 'hidden']);
	});
});

describe('waitingEffects', () => {
	it('keeps an effect whose source this seat sees, drops one whose source it may not see, on both state frames', () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const ids = (pid: number, zone: string) => ((raw.get(keyOf(TYPE.player, pid))?.[zone] as { v: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
		const effects = [
			{ source: ids(1, 'Battlefield')[0]!, kind: 'trigger' as const, text: 'seen' },
			{ source: ids(1, 'Hand')[0]!, kind: 'effect' as const, text: 'hidden' },
		];
		const out = createProjector(0).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1, waitingEffects: effects } }) as Extract<
			StateFrame,
			{ method: 'setGameView' }
		>;
		expect(out.payload.waitingEffects?.map((e) => e.text)).toEqual(['seen']);
		const owner = createProjector(1);
		owner.project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		const delta = owner.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: { packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, waitingEffects: effects },
		}) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(delta.payload.waitingEffects?.map((e) => e.text)).toEqual(['seen', 'hidden']);
	});
});

describe('cantBlock', () => {
	it('keeps the battlefield creatures every seat is sent, drops a card one seat may not see, on both state frames', () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const ids = (pid: number, zone: string) => ((raw.get(keyOf(TYPE.player, pid))?.[zone] as { v: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
		const onField = ids(1, 'Battlefield')[0]!;
		const inTheirHand = ids(1, 'Hand')[0]!;
		const cantBlock = [onField, inTheirHand];
		const out = createProjector(0).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1, cantBlock } }) as Extract<
			StateFrame,
			{ method: 'setGameView' }
		>;
		expect(out.payload.cantBlock).toEqual([onField]);
		const owner = createProjector(1);
		owner.project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		const delta = owner.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: { packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, cantBlock },
		}) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(delta.payload.cantBlock).toEqual([onField, inTheirHand]);
	});

	it('leaves the field off a frame that carried none', () => {
		const gameView = Object.fromEntries(fold(fixtureFrames()));
		const out = createProjector(0).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		expect('cantBlock' in out.payload).toBe(false);
	});
});

describe('printedTypes', () => {
	it('keeps the pairs for cards a seat is sent, drops a card that seat may not see, on both state frames', () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const ids = (pid: number, zone: string) => ((raw.get(keyOf(TYPE.player, pid))?.[zone] as { v: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
		const onField = ids(1, 'Battlefield')[0]!;
		const inTheirHand = ids(1, 'Hand')[0]!;
		const land = { t: 'cardtype', sup: [], core: ['Land'], sub: [], all: false, exc: [] };
		const printedTypes = [[onField, land], [inTheirHand, land]] as const;
		const out = createProjector(0).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1, printedTypes } }) as Extract<
			StateFrame,
			{ method: 'setGameView' }
		>;
		expect(out.payload.printedTypes).toEqual([[onField, land]]);
		const owner = createProjector(1);
		owner.project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		const delta = owner.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: { packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, printedTypes },
		}) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(delta.payload.printedTypes).toEqual(printedTypes);
		expect('printedTypes' in createProjector(0).project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } }).payload).toBe(false);
	});
});

describe('deaths', () => {
	it('keeps the deaths of cards this seat is sent, and rides applyDelta', () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const ids = (pid: number, zone: string) => ((raw.get(keyOf(TYPE.player, pid))?.[zone] as { v: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
		const onField = ids(1, 'Battlefield')[0]!;
		const inTheirHand = ids(1, 'Hand')[0]!;
		const seat0 = createProjector(0);
		seat0.project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		const delta = seat0.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: {
				packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] },
				deaths: [
					[onField, 'DESTROYED'],
					[inTheirHand, 'SACRIFICED'],
				],
			},
		}) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(delta.payload.deaths).toEqual([[onField, 'DESTROYED']]);
	});
});

describe('damage', () => {
	it('keeps the hits on a card this seat is sent, names a source it may not see as none, and rides applyDelta only', () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const ids = (pid: number, zone: string) => ((raw.get(keyOf(TYPE.player, pid))?.[zone] as { v: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
		const onField = ids(1, 'Battlefield')[0]!;
		const inTheirHand = ids(1, 'Hand')[0]!;
		const seat0 = createProjector(0);
		seat0.project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		const delta = seat0.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: {
				packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] },
				damage: [
					[onField, inTheirHand, 3],
					[inTheirHand, onField, 1],
					[onField, -1, 2],
				],
			},
		}) as Extract<StateFrame, { method: 'applyDelta' }>;
		expect(delta.payload.damage).toEqual([
			[onField, -1, 3],
			[onField, -1, 2],
		]);
	});

	it('leaves the field off a frame whose hits this seat sees none of', () => {
		const raw = fold(fixtureFrames());
		const gameView = Object.fromEntries(raw);
		const inTheirHand = ((raw.get(keyOf(TYPE.player, 1))?.Hand as { v: { v: number }[] }).v[0]!).v;
		const seat0 = createProjector(0);
		seat0.project({ kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 1 } });
		const delta = seat0.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: { packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, damage: [[inTheirHand, -1, 1]] },
		});
		expect('damage' in delta.payload).toBe(false);
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
 * The operator, 2026-10-11: "Courser of Kruphix should have something where both people can see the
 * top card of the library at all times." Forge says who may see a library's top card the way it says
 * it for any card: `PlayerMayLook` (Courser's `MayLookAt$ Player` names every player, Vizier of the
 * Menagerie's `MayLookAt$ You` its controller only), and the projection follows it both ways.
 */
describe("a library's top card that Forge lets players look at", () => {
	const mayLook = (ids: number[]) => ({ t: 'list', v: ids.map((v) => ({ t: 'int', v })) });
	const idsIn = (raw: Map<string, WireObj>, owner: number, zone: string): number[] =>
		(raw.get(keyOf(TYPE.player, owner))?.[zone] as { v: { v: number }[] }).v.map((x) => x.v);
	/**
	 * The fixture's state with one of player 1's hand cards (a card the capture carries whole, with its
	 * faces) put on top of their library — the capture names no library card. Returns its id and the next.
	 */
	function onTop(): { raw: Map<string, WireObj>; top: number; next: number } {
		const raw = fold(fixtureFrames());
		const [top, ...hand] = idsIn(raw, 1, 'Hand') as [number, ...number[]];
		const library = idsIn(raw, 1, 'Library');
		const player = raw.get(keyOf(TYPE.player, 1)) as WireObj;
		raw.set(keyOf(TYPE.player, 1), { ...player, Hand: mayLook(hand), Library: mayLook([top, ...library]) });
		raw.set(keyOf(TYPE.card, top), { ...(raw.get(keyOf(TYPE.card, top)) as WireObj), Zone: { t: 'enum', v: 'Library' } });
		return { raw, top, next: library[0]! };
	}
	function delta(objectDeltas: Record<string, WireObj>): StateFrame {
		return { kind: 'notify', method: 'applyDelta', payload: { packet: { seq: 99, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas, events: [] } } };
	}
	const names = (table: Record<string, WireObj>, cardId: number): unknown[] =>
		Object.values(table)
			.filter((o) => (o._type === TYPE.card && o._id === cardId) || (o._type === TYPE.cardState && csvCardId(o._id) === cardId))
			.map((o) => o.Name)
			.filter((n) => n !== undefined && n !== null);

	it('is sent whole to every seat Forge names, and to no other; the card under it stays hidden', () => {
		const { raw, top, next } = onTop();
		const card = raw.get(keyOf(TYPE.card, top)) as WireObj;
		const table = (who: number[]) => ({ ...Object.fromEntries(raw), [keyOf(TYPE.card, top)]: { ...card, PlayerMayLook: mayLook(who) } });
		const frame = (who: number[]): StateFrame => ({ kind: 'notify', method: 'setGameView', payload: { gameView: table(who), sequenceNumber: 1 } });
		const out = (viewer: number, who: number[]) => {
			const p = createProjector(viewer);
			const gameView = (p.project(frame(who)) as Extract<StateFrame, { method: 'setGameView' }>).payload.gameView;
			return { p, gameView };
		};

		// Courser: every player.
		for (const viewer of PLAYERS) {
			const { p, gameView } = out(viewer, [0, 1]);
			expect(p.visibilityOf(top), `seat ${viewer} may see the top`).toBe('full');
			expect(names(gameView, top).length, `seat ${viewer} is sent its name`).toBeGreaterThan(0);
			expect(p.visibilityOf(next), `seat ${viewer} may not see the card under it`).toBe('hidden');
			expect(names(gameView, next), `seat ${viewer} is sent nothing that names the card under it`).toEqual([]);
		}
		// Vizier of the Menagerie: its controller only.
		const own = out(1, [1]);
		expect(own.p.visibilityOf(top)).toBe('full');
		const opp = out(0, [1]);
		expect(opp.p.visibilityOf(top), 'the opponent may not see it').toBe('hidden');
		expect(names(opp.gameView, top), 'and is sent nothing that names it').toEqual([]);
	});

	it('is sent when Forge lets the seat look, kept while it stays on top, and taken back when the library is shuffled', () => {
		const { raw, top } = onTop();
		const key = keyOf(TYPE.card, top);
		const p = createProjector(0);
		p.project({ kind: 'notify', method: 'setGameView', payload: { gameView: Object.fromEntries(raw), sequenceNumber: 1 } });
		expect(p.visibilityOf(top)).toBe('hidden');

		const shown = (p.project(delta({ [key]: { _type: TYPE.card, _id: top, PlayerMayLook: mayLook([0, 1]) } })) as Extract<StateFrame, { method: 'applyDelta' }>).payload.packet;
		expect(p.visibilityOf(top)).toBe('full');
		expect(names(shown.newObjects, top).length, 'the card and its face are re-sent whole').toBeGreaterThan(0);

		p.project(delta({ [key]: { _type: TYPE.card, _id: top, PlayerMayLook: null } as unknown as WireObj }));
		expect(p.visibilityOf(top), 'the seat still knows the card it was shown').toBe('full');

		const [, ...under] = idsIn(raw, 1, 'Library');
		const playerKey = keyOf(TYPE.player, 1);
		const shuffled = { _type: TYPE.player, _id: 1, Library: mayLook([...under.slice(0, 2), top, ...under.slice(2)]) };
		const gone = (p.project(delta({ [playerKey]: shuffled })) as Extract<StateFrame, { method: 'applyDelta' }>).payload.packet;
		expect(p.visibilityOf(top)).toBe('hidden');
		expect((gone.newObjects[key] as WireObj).Name, 'the card is re-sent as existence only').toBeUndefined();
		const wiped = Object.values(gone.newObjects).filter((o) => o._type === TYPE.cardState && csvCardId(o._id) === top);
		expect(wiped.length, 'its face is wiped').toBeGreaterThan(0);
		for (const face of wiped) expect(face.Name).toBeNull();
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

describe('turnNumber', () => {
	it('is the Game object’s own Turn, off a delta either seat could have received — null until one arrives', () => {
		const projector = createProjector(0);
		expect(projector.turnNumber()).toBeNull();
		const game = keyOf(TYPE.game, 1);
		const frame = (turn: number): StateFrame =>
			({
				kind: 'notify',
				method: 'applyDelta',
				payload: {
					packet: {
						seq: 1,
						checksum: 0,
						checksumProperties: [],
						newObjects: { [game]: { _type: TYPE.game, _id: 1 } },
						objectDeltas: { [game]: { _type: TYPE.game, _id: 1, Turn: { t: 'int', v: turn } } },
						events: [],
					},
				},
			}) as StateFrame;
		projector.project(frame(1));
		expect(projector.turnNumber()).toBe(1);
		// A later turn overwrites it — the same object, a newer delta.
		projector.project(frame(14));
		expect(projector.turnNumber()).toBe(14);
	});
});

describe('phase', () => {
	it('is the Game object’s own Phase constant — null until one arrives', () => {
		const projector = createProjector(0);
		expect(projector.phase()).toBeNull();
		const game = keyOf(TYPE.game, 1);
		projector.project({
			kind: 'notify',
			method: 'applyDelta',
			payload: {
				packet: {
					seq: 1,
					checksum: 0,
					checksumProperties: [],
					newObjects: { [game]: { _type: TYPE.game, _id: 1 } },
					objectDeltas: { [game]: { _type: TYPE.game, _id: 1, Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: 'END_OF_TURN' } } },
					events: [],
				},
			},
		} as StateFrame);
		expect(projector.phase()).toBe('END_OF_TURN');
	});
});

/*
 * 2026-10-12, the party request (`docs/requests/WATCHPARTY_SEATS_AND_SPECTATORS.md`):
 * a viewer of `null` is the TABLE — what everyone who is not playing may see.
 * Public zones whole, a face-down permanent as its face, and no hand or library
 * at all. The watcher channel in `match.ts` is one of these.
 */
describe('a null viewer: the public table (the watcher channel)', () => {
	const frames = fixtureFrames();
	const raw = fold(frames);
	const zoneIds = (playerId: number, zone: string): number[] => {
		const list = raw.get(keyOf(TYPE.player, playerId))?.[zone] as { v: { v: number }[] } | undefined;
		return list === undefined ? [] : list.v.map((x) => x.v);
	};

	it('shows every battlefield and graveyard card whole, and nothing from either hand or library', () => {
		const projector = createProjector(null);
		for (const frame of frames) projector.project(frame);
		for (const playerId of PLAYERS) {
			for (const id of zoneIds(playerId, 'Battlefield')) expect(projector.visibilityOf(id), `battlefield card ${id}`).toBe('full');
			for (const id of zoneIds(playerId, 'Graveyard')) expect(projector.visibilityOf(id), `graveyard card ${id}`).toBe('full');
			expect(zoneIds(playerId, 'Hand').length).toBeGreaterThan(0);
			for (const id of zoneIds(playerId, 'Hand')) expect(projector.visibilityOf(id), `hand card ${id}`).toBe('hidden');
			expect(zoneIds(playerId, 'Library').length).toBeGreaterThan(0);
			for (const id of zoneIds(playerId, 'Library')) expect(projector.visibilityOf(id), `library card ${id}`).toBe('hidden');
		}
	});

	it("puts no identifying string of ANY hand or library card into its serialised frames — the payload, not the screen", () => {
		const projector = createProjector(null);
		const emitted = frames.map((frame) => JSON.stringify(projector.project(frame))).join('\n');
		const secret = new Set<string>();
		for (const playerId of PLAYERS) {
			for (const zone of ['Hand', 'Library']) for (const id of zoneIds(playerId, zone)) for (const s of identifyingStrings(raw, id)) secret.add(s);
		}
		// A name shared with a public card is not a secret of the hidden one.
		for (const playerId of PLAYERS) {
			for (const zone of ['Battlefield', 'Graveyard', 'Exile', 'Command']) for (const id of zoneIds(playerId, zone)) for (const s of identifyingStrings(raw, id)) secret.delete(s);
		}
		expect(secret.size).toBeGreaterThan(20);
		// Not vacuous: the raw stream names them all.
		const rawText = frames.map((f) => JSON.stringify(f)).join('\n');
		expect(leaked(secret, rawText).length).toBe(secret.size);
		expect(leaked(secret, emitted)).toEqual([]);
	});

	it('still says how many cards each hand and library holds — the ids stay, the cards do not', () => {
		const projector = createProjector(null);
		const shown = fold(frames.map((frame) => projector.project(frame)));
		for (const playerId of PLAYERS) {
			for (const zone of ['Hand', 'Library']) {
				const list = shown.get(keyOf(TYPE.player, playerId))?.[zone] as { v: { v: number }[] } | undefined;
				expect(list?.v.map((x) => x.v), `${zone} of player ${playerId}`).toEqual(zoneIds(playerId, zone));
			}
			for (const id of zoneIds(playerId, 'Hand')) expect(shown.get(keyOf(TYPE.card, id))?.Name).toBeUndefined();
		}
	});

	it('shows a face-down permanent as its face-down face and nothing underneath', () => {
		const bf = zoneIds(1, 'Battlefield');
		const cardId = bf[0] as number;
		const card = raw.get(keyOf(TYPE.card, cardId)) as WireObj;
		const table = { ...Object.fromEntries(raw), [keyOf(TYPE.card, cardId)]: { ...card, Facedown: { t: 'bool', v: true } } };
		const frame: StateFrame = { kind: 'notify', method: 'setGameView', payload: { gameView: table, sequenceNumber: 1 } };
		const projector = createProjector(null);
		const out = (projector.project(frame) as Extract<StateFrame, { method: 'setGameView' }>).payload.gameView;
		expect(projector.visibilityOf(cardId)).toBe('faceOnly');
		const seen = out[keyOf(TYPE.card, cardId)] as WireObj;
		expect(seen.Name).toBeUndefined();
		expect(seen.Facedown).toEqual({ t: 'bool', v: true });
	});
});

/**
 * What a seat was shown, it keeps — while the card stays where it was shown. A small hand-built table:
 * seat 0 watches player 1's hand (card 10) and library (20 on top of 21, 22). `PlayerMayLook` is how Forge
 * grants a look; `learn` is a reveal the server answered.
 */
describe('a card the seat was shown stays shown while it stays put', () => {
	const int = (v: number) => ({ t: 'int', v });
	const list = (ids: readonly number[]) => ({ t: 'list', v: ids.map(int) });
	const NAMES: Record<number, string> = { 10: 'Goblin Guide', 20: 'Lightning Bolt', 21: 'Shock', 22: 'Mountain' };
	const card = (id: number, mayLook: readonly number[] = []): WireObj => ({
		_type: TYPE.card,
		_id: id,
		Owner: int(1),
		Controller: int(1),
		Name: { t: 'str', v: NAMES[id] },
		...(mayLook.length === 0 ? {} : { PlayerMayLook: list(mayLook) }),
	});
	const player = (id: number, zones: { Hand?: number[]; Library?: number[]; Graveyard?: number[] } = {}): WireObj => ({
		_type: TYPE.player,
		_id: id,
		Hand: list(zones.Hand ?? []),
		Library: list(zones.Library ?? []),
		Graveyard: list(zones.Graveyard ?? []),
	});
	const opening = (mayLook: Record<number, number[]> = {}): StateFrame => ({
		kind: 'notify',
		method: 'setGameView',
		payload: {
			sequenceNumber: 1,
			gameView: Object.fromEntries(
				[player(0), player(1, { Hand: [10], Library: [20, 21, 22] }), ...[10, 20, 21, 22].map((id) => card(id, mayLook[id]))].map((o) => [keyOf(o._type, o._id), o]),
			),
		},
	});
	let seq = 1;
	const delta = (objectDeltas: WireObj[]): StateFrame => ({
		kind: 'notify',
		method: 'applyDelta',
		payload: {
			packet: { seq: ++seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: Object.fromEntries(objectDeltas.map((o) => [keyOf(o._type, o._id), o])), events: [] },
		},
	});
	/** Seat 0's client state after these projected frames: the name it holds for `id`, if any. */
	const held = (emitted: readonly (StateFrame | null)[], id: number): unknown => foldFrames(emitted.filter((f): f is StateFrame => f !== null)).get(keyOf(TYPE.card, id))?.Name;

	it("keeps a hand card Forge let it look at after Forge takes the look back (Thoughtseize's reveal)", () => {
		const p = createProjector(0);
		const out = [p.project(opening({ 10: [0] })), p.project(delta([{ _type: TYPE.card, _id: 10, PlayerMayLook: null }]))];
		expect(p.visibilityOf(10)).toBe('full');
		expect(held(out, 10)).toEqual({ t: 'str', v: 'Goblin Guide' });
	});

	it('follows a revealed top card into its holder\'s hand, and never shows the card under it', () => {
		const p = createProjector(0);
		const out: (StateFrame | null)[] = [p.project(opening())];
		expect(held(out, 20)).toBeUndefined();
		out.push(p.learn([20]));
		expect(held(out, 20), 'the reveal itself sends the card').toEqual({ t: 'str', v: 'Lightning Bolt' });
		out.push(p.project(delta([{ ...player(1, { Hand: [10, 20], Library: [21, 22] }) }])));
		expect(p.visibilityOf(20)).toBe('full');
		expect(held(out, 20), 'drawn, it is still known').toEqual({ t: 'str', v: 'Lightning Bolt' });
		expect(held(out, 21)).toBeUndefined();
		expect(p.learn([20]), 'a card already held needs nothing sent').toBeNull();
	});

	it('forgets a known library card when the library is shuffled', () => {
		const p = createProjector(0);
		const out: (StateFrame | null)[] = [p.project(opening()), p.learn([20])];
		out.push(p.project(delta([{ ...player(1, { Hand: [10], Library: [21, 22, 20] }) }])));
		expect(p.visibilityOf(20)).toBe('hidden');
		expect(held(out, 20), 'a shuffled card is wiped from the client').toBeUndefined();
	});

	it('keeps a known library card while cards are only drawn or put on top of it', () => {
		const p = createProjector(0);
		const out: (StateFrame | null)[] = [p.project(opening()), p.learn([21])];
		out.push(p.project(delta([{ ...player(1, { Hand: [10, 20], Library: [21, 22] }) }])));
		out.push(p.project(delta([{ ...player(1, { Hand: [20], Library: [10, 21, 22] }) }])));
		expect(p.visibilityOf(21)).toBe('full');
		expect(held(out, 21)).toEqual({ t: 'str', v: 'Shock' });
		expect(p.visibilityOf(10), 'a known hand card put back into the library is forgotten').toBe('hidden');
	});

	it('forgets a known hand card that leaves the hand, even for a zone it will be hidden in again', () => {
		const p = createProjector(0);
		const out: (StateFrame | null)[] = [p.project(opening()), p.learn([10])];
		out.push(p.project(delta([{ ...player(1, { Hand: [], Library: [20, 21, 22], Graveyard: [10] }) }])));
		expect(p.visibilityOf(10), 'public in the graveyard').toBe('full');
		out.push(p.project(delta([{ ...player(1, { Hand: [10], Library: [20, 21, 22] }) }])));
		expect(p.visibilityOf(10)).toBe('hidden');
		expect(held(out, 10)).toBeUndefined();
	});

	it("does not keep a look at the seat's own library (a scry), only a reveal of it", () => {
		const p = createProjector(1);
		p.project(opening({ 20: [1] }));
		expect(p.visibilityOf(20)).toBe('full');
		p.project(delta([{ _type: TYPE.card, _id: 20, PlayerMayLook: null }]));
		expect(p.visibilityOf(20), 'the look ends with the scry').toBe('hidden');
		expect(p.learn([20]), 'a reveal of it is kept').not.toBeNull();
		expect(p.visibilityOf(20)).toBe('full');
	});

	it('keeps a known card through a packet that has it in no zone (taken out and put back on top)', () => {
		const p = createProjector(0);
		const out: (StateFrame | null)[] = [p.project(opening()), p.learn([20])];
		out.push(p.project(delta([{ ...player(1, { Hand: [10], Library: [21, 22] }) }])));
		out.push(p.project(delta([{ ...player(1, { Hand: [10], Library: [20, 21, 22] }) }])));
		expect(p.visibilityOf(20)).toBe('full');
		expect(held(out, 20)).toEqual({ t: 'str', v: 'Lightning Bolt' });
	});

	it('teaches the table nothing: a watcher is never shown a reveal', () => {
		const p = createProjector(null);
		p.project(opening({ 10: [0] }));
		expect(p.learn([10, 20])).toBeNull();
		expect(p.visibilityOf(10)).toBe('hidden');
	});

	/** The `PlayerMayLook` seat `viewer`'s client holds for `id`, from these projected frames. */
	const lookHeld = (emitted: readonly (StateFrame | null)[], id: number): unknown =>
		foldFrames(emitted.filter((f): f is StateFrame => f !== null)).get(keyOf(TYPE.card, id))?.PlayerMayLook;

	it('tells the owner which of its hand cards the other seat was shown, and keeps telling it after Forge takes the look back', () => {
		const bob = createProjector(1);
		const out = [bob.project(opening({ 10: [0] }))];
		expect(lookHeld(out, 10), "Forge's own grant, passed through").toEqual(list([0]));
		out.push(bob.project(delta([{ _type: TYPE.card, _id: 10, PlayerMayLook: null }])));
		expect(lookHeld(out, 10), 'the other seat still knows it').toEqual(list([0]));
	});

	it("tells the owner of a reveal the server answered for the other seat, as a delta of that one property", () => {
		const bob = createProjector(1);
		const out: (StateFrame | null)[] = [bob.project(opening())];
		expect(lookHeld(out, 10)).toBeUndefined();
		const told = bob.learn([10], 0);
		out.push(told);
		expect(lookHeld(out, 10)).toEqual(list([0]));
		const packet = told?.method === 'applyDelta' ? told.payload.packet : null;
		expect(packet?.newObjects, 'nothing re-sent whole').toEqual({});
		expect(packet?.objectDeltas, 'one property of one card').toEqual({ [keyOf(TYPE.card, 10)]: { _type: TYPE.card, _id: 10, PlayerMayLook: list([0]) } });
		expect(bob.learn([10], 0), 'told once').toBeNull();
	});

	it('stops telling the owner once the other seat forgets: the card went back into the library and was drawn again', () => {
		const bob = createProjector(1);
		const out: (StateFrame | null)[] = [bob.project(opening()), bob.learn([10], 0)];
		out.push(bob.project(delta([{ ...player(1, { Hand: [], Library: [10, 20, 21, 22] }) }])));
		expect(lookHeld(out, 10), 'hidden in the library').toBeUndefined();
		out.push(bob.project(delta([{ ...player(1, { Hand: [10], Library: [20, 21, 22] }) }])));
		expect(bob.visibilityOf(10)).toBe('full');
		expect(lookHeld(out, 10), 'back in the hand, and nobody else knows it').toBeUndefined();
	});

	it('stops telling the owner of a known top card once the library is shuffled', () => {
		const bob = createProjector(1);
		const out: (StateFrame | null)[] = [bob.project(opening()), bob.learn([20]), bob.learn([20], 0)];
		expect(lookHeld(out, 20), 'both seats saw it').toEqual(list([1, 0]));
		out.push(bob.project(delta([{ ...player(1, { Hand: [10], Library: [21, 22, 20] }) }])));
		expect(lookHeld(out, 20)).toBeUndefined();
	});

	it("stops telling the owner the moment a card leaves the hand while still visible (cast, on the stack, in a graveyard)", () => {
		const bob = createProjector(1);
		const out: (StateFrame | null)[] = [bob.project(opening()), bob.learn([10], 0)];
		out.push(bob.project(delta([{ ...player(1, { Hand: [], Library: [20, 21, 22], Graveyard: [10] }) }])));
		expect(bob.visibilityOf(10)).toBe('full');
		expect(lookHeld(out, 10), 'a public card carries no one-seat knowledge').toBeUndefined();
	});

	/** A packet that sends these cards as new objects: Forge made them anew (they changed zones). */
	const renewed = (cards: WireObj[], players: WireObj[] = []): StateFrame => ({
		kind: 'notify',
		method: 'applyDelta',
		payload: {
			packet: {
				seq: ++seq,
				checksum: 0,
				checksumProperties: [],
				newObjects: Object.fromEntries(cards.map((o) => [keyOf(o._type, o._id), o])),
				objectDeltas: Object.fromEntries(players.map((o) => [keyOf(o._type, o._id), o])),
				events: [],
			},
		},
	});

	it('forgets a hand card that left and came back inside one packet (Timetwister): Forge sends it as a new object', () => {
		const alice = createProjector(0);
		const bob = createProjector(1);
		const aliceOut: (StateFrame | null)[] = [alice.project(opening()), alice.learn([10])];
		const bobOut: (StateFrame | null)[] = [bob.project(opening()), bob.learn([10], 0)];
		expect(lookHeld(bobOut, 10)).toEqual(list([0]));
		const twisted = renewed([card(10)], [player(1, { Hand: [10, 22], Library: [20, 21] })]);
		aliceOut.push(alice.project(twisted));
		bobOut.push(bob.project(twisted));
		expect(alice.visibilityOf(10), 'alice was shown the old object, not this one').toBe('hidden');
		expect(held(aliceOut, 10)).toBeUndefined();
		expect(lookHeld(bobOut, 10), 'and bob is no longer told she knows it').toBeUndefined();
	});

	it('still follows a known top card drawn into the hand, which Forge also sends as a new object', () => {
		const p = createProjector(0);
		const out: (StateFrame | null)[] = [p.project(opening()), p.learn([20])];
		out.push(p.project(renewed([card(20)], [player(1, { Hand: [10, 20], Library: [21, 22] })])));
		expect(p.visibilityOf(20)).toBe('full');
		expect(held(out, 20)).toEqual({ t: 'str', v: 'Lightning Bolt' });
	});

	it("never tells a seat about anyone's knowledge of a card it does not hold", () => {
		const alice = createProjector(0);
		const out: (StateFrame | null)[] = [alice.project(opening({ 10: [0] }))];
		expect(alice.learn([10, 20], 1), "bob's own reveal of his cards changes nothing alice is sent").toBeNull();
		out.push(alice.project(delta([{ _type: TYPE.card, _id: 10, PlayerMayLook: null }])));
		expect(lookHeld(out, 10), 'alice is named, as she knows it, and nobody else').toEqual(list([0]));
		const everyLook = JSON.stringify(out).match(/"PlayerMayLook":\{[^}]*\}/g) ?? [];
		expect(everyLook.filter((l) => l.includes('"v":1')), 'player 1 is in no look alice receives').toEqual([]);
	});
});
