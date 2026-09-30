/**
 * Item 1 — the mulligan's dead hand, driven against a REAL Forge match.
 *
 * `docs/planning/wave30-evidence/item1-mulligan-diagnosis.md` has the full
 * diagnosis: the operator's dead hand ("the only button I can press is Auto")
 * traces to a missing `Mulligan` key on the Game object the London step reads.
 * `apps/ui/src/play/live/match.ts`'s `mulliganHand` only offers the hand when
 * `readGameBool(state, 'Mulligan')` is true, and the diagnosis doc's probe
 * (`mulligan-probe.jvm.test.ts.txt`, run against real Forge, seed 7,
 * Mountain/Memnite decks) printed the Game object's own keys at the London
 * step and `Mulligan` was not among them.
 *
 * `apps/ui/src/play/live/match.ts` is lane A's file, not this lane's, so this
 * test does not drive it. It drives the same real match the probe did, through
 * this lane's own server primitives (`host.ts`, `match.ts`, `visibility.ts` —
 * the same ones `jvm.test.ts` and `auto.jvm.test.ts` use), reaches the same
 * London step, and asserts directly on the Game object the bridge's delta
 * carries — the first place the diagnosis doc says to look. That is the
 * server-side half of the same fact the probe measured: if `Mulligan` is
 * missing HERE, in the raw per-seat state this lane projects, nothing
 * downstream (the client fold, `mulliganHand`) can recover it.
 *
 * Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/mulligan.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 *
 * Budget: this reproduction is run at most three times (wave 30 §B brief).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine } from './host.js';
import { createMatchRegistry } from './match.js';
import { foldFrames, TYPE, type StateFrame, type WireObj } from './visibility.js';
import type { ServerEnvelope } from './transport.js';

const available = jvmHostConfig();
const title = available.ok
	? 'the London mulligan step, against real Forge'
	: `the London mulligan step, against real Forge — SKIPPED: ${available.reason}`;

function deck(name: string, lines: readonly string[]): string {
	return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'carries the Mulligan flag on the Game object once London asks a seat to bottom cards',
		async () => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });

			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, { ...events, line: (l) => { raw.push(l); events.line(l); } }),
				log: (e) => logs.push(e),
				askTimeoutMs: 120_000,
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
			});

			// Same deal as the diagnosis probe: seed 7, two flood decks, no removal
			// logic to fight through before a keep/mulligan decision is offered.
			const match = registry.create({
				seed: 7,
				seats: [
					{ name: 'A', ai: false, deck: deck('M A', ['30 Mountain', '30 Memnite']) },
					{ name: 'B', ai: false, deck: deck('M B', ['30 Mountain', '30 Memnite']) },
				],
			});
			expect(await match.whenRunning(120_000)).toEqual({ ok: true });

			function stateOf(seat: number): Map<string, WireObj> {
				return foldFrames(
					sent
						.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
			}

			function lastPromptOf(seat: number): { message: string } | null {
				const f = [...sent].reverse().find((s) => s.seat === seat && s.envelope.frame.method === 'showPromptMessage')?.envelope.frame as
					| { message: string }
					| undefined;
				return f ?? null;
			}

			function lastButtonsOf(seat: number): { label1: string; label2: string; enable1: boolean; enable2: boolean } | null {
				const f = [...sent].reverse().find((s) => s.seat === seat && s.envelope.frame.method === 'updateButtons')?.envelope.frame as
					| { label1: string; label2: string; enable1: boolean; enable2: boolean }
					| undefined;
				return f ?? null;
			}

			// Drive exactly what the diagnosis probe drove: answer whatever bar shows
			// up, preferring "mulligan" whenever the keep/mulligan prompt offers it,
			// so a seat actually reaches the London bottom-the-cards step.
			const seen = new Set<string>();
			let london: { seat: number; message: string } | null = null;
			const deadline = Date.now() + 45_000;
			while (Date.now() < deadline && london === null) {
				for (const seat of [0, 1] as const) {
					const prompt = lastPromptOf(seat);
					const msg = prompt?.message ?? '';
					const key = `${String(seat)}|${msg}`;
					if (msg === '' || seen.has(key)) continue;
					seen.add(key);
					const buttons = lastButtonsOf(seat);
					if (/bottom of your library/i.test(msg)) {
						london = { seat, message: msg };
						break;
					} else if (/keep your hand|mulligan/i.test(msg) && buttons?.enable2 === true) {
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' }));
					} else if (buttons?.enable1 === true) {
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
					}
				}
				if (london !== null) break;
				await new Promise((r) => setTimeout(r, 200));
			}

			// Forge's delta sync and its prompt/button notifies are separate calls;
			// give a trailing delta describing this step a few more macrotasks to
			// arrive before reading state, so a real lag is not mistaken for an
			// absent flag.
			await new Promise((r) => setTimeout(r, 3_000));

			const dumpDir = process.env.CARDTABLE_PLAY_DUMP;
			if (dumpDir !== undefined) {
				mkdirSync(dumpDir, { recursive: true });
				writeFileSync(
					join(dumpDir, `mulligan-${Date.now()}.json`),
					JSON.stringify({ london, raw, sent: sent.map((s) => ({ seat: s.seat, envelope: s.envelope })) }, null, 2),
				);
			}

			expect(london, `never reached the London step within 45s; seen prompts: ${JSON.stringify([...seen])}`).not.toBeNull();

			const state = stateOf(london!.seat);
			const gameObj = [...state.values()].find((o) => o._type === TYPE.game);
			expect(gameObj, 'no Game object in this seat\'s projected state').toBeDefined();

			// THE ASSERTION: the flag `mulliganHand` gates on, on the wire this lane
			// sends. Fails against today's code (the key is absent); the fix under
			// this item must make it present and true at this step.
			expect(Object.keys(gameObj!)).toContain('Mulligan');
			const mulligan = (gameObj as unknown as Record<string, { t?: string; v?: unknown }>)['Mulligan'];
			expect(mulligan).toEqual({ t: 'bool', v: true });

			match.stop();
			jvm.close();
			await waitUntil(() => liveJvmCount() === 0, 'this match\'s JVM to exit', 15_000);
		},
		240_000,
	);
});
