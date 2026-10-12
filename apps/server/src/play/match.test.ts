/**
 * The match, socket-free, driven by a REAL bridge transcript
 * (`fixtures/bridge-two-seats.ndjson`, provenance in `fixtures/transcript.ts`).
 *
 * What is asserted, in the order the brief lists the risks:
 *
 *   1. participants → seats → Forge players, including the ways it can go wrong
 *   2. per-recipient emission: a seat's envelopes, serialised whole, carry none
 *      of the other seat's hidden cards — and the raw stream provably did
 *   3. the cursor: per seat, from 1, by exactly 1, one epoch; the snapshot's
 *      cursor is the latest of any kind
 *   4. asks: answered by callId, aborted on disconnect and on timeout, re-sent
 *      after a snapshot on the next cursor
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientFrameSchema, deltaKeyOf, safeParseServerFrame, type ClientFrame } from '@hadoku/forge-wire';

import { STRICT_PAYMENT_POLICY } from './auto.js';
import type { BridgeCommand, BridgeLine, HostEvents, JvmRecord, MatchHost, MatchHostFactory } from './host.js';
import { ACT_SILENCE_MS, ANSWER_SILENCE_MS, MATCH_ENDED_TITLE, createMatchRegistry, frameGist, type Match, type MatchSpecWithIdentity, type SeatIdentity } from './match.js';
import { MatchSnapshotSchema, ServerEnvelopeSchema, type MatchSnapshot, type ServerEnvelope } from './transport.js';
import {
	FLYING_FILE,
	FLYING_MATCH,
	everyString,
	identifyingStrings,
	leaked,
	loadTranscript,
	rawStatesOf,
	replayFactory,
	secretsFor,
	type ReplayHost,
} from './fixtures/transcript.js';
import { TYPE, csvCardId, foldFrames, keyOf, type StateFrame, type WireObj } from './visibility.js';

const ALICE = 'fk:aaaaaaaaaaaaaaaa';
const BOB = 'fk:bbbbbbbbbbbbbbbb';
const CAROL = 'dev:cccccccccccccccc';
const EPHEMERAL = 'eph:socket-123';

const TWO_HUMANS = {
	seats: [
		{ name: 'Seat 1', ai: false, deck: null },
		{ name: 'Seat 2', ai: false, deck: null },
	],
} as const;

interface Harness {
	match: Match;
	host: ReplayHost;
	sent: { seat: number; envelope: ServerEnvelope }[];
	logs: Record<string, unknown>[];
}

/** Every `phaseStopChanged` the match made, in order. */
type StopsTold = { seat: number; phase: string | null }[];

function harness(disconnectGraceMs?: number): Harness & { stops: StopsTold } {
	const { factory, hosts } = replayFactory();
	const sent: Harness['sent'] = [];
	const logs: Record<string, unknown>[] = [];
	const stops: StopsTold = [];
	const registry = createMatchRegistry({
		host: factory,
		log: (e) => logs.push(e),
		overGraceMs: 60_000,
		disconnectGraceMs,
		emit: (_match, seat, envelope) => sent.push({ seat, envelope }),
		phaseStopChanged: (_match, seat, phase) => stops.push({ seat, phase }),
	});
	const match = registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] });
	return { match, host: hosts[0] as ReplayHost, sent, logs, stops };
}

const TRANSCRIPT = loadTranscript();
/** Everything up to (not including) the probe's ask: the opening, both seats. */
const PROBE_AT = TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask');
const OPENING = TRANSCRIPT.slice(0, PROBE_AT);
const PROBE_ASK = TRANSCRIPT[PROBE_AT] as Extract<BridgeLine, { t: 'frame' }>;
const AFTER_PROBE = TRANSCRIPT.slice(PROBE_AT + 1);

function envelopesFor(h: Harness, seat: number): ServerEnvelope[] {
	return h.sent.filter((s) => s.seat === seat).map((s) => s.envelope);
}

/** The card {@link castOwn} casts; a payment prompt naming it after the cast is the seat's own. */
const OWN_CARD = 67;

/** The seat's own cast of {@link OWN_CARD}: Forge offers its two abilities and the seat's browser picks one. */
function castOwn(h: Harness, seat: number): void {
	const before = envelopesFor(h, seat).length;
	h.host.push({
		t: 'frame',
		seat,
		frame: {
			kind: 'ask',
			callId: `cast-${seat}`,
			method: 'getAbilityToPlay',
			hostCard: { kind: 'card', id: OWN_CARD },
			abilities: [
				{ kind: 'spellAbility', id: 9001 },
				{ kind: 'spellAbility', id: 9002 },
			],
			triggerEvent: null,
		},
	} as never);
	const ask = envelopesFor(h, seat)
		.slice(before)
		.map((e) => e.frame)
		.find((f) => f.kind === 'ask');
	if (ask === undefined || ask.kind !== 'ask') throw new Error('the ability ask never reached the seat');
	expect(h.match.fromClient(seat, ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9001 } }))).toEqual({ ok: true });
}

function reply(callId: string, result: unknown): ClientFrame {
	return ClientFrameSchema.parse({ kind: 'reply', callId, method: 'showConfirmDialog', result });
}

afterEach(() => {
	vi.useRealTimers();
});

describe('the recorded transcript', () => {
	it('is what the brief asks for: a real ask, two seats, an opening sync each', () => {
		expect(PROBE_AT).toBeGreaterThan(0);
		expect((PROBE_ASK.frame as { method: string }).method).toBe('showConfirmDialog');
		for (const seat of [0, 1]) {
			const methods = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === seat).map(
				(l) => (l as { frame: { method: string } }).frame.method,
			);
			expect(methods).toContain('openView');
			expect(methods).toContain('setGameView');
			expect(methods).toContain('applyDelta');
		}
	});

	it('is forge-wire clean: every one of its frames parses as a ServerFrame', () => {
		const frames = TRANSCRIPT.filter((l) => l.t === 'frame');
		expect(frames).toHaveLength(29);
		const bad = frames
			.map((l) => safeParseServerFrame((l as { frame: unknown }).frame))
			.filter((r) => !r.ok);
		expect(bad).toEqual([]);
	});
});

describe('participants → seats → Forge players', () => {
	it('binds the first two durable participants to seats 0 and 1, and a repeat claim is idempotent', () => {
		const { match } = harness();
		expect(match.claim(ALICE)).toEqual({ ok: true, seat: 0, fresh: true });
		expect(match.claim(BOB)).toEqual({ ok: true, seat: 1, fresh: true });
		expect(match.claim(ALICE)).toEqual({ ok: true, seat: 0, fresh: false });
		expect(match.claim(BOB)).toEqual({ ok: true, seat: 1, fresh: false });
	});

	it('refuses a third person rather than seating them anywhere', () => {
		const { match } = harness();
		match.claim(ALICE);
		match.claim(BOB);
		expect(match.claim(CAROL)).toEqual({ ok: false, error: 'match-full' });
	});

	it('refuses an ephemeral identity, which could never reclaim its seat', () => {
		const { match } = harness();
		const outcome = match.claim(EPHEMERAL);
		expect(outcome.ok).toBe(false);
		expect(match.seats.every((s) => s.owner === null)).toBe(true);
	});

	it('never transfers a seat: after its owner disconnects, a newcomer is still refused', () => {
		const { match, host } = harness();
		host.push(...OPENING);
		match.claim(ALICE);
		match.claim(BOB);
		match.seatDisconnected(0);
		expect(match.claim(CAROL)).toEqual({ ok: false, error: 'match-full' });
		expect(match.seatOf(ALICE)).toBe(0);
	});

	it("learns each seat's Forge player from THAT seat's openView, and goes running only when both are known", async () => {
		const { match, host } = harness();
		const running = match.whenRunning(1000);
		const seat0Open = OPENING.findIndex((l) => l.t === 'frame' && l.seat === 0 && (l.frame as { method: string }).method === 'openView');
		const seat1Open = OPENING.findIndex((l) => l.t === 'frame' && l.seat === 1 && (l.frame as { method: string }).method === 'openView');
		const first = Math.min(seat0Open, seat1Open);
		host.push(...OPENING.slice(0, first + 1));
		expect(match.status).toBe('starting');
		host.push(...OPENING.slice(first + 1));
		expect(await running).toEqual({ ok: true });
		expect(match.status).toBe('running');
		expect(match.seats.map((s) => s.playerId)).toEqual([0, 1]);
	});

	it('fails the match, loudly, if a seat is reopened as a different player', () => {
		const { match, host } = harness();
		host.push(...OPENING);
		host.push({ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [1] } } });
		expect(match.status).toBe('failed');
		expect(match.failure).toContain('reopened');
		expect(host.stopped).toBe(true);
	});
});

/*
 * Item 4, wave 29 §B: the server half of *"i noticed you're still not
 * pulling in the watchparty selected avatars. why not?"* — the last hop,
 * `MatchSpec.seats[i].avatarId` → `Match`'s seat table → `seatIdentities()`,
 * which `socket.ts` sends as its own `forge:seats` event (never folded into
 * `MatchSnapshot`; see that method's own header for why).
 */
describe("item 4: a seat's identity", () => {
	function avatarHarness(avatarIds: readonly [string | undefined, string | undefined]): Harness {
		const { factory, hosts } = replayFactory();
		const sent: Harness['sent'] = [];
		const logs: Record<string, unknown>[] = [];
		const registry = createMatchRegistry({
			host: factory,
			log: (e) => logs.push(e),
			overGraceMs: 60_000,
			emit: (_match, seat, envelope) => sent.push({ seat, envelope }),
		});
		const spec: MatchSpecWithIdentity = {
			seats: [
				{ name: 'Seat 1', ai: false, deck: null, avatarId: avatarIds[0] },
				{ name: 'Seat 2', ai: false, deck: null, avatarId: avatarIds[1] },
			],
		};
		const match = registry.create(spec);
		return { match, host: hosts[0] as ReplayHost, sent, logs };
	}

	it('carries avatarId beside claimed and playerId, absent — not null, not undefined-as-a-key — for a seat with none', () => {
		const { match } = avatarHarness(['wanderer', undefined]);
		expect(match.seatIdentities()).toEqual([
			{ seat: 0, claimed: false, playerId: null, avatarId: 'wanderer' },
			{ seat: 1, claimed: false, playerId: null },
		]);
		// `toEqual` above would pass just as well for `avatarId: undefined`; the
		// key itself has to be checked to catch that regression (D-avatar-field.md
		// §3, "why the key is absent rather than `avatarId: undefined`").
		expect(match.seatIdentities()[1]).not.toHaveProperty('avatarId');
		const wire = JSON.stringify(match.seatIdentities());
		expect(wire).toContain('"avatarId":"wanderer"');
		expect(wire).not.toContain('"avatarId":null');
	});

	it('holds once claimed and once Forge has opened the seat, unaffected by either', () => {
		const { match, host } = avatarHarness(['wanderer', 'herald']);
		match.claim(ALICE);
		host.push(...OPENING);
		// Seat 1's own coin-toss Play/Draw bar is the last thing `OPENING` sent
		// it — genuinely still open, since nothing in this replay presses it —
		// so `waitingOn` correctly carries that, unaffected by either claim.
		// …and the coin toss that bar IS (AE17) rides on both rows, the same object.
		const coinToss = { winner: 1, at: expect.any(Number) as number };
		expect(match.seatIdentities()).toEqual([
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'wanderer', coinToss },
			{ seat: 1, claimed: false, playerId: 1, avatarId: 'herald', waitingOn: { method: 'confirm', hostCard: null }, coinToss },
		]);
	});

	it('is absent for a seat built with none, even once that seat is open and claimed', () => {
		const { match, host } = avatarHarness([undefined, undefined]);
		match.claim(ALICE);
		match.claim(BOB);
		host.push(...OPENING);
		for (const identity of match.seatIdentities()) expect(identity).not.toHaveProperty('avatarId');
	});
});

describe('Q6: an avatar changed mid-match (wave 32)', () => {
	function liveAvatarHarness(): { match: Match; told: { seat: number; avatarId?: string }[][] } {
		const { factory } = replayFactory();
		const told: { seat: number; avatarId?: string }[][] = [];
		const registry = createMatchRegistry({
			host: factory,
			log: () => undefined,
			overGraceMs: 60_000,
			emit: () => undefined,
			seatsChanged: (_match, seats) => told.push(seats),
		});
		const spec: MatchSpecWithIdentity = {
			seats: [
				{ name: 'Seat 1', ai: false, deck: null, avatarId: 'sage' },
				{ name: 'Seat 2', ai: false, deck: null },
			],
		};
		return { match: registry.create(spec), told };
	}

	it('tells everyone the whole roster, with the changed face and nothing else moved', () => {
		const { match, told } = liveAvatarHarness();
		match.setSeatAvatar(1, 'herald');
		expect(told).toHaveLength(1);
		expect(told[0]).toEqual([
			{ seat: 0, claimed: false, playerId: null, avatarId: 'sage' },
			{ seat: 1, claimed: false, playerId: null, avatarId: 'herald' },
		]);
		expect(match.seatIdentities()[1]).toMatchObject({ avatarId: 'herald' });
	});

	it('clears a face with null — the key is ABSENT again — and does not re-send a change that changes nothing', () => {
		const { match, told } = liveAvatarHarness();
		match.setSeatAvatar(0, null);
		expect(match.seatIdentities()[0]).not.toHaveProperty('avatarId');
		expect(told).toHaveLength(1);
		match.setSeatAvatar(0, null);
		match.setSeatAvatar(1, null);
		expect(told).toHaveLength(1);
		match.setSeatAvatar(7, 'nobody');
		expect(told).toHaveLength(1);
	});
});

/**
 * The OTHER seat's view of an open ask — `seatIdentities()`'s
 * `waitingOn`, carried on `forge:seats` the same way item 4's `avatarId` is (see
 * that method's own header on why this is not folded into `MatchSnapshot`).
 */
