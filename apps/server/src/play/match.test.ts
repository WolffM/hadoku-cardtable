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

import type { BridgeLine } from './host.js';
import { MATCH_ENDED_TITLE, createMatchRegistry, type Match } from './match.js';
import { MatchSnapshotSchema, ServerEnvelopeSchema, type ServerEnvelope } from './transport.js';
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
