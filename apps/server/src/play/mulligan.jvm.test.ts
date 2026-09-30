/**
 * Item 1 — the mulligan's dead hand, driven against a REAL Forge match.
 *
 * `docs/planning/wave30-evidence/item1-mulligan-diagnosis.md` has the original
 * diagnosis: the operator's dead hand ("the only button I can press is Auto")
 * traces to a missing `Mulligan` key on the Game object the London step reads.
 * `docs/planning/wave30-evidence/B-item1-mulligan-root-cause.md` has the root
 * cause, read from `forge/`'s real source: `InputLondonMulligan.showMessage()`
 * sets `GameView.Mulligan` correctly and then makes two `IGuiGame` calls
 * Forge's own `RemoteClientGuiGame` never syncs the trackable graph for
 * (`RemoteClientGuiGame.java:330-337` — the `card == null` fast path shared
 * with the live-game-thread auto-pass timer). `PlayBridge.java`'s
 * `SeatGui.syncMulliganFlag()` is the fix: it reads the SERVER's live
 * `GameView.isMulligan()` directly at those two calls (and at every
 * `applyDelta`) and, on a change the wire did not carry, emits a synthetic
 * one-property `applyDelta` in the exact encoding a real one would use.
 *
 * `apps/ui/src/play/live/match.ts`'s `mulliganHand` (lane A's file, not this
 * lane's) only offers the hand when `readGameBool(state, 'Mulligan')` is true;
 * this test does not drive that file. It drives the same real match the
 * diagnosis probe did, through this lane's own server primitives (`host.ts`,
 * `match.ts`, `visibility.ts` — the same ones `jvm.test.ts` and
 * `auto.jvm.test.ts` use), reaches the London step, and asserts directly on
 * the Game object the bridge's delta carries — one step upstream of
 * `mulliganHand`, on the wire this lane owns.
 *
 * Skips visibly without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/mulligan.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
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
		'carries the Mulligan flag true at the London step and false once it is answered',
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

			// The fix emits the correction synchronously with the very button/prompt
			// frames the loop above reacted to, so no extra wait should be needed —
			// this one guards against any residual macrotask lag rather than masking
			// an absent flag the way the pre-fix 3 s wait was measuring for.
			await new Promise((r) => setTimeout(r, 500));

			function gameMulligan(seat: number): { t?: string; v?: unknown } | undefined {
				const gameObj = [...stateOf(seat).values()].find((o) => o._type === TYPE.game);
				return (gameObj as unknown as Record<string, { t?: string; v?: unknown }> | undefined)?.['Mulligan'];
			}

			const dump = (tag: string): void => {
				const dumpDir = process.env.CARDTABLE_PLAY_DUMP;
				if (dumpDir === undefined) return;
				mkdirSync(dumpDir, { recursive: true });
				writeFileSync(
					join(dumpDir, `mulligan-${tag}-${Date.now()}.json`),
					JSON.stringify({ london, raw, sent: sent.map((s) => ({ seat: s.seat, envelope: s.envelope })) }, null, 2),
				);
			};
			dump('london');

			expect(london, `never reached the London step within 45s; seen prompts: ${JSON.stringify([...seen])}`).not.toBeNull();
			const seat = london!.seat;

			// THE FIRST ASSERTION: the flag `mulliganHand` gates on, on the wire this
			// lane sends, true at the moment the step is offered.
			expect(gameMulligan(seat)).toEqual({ t: 'bool', v: true });

			// Complete the step — press "Auto" (button2), exactly the one live button
			// the operator's report says was reachable — and wait for the game to move
			// past it (a new distinct prompt for this seat).
			const promptAtLondon = lastPromptOf(seat)?.message ?? '';
			match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' }));
			await waitUntil(
				() => (lastPromptOf(seat)?.message ?? '') !== '' && lastPromptOf(seat)?.message !== promptAtLondon,
				'a prompt past the London step',
				30_000,
			);
			await new Promise((r) => setTimeout(r, 500));
			dump('after');

			// THE SECOND ASSERTION: once the step is answered, Forge itself clears
			// the flag (`InputLondonMulligan.done()`) — and that clear is EVERY BIT as
			// unsynced as the set was, for the identical reason, so without the fix's
			// both-directions emission this would still read true forever.
			const after = gameMulligan(seat);
			expect(after === undefined || after.v !== true, `Mulligan still true after the London step: ${JSON.stringify(after)}`).toBe(true);

			match.stop();
			jvm.close();
			await waitUntil(() => liveJvmCount() === 0, 'this match\'s JVM to exit', 15_000);
		},
		240_000,
	);
});