describe("a seat's open ask or payment, for the other seat's banner", () => {
	function waitingHarness(): Harness & { told: SeatIdentity[][] } {
		const { factory, hosts } = replayFactory();
		const sent: Harness['sent'] = [];
		const logs: Record<string, unknown>[] = [];
		const told: SeatIdentity[][] = [];
		const registry = createMatchRegistry({
			host: factory,
			log: (e) => logs.push(e),
			overGraceMs: 60_000,
			emit: (_match, seat, envelope) => sent.push({ seat, envelope }),
			seatsChanged: (_match, seats) => told.push(seats),
		});
		const match = registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] });
		return { match, host: hosts[0] as ReplayHost, sent, logs, told };
	}

	it('is absent for both seats before anything has been sent', () => {
		const h = waitingHarness();
		for (const identity of h.match.seatIdentities()) expect(identity).not.toHaveProperty('waitingOn');
	});

	it("appears on the ASKING seat's own entry — never the other seat's — once the ask has stayed open past the grace, and clears the instant it is answered", () => {
		vi.useFakeTimers();
		const h = waitingHarness();
		h.host.push(...OPENING);
		// Seat 1's own coin-toss bar, pressed — same as a real browser's click —
		// so what follows is checked against a seat that has settled past it,
		// not one `OPENING`'s own replay happens to leave sitting on it.
		h.match.fromClient(1, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
		vi.advanceTimersByTime(200);
		const before = h.told.length;
		h.host.push(PROBE_ASK);
		expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'showConfirmDialog', hostCard: null } });
		expect(h.match.seatIdentities()[1]).not.toHaveProperty('waitingOn');
		expect(h.told.length, 'not told yet: the grace').toBe(before);
		vi.advanceTimersByTime(150);
		expect(h.told.length, 'told once the ask outlived the grace').toBeGreaterThan(before);
		expect(h.told.at(-1)![0]).toMatchObject({ waitingOn: { method: 'showConfirmDialog', hostCard: null } });
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		const toldBefore = h.told.length;
		h.match.fromClient(0, reply(callId, true));
		expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
		expect(h.told.length, 'the clear is told at once, no grace').toBe(toldBefore + 1);
		expect(h.told.at(-1)![0]).not.toHaveProperty('waitingOn');
	});

	it('an ask the browser answers inside the grace is never told to the other seat — no flash', () => {
		// The other screen flashed "Waiting for Alice to decide…" twice per land before the grace
		// (claws run 37842845722).
		vi.useFakeTimers();
		const h = waitingHarness();
		h.host.push(...OPENING);
		h.match.fromClient(1, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
		vi.advanceTimersByTime(200);
		const before = h.told.length;
		h.host.push(PROBE_ASK);
		vi.advanceTimersByTime(20);
		h.match.fromClient(0, reply((PROBE_ASK.frame as { callId: string }).callId, true));
		vi.advanceTimersByTime(500);
		expect(h.told.length, 'nothing told: the wait never outlived the grace').toBe(before);
		expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
	});

	describe("the seat's own click's one-ability offer, which its browser answers by itself", () => {
		const offer = (callId: string, hostCard: number) => ({
			t: 'frame' as const,
			seat: 0,
			frame: {
				kind: 'ask' as const,
				callId,
				method: 'getAbilityToPlay' as const,
				hostCard: { kind: 'card' as const, id: hostCard },
				abilities: [{ kind: 'spellAbility' as const, id: 255, label: 'Play land' }],
				triggerEvent: null,
			},
		});
		const click = (h: Harness, card: number) =>
			h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: card }, otherCardViewsToSelect: [], triggerEvent: null }));

		it('is never told to the other seat, however long a loaded browser takes to answer it', () => {
			// Claws: the browser's reply took 154 and 371 ms, past the grace, and bob read
			// "Waiting for Alice to decide…" for a land Alice had already played (e2e/w62-bounce.spec.ts).
			vi.useFakeTimers();
			const h = waitingHarness();
			h.host.push(...OPENING);
			h.match.fromClient(1, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
			vi.advanceTimersByTime(200);
			const before = h.told.length;
			click(h, 121);
			h.host.push(offer('land-1', 121));
			expect(h.sent.some((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'land-1'), 'the browser is asked').toBe(true);
			vi.advanceTimersByTime(400);
			expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
			expect(h.told.slice(before).some((seats) => seats[0]?.waitingOn !== undefined), 'never told').toBe(false);
		});

		it('under full control it is the picker, a real decision: told after the grace', () => {
			vi.useFakeTimers();
			const h = waitingHarness();
			h.host.push(...OPENING);
			h.match.fromClient(1, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
			h.match.setFullControl(0, true);
			vi.advanceTimersByTime(200);
			click(h, 121);
			h.host.push(offer('land-2', 121));
			vi.advanceTimersByTime(200);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'getAbilityToPlay' } });
			expect(h.told.at(-1)![0]).toMatchObject({ waitingOn: { method: 'getAbilityToPlay' } });
		});
	});

	it('a wait that appears is told after the grace even while frames keep re-checking it — the grace is a delay, never a debounce (AE16)', () => {
		// An End Turn crawl re-checks on almost every frame; resetting the timer each time told the
		// wait only when the crawl stopped, ~5 s late (claws: 451, 5045, 837 ms).
		vi.useFakeTimers();
		const h = waitingHarness();
		h.host.push(...OPENING);
		h.match.fromClient(1, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
		vi.advanceTimersByTime(200);
		const before = h.told.length;
		h.host.push(PROBE_ASK);
		const recheck = (h.match as unknown as { checkWaitingOn(): void }).checkWaitingOn.bind(h.match);
		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(40);
			recheck();
		}
		expect(h.told.length, 'told within the grace of the wait appearing, not after the re-checks stopped').toBeGreaterThan(before);
		expect(h.match.seatIdentities()[0]).toHaveProperty('waitingOn');
	});

	it('stays while the asked seat is away — its ask is still open — and clears on its answer', () => {
		const h = waitingHarness();
		h.host.push(...OPENING, PROBE_ASK);
		expect(h.match.seatIdentities()[0]).toHaveProperty('waitingOn');
		h.match.seatDisconnected(0);
		expect(h.match.seatIdentities()[0]).toHaveProperty('waitingOn');
		h.match.fromClient(0, reply((PROBE_ASK.frame as { callId: string }).callId, true));
		expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
	});

	it('does not re-send the roster when the fact it carries has not moved', () => {
		const h = waitingHarness();
		h.host.push(...OPENING);
		const before = h.told.length;
		// A second identical state frame changes nothing `waitingOn` cares about.
		h.host.push(OPENING[OPENING.length - 1] as BridgeLine);
		expect(h.told.length).toBe(before);
	});

	/**
	 * The isolation half (`e2e/play.spec.ts`'s own check, mirrored server-side):
	 * a card named in the asking seat's OWN hand must never resolve to a name
	 * for the other seat, and a card on the battlefield — public either way —
	 * must. Built by hand rather than from the recorded transcript: the 31-line
	 * fixture never reaches a real battlefield.
	 */
	describe('the host card is resolved against the OTHER seat, never the asker', () => {
		const list = (...ids: number[]) => ({ t: 'list', v: ids.map((v) => ({ t: 'int', v })) });
		const card = (id: number, name: string) => ({ [String(deltaKeyOf(TYPE.card, id))]: { _type: TYPE.card, _id: id, Name: { t: 'str', v: name } } });
		function gameView(player0Extra: Record<string, unknown>): Record<string, unknown> {
			return {
				[String(deltaKeyOf(TYPE.game, 1))]: { _type: TYPE.game, _id: 1, Players: list(0, 1) },
				[String(deltaKeyOf(TYPE.player, 0))]: { _type: TYPE.player, _id: 0, Name: { t: 'str', v: 'Seat 1' }, Life: { t: 'int', v: 20 }, ...player0Extra },
				[String(deltaKeyOf(TYPE.player, 1))]: { _type: TYPE.player, _id: 1, Name: { t: 'str', v: 'Seat 2' }, Life: { t: 'int', v: 20 } },
			};
		}
		function openGame(h: Harness, table: Record<string, unknown>): void {
			h.host.push(
				{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'setGameView', payload: { gameView: table, sequenceNumber: -1 } } },
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'setGameView', payload: { gameView: table, sequenceNumber: -1 } } },
				{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [1] } } },
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } },
			);
		}
		function askAbout(h: Harness, cardId: number): void {
			h.host.push(
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'deciding', card: { kind: 'card', id: cardId } } },
				{ t: 'frame', seat: 0, frame: { kind: 'ask', callId: 'w60-ask', method: 'showConfirmDialog', message: 'm', title: 't', yesButtonText: 'Yes', noButtonText: 'No', defaultYes: false } },
			);
		}

		it('names a public (battlefield) card to the other seat', () => {
			const h = waitingHarness();
			const table = { ...gameView({ Battlefield: list(500) }), ...card(500, 'Public Permanent') };
			openGame(h, table);
			askAbout(h, 500);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'showConfirmDialog', hostCard: 'Public Permanent' } });
		});

		it("never names a card the asking seat's own hand holds, even though the asker's own entry is the one carrying the fact", () => {
			const h = waitingHarness();
			const table = { ...gameView({ Hand: list(501) }), ...card(501, 'Secret In Hand') };
			openGame(h, table);
			askAbout(h, 501);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'showConfirmDialog', hostCard: null } });
		});
	});

	/**
	 * `setSelectables` is never an `OpenAsk` — Thirst for Knowledge's own
	 * discard reaches the wire as exactly this, confirmed against the real jar
	 * (`docs/planning/wave60-evidence/B/waiting.md`), with a bridge
	 * `tempShowZones` ASK open at the same moment and no card on the priority
	 * prompt that preceded it — the shape every case below reproduces.
	 */
	describe('a selection (setSelectables) counts as waitingOn too — Thirst for Knowledge’s own shape', () => {
		const list = (...ids: number[]) => ({ t: 'list', v: ids.map((v) => ({ t: 'int', v })) });
		const card = (id: number, name: string) => ({ [String(deltaKeyOf(TYPE.card, id))]: { _type: TYPE.card, _id: id, Name: { t: 'str', v: name } } });
		/** A game whose `Stack` names exactly one item, whose `SourceCard` is `cardId`. */
		function gameViewWithStack(stackCardId: number, stackCardName: string): Record<string, unknown> {
			return {
				[String(deltaKeyOf(TYPE.game, 1))]: { _type: TYPE.game, _id: 1, Players: list(0, 1), Stack: list(900) },
				[String(deltaKeyOf(TYPE.player, 0))]: { _type: TYPE.player, _id: 0, Name: { t: 'str', v: 'Seat 1' }, Life: { t: 'int', v: 20 } },
				[String(deltaKeyOf(TYPE.player, 1))]: { _type: TYPE.player, _id: 1, Name: { t: 'str', v: 'Seat 2' }, Life: { t: 'int', v: 20 } },
				[String(deltaKeyOf(TYPE.stackItem, 900))]: { _type: TYPE.stackItem, _id: 900, SourceCard: { t: 'int', v: stackCardId } },
				...card(stackCardId, stackCardName),
			};
		}
		function openGame(h: Harness, table: Record<string, unknown>): void {
			h.host.push(
				{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'setGameView', payload: { gameView: table, sequenceNumber: -1 } } },
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'setGameView', payload: { gameView: table, sequenceNumber: -1 } } },
				{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [1] } } },
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } },
				// The priority prompt that precedes the resolve — card: null, exactly as measured.
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Priority: Seat 1\nStack: 1 to Resolve.', card: null } },
			);
		}
		function openSelection(h: Harness, min: number, max: number, cardIds: number[]): void {
			h.host.push({
				t: 'frame',
				seat: 0,
				frame: { kind: 'notify', method: 'setSelectables', cards: cardIds.map((id) => ({ kind: 'card', id })), min, max, players: [] },
			});
		}

		it('min === max === 1 reuses chooseSingleEntityForEffect’s own verb slot', () => {
			const h = waitingHarness();
			openGame(h, gameViewWithStack(81, 'Thirst for Knowledge'));
			openSelection(h, 1, 1, [82]);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'chooseSingleEntityForEffect', hostCard: 'Thirst for Knowledge' } });
		});

		it('any other min/max reuses getChoices’ own verb slot, and the host card falls back to the stack’s top when the prompt carries none', () => {
			const h = waitingHarness();
			openGame(h, gameViewWithStack(81, 'Thirst for Knowledge'));
			openSelection(h, 2, 2, [82, 83, 84, 85, 86]);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'getChoices', hostCard: 'Thirst for Knowledge' } });
		});

		it('a selection wins over a concurrently open ask (the bridge’s own tempShowZones, measured alongside it)', () => {
			const h = waitingHarness();
			openGame(h, gameViewWithStack(81, 'Thirst for Knowledge'));
			h.host.push({
				t: 'frame',
				seat: 0,
				frame: { kind: 'ask', callId: 'w60-tsz', method: 'tempShowZones', controller: { kind: 'player', id: 0 }, zonesToUpdate: [{ player: { kind: 'player', id: 0 }, zones: ['Hand'] }] },
			});
			openSelection(h, 2, 2, [82, 83, 84, 85, 86]);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'getChoices', hostCard: 'Thirst for Knowledge' } });
		});

		it('clears the instant clearSelectables arrives, with the ask still open', () => {
			const h = waitingHarness();
			openGame(h, gameViewWithStack(81, 'Thirst for Knowledge'));
			openSelection(h, 2, 2, [82, 83, 84, 85, 86]);
			expect(h.match.seatIdentities()[0]).toHaveProperty('waitingOn');
			h.host.push({ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'clearSelectables' } });
			expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
		});
	});

	/**
	 * The coin toss (Play/Draw), the opening Keep/Mulligan, and an ORDINARY
	 * priority window all answer through `updateButtons` alone — no
	 * `OpenAsk`, no selection, no payment, and (for an ordinary window with
	 * something castable) often no stored ask either, once this server's own
	 * auto-pass has had a chance to decide it. `SeatState.wireButtonsLive`
	 * (`Match.send`'s own note) is the one fact that already tracks "this
	 * seat's own bar is currently live" correctly through every auto-pass
	 * correction, so it is the catch-all underneath the three specific
	 * branches above. Confirmed against a real two-browser run: without the
	 * two pregame bars counting, the OTHER seat's own pregame pop-up never
	 * appeared while bob was choosing play-or-draw or deciding his mulligan;
	 * without ORDINARY priority also counting, the OTHER seat's small corner
	 * line never appeared once the game was properly under way either — the
	 * fact this whole feature replaced used to read ANY enabled button one,
	 * priority included, off the viewer's OWN bar.
	 */
	describe('an answer bar (coin toss, opening Keep/Mulligan, or ordinary priority) counts too', () => {
		function barFrame(seat: number, label1: string, label2: string, enable1: boolean, enable2: boolean) {
			return {
				t: 'frame' as const,
				seat,
				frame: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: seat }, label1, label2, enable1, enable2, focus1: enable1 },
			};
		}

		it('the coin toss’s own Play/Draw bar', () => {
			const h = waitingHarness();
			h.host.push(barFrame(0, 'Play', 'Draw', true, true));
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'confirm', hostCard: null } });
		});

		// AE17 — the operator, three times: "both players should see the coinflip". Forge tells only the
		// winner; the server tells both, at once (no grace), and withdraws it when the winner answers.
		it('the coin toss is told to BOTH seats the instant the winner’s Play/Draw bar goes live, and withdrawn when that bar changes', () => {
			const h = waitingHarness();
			for (const identity of h.match.seatIdentities()) expect(identity).not.toHaveProperty('coinToss');
			const before = h.told.length;
			h.host.push(barFrame(1, 'Play', 'Draw', true, true));
			const ids = h.match.seatIdentities();
			expect(ids[0]).toMatchObject({ coinToss: { winner: 1 } });
			expect(ids[1]).toMatchObject({ coinToss: { winner: 1 } });
			expect(typeof (ids[0] as { coinToss?: { at: number } }).coinToss?.at).toBe('number');
			expect(h.told.length, 'told at once — a coin toss is never a flash').toBe(before + 1);
			expect(h.told.at(-1)![0]).toMatchObject({ coinToss: { winner: 1 } });
			// The loser's own bar changing is not the answer.
			h.host.push(barFrame(0, 'OK', 'End Turn', false, false));
			expect(h.match.seatIdentities()[0]).toMatchObject({ coinToss: { winner: 1 } });
			// The winner's bar moving on IS the answer: withdrawn, both told.
			const toldBefore = h.told.length;
			h.host.push(barFrame(1, 'Keep', 'Mulligan', true, true));
			for (const identity of h.match.seatIdentities()) expect(identity).not.toHaveProperty('coinToss');
			expect(h.told.length).toBe(toldBefore + 1);
		});

		it('the opening hand’s own Keep/Mulligan bar', () => {
			const h = waitingHarness();
			h.host.push(barFrame(0, 'Keep', 'Mulligan', true, true));
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'confirm', hostCard: null } });
		});

		it('an ordinary priority window (a "Priority: …" prompt, OK / End Turn live) counts too — as `priority`, never as a decision', () => {
			// The operator, 2026-10-08 (AE13), after Selesnya Sanctuary bounced itself with no choice to
			// make: "it still shows 'Waiting for Bella to decide…' as if i needed to make a choice there."
			// Holding priority is a wait, not a decision: the client draws it with no verb.
			const h = waitingHarness();
			h.host.push(
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Priority: Seat 1\nTurn: 1 (Seat 1)\nPhase: Main phase, precombat\nStack: Empty', card: null } },
				barFrame(0, 'OK', 'End Turn', true, true),
			);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'priority', hostCard: null } });
		});

		it('a bar alone with no "Priority:" prompt (the pregame shape) stays `confirm`', () => {
			const h = waitingHarness();
			h.host.push(barFrame(0, 'OK', 'End Turn', true, true));
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'confirm', hostCard: null } });
		});

		it('a disabled bar of any shape carries nothing — Forge has not actually left this seat a live button', () => {
			const h = waitingHarness();
			h.host.push(barFrame(0, 'OK', 'End Turn', false, false));
			expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
		});

		it('a real payment reports `pay`, not the generic bar fallback, even though its own Auto bar is also live', () => {
			const h = waitingHarness();
			h.host.push(
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Pay Mana Cost: {1}', card: null } },
				barFrame(0, 'Auto', 'Cancel', true, true),
			);
			expect(h.match.seatIdentities()[0]).toMatchObject({ waitingOn: { method: 'pay', hostCard: null } });
		});

		it('a seat\'s own yield after End Turn ("Yielding until …", only Cancel live) carries nothing — it passed priority and decides nothing', () => {
			// The operator, 2026-10-11, with full control on the other seat: "i see 'Waiting for Hadoku to
			// decide…' but on Hadoku's side, there is nothing since they clicked end turn".
			const h = waitingHarness();
			h.host.push(
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Yielding until end of turn.\nYou may cancel this yield to take an action.', card: null } },
				barFrame(0, 'OK', 'Cancel', false, true),
			);
			expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
		});

		it('clears the instant the seat presses, the same as a real browser click', () => {
			const h = waitingHarness();
			// `fromClient` only acts once the match is running — both seats open.
			h.host.push(
				{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } },
				{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [1] } } },
			);
			h.host.push(barFrame(0, 'Play', 'Draw', true, true));
			expect(h.match.seatIdentities()[0]).toHaveProperty('waitingOn');
			expect(h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }))).toEqual({ ok: true });
			expect(h.match.seatIdentities()[0]).not.toHaveProperty('waitingOn');
		});
	});
});

describe('per-recipient emission, over whole serialised payloads', () => {
	const h = harness();
	h.host.push(...TRANSCRIPT);
	const raw = [0, 1].map((seat) => rawStatesOf(TRANSCRIPT, seat));

	it.each([0, 1])("seat %i's envelopes carry none of the other seat's hidden cards", (seat) => {
		const { secrets, hiddenCards } = secretsFor(raw[seat] ?? [], seat);
		expect(hiddenCards.size).toBeGreaterThan(40); // a hand and two libraries
		expect(secrets.size).toBeGreaterThan(0);
		const rawText = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === seat)
			.map((l) => JSON.stringify(l))
			.join('\n');
		// Not vacuous: Forge's own stream to this seat carries every secret.
		expect(leaked(secrets, rawText).length).toBe(secrets.size);

		const emitted = envelopesFor(h, seat).map((e) => JSON.stringify(e)).join('\n');
		expect(leaked(secrets, emitted)).toEqual([]);
	});

	it('never hands a frame for one seat to the other — every emit names the seat the bridge named', () => {
		// the transcript's own closing window — seat 1's opening
		// Upkeep priority — is auto-passed (Upkeep is not a stop phase), so BOTH
		// halves are withheld (`decidePendingWindow`) rather than forwarded: a
		// window the server answers sends nothing at all, not even its buttons
		// disabled (see that method's own header on why). That is the two bridge
		// frames this harness does NOT re-emit 1:1 — read off the log, never
		// guessed, so a different fixture change cannot hide behind it.
		const withheld = h.logs.filter((l) => l.evt === 'prompt-withheld');
		expect(withheld).toEqual([{ evt: 'prompt-withheld', matchId: h.match.id, seat: 1, kind: 'priority', why: 'auto-pass' }]);
		const expected = TRANSCRIPT.filter((l) => l.t === 'frame').map((l) => (l as { seat: number }).seat);
		// Each bridge frame becomes exactly one emit, to the same seat, except
		// early state frames (re-ordered behind openView, not re-routed) and the
		// withheld pair above.
		const expectedSeats = [...expected].sort();
		expectedSeats.splice(expectedSeats.lastIndexOf(1), 1);
		expectedSeats.splice(expectedSeats.lastIndexOf(1), 1);
		expect(h.sent.map((s) => s.seat).sort()).toEqual(expectedSeats);
		for (const seat of [0, 1]) {
			const bridgeMethods = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === seat)
				.map((l) => (l as { frame: { method: string } }).frame.method)
				.sort();
			if (seat === 1) {
				bridgeMethods.splice(bridgeMethods.indexOf('showPromptMessage'), 1);
				bridgeMethods.splice(bridgeMethods.indexOf('updateButtons'), 1);
			}
			expect(envelopesFor(h, seat).map((e) => e.frame.method).sort()).toEqual(bridgeMethods);
		}
	});

	it('emits only envelopes a browser accepts', () => {
		for (const { envelope } of h.sent) {
			const parsed = ServerEnvelopeSchema.safeParse(envelope);
			expect(parsed.success ? [] : parsed.error.issues.slice(0, 3)).toEqual([]);
			expect(safeParseServerFrame(envelope.frame).ok).toBe(true);
		}
	});

	it('sends openView before any state frame, so the client knows who it is first', () => {
		for (const seat of [0, 1]) {
			const tierC = envelopesFor(h, seat).filter((e) =>
				['openView', 'setGameView', 'applyDelta'].includes(e.frame.method),
			);
			expect(tierC[0]?.frame.method).toBe('openView');
		}
	});
});

