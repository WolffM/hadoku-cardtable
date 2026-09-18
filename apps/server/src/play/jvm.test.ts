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
 *   with `CARDTABLE_PLAY_SEED=<that seed>`.
 *
 * The seed fixes Forge's shuffles, the coin toss and the precon pick
 * (`PlayBridge.seed`). The AI and thread timing are not seeded, so a seed
 * narrows a failure down rather than guaranteeing a replay. A red run with
 * `CARDTABLE_PLAY_DUMP=<dir>` keeps every raw line and every envelope there.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type MatchSpec } from './host.js';
import { createMatchRegistry, type Match } from './match.js';
import type { ServerEnvelope } from './transport.js';
import { leaked, rawStatesOf, secretsFor } from './fixtures/transcript.js';

const available = jvmHostConfig();
const title = available.ok ? 'a real Forge match in a child JVM' : `a real Forge match in a child JVM — SKIPPED: ${available.reason}`;

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function precon(name: string): string {
	if (!available.ok) throw new Error('unreachable');
	return readFileSync(join(available.config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
}

describe.skipIf(!available.ok)(title, () => {
	const matches: Match[] = [];

	afterAll(async () => {
		for (const m of matches) m.stop();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 15_000);
		expect(liveJvmCount()).toBe(0);
	});

	const variety = Number(process.env.CARDTABLE_PLAY_SEED ?? Date.now() % 1_000_000_007);
	const runs: [string, () => MatchSpec][] = [
		[
			'fixed: Spirit Flames v Decay, seed 20260918',
			() => ({
				seed: 20260918,
				seats: [
					{ name: 'Seat 1', ai: false, deck: precon('Spirit Flames') },
					{ name: 'Seat 2', ai: false, deck: precon('Decay') },
				],
			}),
		],
		[
			`variety: random precons, seed ${variety}`,
			() => ({
				seed: variety,
				seats: [
					{ name: 'Seat 1', ai: false, deck: null },
					{ name: 'Seat 2', ai: false, deck: null },
				],
			}),
		],
	];

	it.each(runs)(
		'%s — starts, opens both seats, projects per seat, answers a real ask, moves on an act',
		async (label, spec) => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config);
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
				`[jvm] ${label}: running after ${Date.now() - started} ms (Forge boot ${ready.bootMs} ms); decks: ${ready.seats.map((s) => s.deck).join(' v ')}`,
			);
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
			for (let i = 0; i < 3; i++) {
				for (const seat of [0, 1]) match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
				await new Promise((r) => setTimeout(r, 1500));
			}
			await waitUntil(
				() => sent.slice(before).some((s) => s.envelope.frame.method === 'showPromptMessage' && /Turn: 1/.test(JSON.stringify(s.envelope.frame))),
				'turn 1',
				30_000,
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
				expect(secrets.size).toBeGreaterThan(0);
				expect(leaked(secrets, rawText).length).toBe(secrets.size);
				expect(leaked(secrets, emitted)).toEqual([]);
			}
			match.stop();
			await waitUntil(() => liveJvmCount() === 0, 'this match\'s JVM to exit', 15_000);
		},
		240_000,
	);
});
