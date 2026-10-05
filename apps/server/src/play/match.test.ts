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
import { ClientFrameSchema, safeParseServerFrame, type ClientFrame } from '@hadoku/forge-wire';

import type { BridgeCommand, BridgeLine, HostEvents, JvmRecord, MatchHost, MatchHostFactory } from './host.js';
import { MATCH_ENDED_TITLE, createMatchRegistry, type Match, type MatchSpecWithIdentity } from './match.js';
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

function harness(askTimeoutMs = 60_000, disconnectGraceMs?: number): Harness {
	const { factory, hosts } = replayFactory();
	const sent: Harness['sent'] = [];
	const logs: Record<string, unknown>[] = [];
	const registry = createMatchRegistry({
		host: factory,
		log: (e) => logs.push(e),
		askTimeoutMs,
		overGraceMs: 60_000,
		disconnectGraceMs,
		emit: (_match, seat, envelope) => sent.push({ seat, envelope }),
	});
	const match = registry.create({ seats: [{ ...TWO_HUMANS.seats[0] }, { ...TWO_HUMANS.seats[1] }] });
	return { match, host: hosts[0] as ReplayHost, sent, logs };
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
			askTimeoutMs: 60_000,
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
		expect(match.seatIdentities()).toEqual([
			{ seat: 0, claimed: true, playerId: 0, avatarId: 'wanderer' },
			{ seat: 1, claimed: false, playerId: 1, avatarId: 'herald' },
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
			askTimeoutMs: 60_000,
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
		const expected = TRANSCRIPT.filter((l) => l.t === 'frame').map((l) => (l as { seat: number }).seat);
		// Each bridge frame becomes exactly one emit, to the same seat, except
		// early state frames, which are re-ordered behind openView — not re-routed.
		expect(h.sent.map((s) => s.seat).sort()).toEqual([...expected].sort());
		for (const seat of [0, 1]) {
			const bridgeMethods = TRANSCRIPT.filter((l) => l.t === 'frame' && l.seat === seat)
				.map((l) => (l as { frame: { method: string } }).frame.method)
				.sort();
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
	function opened(askTimeoutMs = 60_000): Harness & { callId: string } {
		const h = harness(askTimeoutMs);
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

	it("aborts it as 'disconnected' when the seat's last connection goes", () => {
		const h = opened();
		h.match.seatDisconnected(0);
		expect(h.host.commands).toEqual([{ t: 'abort', seat: 0, callId: h.callId, reason: 'disconnected' }]);
		expect(h.match.fromClient(0, reply(h.callId, true))).toEqual({ ok: false, error: 'stale-reply' });
	});

	it("aborts it as 'timeout' when nobody answers", () => {
		vi.useFakeTimers();
		const h = opened(5000);
		vi.advanceTimersByTime(4999);
		expect(h.host.commands).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(h.host.commands).toEqual([{ t: 'abort', seat: 0, callId: h.callId, reason: 'timeout' }]);
	});

	it("passes the browser's own abort through", () => {
		const h = opened();
		const abort = ClientFrameSchema.parse({ kind: 'abort', callId: h.callId, reason: 'unsupported' });
		expect(h.match.fromClient(0, abort)).toEqual({ ok: true });
		expect(h.host.commands).toEqual([{ t: 'abort', seat: 0, callId: h.callId, reason: 'unsupported' }]);
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
		const h = harness(10 * 60_000, GRACE);
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

	it('does not abort the open ask while the seat is gone for less than the grace', () => {
		const h = refreshing();
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(GRACE - 1);
		h.match.seatConnected(0);
		vi.advanceTimersByTime(10 * GRACE);
		expect(h.host.commands).toEqual([]);
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

	it("aborts as 'disconnected' once the seat has stayed gone for the whole grace", () => {
		const h = refreshing();
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(GRACE - 1);
		expect(h.host.commands).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(h.host.commands).toEqual([{ t: 'abort', seat: 0, callId: h.callId, reason: 'disconnected' }]);
	});

	it('a second disconnect does not restart the clock', () => {
		const h = refreshing();
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(GRACE - 10);
		h.match.seatDisconnected(0);
		vi.advanceTimersByTime(10);
		expect(h.host.commands).toEqual([{ t: 'abort', seat: 0, callId: h.callId, reason: 'disconnected' }]);
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
			askTimeoutMs: 60_000,
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
					askTimeoutMs: 60_000,
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

	it("a registry whose host cannot re-attach adopts nothing rather than pretending to", () => {
		const { factory } = replayFactory();
		const registry = createMatchRegistry({
			host: factory,
			log: () => undefined,
			askTimeoutMs: 60_000,
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
			askTimeoutMs: 60_000,
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

		// The browser dismissing it sends Forge nothing further — it was
		// already told, and a second reply for a callId it has already
		// resolved is not owed one.
		const dismiss = ClientFrameSchema.parse({ kind: 'reply', callId: 'x-reveal-1', method: 'getChoices', result: [] });
		expect(h.match.fromClient(0, dismiss)).toEqual({ ok: true });
		expect(h.host.commands).toHaveLength(1);
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
		expect(shown).toBeDefined();
		const other = h.sent.find((s) => s.envelope.frame.kind === 'ask' && (s.envelope.frame as { callId: string }).callId === 'x-other');
		expect(other).toBeDefined();
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