describe("regression: the red jvm.test.ts run ('Flying'), from its captured frames", () => {
	const lines = loadTranscript(FLYING_FILE, FLYING_MATCH);
	const states = rawStatesOf(lines, 1);
	const last = states[states.length - 1] as Map<string, import('./visibility.js').WireObj>;
	const hand = (last.get('268435457')?.Hand as { v: { v: number }[] }).v.map((x) => x.v);
	const library = (last.get('268435457')?.Library as { v: { v: number }[] }).v.map((x) => x.v);

	it('holds the case exactly: a hidden library card whose whole rules text is "Flying", and visible flyers in hand', () => {
		expect(library).toContain(99);
		expect(identifyingStrings(last, 99)).toContain('Flying');
		expect(identifyingStrings(last, 99)).toContain('Bog Imp');
		for (const id of [96, 100]) {
			expect(hand).toContain(id);
			// Visible only as a keyword — which the old `str`-only `allowed` never collected.
			expect(identifyingStrings(last, id)).not.toContain('Flying');
			expect(everyString(last, id)).toContain('Flying');
		}
	});

	it('no longer counts "Flying" as a secret, and still counts the hidden card\'s name', () => {
		const { secrets, hiddenCards } = secretsFor(states, 1);
		expect(hiddenCards.has(99)).toBe(true);
		expect(secrets.has('Flying')).toBe(false);
		expect(secrets.has('Bog Imp')).toBe(true);
	});

	it("puts none of seat 1's secrets in what seat 1 is sent — and the projection hides card 99 whole", () => {
		const h = harness();
		h.host.push(...lines);
		const emitted = envelopesFor(h, 1).map((e) => JSON.stringify(e)).join('\n');
		const raw = lines.filter((l) => l.t === 'frame').map((l) => JSON.stringify(l)).join('\n');
		const { secrets } = secretsFor(states, 1);
		expect(secrets.size).toBeGreaterThan(40);
		expect(leaked(secrets, raw).length).toBe(secrets.size);
		expect(leaked(secrets, emitted)).toEqual([]);
		for (const e of envelopesFor(h, 1)) {
			if (e.frame.method !== 'applyDelta' && e.frame.method !== 'setGameView') continue;
			const table =
				e.frame.method === 'applyDelta'
					? { ...e.frame.payload.packet.newObjects, ...e.frame.payload.packet.objectDeltas }
					: e.frame.payload.gameView;
			for (const obj of Object.values(table) as { _type: number; _id: number }[]) {
				if (obj._type === TYPE.cardState) expect(csvCardId(obj._id)).not.toBe(99);
			}
		}
	});
});

describe("regression: a card in both a precon's main deck and its sideboard (jvm.test.ts, seed 936747)", () => {
	// "Arcane Tempo" lists Beacon Bolt in [Main] AND [Sideboard]. Seat 0 is sent its own
	// sideboard with names, and the library copy's name once read as leaked by it.
	const list = (...ids: number[]) => ({ t: 'list', v: ids.map((v) => ({ t: 'int', v })) });
	const card = (id: number, name: string): [string, WireObj] => [
		keyOf(TYPE.card, id),
		{ _type: TYPE.card, _id: id, Name: { t: 'str', v: name } },
	];
	const state = new Map<string, WireObj>([
		[keyOf(TYPE.player, 0), { _type: TYPE.player, _id: 0, Library: list(17), Sideboard: list(71) }],
		[keyOf(TYPE.player, 1), { _type: TYPE.player, _id: 1, Library: list(200), Sideboard: list(271) }],
		card(17, 'Beacon Bolt'),
		card(71, 'Beacon Bolt'),
		card(200, 'Faerie Duelist'),
		card(271, 'Negate'),
	]);

	it("does not count the viewer's own sideboard as hidden, so its name is no secret", () => {
		const { secrets, hiddenCards } = secretsFor([state], 0);
		expect(hiddenCards.has(71)).toBe(false);
		expect(secrets.has('Beacon Bolt')).toBe(false);
	});

	it("counts the opponent's sideboard as hidden, so its name is a secret", () => {
		const { secrets, hiddenCards } = secretsFor([state], 0);
		expect(hiddenCards.has(271)).toBe(true);
		expect(secrets.has('Negate')).toBe(true);
		expect(secrets.has('Faerie Duelist')).toBe(true);
	});
});

describe("regression: a secret spelled like a wire key (jvm.test.ts, seed 3269333, 'Life // Death')", () => {
	// The hidden split card's face name "Life" is also the PlayerView key `"Life":{"t":"int",…}`.
	const player = JSON.stringify({ _type: TYPE.player, _id: 0, Life: { t: 'int', v: 20 } });

	it('does not count an occurrence as an object key as a leak', () => {
		expect(leaked(['Life'], player)).toEqual([]);
		expect(leaked(['Life'], '{"Life" \n : {"t":"int","v":20}}')).toEqual([]);
	});

	it('counts an occurrence as a value — even after the same text appeared as a key', () => {
		expect(leaked(['Life'], JSON.stringify({ Name: { t: 'str', v: 'Life' } }))).toEqual(['Life']);
		expect(leaked(['Life'], `${player}\n${JSON.stringify({ Name: { t: 'str', v: 'Life' } })}`)).toEqual(['Life']);
		expect(leaked(['Life'], JSON.stringify({ Life: ['Life'] }))).toEqual(['Life']);
	});

	it('still does not match a secret embedded in a larger string value', () => {
		expect(leaked(['Life'], JSON.stringify({ Text: 'You gain Life' }))).toEqual([]);
	});
});

describe('the cursor', () => {
	it('is per seat: from 1, by exactly 1, in one epoch', () => {
		const h = harness();
		h.host.push(...TRANSCRIPT);
		for (const seat of [0, 1]) {
			const cursors = envelopesFor(h, seat).map((e) => e.cursor);
			expect(cursors.length).toBeGreaterThan(5);
			expect(cursors.map((c) => c.seq)).toEqual(cursors.map((_, i) => i + 1));
			expect(new Set(cursors.map((c) => c.epoch))).toEqual(new Set([h.match.epoch]));
		}
	});

	it('is a new epoch for a new match process', () => {
		const a = harness();
		const b = harness();
		expect(a.match.epoch).not.toBe(b.match.epoch);
	});

	it("puts the seat's LATEST cursor of any kind on the snapshot, and only state frames in it", () => {
		const h = harness();
		h.host.push(...OPENING);
		for (const seat of [0, 1]) {
			const snap = h.match.snapshot(seat);
			expect('frames' in snap).toBe(true);
			if (!('frames' in snap)) continue;
			expect(MatchSnapshotSchema.safeParse(snap).success).toBe(true);
			const last = envelopesFor(h, seat).at(-1);
			expect(snap.cursor).toEqual(last?.cursor);
			// The opening ends with prompts, so the latest frame is NOT a state frame —
			// the case the literal reading of the contract gets wrong.
			expect(['showPromptMessage', 'updateButtons']).toContain(last?.frame.method);
			expect(snap.frames.every((f) => ['openView', 'setGameView', 'applyDelta'].includes(f.method))).toBe(true);
			expect(snap.playerId).toBe(seat);
			expect(snap.seat).toBe(seat);
		}
	});

	it("folds the seat's own history into the state that seat should hold", () => {
		const h = harness();
		h.host.push(...TRANSCRIPT);
		const state = h.match.seatState(0);
		if ('error' in state) throw new Error(state.error);
		expect(state.cursor).toEqual(envelopesFor(h, 0).at(-1)?.cursor);
		expect(Object.values(state.objects).filter((o) => o._type === 3)).toHaveLength(1);
		const { secrets } = secretsFor(rawStatesOf(TRANSCRIPT, 0), 0);
		expect(leaked(secrets, JSON.stringify(state))).toEqual([]);
	});

	it('answers "match-starting", not an empty snapshot, before the seat has a player', () => {
		const h = harness();
		expect(h.match.snapshot(0)).toEqual({ error: 'match-starting' });
	});
});

describe('asks', () => {
	function opened(): Harness & { callId: string } {
		const h = harness();
		h.host.push(...OPENING, PROBE_ASK);
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		return { ...h, callId };
	}

	it('forwards the real ask to its seat and to no one else', () => {
		const h = opened();
		const asks = h.sent.filter((s) => s.envelope.frame.kind === 'ask');
		expect(asks.map((a) => a.seat)).toEqual([PROBE_ASK.seat]);
	});

	it("routes the seat's answer to Forge by callId, once", () => {
		const h = opened();
		expect(h.match.fromClient(0, reply('s0-999', true))).toEqual({ ok: false, error: 'stale-reply' });
		expect(h.match.fromClient(0, reply(h.callId, true))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: h.callId, result: true }]);
		expect(h.match.fromClient(0, reply(h.callId, false))).toEqual({ ok: false, error: 'stale-reply' });
		expect(h.host.commands).toHaveLength(1);
	});

	it("does not let the OTHER seat answer it", () => {
		const h = opened();
		expect(h.match.fromClient(1, reply(h.callId, true))).toEqual({ ok: false, error: 'stale-reply' });
		expect(h.host.commands).toEqual([]);
	});

	it("keeps it open however long the seat's last connection stays gone, and nobody answering never closes it (prod m-dd37bda1c441)", () => {
		vi.useFakeTimers();
		const h = opened();
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(24 * 60 * 60_000);
		expect(h.host.commands).toEqual([]);
		h.match.seatConnected(0);
		const before = h.sent.length;
		h.match.resendAfterSnapshot(0);
		expect(h.sent.slice(before).map((x) => x.envelope.frame)).toContainEqual(PROBE_ASK.frame);
		expect(h.match.fromClient(0, reply(h.callId, true))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: h.callId, result: true }]);
	});

	it("passes the browser's own abort through for an ask whose aborted answer is Forge's own default", () => {
		const h = opened();
		const abort = ClientFrameSchema.parse({ kind: 'abort', callId: h.callId, reason: 'unsupported' });
		expect(h.match.fromClient(0, abort)).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'abort', seat: 0, callId: h.callId, reason: 'unsupported' }]);
	});

	it("refuses the browser's abort of an ask an abort would answer with a null, and keeps it open", () => {
		const h = harness();
		h.host.push(...OPENING);
		const choose = {
			kind: 'ask',
			callId: 's0-90',
			method: 'getChoices',
			message: 'Choose a card name',
			min: 1,
			max: 1,
			choices: [
				{ key: 'a', label: 'Black Lotus', ref: null },
				{ key: 'b', label: 'Mox Pearl', ref: null },
			],
			selected: [],
		};
		h.host.push({ t: 'frame', seat: 0, frame: choose });
		const abort = ClientFrameSchema.parse({ kind: 'abort', callId: 's0-90', reason: 'cancelled' });
		expect(h.match.fromClient(0, abort)).toMatchObject({ ok: false });
		expect(h.host.commands).toEqual([]);
		expect(h.logs.find((l) => l.evt === 'ask-abort-refused')).toMatchObject({ callId: 's0-90', method: 'getChoices' });
		const answer = ClientFrameSchema.parse({ kind: 'reply', callId: 's0-90', method: 'getChoices', result: ['b'] });
		expect(h.match.fromClient(0, answer)).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 's0-90', result: ['b'] }]);
	});

	it('re-sends the open ask after a snapshot, on the next cursor', () => {
		const h = opened();
		const snap = h.match.snapshot(0);
		if (!('frames' in snap)) throw new Error('expected a snapshot');
		const before = h.sent.length;
		h.match.resendAfterSnapshot(0);
		const resent = h.sent.slice(before).map((s) => s.envelope);
		expect(resent.map((e) => e.cursor.seq)).toEqual(resent.map((_, i) => (snap.cursor?.seq ?? 0) + i + 1));
		expect(resent.at(-1)?.frame).toEqual(PROBE_ASK.frame);
	});

	it('forwards an act to Forge for the seat that sent it', () => {
		const h = opened();
		const ok = ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' });
		expect(h.match.fromClient(1, ok)).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'act', seat: 1, frame: ok }]);
	});

	it('the rest of the recorded game still flows after the answer', () => {
		const h = opened();
		h.match.fromClient(0, reply(h.callId, true));
		const before = h.sent.length;
		h.host.push(...AFTER_PROBE);
		expect(h.sent.length).toBeGreaterThan(before);
	});
});

describe('what Forge sends that forge-wire refuses', () => {
	it('is dropped and counted, never forwarded', () => {
		const h = harness();
		h.host.push(...OPENING);
		const before = h.sent.length;
		const prompt = OPENING.find((l) => l.t === 'frame' && (l.frame as { method: string }).method === 'showPromptMessage') as Extract<BridgeLine, { t: 'frame' }>;
		const broken = { ...(prompt.frame as Record<string, unknown>) };
		delete broken.card;
		h.host.push({ t: 'frame', seat: prompt.seat, frame: broken });
		expect(h.sent.length).toBe(before);
		expect(h.match.invalidFrames).toBe(1);
		expect(h.logs.some((l) => l.evt === 'frame-invalid')).toBe(true);
	});

	it('an ask it refuses is shown as a pick of its whole answers, and the pick reaches Forge as the real method\'s answer (prod m-24f69e2e0b7e)', () => {
		const h = harness();
		h.host.push(...OPENING);
		const key = { target: 'entity', ref: null };
		const ask = {
			kind: 'ask',
			callId: 's0-77',
			method: 'assignGenericAmount',
			effectSource: { kind: 'card', id: 8 },
			target: [
				{ key, amount: 2 },
				{ key, amount: 2 },
			],
			amount: 2,
			atLeastOne: false,
			amountLabel: 'mana',
		};
		h.host.push({ t: 'frame', seat: 0, frame: ask });
		expect(h.host.commands).toEqual([]);
		const logged = h.logs.find((l) => l.evt === 'ask-unparsed');
		expect(logged).toMatchObject({ seat: 0, callId: 's0-77', method: 'assignGenericAmount', fallback: true });
		expect(JSON.stringify(logged?.errors)).toContain('ref');
		const shown = h.sent.at(-1)?.envelope.frame as { method: string; callId: string; min: number; max: number; choices: { key: string; label: string }[] };
		expect(shown).toMatchObject({ method: 'getChoices', callId: 's0-77', min: 1, max: 1 });
		expect(shown.choices.map((c) => c.label)).toEqual(['2 target 1', '1 target 1, 1 target 2', '2 target 2']);
		const pick = ClientFrameSchema.parse({ kind: 'reply', callId: 's0-77', method: 'getChoices', result: ['1'] });
		expect(h.match.fromClient(0, pick)).toEqual({ ok: true });
		expect(h.host.commands).toEqual([
			{ t: 'reply', seat: 0, callId: 's0-77', result: [{ key, amount: 1 }, { key, amount: 1 }] },
		]);
	});

	it('an ask with no fallback is kept open, never aborted', () => {
		const h = harness();
		h.host.push(...OPENING);
		const before = h.sent.length;
		h.host.push({ t: 'frame', seat: 0, frame: { kind: 'ask', callId: 's0-78', method: 'order', title: null } });
		expect(h.sent.length).toBe(before);
		expect(h.host.commands).toEqual([]);
		expect(h.logs.find((l) => l.evt === 'ask-unparsed')).toMatchObject({ callId: 's0-78', fallback: false });
	});

});

describe('a lost ask: an input act that gets nothing back', () => {
	const ok = ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' });
	const resends = (h: Harness) => h.host.commands.filter((c) => c.t === 'resend-pending');

	it('asks the bridge to re-send the seat\'s pending asks after ACT_SILENCE_MS of silence', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.match.fromClient(0, ok);
		vi.advanceTimersByTime(ACT_SILENCE_MS - 1);
		expect(resends(h)).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(resends(h)).toEqual([{ t: 'resend-pending', seat: 0 }]);
		expect(h.logs.find((l) => l.evt === 'act-unanswered')).toMatchObject({ seat: 0 });
	});

	it('stays quiet once the seat is shown its next window, and is not disarmed by the other seat\'s frames', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.match.fromClient(0, ok);
		h.match.fromClient(1, ok);
		const prompt = OPENING.find((l) => l.t === 'frame' && l.seat === 0 && (l.frame as { method: string }).method === 'showPromptMessage')!;
		h.host.push(prompt);
		vi.advanceTimersByTime(ACT_SILENCE_MS);
		expect(resends(h)).toEqual([{ t: 'resend-pending', seat: 1 }]);
	});

	it('is not disarmed by a state delta alone: a card click applies one before Forge asks which ability (pin 09aeb164)', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.match.fromClient(0, ok);
		const delta = OPENING.find((l) => l.t === 'frame' && l.seat === 0 && (l.frame as { method: string }).method === 'applyDelta')!;
		h.host.push(delta);
		vi.advanceTimersByTime(ACT_SILENCE_MS);
		expect(resends(h)).toEqual([{ t: 'resend-pending', seat: 0 }]);
	});

	it('is not armed by an act that is not a game input', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'requestResync' }));
		vi.advanceTimersByTime(ACT_SILENCE_MS * 2);
		expect(resends(h)).toEqual([]);
	});

	it('shows a re-sent ask that never arrived, once, and drops the copy of one it already has', () => {
		const h = harness();
		h.host.push(...OPENING, PROBE_ASK);
		const asks = () => h.sent.filter((s) => s.envelope.frame.kind === 'ask');
		expect(asks()).toHaveLength(1);
		h.host.push(PROBE_ASK, { t: 'resent', seat: PROBE_ASK.seat, callIds: [(PROBE_ASK.frame as { callId: string }).callId] });
		expect(asks()).toHaveLength(1);
		expect(h.logs.some((l) => l.evt === 'ask-duplicate')).toBe(true);
		expect(h.logs.find((l) => l.evt === 'asks-resent')).toMatchObject({ seat: PROBE_ASK.seat });
		const lost = { ...(PROBE_ASK.frame as Record<string, unknown>), callId: 's0-lost' };
		h.host.push({ t: 'frame', seat: PROBE_ASK.seat, frame: lost });
		expect(asks()).toHaveLength(2);
		expect(h.match.fromClient(PROBE_ASK.seat, reply('s0-lost', true))).toEqual({ ok: true });
	});
});

describe('failure', () => {
	it('a fatal line fails the match and releases anyone waiting for it', async () => {
		const h = harness();
		const running = h.match.whenRunning(1000);
		h.host.push({ t: 'fatal', message: 'Forge refused to start the match' });
		expect(await running).toEqual({ ok: false, error: 'Forge refused to start the match' });
		expect(h.match.status).toBe('failed');
	});

	it('a deliberate stop is not a failure, and the exit that follows does not make it one', async () => {
		const h = harness();
		h.host.push(...OPENING);
		h.match.stop();
		expect(h.host.stopped).toBe(true);
		h.host.exit('stopped');
		expect(h.match.status).toBe('stopped');
		expect(h.match.failure).toBeNull();
	});

	it('the JVM exiting mid-match fails it', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.exit('the JVM exited (code 1, signal null)');
		expect(h.match.status).toBe('failed');
	});
});

