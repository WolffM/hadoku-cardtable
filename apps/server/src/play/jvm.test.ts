/**
 * A real Forge match, in a real JVM, through the real bridge.
 *
 * CI has no Java and no `forge/`, so this suite SKIPS unless the Forge build is
 * configured — and says so in the suite's name, with the exact reason, rather
 * than passing silently. To run it:
 *
 *   CARDTABLE_FORGE_JAR=~/.cache/cardtable-w8/forge-build/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar \
 *   CARDTABLE_FORGE_RES=~/.cache/cardtable-w8/forge-build/forge-gui/res \
 *   pnpm exec vitest run apps/server/src/play/jvm.test.ts
 *
 * What it proves that the replayed transcript cannot: that the bridge still
 * starts a match against the Forge build on this machine, that every frame it
 * produces today parses as forge-wire, that a browser's answer to a real
 * server-side `showConfirmDialog` reaches Forge's `sendAndWait` and comes back
 * as the return value, that an act moves the game on, and that the JVM is gone
 * afterwards.
 *
 * ## Two runs, both repeatable
 *
 * - **Fixed:** "Spirit Flames" v "Decay" — the two precons of the red run the
 *   manager hit (`fixtures/bridge-flying-seat1.ndjson`) — with a fixed seed.
 * - **Variety:** random precons from a seed printed in the log; rerun a red one
 *   with `CARDTABLE_PLAY_SEED=<that seed>`. This one is started **through the
 *   warm spare** (Wave 10), so the leak check covers both ways a match reaches
 *   its JVM.
 *
 * A third test (Wave 10) runs a refresh and a crash against a real JVM: the
 * seat's socket goes and comes back inside the grace while a real
 * `showConfirmDialog` is parked in Forge, and the answer given after the
 * refresh is the one Forge's `sendAndWait` returns; then the JVM is SIGKILLed
 * and both seats must be told.
 *
 * The seed fixes Forge's shuffles, the coin toss and the precon pick
 * (`PlayBridge.seed`). The AI and thread timing are not seeded, so a seed
 * narrows a failure down rather than guaranteeing a replay. A red run with
 * `CARDTABLE_PLAY_DUMP=<dir>` keeps every raw line and every envelope there.
 *
 * ## What the deal has a say in, audited (wave 21 §B)
 *
 * The variety run plays a RANDOM pair of precons on purpose, so every wait in
 * it is a place where a red could be the deal rather than the product. Audited
 * one by one, exactly one is: the wait for **turn 1** after six OKs, which only
 * arrives while nothing else is parked on an answer. That wait now prints what
 * each seat was last told and every ask that reached a browser, so the deal and
 * the product are told apart from the failure alone. The others cannot turn on
 * the deal: the ask is one this test itself sends (`match.probe`), the opening
 * prompt is Forge's coin toss, and the secrets the leak check needs are two
 * intact opening hands. Measured over three consecutive runs: turn 1 reached
 * every time, 133-204 secrets per seat, 103 board objects at the refresh.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type JvmHostFactory, type MatchSpec } from './host.js';
import { MATCH_ENDED_TITLE, createMatchRegistry, type Match } from './match.js';
import { foldFrames, type StateFrame } from './visibility.js';
import type { ServerEnvelope } from './transport.js';
import { leaked, rawStatesOf, secretsFor } from './fixtures/transcript.js';

const available = jvmHostConfig();
const title = available.ok ? 'a real Forge match in a child JVM' : `a real Forge match in a child JVM — SKIPPED: ${available.reason}`;

/**
 * `detail` is read WHEN THE WAIT FAILS, never when it is set up. The variety run
 * below plays a random pair of precons, so a wait that expires is as likely to
 * be the deal as the product — and "timed out waiting for turn 1" cannot tell
 * the two apart. Every wait whose precondition the shuffle has a say in passes
 * one (wave 21 §B).
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number, detail?: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${detail === undefined ? '' : `\n${detail()}`}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function precon(name: string): string {
	if (!available.ok) throw new Error('unreachable');
	return readFileSync(join(available.config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
}

describe.skipIf(!available.ok)(title, () => {
	const matches: Match[] = [];
	const pools: JvmHostFactory[] = [];

	afterAll(async () => {
		for (const m of matches) m.stop();
		for (const p of pools) p.close();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 15_000);
		expect(liveJvmCount()).toBe(0);
	});

	const variety = Number(process.env.CARDTABLE_PLAY_SEED ?? Date.now() % 1_000_000_007);
	const runs: [string, () => MatchSpec, boolean][] = [
		[
			'fixed: Spirit Flames v Decay, seed 20260918, cold',
			() => ({
				seed: 20260918,
				seats: [
					{ name: 'Seat 1', ai: false, deck: precon('Spirit Flames') },
					{ name: 'Seat 2', ai: false, deck: precon('Decay') },
				],
			}),
			false,
		],
		[
			`variety: random precons, seed ${variety}, through the warm spare`,
			() => ({
				seed: variety,
				seats: [
					{ name: 'Seat 1', ai: false, deck: null },
					{ name: 'Seat 2', ai: false, deck: null },
				],
			}),
			true,
		],
	];

	it.each(runs)(
		'%s — starts, opens both seats, projects per seat, answers a real ask, moves on an act',
		async (label, spec, spare) => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { spare, log: (e) => logs.push(e) });
			pools.push(jvm);
			if (spare) await waitUntil(() => jvm.spare() === 'warm', 'the spare to boot', 120_000);
			const registry = createMatchRegistry({
				host: (id, spec, events) =>
					jvm(id, spec, {
						...events,
						line: (l) => {
							raw.push(l);
							events.line(l);
						},
					}),
				log: (e) => logs.push(e),
				askTimeoutMs: 60_000,
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
			});
			const started = Date.now();
			const match = registry.create(spec());
			matches.push(match);
			const running = await match.whenRunning(120_000);
			expect(running).toEqual({ ok: true });
			const ready = raw.find((l) => l.t === 'ready') as Extract<BridgeLine, { t: 'ready' }>;
			console.log(
				`[jvm] ${label}: running after ${Date.now() - started} ms (JVM up ${ready.bootMs} ms, match start ${ready.startMs} ms); decks: ${ready.seats.map((s) => s.deck).join(' v ')}`,
			);
			expect(logs.some((l) => l.evt === 'spare-adopted')).toBe(spare);
			expect(match.seats.map((s) => s.playerId).sort()).toEqual([0, 1]);

			// Forge opens with the coin toss: one seat is asked play-or-draw.
			await waitUntil(
				() => [0, 1].every((seat) => sent.some((s) => s.seat === seat && s.envelope.frame.method === 'updateButtons')),
				'a prompt for each seat',
				30_000,
			);

			// A real showConfirmDialog from Forge's server side, answered by "the browser".
			const probe = match.probe(0, 'jvm.test: answer yes', 30_000);
			await waitUntil(() => sent.some((s) => s.seat === 0 && s.envelope.frame.kind === 'ask'), 'the ask', 30_000);
			const ask = sent.find((s) => s.seat === 0 && s.envelope.frame.kind === 'ask')?.envelope.frame as { callId: string };
			const reply = ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'showConfirmDialog', result: true });
			expect(match.fromClient(0, reply)).toEqual({ ok: true });
			const result = await probe;
			console.log(`[jvm] probe: ${JSON.stringify(result)}`);
			// The probe's default is NO, so a yes can only have come from the reply.
			expect(result.answer).toBe(true);

			// Acts move the game: OK from both seats plays first and keeps both hands.
			const before = sent.length;
			const acts = { sent: 0 };
			for (let i = 0; i < 3; i++) {
				for (const seat of [0, 1]) {
					match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
					acts.sent += 1;
				}
				await new Promise((r) => setTimeout(r, 1500));
			}
			/*
			 * The one precondition in this test that the DEAL has a say in: six OKs
			 * reach turn 1 only while nothing else is waiting for an answer. An
			 * unanswered ask (this test answers only the probe) parks Forge's thread
			 * and no number of OKs moves it — so if this expires, what each seat was
			 * last told and every ask still open is the answer, and it is printed.
			 */
			const lastPrompt = (seat: number): string =>
				JSON.stringify(
					[...sent].reverse().find((s) => s.seat === seat && s.envelope.frame.method === 'showPromptMessage')?.envelope.frame ?? null,
				);
			const openAsks = (): string =>
				JSON.stringify(sent.filter((s) => s.envelope.frame.kind === 'ask').map((s) => ({ seat: s.seat, method: s.envelope.frame.method })));
			await waitUntil(
				() => sent.slice(before).some((s) => s.envelope.frame.method === 'showPromptMessage' && /Turn: 1/.test(JSON.stringify(s.envelope.frame))),
				'turn 1',
				30_000,
				() =>
					`${acts.sent} OKs sent and turn 1 never arrived. This is the deal or the product, and the difference is here:\n` +
					`seat 0 last told ${lastPrompt(0)}\nseat 1 last told ${lastPrompt(1)}\nasks that reached a browser: ${openAsks()}`,
			);

			expect(match.invalidFrames).toBe(0);
			for (const seat of [0, 1]) {
				const { secrets } = secretsFor(rawStatesOf(raw, seat), seat);
				const rawText = raw.filter((l) => l.t === 'frame' && l.seat === seat).map((l) => JSON.stringify(l)).join('\n');
				const emitted = sent.filter((s) => s.seat === seat).map((s) => JSON.stringify(s.envelope)).join('\n');
				console.log(
					`[jvm] seat ${seat}: ${sent.filter((s) => s.seat === seat).length} envelopes, ${secrets.size} secrets, ` +
						`${leaked(secrets, rawText).length} in Forge's raw stream, ${leaked(secrets, emitted).length} in what was emitted`,
				);
				const dumpDir = process.env.CARDTABLE_PLAY_DUMP;
				if (dumpDir !== undefined && leaked(secrets, emitted).length > 0) {
					// A red run is kept whole, so it can be diagnosed from data.
					mkdirSync(dumpDir, { recursive: true });
					writeFileSync(join(dumpDir, `leak-seat${seat}-${Date.now()}.json`), JSON.stringify({ label, seat, leaked: leaked(secrets, emitted), raw, sent }));
				}
				/*
				 * Non-vacuity: the leak check had something to look for. It cannot
				 * fail on the deal HERE, unlike `prompts.jvm.test.ts` where a hand
				 * played out to nothing legitimately left 0 secrets (wave 20,
				 * `341e51d`) — this run stops at turn 1 with both opening hands
				 * intact, so every deal has ~130-200 hidden card names in it. Three
				 * consecutive runs measured 133-204 per seat.
				 */
				expect(secrets.size).toBeGreaterThan(0);
				expect(leaked(secrets, rawText).length).toBe(secrets.size);
				expect(leaked(secrets, emitted)).toEqual([]);
			}
			match.stop();
			jvm.close();
			await waitUntil(() => liveJvmCount() === 0, 'this match\'s JVM (and any spare) to exit', 15_000);
		},
		240_000,
	);

	it('refresh, then crash: an ask parked in Forge survives the seat going and coming back; a SIGKILLed JVM tells both seats', async () => {
		if (!available.ok) return;
		const sent: { seat: number; envelope: ServerEnvelope }[] = [];
		const logs: Record<string, unknown>[] = [];
		const jvm = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });
		pools.push(jvm);
		const registry = createMatchRegistry({
			host: jvm,
			log: (e) => logs.push(e),
			askTimeoutMs: 60_000,
			overGraceMs: 60_000,
			disconnectGraceMs: 30_000,
			emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
		});
		const match = registry.create({
			seed: 20260918,
			seats: [
				{ name: 'Seat 1', ai: false, deck: precon('Spirit Flames') },
				{ name: 'Seat 2', ai: false, deck: precon('Decay') },
			],
		});
		matches.push(match);
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });
		// Let the opening land — hands dealt, the coin toss asked — so the board compared below is a real one.
		await waitUntil(
			() => [0, 1].every((seat) => sent.some((s) => s.seat === seat && s.envelope.frame.method === 'updateButtons')),
			'a prompt for each seat',
			30_000,
		);

		// Refresh. A real showConfirmDialog is parked in Forge's sendAndWait; its
		// default is NO, so a `true` can only be the answer given after the refresh.
		const probe = match.probe(0, 'jvm.test: answer after the refresh', 60_000);
		const isAsk = (s: { seat: number; envelope: ServerEnvelope }): boolean => s.seat === 0 && s.envelope.frame.kind === 'ask';
		await waitUntil(() => sent.some(isAsk), 'the ask', 30_000);
		const callId = (sent.find(isAsk)?.envelope.frame as { callId: string }).callId;
		const stateOf = (frames: readonly unknown[]): Map<string, unknown> =>
			foldFrames(
				(frames as ServerEnvelope['frame'][]).filter((f) => ['setGameView', 'openView', 'applyDelta'].includes(f.method)) as unknown as StateFrame[],
			);
		const boardBefore = stateOf(sent.filter((s) => s.seat === 0).map((s) => s.envelope.frame));
		expect(boardBefore.size).toBeGreaterThan(20);
		match.seatDisconnected(0);
		await new Promise((r) => setTimeout(r, 1500));
		match.seatConnected(0);
		const snap = match.snapshot(0);
		if (!('frames' in snap)) throw new Error(`expected a snapshot, got ${JSON.stringify(snap)}`);
		expect(stateOf(snap.frames)).toEqual(boardBefore);
		const mark = sent.length;
		match.resendAfterSnapshot(0);
		expect(sent.slice(mark).some((s) => isAsk(s) && (s.envelope.frame as { callId: string }).callId === callId)).toBe(true);
		expect(match.fromClient(0, ClientFrameSchema.parse({ kind: 'reply', callId, method: 'showConfirmDialog', result: true }))).toEqual({ ok: true });
		const answered = await probe;
		console.log(`[jvm] refresh: seat 0 away 1500 ms with the ask open; board ${stateOf(snap.frames).size} objects, equal; Forge got ${JSON.stringify(answered)}`);
		expect(answered.answer).toBe(true);

		// Crash.
		const pid = logs.find((l) => l.evt === 'jvm-spawned')?.pid as number;
		const killedAt = Date.now();
		process.kill(pid, 'SIGKILL');
		const told = (seat: number): boolean =>
			sent.some((s) => s.seat === seat && s.envelope.frame.method === 'showErrorDialog' && (s.envelope.frame as { title: string }).title === MATCH_ENDED_TITLE);
		await waitUntil(() => told(0) && told(1), 'both seats to be told', 10_000);
		console.log(`[jvm] crash: SIGKILL pid ${pid} → match ${match.status}, both seats told in ${Date.now() - killedAt} ms; failure: ${match.failure}`);
		expect(match.status).toBe('failed');
		expect(match.failure).toMatch(/signal SIGKILL/);
		expect(liveJvmCount()).toBe(0);
		jvm.close();
	}, 240_000);
});
