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
import { foldFrames, keyOf, TYPE, type StateFrame, type WireObj } from './visibility.js';
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

			// London order (wave 31, P7): every seat is asked keep-or-mulligan on the
			// full new hand, and the cards go back only after Keep. Seat 0 mulligans
			// once and then keeps, which is what puts the bottom-the-cards step on
			// the wire. Keyed by the prompt frame's position, not its text, because
			// the same keep question is legitimately asked twice.
			const handled = new Set<number>();
			const mulliganed = new Set<number>();
			let london: { seat: number; message: string } | null = null;
			const seen = new Set<string>();
			const deadline = Date.now() + 45_000;
			while (Date.now() < deadline && london === null) {
				for (const seat of [0, 1] as const) {
					const at = sent.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1)).filter((i) => i >= 0).pop();
					if (at === undefined || handled.has(at)) continue;
					handled.add(at);
					const msg = (sent[at]!.envelope.frame as unknown as { message: string }).message;
					seen.add(`${String(seat)}|${msg}`);
					const buttons = lastButtonsOf(seat);
					if (/bottom of your library/i.test(msg)) {
						london = { seat, message: msg };
						break;
					} else if (/keep your hand/i.test(msg) && seat === 0 && !mulliganed.has(seat) && buttons?.enable2 === true) {
						mulliganed.add(seat);
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' }));
					} else if (buttons?.enable1 === true) {
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
					}
				}
				if (london !== null) break;
				await new Promise((r) => setTimeout(r, 50));
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
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, 'this match\'s JVM to exit', 15_000);
		},
		240_000,
	);
	it(
		'asks keep-or-mulligan on the full new hand and puts the card back only after Keep',
		async () => {
			if (!available.ok) return;
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });
			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, events),
				log: (e) => logs.push(e),
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
			});
			const match = registry.create({
				seed: 7,
				seats: [
					{ name: 'A', ai: false, deck: deck('M A', ['30 Mountain', '30 Memnite']) },
					{ name: 'B', ai: false, deck: deck('M B', ['30 Mountain', '30 Memnite']) },
				],
			});
			expect(await match.whenRunning(120_000)).toEqual({ ok: true });

			function handSize(seat: number, upTo: number): number {
				const state = foldFrames(
					sent
						.slice(0, upTo + 1)
						.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
				const player = state.get(keyOf(TYPE.player, match.seats[seat]!.playerId ?? -1)) as unknown as Record<string, { v?: unknown[] }> | undefined;
				return player?.['Hand']?.v?.length ?? -1;
			}

			function libraryOf(viewer: number, owner: number, upTo: number): number[] {
				const state = foldFrames(
					sent
						.slice(0, upTo + 1)
						.filter((x) => x.seat === viewer && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
				const player = state.get(keyOf(TYPE.player, match.seats[owner]!.playerId ?? -1)) as unknown as Record<string, { v?: { v: number }[] }> | undefined;
				return (player?.['Library']?.v ?? []).map((id) => id.v);
			}

			/** Seat 0 mulligans once, then keeps; seat 1 keeps. Every prompt either seat sees is recorded in order. */
			const sequence: string[] = [];
			const buttons = [{ enable1: false, enable2: false }, { enable1: false, enable2: false }];
			const changed = [true, true];
			const returned = [false, false];
			let cursor = 0;
			let mulligansTaken = 0;
			const deadline = Date.now() + 60_000;
			let done = false;
			while (!done && Date.now() < deadline) {
				for (; cursor < sent.length; cursor++) {
					const { seat, envelope } = sent[cursor]!;
					const f = envelope.frame as unknown as Record<string, unknown>;
					if (f.method === 'applyDelta') changed[seat] = true;
					if (f.method === 'updateButtons') {
						buttons[seat] = { enable1: f.enable1 === true, enable2: f.enable2 === true };
						continue;
					}
					if (f.method !== 'showPromptMessage') continue;
					const msg = String(f.message);
					// Forge re-sends a prompt frame while it waits, so one is recorded only if
					// the seat's state changed since the last one it recorded (a mulligan
					// changes the hand); the return step happens once per seat.
					if (/keep your hand/i.test(msg)) {
						if (!changed[seat]) continue;
						changed[seat] = false;
						sequence.push(`seat${String(seat)} keep? (${String(handSize(seat, cursor))} cards)`);
						if (seat === 0 && mulligansTaken === 0) {
							mulligansTaken++;
							match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' }));
						} else {
							match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
						}
					} else if (/bottom of your library/i.test(msg)) {
						if (returned[seat]) continue;
						returned[seat] = true;
						sequence.push(`seat${String(seat)} return (${String(handSize(seat, cursor))} cards): ${msg.replace(/\s+/g, ' ')}`);
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' }));
					} else if (!done && !/^Waiting for/.test(msg)) {
						// The coin toss and anything else with a live OK: answer it, record what follows the return.
						if (seat === 0 && sequence.some((x) => x.startsWith('seat0 return'))) {
							sequence.push(`seat0 after: ${msg.split('\n')[0]}`);
							done = true;
						} else if (buttons[seat]!.enable1) {
							match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
						}
					}
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			await new Promise((r) => setTimeout(r, 1000));
			console.log(`[mulligan-sequence] ${JSON.stringify(sequence, null, 1)}`);

			const seat0 = sequence.filter((x) => x.startsWith('seat0'));
			expect(seat0.map((x) => x.replace(/:.*$/, ''))).toEqual([
				'seat0 keep? (7 cards)',
				'seat0 keep? (7 cards)',
				'seat0 return (7 cards)',
				'seat0 after',
			]);

			// The shuffle sound's whole input (`apps/ui/src/play/live/sound-events.ts`'s
			// `wasShuffled`): a mulligan shuffles the library, and Forge re-sends the
			// reordered `Library` list (`Zone.shuffle` → `onChanged` →
			// `updateZoneForView`). Both seats' projections must carry it, ids in a new
			// order, because the opponent hears the shuffle too.
			for (const viewer of [0, 1] as const) {
				const orders: string[] = [];
				for (let upTo = 0; upTo < sent.length; upTo++) {
					if (sent[upTo]!.seat !== viewer || sent[upTo]!.envelope.frame.method !== 'applyDelta') continue;
					const ids = libraryOf(viewer, 0, upTo);
					if (ids.length > 0 && orders.at(-1) !== ids.join(',')) orders.push(ids.join(','));
				}
				// A London mulligan puts the hand back, shuffles and draws in one delta, so
				// the list changes cards as well as order: compare the cards in both.
				const reordered = orders.some((o, i) => {
					if (i === 0) return false;
					const before = orders[i - 1]!.split(',');
					const kept = new Set(before);
					const common = o.split(',').filter((id) => kept.has(id));
					const shared = new Set(common);
					return common.length >= 20 && common.join() !== before.filter((id) => shared.has(id)).join();
				});
				expect(reordered, `seat ${String(viewer)} never saw seat 0's library reordered in place`).toBe(true);
			}
			match.stop();
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, "this match's JVM to exit", 15_000);
		},
		240_000,
	);
	it(
		'asks the order of the cards a London mulligan puts on the bottom, and puts them there in that order',
		async () => {
			if (!available.ok) return;
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });
			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, events),
				log: (e) => logs.push(e),
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
			});
			const match = registry.create({
				seed: 7,
				seats: [
					{ name: 'A', ai: false, deck: deck('M A', ['30 Mountain', '30 Memnite']) },
					{ name: 'B', ai: false, deck: deck('M B', ['30 Mountain', '30 Memnite']) },
				],
			});
			expect(await match.whenRunning(120_000)).toEqual({ ok: true });

			const zone = (seat: number, name: 'Hand' | 'Library'): number[] => {
				const state = foldFrames(
					sent
						.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
				const player = state.get(keyOf(TYPE.player, match.seats[seat]!.playerId ?? -1)) as unknown as Record<string, { v?: { v: number }[] }> | undefined;
				return (player?.[name]?.v ?? []).map((id) => id.v);
			};
			type Ask = { kind: string; callId: string; method: string; title?: string; top?: string; sourceChoices?: { key: string; ref: { id: number } | null }[] };
			const orderAsk = (): Ask | undefined =>
				sent.map((x) => (x.seat === 0 ? (x.envelope.frame as unknown as Ask) : undefined)).find((f) => f?.kind === 'ask' && f.method === 'order');

			// Seat 0 mulligans twice and keeps, so it puts two cards back; seat 1 keeps.
			const buttons = [{ enable1: false }, { enable1: false }];
			const changed = [true, true];
			let mulligans = 0;
			let bottomed: number[] = [];
			let cursor = 0;
			const deadline = Date.now() + 60_000;
			while (bottomed.length === 0 && Date.now() < deadline) {
				for (; cursor < sent.length && bottomed.length === 0; cursor++) {
					const { seat, envelope } = sent[cursor]!;
					const f = envelope.frame as unknown as Record<string, unknown>;
					if (f.method === 'applyDelta') changed[seat] = true;
					if (f.method === 'updateButtons') {
						buttons[seat] = { enable1: f.enable1 === true };
						continue;
					}
					if (f.method !== 'showPromptMessage') continue;
					const msg = String(f.message);
					if (/keep your hand/i.test(msg)) {
						if (!changed[seat]) continue;
						changed[seat] = false;
						const mulligan = seat === 0 && mulligans < 2;
						if (mulligan) mulligans++;
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: mulligan ? 'selectButtonCancel' : 'selectButtonOk' }));
					} else if (seat === 0 && /return 2 card/i.test(msg)) {
						bottomed = zone(0, 'Hand').slice(0, 2);
						for (const id of bottomed) {
							match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null }));
							await new Promise((r) => setTimeout(r, 300));
						}
						match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
					} else if (!/^Waiting for|bottom of your library/i.test(msg) && buttons[seat]!.enable1) {
						match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' }));
					}
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			expect(bottomed, 'seat 0 reached the bottom pick for two cards').toHaveLength(2);

			// Rule 103.5: the cards go to the bottom "in any order", so their owner is asked it.
			try {
				await waitUntil(() => orderAsk() !== undefined, 'an order ask for the two bottomed cards', 20_000);
			} catch (err) {
				const prompts = sent.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage').map((x) => (x.envelope.frame as unknown as { message: string }).message);
				console.log(`[af64] no order ask; seat 0's prompts since: ${JSON.stringify(prompts.slice(-5))}`);
				throw err;
			}
			const ask = orderAsk()!;
			console.log(`[af64] order ask ${JSON.stringify({ title: ask.title, top: ask.top, cards: ask.sourceChoices?.map((c) => c.ref?.id) })}`);
			expect(ask.sourceChoices?.map((c) => c.ref?.id).sort(), 'it orders exactly the two bottomed cards').toEqual([...bottomed].sort());
			expect(ask.top, "the list's first place is the card closest to the top").toMatch(/closest to top/i);
			// The Mulligan flag is already clear when the ask lands: the bottom pick is over.
			const before = sent.findIndex((x) => x.seat === 0 && (x.envelope.frame as unknown as Ask).callId === ask.callId);
			const flag = foldFrames(
				sent
					.slice(0, before)
					.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as StateFrame)
					.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
			);
			const game = [...flag.values()].find((o) => o._type === TYPE.game) as unknown as Record<string, { v?: unknown }> | undefined;
			expect(game?.['Mulligan']?.v, 'the bottom pick is over before its order is asked').not.toBe(true);

			// Answer against Forge's offer: the second-offered card closest to the top.
			const keys = ask.sourceChoices!.map((c) => c.key).reverse();
			const wanted = ask.sourceChoices!.map((c) => c.ref!.id).reverse();
			match.fromClient(0, ClientFrameSchema.parse({ kind: 'reply', callId: ask.callId, method: 'order', result: { ordered: keys, rememberDecision: false } }));
			await waitUntil(() => zone(0, 'Library').slice(-2).join() === wanted.join(), `the library to end ${wanted.join()} (top to bottom)`, 20_000).catch((err: unknown) => {
				console.log(`[af64] library tail ${JSON.stringify(zone(0, 'Library').slice(-4))}, wanted ${JSON.stringify(wanted)}`);
				throw err;
			});

			match.stop();
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, "this match's JVM to exit", 15_000);
		},
		240_000,
	);
});