/* ── Wave 10: crash and reconnect ────────────────────────────────────── */

const KILLED = 'the JVM exited (code null, signal SIGKILL); see /tmp/cardtable-play/m-x/bridge.stderr.txt';

function isEndedNotice(e: ServerEnvelope | undefined): boolean {
	const f = e?.frame as { method?: string; title?: string } | undefined;
	return f?.method === 'showErrorDialog' && f.title === MATCH_ENDED_TITLE;
}

describe('crash: the JVM dies mid-match', () => {
	it('tells BOTH seats, each on its own stream at its next cursor, with a frame a browser accepts', () => {
		const h = harness();
		h.host.push(...OPENING, PROBE_ASK);
		const lastSeq = [0, 1].map((seat) => envelopesFor(h, seat).at(-1)?.cursor.seq ?? 0);
		h.host.exit(KILLED);
		expect(h.match.status).toBe('failed');
		for (const seat of [0, 1]) {
			const last = envelopesFor(h, seat).at(-1);
			expect(isEndedNotice(last)).toBe(true);
			expect(last?.cursor).toEqual({ epoch: h.match.epoch, seq: (lastSeq[seat] as number) + 1 });
			expect(ServerEnvelopeSchema.safeParse(last).success).toBe(true);
			// The cause reaches the seat; the server's filesystem does not.
			expect(JSON.stringify(last)).toContain('signal SIGKILL');
			expect(JSON.stringify(last)).not.toContain('/tmp/');
		}
	});

	it('closes the open ask, so a late answer is refused rather than sent to a dead JVM', () => {
		const h = harness();
		h.host.push(...OPENING, PROBE_ASK);
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		h.host.exit(KILLED);
		expect(h.match.fromClient(0, reply(callId, true))).toEqual({ ok: false, error: 'match is failed' });
		expect(h.host.commands).toEqual([]);
	});

	it('a seat that resyncs or refreshes afterwards gets the board it had, then the same notice', () => {
		const h = harness();
		h.host.push(...OPENING);
		const before = h.match.snapshot(0);
		h.host.exit(KILLED);
		const after = h.match.snapshot(0);
		if (!('frames' in before) || !('frames' in after)) throw new Error('expected snapshots');
		expect(after.frames).toEqual(before.frames);
		const mark = h.sent.length;
		h.match.resendAfterSnapshot(0);
		expect(isEndedNotice(h.sent.slice(mark).at(-1)?.envelope)).toBe(true);
	});

	it('tells each seat once, however the failure arrives (fatal, then the exit it causes)', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'fatal', message: 'Forge failed while starting the match' });
		h.host.exit(KILLED);
		for (const seat of [0, 1]) expect(envelopesFor(h, seat).filter(isEndedNotice)).toHaveLength(1);
		expect(h.match.failure).toBe('Forge failed while starting the match');
	});

	it('a deliberate stop is not a crash: nobody is sent the notice', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.match.stop();
		h.host.exit('stopped');
		expect(h.sent.some((s) => isEndedNotice(s.envelope))).toBe(false);
	});

	it('a seat that never opened is answered with the failure, not "match-starting"', () => {
		const h = harness();
		h.host.exit(KILLED);
		expect(h.match.snapshot(0)).toEqual({ error: KILLED });
	});
});

describe('reconnect: a refresh closes the old socket before the new page joins', () => {
	const GRACE = 30_000;

	function refreshing(): Harness & { callId: string } {
		vi.useFakeTimers();
		const h = harness(GRACE);
		h.host.push(...OPENING, PROBE_ASK);
		return { ...h, callId: (PROBE_ASK.frame as { callId: string }).callId };
	}

	// /health/busy counts a running match only while somebody is at it: the zombie of
	// m-09487f336215 (both seats gone at 01:15/01:19 UTC) held every deploy for hours.
	it('anyoneHere follows the seats: here on connect, still here inside the grace, gone after it', () => {
		const h = refreshing();
		expect(h.match.anyoneHere(), 'nobody has connected yet').toBe(false);
		h.match.seatConnected(0);
		expect(h.match.anyoneHere()).toBe(true);
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(GRACE - 1);
		expect(h.match.anyoneHere(), 'inside the grace a reload is still somebody').toBe(true);
		vi.advanceTimersByTime(2);
		expect(h.match.anyoneHere(), 'past the grace nobody is here').toBe(false);
		h.match.seatConnected(0);
		expect(h.match.anyoneHere(), 'and back').toBe(true);
	});

	it('returns the same seat to the same board, and re-sends the SAME ask, which it can then answer', () => {
		const h = refreshing();
		const heldBefore = foldFrames(
			envelopesFor(h, 0).filter((e) => e.frame.kind === 'notify' && ['setGameView', 'openView', 'applyDelta'].includes(e.frame.method)).map((e) => e.frame as unknown as StateFrame),
		);
		expect(heldBefore.size).toBeGreaterThan(50);
		h.match.claim(ALICE);
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(2000);
		// The new page: same participant, so the same seat.
		expect(h.match.claim(ALICE)).toEqual({ ok: true, seat: 0, fresh: false });
		h.match.seatConnected(0);
		const snap = h.match.snapshot(0);
		if (!('frames' in snap)) throw new Error('expected a snapshot');
		expect(foldFrames(snap.frames as unknown as StateFrame[])).toEqual(heldBefore);
		expect(snap.cursor?.epoch).toBe(h.match.epoch);
		const mark = h.sent.length;
		h.match.resendAfterSnapshot(0);
		const resentAsk = h.sent.slice(mark).find((s) => s.envelope.frame.kind === 'ask');
		expect(resentAsk?.envelope.frame).toEqual(PROBE_ASK.frame);
		expect(h.match.fromClient(0, reply(h.callId, true))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: h.callId, result: true }]);
	});

	it('keeps the open ask past the whole grace too: a seat back after 1.5 min re-sees it and its answer reaches Forge (prod m-dd37bda1c441)', () => {
		const h = refreshing();
		h.match.claim(ALICE);
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(90_000);
		expect(h.match.anyoneHere()).toBe(false);
		expect(h.host.commands).toEqual([]);
		h.match.seatConnected(0);
		h.match.snapshot(0);
		const mark = h.sent.length;
		h.match.resendAfterSnapshot(0);
		expect(h.sent.slice(mark).find((s) => s.envelope.frame.kind === 'ask')?.envelope.frame).toEqual(PROBE_ASK.frame);
		expect(h.match.fromClient(0, reply(h.callId, true))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: h.callId, result: true }]);
	});

	it('a second disconnect does not restart the clock', () => {
		const h = refreshing();
		h.match.seatConnected(0);
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(GRACE - 10);
		h.match.seatDisconnected(0);
		expect(h.match.anyoneHere()).toBe(true);
		vi.advanceTimersByTime(10);
		expect(h.match.anyoneHere()).toBe(false);
		expect(h.host.commands).toEqual([]);
	});
});

/* ── A match that outlives its server (Wave 22 §E) ───────────────────── */

/**
 * A host whose "JVM" survives being let go, as `play/host.ts`'s does. It keeps
 * the lines it delivered and the commands it was sent in ONE ordered stream —
 * which is exactly what `<run>/stream.jsonl` is — and `attach` feeds that stream
 * back before returning, which is the contract `Match.resume` is written
 * against. Nothing here knows what a JVM or a fifo is; that half is
 * `host.test.ts`'s.
 */
interface Survivable {
	stream: ({ t: 'line'; line: BridgeLine } | { t: 'sent'; command: BridgeCommand })[];
	remembered: { epoch: string; owners: (string | null)[] } | null;
	handedOver: boolean;
	stopped: boolean;
	/** Deliver lines AND record them, the way a real host persists what it reads. */
	push(...lines: BridgeLine[]): void;
	commandsSent(): BridgeCommand[];
}

function survivable(): { factory: MatchHostFactory; attach: (record: JvmRecord, events: HostEvents) => MatchHost; state: Survivable } {
	let events: HostEvents | null = null;
	const state: Survivable = {
		stream: [],
		remembered: null,
		handedOver: false,
		stopped: false,
		push(...lines) {
			for (const line of lines) {
				state.stream.push({ t: 'line', line });
				events?.line(line);
			}
		},
		commandsSent: () => state.stream.flatMap((e) => (e.t === 'sent' ? [e.command] : [])),
	};
	const face = (): MatchHost => ({
		send: (command) => void state.stream.push({ t: 'sent', command }),
		stop: () => void (state.stopped = true),
		remember: (s) => void (state.remembered = { epoch: s.epoch, owners: [...s.owners] }),
		handOver: () => {
			state.handedOver = true;
			return true;
		},
	});
	return {
		state,
		factory: (_id, _spec, e) => {
			events = e;
			return face();
		},
		attach: (_record, e) => {
			events = e;
			// A copy: a replay must not see anything the replay itself causes.
			for (const entry of [...state.stream]) {
				if (entry.t === 'line') e.line(entry.line);
				else e.replayed?.(entry.command);
			}
			return face();
		},
	};
}

function recordFor(match: Match, state: Survivable): JvmRecord {
	return {
		matchId: match.id,
		pid: process.pid,
		run: `/nonexistent/${match.id}`,
		startedAt: new Date().toISOString(),
		epoch: state.remembered?.epoch ?? null,
		owners: state.remembered?.owners ?? [],
		spec: { seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] },
		orphanedAt: new Date().toISOString(),
	};
}

describe('a match nobody is at', () => {
	/** Both seats claimed and opened; the departure grace 1 s, the rejoin grace 5 s. */
	function table(opened = true): Harness {
		const { factory, hosts } = replayFactory();
		const logs: Record<string, unknown>[] = [];
		const registry = createMatchRegistry({
			host: factory,
			log: (e) => logs.push(e),
			overGraceMs: 60_000,
			disconnectGraceMs: 1000,
			rejoinGraceMs: 5000,
			emit: () => undefined,
		});
		const match = registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] });
		match.claim(ALICE);
		match.claim(BOB);
		const host = hosts[0] as ReplayHost;
		if (opened) host.push(...OPENING);
		return { match, host, sent: [], logs };
	}

	it('stops a running match both seats have left, once their departure grace and then the rejoin grace have run out', () => {
		vi.useFakeTimers();
		const h = table();
		h.match.seatConnected(0);
		h.match.seatConnected(1);
		expect(h.match.status).toBe('running');
		h.match.seatDisconnected(0);
		h.match.seatDisconnected(1);
		vi.advanceTimersByTime(1000 + 4999);
		expect(h.match.status, 'still inside the rejoin grace').toBe('running');
		vi.advanceTimersByTime(1);
		expect(h.match.status).toBe('stopped');
		expect(h.host.stopped).toBe(true);
		expect(h.logs.find((l) => l.evt === 'match-not-rejoined')).toMatchObject({ matchId: h.match.id, status: 'running', afterMs: 5000 });
	});

	it('keeps it while one seat is still here', () => {
		vi.useFakeTimers();
		const h = table();
		h.match.seatConnected(0);
		h.match.seatConnected(1);
		h.match.seatDisconnected(1);
		vi.advanceTimersByTime(60_000);
		expect(h.match.status).toBe('running');
	});

	it('keeps it when a seat comes back inside the rejoin grace', () => {
		vi.useFakeTimers();
		const h = table();
		h.match.seatConnected(0);
		h.match.seatConnected(1);
		h.match.seatDisconnected(0);
		h.match.seatDisconnected(1);
		vi.advanceTimersByTime(1000 + 4000);
		h.match.seatConnected(1);
		vi.advanceTimersByTime(60_000);
		expect(h.match.status).toBe('running');
	});

	it('stops a match nobody ever joined', () => {
		vi.useFakeTimers();
		const h = table();
		vi.advanceTimersByTime(5000);
		expect(h.match.status).toBe('stopped');
	});

	it("does not count Forge's boot: a match still starting cannot be joined yet, so nothing is armed", () => {
		vi.useFakeTimers();
		const h = table(false);
		vi.advanceTimersByTime(60_000);
		expect(h.match.status).toBe('starting');
		h.host.push(...OPENING);
		expect(h.match.status).toBe('running');
		vi.advanceTimersByTime(5000);
		expect(h.match.status, 'armed once running').toBe('stopped');
	});
});

describe('a match that outlives its server', () => {
	interface Restartable {
		state: Survivable;
		first: Match;
		sent: { seat: number; envelope: ServerEnvelope }[];
		/** The next process: a second registry over the same surviving host. */
		next(rejoinGraceMs?: number): { match: Match | null; sent: { seat: number; envelope: ServerEnvelope }[]; logs: Record<string, unknown>[] };
	}

	/** One match, both seats claimed, opened and mid-ask — then whatever the test does to it. */
	function running(): Restartable {
		const { factory, attach, state } = survivable();
		const sent: Restartable['sent'] = [];
		const registry = createMatchRegistry({
			host: factory,
			attach,
			log: () => undefined,
			overGraceMs: 60_000,
			emit: (_m, seat, envelope) => void sent.push({ seat, envelope }),
		});
		const first = registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] });
		first.claim(ALICE);
		first.claim(BOB);
		state.push(...OPENING, PROBE_ASK);
		return {
			state,
			first,
			sent,
			next(rejoinGraceMs?: number) {
				const nextSent: Restartable['sent'] = [];
				const logs: Record<string, unknown>[] = [];
				const nextRegistry = createMatchRegistry({
					host: factory,
					attach,
					log: (e) => void logs.push(e),
					overGraceMs: 60_000,
					...(rejoinGraceMs === undefined ? {} : { rejoinGraceMs }),
					emit: (_m, seat, envelope) => void nextSent.push({ seat, envelope }),
				});
				return { match: nextRegistry.adopt(recordFor(first, state)), sent: nextSent, logs };
			},
		};
	}

	it('writes down the two things a replay cannot reproduce: the epoch, and who owns which seat', () => {
		const r = running();
		expect(r.state.remembered).toEqual({ epoch: r.first.epoch, owners: [ALICE, BOB] });
	});

	it('is handed over without one frame on the wire — a frame now would take a seq the replay cannot', () => {
		const r = running();
		const before = r.sent.length;
		expect(before).toBeGreaterThan(0);
		expect(r.first.handOver()).toBe(true);
		expect(r.state.handedOver).toBe(true);
		expect(r.state.stopped).toBe(false);
		expect(r.sent.length).toBe(before);
	});

	it('comes back on the same epoch, at the same seats, with a snapshot identical to the one it had', () => {
		const r = running();
		const before = [r.first.snapshot(0), r.first.snapshot(1)];
		r.first.handOver();

		const { match } = r.next();
		expect(match).not.toBeNull();
		const resumed = match as Match;
		expect(resumed.id).toBe(r.first.id);
		expect(resumed.epoch).toBe(r.first.epoch);
		expect(resumed.status).toBe('running');
		// Seat 2 coming back as seat 1 would be handed the other player's hand.
		expect(resumed.seatOf(ALICE)).toBe(0);
		expect(resumed.seatOf(BOB)).toBe(1);
		expect([resumed.snapshot(0), resumed.snapshot(1)]).toEqual(before);
		// And a client that held the old cursor is offered the very same one.
		expect((resumed.snapshot(0) as MatchSnapshot).cursor).toEqual({ epoch: r.first.epoch, seq: (before[0] as MatchSnapshot).cursor?.seq });
	});

	it('sends Forge nothing while it replays: every command in the stream was already sent once', () => {
		const r = running();
		// There has to be something in the stream to re-send, or this proves nothing.
		r.first.fromClient(PROBE_ASK.seat, reply((PROBE_ASK.frame as { callId: string }).callId, true));
		const already = r.state.commandsSent();
		expect(already.length).toBeGreaterThan(0);
		r.first.handOver();
		r.next();
		expect(r.state.commandsSent()).toEqual(already);
	});

	/**
	 * The sharper half of the same rule. Above, the commands in the stream are
	 * ones the BROWSER caused; here the stream holds a LINE that makes the match
	 * answer by itself (`auto.ts`: a dialog with one button is not a question).
	 * Replaying that line must not press the button a second time — Forge's
	 * `sendAndWait` has already returned from it.
	 */
	it('does not answer for the seat a second time when the line that provoked it is replayed', () => {
		const r = running();
		const auto: BridgeLine = {
			t: 'frame',
			seat: 0,
			frame: {
				kind: 'ask',
				callId: 'w22-one-button',
				method: 'showOptionDialog',
				message: 'Which game should this match continue with?',
				title: 'Next game',
				icon: 'ICO_QUESTION',
				options: ['Play first'],
				defaultOption: 0,
			},
		};
		r.state.push(auto);
		const already = r.state.commandsSent();
		expect(already).toMatchObject([{ t: 'reply', seat: 0, callId: 'w22-one-button', result: 0 }]);

		r.first.handOver();
		const { match } = r.next();
		// One press, not two — and the ask stayed closed, as it was.
		expect(r.state.commandsSent()).toEqual(already);
		expect((match as Match).seats[0]?.asks.has('w22-one-button')).toBe(false);
	});

	it('does not re-open an ask the old server had already answered', () => {
		const r = running();
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		expect(r.first.seats[PROBE_ASK.seat]?.asks.has(callId)).toBe(true);
		expect(r.first.fromClient(PROBE_ASK.seat, reply(callId, true))).toEqual({ ok: true });
		r.first.handOver();

		const { match } = r.next();
		expect((match as Match).seats[PROBE_ASK.seat]?.asks.has(callId)).toBe(false);
	});

	it('re-opens an ask that was still parked in Forge, so the seat is asked it again', () => {
		const r = running();
		const callId = (PROBE_ASK.frame as { callId: string }).callId;
		r.first.handOver();
		const { match } = r.next();
		expect((match as Match).seats[PROBE_ASK.seat]?.asks.has(callId)).toBe(true);
	});

	it('stops a match it took back that nobody rejoins — an orphan nobody wants is still a JVM', () => {
		vi.useFakeTimers();
		const r = running();
		r.first.handOver();
		const { match, logs } = r.next(1000);
		expect((match as Match).status).toBe('running');
		vi.advanceTimersByTime(1000);
		expect((match as Match).status).toBe('stopped');
		expect(logs.find((l) => l.evt === 'match-not-rejoined')).toMatchObject({ matchId: r.first.id });
	});

	it('keeps a match it took back that somebody does rejoin', () => {
		vi.useFakeTimers();
		const r = running();
		r.first.handOver();
		const { match } = r.next(1000);
		(match as Match).seatConnected(0);
		vi.advanceTimersByTime(5000);
		expect((match as Match).status).toBe('running');
	});

	it('tells both seats in words when the match CANNOT be handed over', () => {
		// The replay host has no `handOver`: its Forge dies with the process, which
		// is every host that is not the JVM pool.
		const h = harness();
		h.match.claim(ALICE);
		h.match.claim(BOB);
		h.host.push(...OPENING);
		expect(h.match.handOver()).toBe(false);

		const mark = h.sent.length;
		h.match.serverStopping('The server is restarting for a deploy.');
		const notices = h.sent.slice(mark).map((s) => s.envelope.frame);
		expect(notices).toHaveLength(2);
		for (const frame of notices) {
			expect(frame).toMatchObject({
				kind: 'notify',
				method: 'showErrorDialog',
				title: MATCH_ENDED_TITLE,
				message: 'The server is restarting for a deploy.',
			});
		}
		// And it is kept, so a page that reloads after the restart is told too.
		h.match.resendAfterSnapshot(0);
		expect(h.sent.at(-1)?.envelope.frame).toMatchObject({ method: 'showErrorDialog' });
	});

	it("Forge's finishGame is forwarded, kept, and re-sent after a later snapshot (w35 R16)", () => {
		const h = harness();
		h.match.claim(ALICE);
		h.match.claim(BOB);
		h.host.push(...OPENING);
		const mark = h.sent.length;
		h.host.push({ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'finishGame' } });
		const forwarded = h.sent.slice(mark).map((s) => ({ seat: s.seat, method: s.envelope.frame.method }));
		expect(forwarded).toEqual([{ seat: 0, method: 'finishGame' }]);
		h.match.resendAfterSnapshot(0);
		expect(h.sent.at(-1)?.envelope.frame).toMatchObject({ kind: 'notify', method: 'finishGame' });
		// The other seat never got one, so it is not re-sent to that seat either.
		const before = h.sent.length;
		h.match.resendAfterSnapshot(1);
		expect(h.sent.slice(before).map((s) => s.envelope.frame.method)).not.toContain('finishGame');
	});

	it("a registry whose host cannot re-attach adopts nothing rather than pretending to", () => {
		const { factory } = replayFactory();
		const registry = createMatchRegistry({
			host: factory,
			log: () => undefined,
			overGraceMs: 60_000,
			emit: () => undefined,
		});
		const match = registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] });
		expect(registry.handOver()).toEqual({ handed: [], ending: [match] });
		expect(
			registry.adopt({
				matchId: 'm-000000000000',
				pid: process.pid,
				run: '/nonexistent',
				startedAt: new Date().toISOString(),
				epoch: 'm-000000000000:1',
				owners: [],
				spec: { seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] },
			}),
		).toBeNull();
	});
});

/* ── Wave 31 §S: a reload with a selection open, a concede after the end, names ── */

describe('wave 31 §S: the open selection survives a reload (P10)', () => {
	const CARD_A = { kind: 'card', id: 101 };
	const CARD_B = { kind: 'card', id: 102 };
	const frameLine = (seat: number, frame: Record<string, unknown>): BridgeLine => ({ t: 'frame', seat, frame }) as BridgeLine;

	function opened(): Harness {
		const h = harness();
		h.match.claim(ALICE);
		h.match.claim(BOB);
		h.host.push(...OPENING);
		return h;
	}

	/** The frames seat 0 was sent on the `mark`-th envelope and after, by method. */
	function methodsSince(h: Harness, seat: number, mark: number): string[] {
		return envelopesFor(h, seat)
			.slice(mark)
			.map((e) => (e.frame as { method: string }).method);
	}

	it('re-sends the selection, the marks and the actionable set after a snapshot, to that seat only', () => {
		const h = opened();
		h.host.push(
			frameLine(0, { kind: 'notify', method: 'setSelectables', cards: [CARD_A, CARD_B], min: 1, max: 2 }),
			frameLine(0, { kind: 'notify', method: 'setHighlighted', entities: [CARD_A, { kind: 'player', id: 1 }], on: true }),
			frameLine(0, { kind: 'notify', method: 'setWeaklySelectable', cards: [CARD_A] }),
		);
		const mark = envelopesFor(h, 0).length;
		const otherMark = envelopesFor(h, 1).length;
		h.match.snapshot(0);
		h.match.resendAfterSnapshot(0);
		const sent = envelopesFor(h, 0).slice(mark).map((e) => e.frame as Record<string, unknown>);
		expect(sent.find((f) => f.method === 'setSelectables')).toEqual({
			kind: 'notify',
			method: 'setSelectables',
			cards: [CARD_A, CARD_B],
			min: 1,
			max: 2,
		});
		expect(sent.find((f) => f.method === 'setHighlighted')).toEqual({
			kind: 'notify',
			method: 'setHighlighted',
			entities: [CARD_A, { kind: 'player', id: 1 }],
			on: true,
		});
		expect(sent.find((f) => f.method === 'setWeaklySelectable')).toMatchObject({ cards: [CARD_A] });
		expect(methodsSince(h, 1, otherMark)).toEqual([]);
	});

	it('folds incremental marks, and forgets all of it when Forge clears the selection', () => {
		const h = opened();
		h.host.push(
			frameLine(0, { kind: 'notify', method: 'setSelectables', cards: [CARD_A, CARD_B], min: 1, max: 2 }),
			frameLine(0, { kind: 'notify', method: 'setHighlighted', entities: [CARD_A, CARD_B], on: true }),
			frameLine(0, { kind: 'notify', method: 'setHighlighted', entities: [CARD_A], on: false }),
		);
		let mark = envelopesFor(h, 0).length;
		h.match.resendAfterSnapshot(0);
		const marks = envelopesFor(h, 0)
			.slice(mark)
			.map((e) => e.frame as { method: string; entities?: unknown[] })
			.find((f) => f.method === 'setHighlighted');
		expect(marks?.entities).toEqual([CARD_B]);

		h.host.push(frameLine(0, { kind: 'notify', method: 'clearSelectables' }));
		mark = envelopesFor(h, 0).length;
		h.match.resendAfterSnapshot(0);
		expect(methodsSince(h, 0, mark)).not.toContain('setSelectables');
		expect(methodsSince(h, 0, mark)).not.toContain('setHighlighted');
	});

	it('forgets the actionable set on clearWeaklySelectable', () => {
		const h = opened();
		h.host.push(
			frameLine(0, { kind: 'notify', method: 'setWeaklySelectable', cards: [CARD_A] }),
			frameLine(0, { kind: 'notify', method: 'clearWeaklySelectable' }),
		);
		const mark = envelopesFor(h, 0).length;
		h.match.resendAfterSnapshot(0);
		expect(methodsSince(h, 0, mark)).not.toContain('setWeaklySelectable');
	});
});

describe('wave 31 §S: a concede after the game ended (P18)', () => {
	const concede = { kind: 'act', method: 'concede' } as ClientFrame;

	it('is refused in words of its own, logged, and never reaches Forge', () => {
		const h = harness();
		h.match.claim(ALICE);
		h.match.claim(BOB);
		h.host.push(...OPENING);
		expect(h.match.fromClient(0, concede)).toEqual({ ok: true });
		expect(h.host.commands).toHaveLength(1);

		h.host.push({ t: 'gameover', winner: null } as BridgeLine);
		expect(h.match.status).toBe('over');
		const outcome = h.match.fromClient(0, concede);
		expect(outcome).toEqual({ ok: false, error: expect.stringContaining('concede-after-game-over') });
		expect(h.host.commands).toHaveLength(1);
		expect(h.logs).toContainEqual(expect.objectContaining({ evt: 'concede-refused', seat: 0, status: 'over' }));
	});
});

describe('wave 31 §S: seat names', () => {
	it('names a seat on forge:seats only when the caller named it', () => {
		const { factory } = replayFactory();
		const registry = createMatchRegistry({
			host: factory,
			log: () => undefined,
			overGraceMs: 60_000,
			emit: () => undefined,
		});
		const spec: MatchSpecWithIdentity = {
			seats: [
				{ name: 'Hadoku', displayName: 'Hadoku', ai: false, deck: null },
				{ name: 'Seat 2', ai: false, deck: null },
			],
		};
		const match = registry.create(spec);
		const [a, b] = match.seatIdentities();
		expect(a).toMatchObject({ seat: 0, name: 'Hadoku' });
		expect(b).toBeDefined();
		expect('name' in (b as object)).toBe(false);
	});
});

describe('wave 35 §S, R4: a reveal the fold does not claim is never swallowed', () => {
	/**
	 * A `getChoices` reveal (`min === max === -1`) — the shape ANY reveal
	 * takes, Thoughtseize's "look at hand" step among them. `auto.ts:551-569`
	 * is explicit that this shape "stays on screen" because answering it
	 * "would take the reveal away from the player" — the regression this
	 * block guards is R4's fold doing exactly that for every OTHER reveal in
	 * the game (an opponent's hand shown by a tutor, a library search coming
	 * up empty, Secluded Glen's reveal to the other seat, …), not just
	 * Thoughtseize's own.
	 */
	function revealFrame(callId: string, ids: number[]) {
		return {
			kind: 'ask' as const,
			callId,
			method: 'getChoices' as const,
			message: "Looking at cards in B's hand",
			min: -1,
			max: -1,
			choices: ids.map((id, i) => ({ key: `c${i}`, label: `Card ${id}`, ref: { kind: 'card' as const, id } })),
			selected: [],
		};
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('nothing claims it: Forge is answered at once, but the seat still sees it, unchanged, once the fold window passes', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		const frame = revealFrame('x-reveal-1', [900, 901, 902]);
		h.host.push({ t: 'frame', seat: 0, frame });

		// Forge's game thread is parked inside the reveal and will not build
		// whatever comes next until it is answered — so this is immediate,
		// not deferred to the fold window below.
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-reveal-1', result: [] }]);
		// But the seat has not been shown anything yet — the window is still open.
		expect(h.sent.some((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'x-reveal-1')).toBe(false);

		vi.advanceTimersByTime(1000);

		const shown = h.sent.find((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'x-reveal-1');
		expect(shown?.envelope.frame).toEqual(frame);
		// Shown, never asked: the envelope says nothing waits on it.
		expect(shown?.envelope.displayOnly).toBe(true);

		// Nothing is open for the seat, so nothing could answer it: a reply is
		// stale, and Forge — already told — is sent nothing further.
		const reply = ClientFrameSchema.parse({ kind: 'reply', callId: 'x-reveal-1', method: 'getChoices', result: [] });
		expect(h.match.fromClient(0, reply)).toEqual({ ok: false, error: 'stale-reply' });
		expect(h.host.commands).toHaveLength(1);
	});

	it('a shown reveal is not a wait: the other seat is never told this seat is deciding', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: revealFrame('x-reveal-5', [930]) });
		vi.advanceTimersByTime(5000);
		expect(h.match.seatIdentities().find((s) => s.seat === 0)?.waitingOn ?? null).toBeNull();
	});

	it('a disqualifying ask arrives first: the reveal reaches the seat AT ONCE, not after the fold window', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: revealFrame('x-reveal-2', [910]) });
		// An ask that cannot possibly be this reveal's discard choice (not even
		// `getChoices`) arrives right behind it — no need to wait out the timer.
		h.host.push({ t: 'frame', seat: 0, frame: { kind: 'ask', callId: 'x-other', method: 'openZones', controller: { kind: 'player', id: 0 }, zones: [], players: [], backupLastZones: false } });

		const shown = h.sent.find((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'x-reveal-2');
		expect(shown?.envelope.displayOnly).toBe(true);
		const other = h.sent.find((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'x-other');
		expect(other).toBeDefined();
		expect(other?.envelope.displayOnly).toBeUndefined();
	});

	it('two reveals back to back: the first is shown too, not dropped for the second', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: revealFrame('x-reveal-3', [920]) });
		h.host.push({ t: 'frame', seat: 0, frame: revealFrame('x-reveal-4', [921]) });
		vi.advanceTimersByTime(1000);

		expect(h.host.commands).toEqual([
			{ t: 'reply', seat: 0, callId: 'x-reveal-3', result: [] },
			{ t: 'reply', seat: 0, callId: 'x-reveal-4', result: [] },
		]);
		for (const callId of ['x-reveal-3', 'x-reveal-4']) {
			expect(h.sent.some((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === callId)).toBe(true);
		}
	});
});

describe('an ask in which nothing may be chosen is a reveal, whatever its shape', () => {
	/** The one envelope `callId` reached seat 0 in, if any. */
	const shownTo0 = (h: Harness, callId: string) =>
		h.sent.find((s) => s.seat === 0 && s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === callId);

	it('getChoices with max 0: Forge is answered [] at once and the seat is shown it as a notice', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		const frame = {
			kind: 'ask' as const,
			callId: 'x-zero-1',
			method: 'getChoices' as const,
			message: 'Revealed',
			min: 0,
			max: 0,
			choices: [{ key: 'c0', label: 'Card 940', ref: { kind: 'card' as const, id: 940 } }],
			selected: [],
		};
		h.host.push({ t: 'frame', seat: 0, frame });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-zero-1', result: [] }]);
		vi.advanceTimersByTime(1000);
		expect(shownTo0(h, 'x-zero-1')?.envelope).toMatchObject({ frame, displayOnly: true });
		expect(h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'reply', callId: 'x-zero-1', method: 'getChoices', result: [] }))).toEqual({
			ok: false,
			error: 'stale-reply',
		});
	});

	it('chooseEntitiesForEffect with max 0: answered [] at once, shown as the getChoices reveal of every card it names', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({
			t: 'frame',
			seat: 0,
			frame: {
				kind: 'ask',
				callId: 'x-zero-2',
				method: 'chooseEntitiesForEffect',
				title: "Looking at cards in B's library",
				optionList: [{ kind: 'card', id: 950 }],
				min: 0,
				max: 0,
				delayedReveal: { cards: [{ kind: 'card', id: 950 }, { kind: 'card', id: 951 }], zones: ['Library'], owner: { kind: 'player', id: 1 }, messagePrefix: 'Revealed' },
			},
		});
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-zero-2', result: [] }]);
		vi.advanceTimersByTime(1000);
		const shown = shownTo0(h, 'x-zero-2');
		expect(shown?.envelope.displayOnly).toBe(true);
		expect(shown?.envelope.frame).toMatchObject({
			method: 'getChoices',
			message: "Looking at cards in B's library",
			choices: [{ ref: { kind: 'card', id: 950 } }, { ref: { kind: 'card', id: 951 } }],
		});
		expect(safeParseServerFrame(shown?.envelope.frame).ok).toBe(true);
	});
});

describe("a trigger's one ability is not a question: the server plays it", () => {
	/** Forge's `getAbilityToPlay` for `hostCard`, offering `abilities` (their ids). */
	function offer(callId: string, hostCard: number, abilities: number[]) {
		return {
			kind: 'ask' as const,
			callId,
			method: 'getAbilityToPlay' as const,
			hostCard: { kind: 'card' as const, id: hostCard },
			abilities: abilities.map((id) => ({ kind: 'spellAbility' as const, id, label: `ability ${id}` })),
			triggerEvent: null,
		};
	}
	const onWire = (h: Harness, callId: string) =>
		h.sent.some((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === callId);
	const click = (h: Harness, card: number) =>
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: card }, otherCardViewsToSelect: [], triggerEvent: null }));

	it('nobody clicked the card: Forge gets the one ability and the offer never reaches the wire', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: offer('t-1', 960, [77]) });
		expect(onWire(h, 't-1')).toBe(false);
		expect(h.host.commands).toContainEqual({ t: 'reply', seat: 0, callId: 't-1', result: { kind: 'spellAbility', id: 77, label: 'ability 77' } });
		expect(h.logs).toContainEqual(expect.objectContaining({ evt: 'ask-auto-answered', callId: 't-1', method: 'getAbilityToPlay' }));
	});

	it("the seat's own click still asks: the offer for the card it clicked reaches the browser", () => {
		const h = harness();
		h.host.push(...OPENING);
		click(h, 961);
		h.host.push({ t: 'frame', seat: 0, frame: offer('t-2', 961, [78]) });
		expect(onWire(h, 't-2')).toBe(true);
		// The click is spent on its own offer: a trigger of that same card afterwards is nobody's click.
		h.host.push({ t: 'frame', seat: 0, frame: offer('t-3', 961, [79]) });
		expect(onWire(h, 't-3')).toBe(false);
	});

	it('two abilities are a real choice: asked', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: offer('t-4', 962, [80, 81]) });
		expect(onWire(h, 't-4')).toBe(true);
	});

	it('full control: asked', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.match.setFullControl(0, true);
		h.host.push({ t: 'frame', seat: 0, frame: offer('t-5', 963, [82]) });
		expect(onWire(h, 't-5')).toBe(true);
	});
});

describe("V7: the whole game's log, not just its last few lines", () => {
	/**
	 * `setFullControl` is the simplest caller of `Match.say` that needs no
	 * transcript to drive: each toggle away from the seat's current value
	 * pushes exactly one `message` line (`match.ts`'s `say`). 31 toggles make
	 * 31 lines — comfortably past both the old cap (8) and the "30+" the brief
	 * asks for — with no fixture and no Forge frame involved.
	 */
	function sayLines(h: Harness, count: number): void {
		for (let i = 0; i < count; i++) h.match.setFullControl(0, i % 2 === 0);
	}

	it('keeps more than the old 8-line cap, and replays all of it after a snapshot', () => {
		const h = harness();
		h.host.push(...OPENING);
		const LINES = 31;
		sayLines(h, LINES);

		const before = h.sent.length;
		const snap = h.match.snapshot(0);
		if (!('frames' in snap)) throw new Error('expected a snapshot');
		h.match.resendAfterSnapshot(0);

		const resent = h.sent.slice(before).map((s) => s.envelope.frame as { method?: string; message?: string });
		const messages = resent.filter((f) => f.method === 'message');
		expect(messages).toHaveLength(LINES);
		expect(messages.map((f) => f.message)).toEqual(
			Array.from({ length: LINES }, (_, i) => (i % 2 === 0 ? 'full control on' : 'full control off')),
		);
	});
});

/**
 * hold-decide-forward, on recorded frame PAIRS rather
 * than a real jar: each case pushes `OPENING` (so both seats have a
 * `playerId` and a clean board), then a `showPromptMessage`/`updateButtons`
 * pair of its own, built from `@hadoku/forge-wire`'s own example shapes so a
 * malformed frame cannot pass `safeParseServerFrame` and be silently dropped.
 *
 * `decidePendingWindow` and `flushPendingWindow` are exercised directly
 * through `onFrame` (`h.host.push`), never called as units — what is asserted
 * is the frames a seat's own socket would receive, the same oracle every other
 * `describe` in this file uses.
 */
describe('hold-decide-forward', () => {
	const SEAT1_ID = 1;

	function openedHarness(): ReturnType<typeof harness> {
		const h = harness();
		h.host.push(...OPENING);
		return h;
	}

	/**
	 * `OPENING` leaves seat 1's own coin-toss bar open (Play/Draw, both
	 * enabled) — unrelated to what a case pushes next, but it would leave
	 * `wireButtonsLive` true for a reason that has nothing to do with the
	 * case itself. Closed the same way a real client would, before `before`
	 * is captured, so a case that wants a CLEAN slate gets one.
	 */
	function closeDanglingBar(h: Harness, seat: number): void {
		h.match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
	}

	function promptFrame(playerId: number, message: string, card: number | null = null) {
		return {
			kind: 'notify' as const,
			method: 'showPromptMessage' as const,
			player: { kind: 'player' as const, id: playerId },
			message,
			card: card === null ? null : { kind: 'card' as const, id: card },
		};
	}

	function buttonsFrame(
		playerId: number,
		opts: { label1?: string; label2?: string; enable1?: boolean; enable2?: boolean } = {},
	) {
		return {
			kind: 'notify' as const,
			method: 'updateButtons' as const,
			owner: { kind: 'player' as const, id: playerId },
			label1: opts.label1 ?? 'OK',
			label2: opts.label2 ?? 'Cancel',
			enable1: opts.enable1 ?? true,
			enable2: opts.enable2 ?? false,
			focus1: true,
		};
	}

	function methodsSent(h: Harness, seat: number, from: number): string[] {
		return envelopesFor(h, seat)
			.slice(from)
			.map((e) => e.frame.method);
	}

	it('a payment for the seat’s own cast, which Forge auto-pays (DEFAULT_STOP_POLICY is forgeAuto): nothing sent', () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		castOwn(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		const logsBefore = h.logs.length;
		// `InputPayMana`'s order: a disabled Auto bar, the enabled one, then the prompt.
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: false, enable2: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: true, enable2: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Pay Mana Cost: {U}', OWN_CARD) },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
		const since = h.logs.slice(logsBefore);
		expect(since.filter((l) => l.evt === 'prompt-withheld')).toEqual([
			{ evt: 'prompt-withheld', matchId: h.match.id, seat: SEAT1_ID, kind: 'payment', why: 'auto-pay' },
		]);
		expect(since.some((l) => l.evt === 'prompt-forwarded')).toBe(false);
	});

	it('a second click of the same mana source, whose one ability the server answers from the first, is still the seat’s own payment: auto-paid', () => {
		const SIGNET = 71;
		const PRIORITY_MAIN = 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: Empty';
		const offer = (callId: string) => ({
			kind: 'ask' as const,
			callId,
			method: 'getAbilityToPlay' as const,
			hostCard: { kind: 'card' as const, id: SIGNET },
			abilities: [{ kind: 'spellAbility' as const, id: 9100 }],
			triggerEvent: null,
		});
		const click = (h: Harness) =>
			h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: SIGNET }, otherCardViewsToSelect: [], triggerEvent: null }));
		const payment = (h: Harness) =>
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: true, enable2: true }) },
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Pay Mana Cost: {1}', SIGNET) },
			);
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		// The first click: the browser answers the offer its click opened, and the payment is auto-paid.
		click(h);
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: offer('s1-1') });
		expect(h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'reply', callId: 's1-1', method: 'getAbilityToPlay', result: { kind: 'spellAbility', id: 9100 } }))).toEqual({ ok: true });
		payment(h);
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, PRIORITY_MAIN) },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'OK', label2: 'End Turn' }) },
		);
		// The second click, in a later priority window: the server answers the same one ability.
		const logsBefore = h.logs.length;
		click(h);
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: offer('s1-2') });
		expect(h.logs.slice(logsBefore)).toContainEqual(
			expect.objectContaining({ evt: 'ask-auto-answered', callId: 's1-2', why: 'forge re-asked its own already-answered getAbilityToPlay' }),
		);
		const before = envelopesFor(h, SEAT1_ID).length;
		payment(h);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
		expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'auto-paid')).toEqual([{ evt: 'auto-paid', matchId: h.match.id, seat: SEAT1_ID, cost: '{1}' }]);
	});

	it('a priority window outside the stop set is auto-passed: nothing sent', () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		const logsBefore = h.logs.length;
		const message = 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: Empty';
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, message) },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
		expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'prompt-withheld')).toEqual([
			{ evt: 'prompt-withheld', matchId: h.match.id, seat: SEAT1_ID, kind: 'priority', why: 'auto-pass' },
		]);
	});

	it('a window the policy leaves to the seat (own main phase): both frames sent, in order', () => {
		const h = openedHarness();
		const before = envelopesFor(h, SEAT1_ID).length;
		const logsBefore = h.logs.length;
		const message = 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: Empty';
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, message) },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons']);
		expect(envelopesFor(h, SEAT1_ID).at(-1)?.frame).toEqual(buttonsFrame(1));
		expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'prompt-forwarded')).toEqual([
			{ evt: 'prompt-forwarded', matchId: h.match.id, seat: SEAT1_ID, kind: 'priority', why: 'kept' },
		]);
	});

	it('buttons arriving before their prompt (the payment order, left to the seat) are forwarded buttons-then-prompt, same as the pair arrived', () => {
		const h = openedHarness();
		// STRICT_PAYMENT_POLICY-shaped: left to the seat regardless of source
		// count, so the pair is forwarded, never auto-paid — the claim under
		// test is the ORDER, not the decision.
		h.match.setStopPolicy(SEAT1_ID, STRICT_PAYMENT_POLICY);
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push(
			// `InputPayMana`'s own documented order: Forge's `Auto` buttons
			// arrive before the message that names the cost — the one
			// buttons-first shape `buttonsCouldBeAnswered` holds for.
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Pay Mana Cost: {U}') },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['updateButtons', 'showPromptMessage']);
	});

	it('the safety flush: a half with no partner is forwarded, undecided, after the hold window', () => {
		vi.useFakeTimers();
		const h = openedHarness();
		const before = envelopesFor(h, SEAT1_ID).length;
		const logsBefore = h.logs.length;
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: Empty') });
		expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
		vi.advanceTimersByTime(1999);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage']);
		expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'prompt-forwarded' && l.why === 'unpaired')).toHaveLength(1);
	});

	it('an ask for the seat flushes a parked half at once, rather than waiting out the hold window', () => {
		const h = openedHarness();
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: Empty') },
			{ t: 'frame', seat: SEAT1_ID, frame: { kind: 'ask', callId: 'ask-1', method: 'showConfirmDialog', message: 'Mulligan?', title: 'Mulligan', yesButtonText: 'Yes', noButtonText: 'No', defaultYes: true } },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'showConfirmDialog']);
	});

	/**
	 * `InputPayMana.updateMessage`'s own order — buttons, THEN the actionable
	 * set, THEN the message — means a real payment ALWAYS interleaves a
	 * `setWeaklySelectable` between its two prompt halves (measured against a
	 * real jar, as much as 251ms end to end: `auto.jvm.test.ts`'s own
	 * Bitterblossom case). The first version of this fix flushed on ANY other
	 * frame, which threw the buttons half away unpaired, live, on every
	 * payment — the exact shape worse than the bug this file fixes. State
	 * frames and the actionable-set frames must not flush a parked half.
	 */
	it('setWeaklySelectable and a state frame, interleaved between the two halves, do not flush them — the pair still completes', () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		castOwn(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: { kind: 'notify', method: 'setWeaklySelectable', cards: [{ kind: 'card', id: 1 }] } },
		);
		// `setWeaklySelectable` is never held — it is sent at once, same as
		// always — but it does NOT flush the parked buttons half.
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['setWeaklySelectable']);
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Pay Mana Cost: {U}', OWN_CARD) });
		// Still nothing MORE: the pair completed and the single-source payment was auto-paid.
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['setWeaklySelectable']);
	});

	/**
	 * The narrowing a real jar's own 2s stall demanded: a window no decider
	 * could ever read (no `Priority: `/`Pay Mana Cost: ` text, no
	 * `confirmAbility`) is sent at once, never parked waiting for a partner
	 * that was never going to matter either way — `InputAttack`'s own
	 * per-toggle `updateButtons` refresh is exactly this shape, and holding
	 * it for the full {@link PROMPT_HOLD_FLUSH_MS} is what measured as a 2s
	 * lag on a real jar (a click landing on a stale card).
	 */
	it('a lone showPromptMessage with no answerable shape is forwarded at once, no timer', () => {
		vi.useFakeTimers();
		const h = openedHarness();
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Select creatures to attack (125) or select another attacker to declare blockers for.') });
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage']);
	});

	it('a lone updateButtons with no answerable shape (label1 neither Auto nor Yes/No) is forwarded at once, no timer', () => {
		vi.useFakeTimers();
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) }); // label1: 'OK' (the default)
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['updateButtons']);
	});

	/**
	 * The design check a withheld window's "nothing sent" has to answer: does
	 * it ever leave an ENABLED bar on the seat's screen that a stray click
	 * could still act on? The one real case is priority ping-ponging back to
	 * a seat that never itself acted — the opponent casts something and Forge
	 * re-opens THIS seat's own priority, now auto-passable, with no click
	 * from this seat in between (so `fromClient`'s own `disableStaleButtons`,
	 * which covers every OTHER case in this file, never ran).
	 */
	it('a live bar left over from a forwarded window is corrected (disabled) before the next window is withheld, never left stale-enabled', () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		// A real, forwarded, UNANSWERED stop: own main phase, bar enabled. No
		// act from this seat follows — the opponent's own move is what moves
		// Forge on, not a click from seat 1.
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: Empty') },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
		);
		expect(h.match.seats[SEAT1_ID]?.wireButtonsLive).toBe(true);
		const before = envelopesFor(h, SEAT1_ID).length;
		// Forge re-opens the SAME seat's priority — idle, outside the stop set —
		// without a single click from seat 1 in between.
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: Empty') },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
		);
		// Not nothing: the stale live bar is corrected, once, disabled — and
		// nothing ever reads as a question (no `showPromptMessage`).
		const sent = envelopesFor(h, SEAT1_ID).slice(before);
		expect(sent.map((e) => e.frame.method)).toEqual(['updateButtons']);
		expect(sent[0]?.frame).toMatchObject({ enable1: false, enable2: false });
		expect(h.match.seats[SEAT1_ID]?.wireButtonsLive).toBe(false);
	});

	/**
	 * A real bug this wave's own e2e proof found: a second `showPromptMessage`
	 * arriving before the FIRST one's `updateButtons` ever paired used to
	 * silently overwrite `pendingPrompt` — the first window's text was never
	 * sent, never logged, just gone. Measured against a real jar: Ponder's
	 * own resolution can open its "Do you want to shuffle…" confirm before
	 * the caster's own "Stack: 1 to Resolve" buttons ever arrive, under FULL
	 * CONTROL (where nothing should ever be withheld) — the caster's own
	 * priority stop vanished outright. A held half is now flushed, unpaired,
	 * the moment a second half of the SAME kind would otherwise replace it —
	 * forwarded exactly as it would have gone out before this wave, never
	 * silently discarded.
	 */
	it('a second showPromptMessage arriving before the first ever paired flushes the first, unpaired, rather than discarding it', () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: 1 to Resolve') },
			// The SAME seat's buttons for THIS window never arrive — Forge moves
			// straight to a second, unrelated prompt instead (full control: the
			// first prompt's own buttons would never have been auto-answered
			// away, so it must have genuinely not come yet). "Do you want to
			// shuffle the library?" has no shape any decider reads (no
			// `confirmAbility`, no `Priority: `/`Pay Mana Cost: ` text), so it
			// is sent at once — the narrowed hold (§S's own follow-up) never
			// touches it either.
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Do you want to shuffle the library?') },
		);
		const sent = envelopesFor(h, SEAT1_ID).slice(before);
		// The FIRST prompt text is still there — not overwritten into oblivion —
		// followed by the second, unrelated prompt, sent immediately.
		expect(sent.map((e) => e.frame.method)).toEqual(['showPromptMessage', 'showPromptMessage']);
		expect((sent[0]?.frame as { message?: string }).message).toContain('Stack: 1 to Resolve');
		expect((sent[1]?.frame as { message?: string }).message).toBe('Do you want to shuffle the library?');
	});

	it('a second answerable prompt arriving before the first paired flushes the first as forwarded, then holds the second', () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		const logsBefore = h.logs.length;
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: 1 to Resolve') },
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: Empty') },
		);
		const sent = envelopesFor(h, SEAT1_ID).slice(before);
		expect(sent.map((e) => e.frame.method)).toEqual(['showPromptMessage']);
		expect((sent[0]?.frame as { message?: string }).message).toContain('Stack: 1 to Resolve');
		expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'prompt-forwarded' && l.why === 'unpaired')).toHaveLength(1);
		// The second is the one now waiting for its buttons; they complete it.
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) });
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'showPromptMessage', 'updateButtons']);
	});

	it("a payment's leftover Auto bar never pairs with the priority window after it: that window is still decided", () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		const logsBefore = h.logs.length;
		h.host.push(
			// `InputPayMana`'s refresh after a payment completes: a bar, no prompt.
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: false, enable2: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: Empty') },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'OK', label2: 'End Turn', enable1: true, enable2: true }) },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
		expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'prompt-withheld')).toEqual([
			{ evt: 'prompt-withheld', matchId: h.match.id, seat: SEAT1_ID, kind: 'priority', why: 'auto-pass' },
		]);
	});

	it("a confirm's Yes/No bar arriving while a priority prompt is held is never read as that prompt's bar", () => {
		const h = openedHarness();
		closeDanglingBar(h, SEAT1_ID);
		const before = envelopesFor(h, SEAT1_ID).length;
		const actsBefore = h.host.commands.filter((c) => c.t === 'act').length;
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Upkeep step\nStack: Empty') },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Yes', label2: 'No', enable1: true, enable2: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, "Use Mirri's Guile's ability?") },
		);
		// No press reached Forge: an auto-pass here would have answered the confirm Yes.
		expect(h.host.commands.filter((c) => c.t === 'act').length).toBe(actsBefore);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons', 'showPromptMessage']);
		expect(envelopesFor(h, SEAT1_ID).at(-2)?.frame).toMatchObject({ label1: 'Yes', enable1: true });
	});

	it('a newer Auto bar replaces a held one: a payment left to the seat goes out with its latest bar only', () => {
		const h = openedHarness();
		h.match.setStopPolicy(SEAT1_ID, STRICT_PAYMENT_POLICY);
		const before = envelopesFor(h, SEAT1_ID).length;
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: false, enable2: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Auto', enable1: true, enable2: true }) },
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Pay Mana Cost: {U}') },
		);
		const sent = envelopesFor(h, SEAT1_ID).slice(before);
		expect(sent.map((e) => e.frame.method)).toEqual(['updateButtons', 'showPromptMessage']);
		expect(sent[0]?.frame).toMatchObject({ label1: 'Auto', enable1: true });
	});

	it("InputAttack's per-click button refreshes are sent the moment they arrive, never held", () => {
		vi.useFakeTimers();
		const h = openedHarness();
		// Both players at the table, as in a real attack: a match nobody is at keeps its own rejoin timer.
		h.match.seatConnected(0);
		h.match.seatConnected(1);
		const before = envelopesFor(h, SEAT1_ID).length;
		const attack = (label2: string) => buttonsFrame(1, { label1: 'OK', label2, enable1: true, enable2: true });
		h.host.push(
			{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Select creatures to attack Seat 1 or select another attacker to declare blockers for.') },
			{ t: 'frame', seat: SEAT1_ID, frame: attack('Alpha Strike') },
		);
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons']);
		// One refresh per toggled attacker, no new prompt with any of them.
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: attack('Call Back') });
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons', 'updateButtons']);
		h.host.push({ t: 'frame', seat: SEAT1_ID, frame: attack('Alpha Strike') });
		expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons', 'updateButtons', 'updateButtons']);
		// The one timer this leaves is the roster's own grace on the wait that appeared (the other
		// seat's "Waiting for …", `checkWaitingOn`) — not a held frame: every frame above was sent at once.
		vi.advanceTimersByTime(150);
		expect(vi.getTimerCount()).toBe(0);
	});

	/*
	 * `turnFrame` is Forge's own Game-object `Turn`, off a delta — never off
	 * this seat's own prompt text, which `auto.ts`'s `TURN_OWNER` reads for a
	 * different fact and only when this seat IS the one prompted.
	 */
	describe('a stop at a phase: held once, at the next occurrence, on either turn', () => {
		function gameFrame(turn: number, phase: string) {
			return {
				kind: 'notify' as const,
				method: 'applyDelta' as const,
				payload: {
					packet: {
						seq: 1,
						checksum: 0,
						checksumProperties: [],
						newObjects: {},
						objectDeltas: {
							[String(deltaKeyOf(TYPE.game, 1))]: {
								_type: TYPE.game,
								_id: 1,
								Turn: { t: 'int', v: turn },
								Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: phase },
							},
						},
						events: [],
					},
				},
			};
		}
		const actsSent = (h: Harness) => h.host.commands.filter((c) => c.t === 'act').length;
		/** Seat 2's priority window in `phase` on `turn`, whoever's turn it is. */
		function windowAt(h: Harness, turn: number, owner: 'Seat 1' | 'Seat 2', label: string, phase: string) {
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: gameFrame(turn, phase) },
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, `Priority: Seat 2\nTurn: ${turn} (${owner})\nPhase: ${label}\nStack: Empty`) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label2: 'End Turn', enable2: true }) },
			);
		}
		const stopLogs = (h: Harness) => h.logs.filter((l) => typeof l.evt === 'string' && ['stop-set', 'stop-fired', 'stop-cleared'].includes(l.evt));

		it("keeps the seat's own end step the default passes, once, and tells the seat it is spent", () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: gameFrame(5, 'MAIN1') });
			expect(h.match.setPhaseStop(SEAT1_ID, 'END_OF_TURN')).toEqual({ ok: true });
			expect(h.match.phaseStop(SEAT1_ID)).toBe('END_OF_TURN');

			const acts = actsSent(h);
			windowAt(h, 5, 'Seat 2', 'End step', 'END_OF_TURN');
			expect(actsSent(h), 'kept').toBe(acts);
			expect(h.match.phaseStop(SEAT1_ID)).toBeNull();
			// A second window in the same end step — after a spell resolved — is kept as well.
			windowAt(h, 5, 'Seat 2', 'End step', 'END_OF_TURN');
			expect(actsSent(h), 'still held').toBe(acts);
			// The next own end step is the default's again.
			windowAt(h, 7, 'Seat 2', 'End step', 'END_OF_TURN');
			expect(actsSent(h), 'spent: passed').toBe(acts + 1);

			expect(h.stops).toEqual([
				{ seat: SEAT1_ID, phase: 'END_OF_TURN' },
				{ seat: SEAT1_ID, phase: null },
			]);
			expect(stopLogs(h).map((l) => [l.evt, l.phase, l.turn])).toEqual([
				['stop-set', 'END_OF_TURN', 5],
				['stop-fired', 'END_OF_TURN', 5],
			]);
		});

		it("set in the phase itself, it is for that phase's next occurrence — the other seat's turn", () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: gameFrame(5, 'UPKEEP') });
			h.match.setPhaseStop(SEAT1_ID, 'UPKEEP');
			const acts = actsSent(h);
			windowAt(h, 5, 'Seat 2', 'Upkeep step', 'UPKEEP');
			expect(actsSent(h), 'this upkeep is passed').toBe(acts + 1);
			windowAt(h, 6, 'Seat 1', 'Upkeep step', 'UPKEEP');
			expect(actsSent(h), "the other seat's upkeep is held").toBe(acts + 1);
			expect(stopLogs(h).map((l) => [l.evt, l.phase, l.myTurn])).toEqual([
				['stop-set', 'UPKEEP', undefined],
				['stop-fired', 'UPKEEP', false],
			]);
		});

		it('cleared before it fires, the phase is passed as ever', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: gameFrame(5, 'MAIN1') });
			h.match.setPhaseStop(SEAT1_ID, 'END_OF_TURN');
			h.match.setPhaseStop(SEAT1_ID, null);
			const acts = actsSent(h);
			windowAt(h, 5, 'Seat 2', 'End step', 'END_OF_TURN');
			expect(actsSent(h)).toBe(acts + 1);
			expect(stopLogs(h).map((l) => [l.evt, l.phase, l.why])).toEqual([
				['stop-set', 'END_OF_TURN', undefined],
				['stop-cleared', 'END_OF_TURN', 'player'],
			]);
			expect(h.stops.map((c) => c.phase)).toEqual(['END_OF_TURN', null]);
		});

		it("outranks the seat's own Auto Yield, and touches only its own seat", () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: gameFrame(6, 'MAIN1') });
			h.match.setAutoYield(SEAT1_ID, true);
			h.match.setPhaseStop(SEAT1_ID, 'END_OF_TURN');
			expect(h.match.phaseStop(0)).toBeNull();
			const acts = actsSent(h);
			windowAt(h, 6, 'Seat 1', 'End step', 'END_OF_TURN');
			expect(actsSent(h)).toBe(acts);
		});
	});

	describe('the auto-yield override, read ahead of autoPassReason', () => {
		function turnFrame(turn: number) {
			return {
				kind: 'notify' as const,
				method: 'applyDelta' as const,
				payload: {
					packet: {
						seq: 1,
						checksum: 0,
						checksumProperties: [],
						// No `newObjects` entry: OPENING already created the Game object, and
						// a replace there would clear every OTHER fact it carries.
						newObjects: {},
						objectDeltas: { [String(deltaKeyOf(TYPE.game, 1))]: { _type: TYPE.game, _id: 1, Turn: { t: 'int', v: turn } } },
						events: [],
					},
				},
			};
		}
		const actsSent = (h: Harness) => h.host.commands.filter((c) => c.t === 'act').length;
		// Priority is "Seat 2" (this seat's own) while the TURN OWNER is "Seat
		// 1" — not this seat's turn — with one item already on the stack.
		const theirTurnResponseWindow = 'Priority: Seat 2\nTurn: 5 (Seat 1)\nPhase: Main phase, precombat\nStack: 1 card';

		it('passes a priority window on the OTHER seat’s turn, a stack with their spell on it included, and the log names why', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: turnFrame(5) });
			expect(h.match.setAutoYield(SEAT1_ID, true)).toEqual({ ok: true });
			const before = envelopesFor(h, SEAT1_ID).length;
			const logsBefore = h.logs.length;
			const actsBefore = actsSent(h);
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, theirTurnResponseWindow) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
			);
			expect(methodsSent(h, SEAT1_ID, before)).toEqual([]);
			expect(actsSent(h)).toBe(actsBefore + 1);
			expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed')).toEqual([
				{ evt: 'auto-passed', matchId: h.match.id, seat: SEAT1_ID, phase: 'Main phase, precombat', why: 'auto-yield' },
			]);
		});

		it('pressed while a window is already open: that window is passed at once, not on the next one', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: turnFrame(5) });
			// The window is open and LIVE on the seat's own wire before the toggle comes on.
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, theirTurnResponseWindow) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
			);
			const before = envelopesFor(h, SEAT1_ID).length;
			expect(methodsSent(h, SEAT1_ID, before - 2)).toEqual(['showPromptMessage', 'updateButtons']);
			const logsBefore = h.logs.length;
			const actsBefore = actsSent(h);
			expect(h.match.setAutoYield(SEAT1_ID, true)).toEqual({ ok: true });
			expect(actsSent(h)).toBe(actsBefore + 1);
			expect(h.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed')).toEqual([
				{ evt: 'auto-passed', matchId: h.match.id, seat: SEAT1_ID, phase: 'Main phase, precombat', why: 'auto-yield' },
			]);
			// And the already-live bar is corrected, the same disabled correction a window answered inside `decideWindow` gets.
			const sent = envelopesFor(h, SEAT1_ID).slice(before);
			expect(sent.map((e) => e.frame.method)).toEqual(['updateButtons']);
			expect(sent[0]?.frame).toMatchObject({ enable1: false, enable2: false });
		});

		it('a turn change expires it with nothing run to clear it — the SAME window, one turn later, is kept', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: turnFrame(5) });
			h.match.setAutoYield(SEAT1_ID, true);
			// The turn moves on before this window arrives — nothing here ran to
			// notice it; `maybeAutoPass`'s own compare is what expires it.
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: turnFrame(6) });
			const before = envelopesFor(h, SEAT1_ID).length;
			const actsBefore = actsSent(h);
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, theirTurnResponseWindow.replace('Turn: 5', 'Turn: 6')) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
			);
			expect(actsSent(h)).toBe(actsBefore); // not auto-passed: it is kept, and asks
			expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons']);
		});

		it('Cancel Yield (on: false) is read at once, same turn, with no new window needed', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: turnFrame(5) });
			h.match.setAutoYield(SEAT1_ID, true);
			h.match.setAutoYield(SEAT1_ID, false);
			const before = envelopesFor(h, SEAT1_ID).length;
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, theirTurnResponseWindow) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
			);
			expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons']);
		});

		it('full control still wins: an escape-hatch seat is asked even with auto-yield on', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: turnFrame(5) });
			h.match.setFullControl(SEAT1_ID, true);
			h.match.setAutoYield(SEAT1_ID, true);
			const before = envelopesFor(h, SEAT1_ID).length;
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, theirTurnResponseWindow) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1) },
			);
			expect(methodsSent(h, SEAT1_ID, before)).toEqual(['showPromptMessage', 'updateButtons']);
		});
	});

	describe('a batch of identical triggers (six Valakut triggers)', () => {
		const VALAKUT = 40;
		const BOB = 0;
		const selectables = { kind: 'notify' as const, method: 'setSelectables' as const, cards: [{ kind: 'card' as const, id: 77 }], min: 1, max: 1 };
		const targetPrompt = (abilityId: number, more: number, players = [BOB]) => ({
			...promptFrame(1, 'Valakut, the Molten Pinnacle - Select any target'),
			card: { kind: 'card' as const, id: VALAKUT },
			targetAbility: { hostCard: { kind: 'card' as const, id: VALAKUT }, abilityId, trigger: `${VALAKUT}:9`, more, players: players.map((id) => ({ kind: 'player' as const, id })) },
		});
		const targetBar = buttonsFrame(1, { enable1: false, enable2: false });
		const ask = (h: Harness, abilityId: number, more: number) =>
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: selectables },
				{ t: 'frame', seat: SEAT1_ID, frame: targetPrompt(abilityId, more) },
				{ t: 'frame', seat: SEAT1_ID, frame: targetBar },
			);
		const dealConfirm = (abilityId: number) => [
			{ t: 'frame' as const, seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'Yes', label2: 'No', enable1: true, enable2: true }) },
			{ t: 'frame' as const, seat: SEAT1_ID, frame: { ...promptFrame(1, 'Do you want to deal 3 damage to Bob?'), confirmAbility: { hostCard: { kind: 'card' as const, id: VALAKUT }, abilityId } } },
		];
		const picks = (h: Harness) => h.host.commands.filter((c) => c.t === 'act' && c.frame.method === 'selectPlayer').map((c) => (c.t === 'act' ? c.frame : null));
		const oks = (h: Harness) => h.host.commands.filter((c) => c.t === 'act' && c.frame.method === 'selectButtonOk').length;

		it('one pick with "same target for all" answers the rest, never reaching the seat; Forge never sees the flag', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			ask(h, 101, 2);
			const shown = envelopesFor(h, SEAT1_ID).length;
			expect(h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: BOB }, triggerEvent: null, sameTarget: true }))).toEqual({ ok: true });
			ask(h, 102, 1);
			ask(h, 103, 0);
			expect(picks(h)).toEqual([0, 1, 2].map(() => ({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: BOB }, triggerEvent: null })));
			expect(methodsSent(h, SEAT1_ID, shown).filter((m) => m === 'showPromptMessage'), 'the two answered questions never reached the seat').toEqual([]);
		});

		it('a target Forge no longer offers is asked again', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			ask(h, 101, 1);
			h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: BOB }, triggerEvent: null, sameTarget: true }));
			const before = envelopesFor(h, SEAT1_ID).length;
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: selectables },
				{ t: 'frame', seat: SEAT1_ID, frame: targetPrompt(102, 0, []) },
				{ t: 'frame', seat: SEAT1_ID, frame: targetBar },
			);
			expect(picks(h)).toHaveLength(1);
			expect(methodsSent(h, SEAT1_ID, before)).toContain('showPromptMessage');
		});

		it('without the box each question is the seat\'s own', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			ask(h, 101, 1);
			h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: BOB }, triggerEvent: null }));
			const before = envelopesFor(h, SEAT1_ID).length;
			ask(h, 102, 0);
			expect(picks(h)).toHaveLength(1);
			expect(methodsSent(h, SEAT1_ID, before)).toContain('showPromptMessage');
		});

		it('"Do you want to deal 3 damage" for a target the seat chose is answered Yes, once; an ability it chose nothing for still asks', () => {
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			ask(h, 101, 0);
			h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: BOB }, triggerEvent: null }));
			const before = envelopesFor(h, SEAT1_ID).length;
			const okBefore = oks(h);
			h.host.push(...dealConfirm(101));
			expect(oks(h) - okBefore, 'answered Yes').toBe(1);
			expect(methodsSent(h, SEAT1_ID, before).filter((m) => m === 'showPromptMessage')).toEqual([]);
			expect(h.logs).toContainEqual(expect.objectContaining({ evt: 'auto-confirmed', why: 'the seat chose its target' }));
			h.host.push(...dealConfirm(999));
			expect(oks(h) - okBefore, 'a confirm for an ability it targeted nothing for').toBe(1);
			expect(methodsSent(h, SEAT1_ID, before)).toContain('showPromptMessage');
		});
	});

	describe("an optional trigger's remembered answer", () => {
		const KEY = 'Whenever another creature enters the battlefield, you may gain 1 life.';
		const triggerConfirm = (key = KEY) => ({
			...promptFrame(1, "Use triggered ability of Soul's Attendant?"),
			confirmAbility: { hostCard: { kind: 'card' as const, id: 40 }, abilityId: 7, trigger: { key, name: "Soul's Attendant" } },
		});
		const yieldActs = (h: Harness) => h.host.commands.filter((c) => c.t === 'act' && c.frame.method === 'sendYieldUpdate');

		it("is sent to Forge as its own triggerDecision, and listed with the trigger's card", () => {
			const h = openedHarness();
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: triggerConfirm() });
			expect(h.match.setTriggerDecision(SEAT1_ID, KEY, 'ACCEPT')).toEqual({ ok: true });
			expect(yieldActs(h)).toEqual([
				{ t: 'act', seat: SEAT1_ID, frame: { kind: 'act', method: 'sendYieldUpdate', update: { update: 'triggerDecision', storageKey: KEY, decision: 'ACCEPT' } } },
			]);
			expect(h.match.triggerDecisions(SEAT1_ID)).toEqual([{ key: KEY, name: "Soul's Attendant", decision: 'ACCEPT' }]);
			expect(h.match.triggerDecisions(0)).toEqual([]);
		});

		it('ASK clears it — in Forge and in the list — after the confirm is long gone', () => {
			const h = openedHarness();
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: triggerConfirm() });
			h.match.setTriggerDecision(SEAT1_ID, KEY, 'DECLINE');
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, 'Priority: Seat 2\nTurn: 1 (Seat 2)\nPhase: Main phase, precombat\nStack: Empty') });
			expect(h.match.setTriggerDecision(SEAT1_ID, KEY, 'ASK')).toEqual({ ok: true });
			expect(yieldActs(h).map((c) => (c.t === 'act' && c.frame.method === 'sendYieldUpdate' ? c.frame.update : null))).toEqual([
				{ update: 'triggerDecision', storageKey: KEY, decision: 'DECLINE' },
				{ update: 'triggerDecision', storageKey: KEY, decision: 'ASK' },
			]);
			expect(h.match.triggerDecisions(SEAT1_ID)).toEqual([]);
		});

		it('a key the seat was never asked about reaches nothing', () => {
			const h = openedHarness();
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: triggerConfirm() });
			expect(h.match.setTriggerDecision(SEAT1_ID, 'some other trigger', 'ACCEPT')).toEqual({ ok: false, error: 'not a trigger this seat was asked about' });
			expect(h.match.setTriggerDecision(0, KEY, 'ACCEPT')).toMatchObject({ ok: false });
			expect(yieldActs(h)).toEqual([]);
			expect(h.match.triggerDecisions(SEAT1_ID)).toEqual([]);
		});
	});

	describe('a window Forge keeps after the seat acted: re-sent, never left dead', () => {
		const PRIORITY = 'Priority: Seat 2\nTurn: 3 (Seat 2)\nPhase: Main phase, precombat\nStack: Empty';
		const bars = (h: Harness, from: number) =>
			envelopesFor(h, SEAT1_ID)
				.slice(from)
				.map((e) => e.frame)
				.filter((f): f is Extract<typeof f, { method: 'updateButtons' }> => f.method === 'updateButtons')
				.map((f) => `${f.label1}:${f.enable1}/${f.label2}:${f.enable2}`);
		const offer = (callId: string) => ({
			kind: 'ask' as const,
			callId,
			method: 'getAbilityToPlay' as const,
			hostCard: { kind: 'card' as const, id: 960 },
			abilities: [80, 81].map((id) => ({ kind: 'spellAbility' as const, id, label: `ability ${id}` })),
			triggerEvent: null,
		});

		/** Seat 1 holds a live priority window (full control, so no stop decides it), clicks a card, and Forge asks which ability. */
		function pickerOpen(): { h: Harness; from: number } {
			vi.useFakeTimers();
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.match.setFullControl(SEAT1_ID, true);
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, PRIORITY) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'OK', label2: 'End Turn', enable1: true, enable2: true }) },
			);
			const from = envelopesFor(h, SEAT1_ID).length;
			h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: 960 }, otherCardViewsToSelect: [], triggerEvent: null }));
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: offer('s1-22') });
			return { h, from };
		}
		const none = ClientFrameSchema.parse({ kind: 'reply', callId: 's1-22', method: 'getAbilityToPlay', result: null });

		it('a picker answered None, then nothing from Forge: the live window is back ANSWER_SILENCE_MS later, once', () => {
			const { h, from } = pickerOpen();
			expect(bars(h, from)).toEqual(['OK:false/End Turn:false']);
			expect(h.match.fromClient(SEAT1_ID, none)).toEqual({ ok: true });
			vi.advanceTimersByTime(ANSWER_SILENCE_MS - 1);
			expect(bars(h, from)).toEqual(['OK:false/End Turn:false']);
			vi.advanceTimersByTime(1);
			expect(bars(h, from)).toEqual(['OK:false/End Turn:false', 'OK:true/End Turn:true']);
			const resent = envelopesFor(h, SEAT1_ID).slice(from).map((e) => e.frame.method);
			expect(resent.slice(-2)).toEqual(['showPromptMessage', 'updateButtons']);
			expect(h.logs.filter((l) => l.evt === 'window-resent')).toEqual([
				{ evt: 'window-resent', matchId: h.match.id, seat: SEAT1_ID, after: 'answer', label1: 'OK', label2: 'End Turn' },
			]);
			vi.advanceTimersByTime(ACT_SILENCE_MS * 2);
			expect(h.logs.filter((l) => l.evt === 'window-resent')).toHaveLength(1);
		});

		it('a picker answered and Forge shows its next window: nothing is re-sent', () => {
			const { h, from } = pickerOpen();
			h.match.fromClient(SEAT1_ID, none);
			h.host.push({ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'OK', label2: 'Undo (1)', enable1: true, enable2: true }) });
			vi.advanceTimersByTime(ACT_SILENCE_MS * 2);
			expect(bars(h, from)).toEqual(['OK:false/End Turn:false', 'OK:true/Undo (1):true']);
			expect(h.logs.filter((l) => l.evt === 'window-resent')).toEqual([]);
		});

		it('an act Forge never answers at all: the live window is back after ACT_SILENCE_MS, beside the lost-ask re-send', () => {
			vi.useFakeTimers();
			const h = openedHarness();
			closeDanglingBar(h, SEAT1_ID);
			h.match.setFullControl(SEAT1_ID, true);
			h.host.push(
				{ t: 'frame', seat: SEAT1_ID, frame: promptFrame(1, PRIORITY) },
				{ t: 'frame', seat: SEAT1_ID, frame: buttonsFrame(1, { label1: 'OK', label2: 'End Turn', enable1: true, enable2: true }) },
			);
			const from = envelopesFor(h, SEAT1_ID).length;
			h.match.fromClient(SEAT1_ID, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: 960 }, otherCardViewsToSelect: [], triggerEvent: null }));
			vi.advanceTimersByTime(ACT_SILENCE_MS);
			expect(bars(h, from)).toEqual(['OK:false/End Turn:false', 'OK:true/End Turn:true']);
			expect(h.logs.find((l) => l.evt === 'window-resent')).toMatchObject({ seat: SEAT1_ID, after: 'act' });
			expect(h.host.commands).toContainEqual({ t: 'resend-pending', seat: SEAT1_ID });
		});
	});
});

/**
 * The ring: `prompt-forwarded`/`prompt-withheld` are logged as each window is
 * decided (asserted throughout the describe above); `match-frames` is the
 * whole match's record, logged once when it ends.
 */
describe('telemetry (match-frames)', () => {
	const PRIORITY_MAIN = 'Priority: Seat 1\nTurn: 1 (Seat 1)\nPhase: Main phase, precombat\nStack: Empty';
	const ringOf = (h: Harness) => h.logs.filter((l) => l.evt === 'match-frames') as { matchId: string; frames: Record<string, unknown>[] }[];

	it('logs the ring once, on match end — both decisions, each seat', () => {
		const h = harness();
		h.host.push(...OPENING);
		castOwn(h, 1);
		h.host.push(
			{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 1 }, label1: 'Auto', label2: 'Cancel', enable1: true, enable2: false, focus1: true } },
			{ t: 'frame', seat: 1, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 1 }, message: 'Pay Mana Cost: {U}', card: { kind: 'card', id: OWN_CARD } } },
			{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: PRIORITY_MAIN, card: null } },
			{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2: 'Cancel', enable1: true, enable2: false, focus1: true } },
		);
		expect(ringOf(h)).toEqual([]);
		h.match.stop();
		const [ring, ...rest] = ringOf(h);
		expect(rest).toEqual([]);
		expect(ring?.matchId).toBe(h.match.id);
		expect(ring?.frames).toEqual([
			expect.objectContaining({ seat: 1, kind: 'payment', decision: 'withheld', why: 'auto-pay', message: 'Pay Mana Cost: {U}' }),
			expect.objectContaining({ seat: 0, kind: 'priority', decision: 'forwarded', why: 'kept', buttons: { label1: 'OK', enable1: true, label2: 'Cancel', enable2: false } }),
		]);
	});

	it('logs nothing when the match never decided a window', () => {
		const h = harness();
		h.match.stop();
		expect(ringOf(h)).toEqual([]);
	});

	it('logs exactly once when a natural game-over is followed by an explicit stop()', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push(
			{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: PRIORITY_MAIN, card: null } },
			{ t: 'frame', seat: 0, frame: { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2: 'Cancel', enable1: true, enable2: false, focus1: true } },
		);
		h.host.push({ t: 'gameover', winner: '0' });
		expect(ringOf(h)).toHaveLength(1);
		h.match.stop();
		expect(ringOf(h)).toHaveLength(1);
	});
});

describe('frameGist (the probe-mode frame trace)', () => {
	it('names a frame by method, kind, message, bar and card — and survives a null card', () => {
		expect(frameGist({ kind: 'notify', method: 'showPromptMessage', message: 'Priority: Main 1', card: null })).toEqual({
			method: 'showPromptMessage',
			kind: 'notify',
			message: 'Priority: Main 1',
		});
		expect(frameGist({ kind: 'act', method: 'selectCard', card: { id: 42 } })).toEqual({ method: 'selectCard', kind: 'act', card: 42 });
		expect(frameGist({ kind: 'notify', method: 'updateButtons', label1: 'OK', enable1: true, label2: 'End Turn', enable2: false })).toMatchObject({
			bar: ['OK', true, 'End Turn', false],
		});
		expect(frameGist(null)).toEqual({ method: undefined, kind: undefined });
	});
});

describe('a card-name ask', () => {
	const DECK = '[metadata]\nName=Guides\n[Main]\n4 Goblin Guide|ZEN\n56 Mountain|ZEN\n';

	function named(format: string | undefined) {
		const { factory, hosts } = replayFactory();
		const sent: Harness['sent'] = [];
		const logs: Record<string, unknown>[] = [];
		const registry = createMatchRegistry({
			host: factory,
			log: (e) => logs.push(e),
			overGraceMs: 60_000,
			emit: (_match, seat, envelope) => sent.push({ seat, envelope }),
			formatNames: (id) => (id === 'legacy-2005' ? new Set(['Grizzly Bears', 'Llanowar Elves']) : null),
		});
		const match = registry.create({
			seats: [
				{ name: 'Seat 1', ai: false, deck: null },
				{ name: 'Seat 2', ai: false, deck: DECK },
			],
			...(format === undefined ? {} : { format }),
		});
		const h: Harness = { match, host: hosts[0] as ReplayHost, sent, logs };
		h.host.push(...OPENING);
		h.host.push({
			t: 'frame',
			seat: 0,
			frame: {
				kind: 'ask',
				callId: 'x-name-1',
				method: 'getChoices',
				message: 'Choose a nonland card name.',
				min: 1,
				max: 1,
				choices: [],
				selected: [],
				names: ['Ach! Hans, Run!', 'Goblin Guide', 'Grizzly Bears', 'Llanowar Elves'],
			},
		});
		const shown = h.sent.find((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'x-name-1');
		return { h, names: (shown?.envelope.frame as { names?: string[] } | undefined)?.names };
	}

	const answer = (name: string) => ClientFrameSchema.parse({ kind: 'reply', callId: 'x-name-1', method: 'getChoices', result: [name] });

	it('offers the names the format allows and a deck plays, never one outside both', () => {
		const { h, names } = named('legacy-2005');
		expect(names).toEqual(['Goblin Guide', 'Grizzly Bears', 'Llanowar Elves']);
		expect(h.logs.find((l) => l.evt === 'name-ask')).toMatchObject({ format: 'legacy-2005', offered: 4, shown: 3 });
		expect(h.match.fromClient(0, answer('Ach! Hans, Run!'))).toEqual({ ok: false, error: 'reply names a card that was not offered' });
		expect(h.host.commands).toEqual([]);
	});

	it('the chosen name reaches Forge as its own key', () => {
		const { h } = named('legacy-2005');
		expect(h.match.fromClient(0, answer('Grizzly Bears'))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-name-1', result: ['Grizzly Bears'] }]);
	});

	it('a match with no format offers Forge’s whole list', () => {
		expect(named(undefined).names).toEqual(['Ach! Hans, Run!', 'Goblin Guide', 'Grizzly Bears', 'Llanowar Elves']);
		expect(named('free').names).toHaveLength(4);
	});
});

describe('a scry is one prompt', () => {
	const cards = (ids: number[], prefix: string) => ids.map((id, i) => ({ key: `${prefix}${i}`, label: `Card (${id})`, ref: { kind: 'card' as const, id } }));
	/** Forge's first question (`arrangeForScry`'s `many`) and its second (the top's order). */
	const bottomAsk = (callId: string, ids: number[], top = 'Cards to put on the bottom') => ({
		kind: 'ask' as const,
		callId,
		method: 'order' as const,
		title: 'Select cards to be put on the bottom of your library',
		top,
		remainingObjectsMin: -1,
		remainingObjectsMax: -1,
		sourceChoices: cards(ids, 'b'),
		destChoices: [],
		referenceCard: null,
		sideboardingMode: false,
		showRememberCheckbox: false,
	});
	const topAsk = (callId: string, ids: number[]) => ({
		...bottomAsk(callId, ids),
		title: 'Arrange cards to be put on top of your library',
		top: 'Top of Library',
		remainingObjectsMin: 0,
		remainingObjectsMax: 0,
		sourceChoices: cards(ids, 't'),
	});
	const shown = (h: Harness, callId: string) =>
		h.sent.filter((s) => s.seat === 0 && s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === callId);
	const orderReply = (callId: string, result: { ordered: string[]; rememberDecision: boolean; rest?: string[] }) =>
		ClientFrameSchema.parse({ kind: 'reply', callId, method: 'order', result });

	it('the seat sees two named groups; Forge gets the bottom, then the top in the order the same reply gave, never asked again', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: bottomAsk('x-scry-1', [700, 701, 702, 703]) });
		expect(shown(h, 'x-scry-1')[0]?.envelope.frame).toMatchObject({ method: 'order', rest: 'Cards on top', top: 'Cards on bottom' });

		expect(h.match.fromClient(0, orderReply('x-scry-1', { ordered: ['b1'], rememberDecision: false, rest: ['b2', 'b0', 'b3'] }))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-scry-1', result: { ordered: ['b1'], rememberDecision: false } }]);

		h.host.push({ t: 'frame', seat: 0, frame: topAsk('x-scry-2', [700, 702, 703]) });
		expect(shown(h, 'x-scry-2')).toEqual([]);
		expect(h.host.commands[1]).toEqual({ t: 'reply', seat: 0, callId: 'x-scry-2', result: { ordered: ['t1', 't0', 't2'], rememberDecision: false } });
	});

	it("a reply that did not order the top takes Forge's own order; one card left on top expects no second question", () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: bottomAsk('x-scry-3', [710, 711, 712]) });
		h.match.fromClient(0, orderReply('x-scry-3', { ordered: [], rememberDecision: false }));
		h.host.push({ t: 'frame', seat: 0, frame: topAsk('x-scry-4', [710, 711, 712]) });
		expect(h.host.commands[1]).toEqual({ t: 'reply', seat: 0, callId: 'x-scry-4', result: { ordered: ['t0', 't1', 't2'], rememberDecision: false } });

		h.host.push({ t: 'frame', seat: 0, frame: bottomAsk('x-scry-5', [720, 721]) });
		h.match.fromClient(0, orderReply('x-scry-5', { ordered: ['b0'], rememberDecision: false, rest: ['b1'] }));
		// Nothing is waiting: the next order is a question of its own and reaches the seat.
		h.host.push({ t: 'frame', seat: 0, frame: topAsk('x-other', [721, 730]) });
		expect(shown(h, 'x-other')).toHaveLength(1);
	});

	it('a surveil is the same prompt with the graveyard for the bottom; any other `many` of cards is left alone', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: bottomAsk('x-surveil', [740, 741], 'Cards to put in the graveyard') });
		expect(shown(h, 'x-surveil')[0]?.envelope.frame).toMatchObject({ rest: 'Cards on top', top: 'Cards in graveyard' });
		h.host.push({ t: 'frame', seat: 0, frame: bottomAsk('x-exile', [750, 751], 'Cards to exile') });
		expect(shown(h, 'x-exile')[0]?.envelope.frame).not.toHaveProperty('rest');
	});
});

describe('cards entering the battlefield together, every one the same card, are not a question', () => {
	/** `orderMoveToZoneList`'s battlefield ask as the bridge sends it (Splendid Reclamation returning six Mountains). */
	const entryAsk = (callId: string, names: string[], title = 'Choose order of cards to put onto the battlefield') => ({
		kind: 'ask' as const,
		callId,
		method: 'order' as const,
		title,
		top: 'Put first',
		remainingObjectsMin: 0,
		remainingObjectsMax: 0,
		sourceChoices: names.map((name, i) => ({ key: `s${i}`, label: `${name} (${128 + i})`, ref: { kind: 'card' as const, id: 128 + i } })),
		destChoices: [],
		referenceCard: null,
		sideboardingMode: false,
		showRememberCheckbox: false,
	});
	const shown = (h: Harness, callId: string) =>
		h.sent.filter((s) => s.seat === 0 && s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === callId);
	const MOUNTAINS = Array.from({ length: 6 }, () => 'Mountain');

	it("six Mountains: Forge's own order, logged, never shown", () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: entryAsk('x-entry-1', MOUNTAINS) });
		expect(shown(h, 'x-entry-1')).toEqual([]);
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-entry-1', result: { ordered: ['s0', 's1', 's2', 's3', 's4', 's5'], rememberDecision: false } }]);
		expect(h.logs.find((l) => l.evt === 'ask-auto-answered' && l.callId === 'x-entry-1')).toMatchObject({ method: 'order', why: 'every card the same' });
	});

	it('two different cards, a library order of the same card, and full control are still asked', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: entryAsk('x-entry-2', ['Mountain', 'Forest', 'Mountain']) });
		h.host.push({ t: 'frame', seat: 0, frame: entryAsk('x-library', ['Island', 'Island'], 'Choose order of cards to put into the library') });
		h.match.setFullControl(0, true);
		h.host.push({ t: 'frame', seat: 0, frame: entryAsk('x-entry-3', MOUNTAINS) });
		for (const callId of ['x-entry-2', 'x-library', 'x-entry-3']) expect(shown(h, callId), callId).toHaveLength(1);
		expect(h.host.commands.filter((c) => c.t === 'reply')).toEqual([]);
	});
});

describe("a modal spell's modes are one prompt", () => {
	const MODES = ['Counter target spell.', "Return target permanent to its owner's hand.", 'Tap all creatures your opponents control.', 'Draw a card.'];
	const message = 'Alice activated Cryptic Command - Choose a mode';
	/** Forge's mode question over `labels`, `modes` set on the first one the way the bridge sets it. */
	const modeAsk = (callId: string, labels: string[], o: { min?: number; modes?: { min: number; max: number } } = {}) => ({
		kind: 'ask' as const,
		callId,
		method: 'getChoices' as const,
		message,
		min: o.min ?? 1,
		max: 1,
		choices: labels.map((label, i) => ({ key: `c${i}`, label, ref: { kind: 'spellAbility' as const, id: 741 + MODES.indexOf(label) } })),
		selected: [],
		...(o.modes === undefined ? {} : { modes: { ...o.modes, card: { kind: 'card' as const, id: 17 } } }),
	});
	const shown = (h: Harness, callId: string) =>
		h.sent.filter((s) => s.seat === 0 && s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === callId);
	const reply = (callId: string, result: string[]) => ClientFrameSchema.parse({ kind: 'reply', callId, method: 'getChoices', result });

	it('"choose two" is one question picking two; Forge gets the first, then the second from the same reply, never asked again', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-1', MODES, { modes: { min: 2, max: 2 } }) });
		expect(shown(h, 'x-mode-1')[0]?.envelope.frame).toMatchObject({ method: 'getChoices', min: 2, max: 2, modes: { min: 2, max: 2, card: { id: 17 } } });

		expect(h.match.fromClient(0, reply('x-mode-1', ['c0', 'c3']))).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'reply', seat: 0, callId: 'x-mode-1', result: ['c0'] }]);

		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-2', MODES.slice(1)) });
		expect(shown(h, 'x-mode-2')).toEqual([]);
		expect(h.host.commands[1]).toEqual({ t: 'reply', seat: 0, callId: 'x-mode-2', result: ['c2'] });
	});

	it('"choose one or more": fewer picks than the most allowed stop Forge at its optional question', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-3', MODES, { modes: { min: 1, max: 4 } }) });
		expect(shown(h, 'x-mode-3')[0]?.envelope.frame).toMatchObject({ min: 1, max: 4 });
		h.match.fromClient(0, reply('x-mode-3', ['c1']));
		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-4', [MODES[0]!, MODES[2]!, MODES[3]!], { min: 0 }) });
		expect(shown(h, 'x-mode-4')).toEqual([]);
		expect(h.host.commands[1]).toEqual({ t: 'reply', seat: 0, callId: 'x-mode-4', result: [] });
	});

	it('a later question without the mode next in line reaches the seat; a one-mode spell is left alone', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-5', MODES, { modes: { min: 2, max: 2 } }) });
		h.match.fromClient(0, reply('x-mode-5', ['c0', 'c3']));
		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-6', [MODES[1]!, MODES[2]!]) });
		expect(shown(h, 'x-mode-6')).toHaveLength(1);

		h.host.push({ t: 'frame', seat: 0, frame: modeAsk('x-mode-7', MODES) });
		expect(shown(h, 'x-mode-7')[0]?.envelope.frame).toMatchObject({ min: 1, max: 1 });
	});
});

/**
 * The two records that answer "X wasn't clickable" from the match log: what Forge offered at each
 * window the seat was shown (`offered`, only when it changed), and what came of each card click
 * (`click`, ended by the act watch's own events).
 */
describe('telemetry (offered, click)', () => {
	const PRIORITY_MAIN = 'Priority: Seat 1\nTurn: 1 (Seat 1)\nPhase: Main phase, precombat\nStack: Empty';
	const frameLine = (seat: number, frame: Record<string, unknown>): BridgeLine => ({ t: 'frame', seat, frame }) as BridgeLine;
	const priorityWindow = (cards: number[]): BridgeLine[] => [
		frameLine(0, { kind: 'notify', method: 'setWeaklySelectable', cards: cards.map((id) => ({ kind: 'card', id })) }),
		frameLine(0, { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: PRIORITY_MAIN, card: null }),
		frameLine(0, { kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2: 'End Turn', enable1: true, enable2: true, focus1: true }),
	];
	const offered = (h: Harness) => h.logs.filter((l) => l.evt === 'offered');
	const clicks = (h: Harness) => h.logs.filter((l) => l.evt === 'click');
	const click = (card: number) => ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: card }, otherCardViewsToSelect: [], triggerEvent: null });

	it('logs the offered cards of a forwarded priority window, sorted, and again only when the set changes', () => {
		const h = harness();
		h.host.push(...OPENING);
		const before = offered(h).length;
		h.host.push(...priorityWindow([7, 3]));
		expect(offered(h).slice(before)).toEqual([{ evt: 'offered', matchId: h.match.id, seat: 0, kind: 'priority', cards: [3, 7] }]);
		h.host.push(...priorityWindow([3, 7]));
		expect(offered(h).slice(before)).toHaveLength(1);
		h.host.push(...priorityWindow([3]));
		expect(offered(h).slice(before).map((l) => l.cards)).toEqual([[3, 7], [3]]);
	});

	it('a click Forge answers is logged with the frame that answered it and how long it took', () => {
		const h = harness();
		h.host.push(...OPENING);
		h.match.fromClient(0, click(42));
		expect(clicks(h)).toEqual([]);
		h.host.push(frameLine(1, { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 1 }, message: PRIORITY_MAIN, card: null }));
		expect(clicks(h)).toEqual([]);
		h.host.push(frameLine(0, { kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message: 'Pay Mana Cost: {2}', card: null }));
		expect(clicks(h)).toEqual([expect.objectContaining({ seat: 0, card: 42, outcome: 'answered', by: 'showPromptMessage', ms: expect.any(Number) })]);
	});

	it('a click nothing answers is logged when the act watch runs out, and one followed by another act as `next-act`', () => {
		vi.useFakeTimers();
		const h = harness();
		h.host.push(...OPENING);
		h.match.fromClient(0, click(42));
		h.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
		expect(clicks(h)).toEqual([expect.objectContaining({ card: 42, outcome: 'next-act' })]);
		h.match.fromClient(0, click(43));
		vi.advanceTimersByTime(ACT_SILENCE_MS);
		expect(clicks(h)).toEqual([expect.objectContaining({ card: 42, outcome: 'next-act' }), expect.objectContaining({ card: 43, outcome: 'silence', ms: ACT_SILENCE_MS })]);
		vi.useRealTimers();
	});
});
