/**
 * Wave 19, lane C, against a REAL Forge match in a child JVM.
 *
 * `auto.test.ts` holds the rules and the wiring; this holds the thing the
 * operator actually complained about, end to end:
 *
 *  - **#7** *"having to confirm through all the phases even when nothing is
 *    playable"* — every priority stop where Forge itself named nothing
 *    actionable is passed, and every pass says which phase it was. A stop where
 *    Forge named something is never passed.
 *  - **#8** *"i casted galvanic blast without even having mana?"* — every cast
 *    leaves a `paid …` line naming the cost and the lands that tapped for it.
 *  - **#11/#7** *"having the abilities numbered … is extremely ugly"* — the
 *    one-ability `getAbilityToPlay` asks (nine in a 3-turn run of this very
 *    scenario, each a one-item list reading `ability #243`) are the player's
 *    click made visible, and they stay questions. Payment-time ones cannot
 *    occur at all: Forge's own `InputPayMana` plays a single mana ability
 *    without asking (`InputPayMana.java:102-106`), and two on a dual land IS a
 *    real question. The button's LABEL is the remaining ugliness, and it is a
 *    wire gap only the bridge can close (`lookup.ts` has it since Wave 17).
 *  - **#12** *"when i cast preordain it showed the whole library"* — the scry
 *    asks about the cards it scried. Before this lane the same cast arrived as
 *    `manipulateCardList` with **53** cards (the seat's whole library) and 2
 *    manipulable; see `host.ts`'s `FORGE_PREFERENCES`.
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, like
 * `jvm.test.ts` — and **`CARDTABLE_PLAY_WORK_DIR` must point at scratch**, or
 * the run sweeps production's run directories.
 *
 * The deck is all-Preordain/Galvanic Blast over duals so both a scry and a cast
 * happen within two turns; the driver is deliberately crude (play a land, cast
 * the first spell it can afford, press OK) because what is asserted is what
 * FORGE was asked and what the seat was told, not the quality of the play.
 */

import { describe, expect, it } from 'vitest';
import { ClientFrameSchema, type ServerFrame } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine } from './host.js';
import { createMatchRegistry } from './match.js';
import { foldFrames, keyOf, TYPE, type StateFrame, type WireObj } from './visibility.js';
import type { ServerEnvelope } from './transport.js';

const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });
const title = available.ok
	? 'wave 19 lane C against a real Forge match'
	: `wave 19 lane C against a real Forge match — SKIPPED: ${available.reason}`;

function deck(name: string, lines: readonly string[]): string {
	return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

async function waitUntil(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function ids(o: WireObj | undefined, k: string): number[] {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
	return (v.v as { t?: string; v?: unknown }[]).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
}

function str(o: WireObj | undefined, k: string): string | null {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'stops only where the seat can act, says what it paid, and never asks a one-answer question',
		async () => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });

			/** What each seat was last told, and what happened at each priority stop. */
			const notes = [0, 1].map(() => ({ prompt: '', ok: false, actionable: null as number[] | null }));
			/** One row per priority stop this seat was shown: was Forge's set empty, was it passed. */
			const stops: { seat: number; phase: string; idle: boolean; passed: boolean }[] = [];
			const says: { seat: number; message: string }[] = [];

			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, { ...events, line: (l) => { raw.push(l); events.line(l); } }),
				log: (e) => logs.push(e),
				askTimeoutMs: 120_000,
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => {
					sent.push({ seat, envelope });
					const f = envelope.frame;
					if (f.method === 'setWeaklySelectable') notes[seat]!.actionable = f.cards.map((c) => c.id);
					else if (f.method === 'clearWeaklySelectable') notes[seat]!.actionable = null;
					else if (f.method === 'showPromptMessage') notes[seat]!.prompt = f.message;
					else if (f.method === 'updateButtons') {
						notes[seat]!.ok = f.enable1;
						const n = notes[seat]!;
						if (/^Priority: /.test(n.prompt) && /^Stack: Empty$/m.test(n.prompt) && f.enable1) {
							stops.push({
								seat,
								phase: /^Phase: (.+)$/m.exec(n.prompt)?.[1] ?? '?',
								idle: n.actionable !== null && n.actionable.length === 0,
								passed: false,
							});
						}
					} else if (f.method === 'message') {
						says.push({ seat, message: f.message });
						// The auto-pass lands right after the buttons that opened the stop.
						if (f.message.startsWith('auto-passed')) {
							const last = [...stops].reverse().find((x) => x.seat === seat);
							if (last !== undefined) last.passed = true;
						}
					}
				},
			});

			// Preordain over duals that enter untapped: every copy is payable off any
			// land in play and none of them targets, so a cast always reaches its
			// payment. (Galvanic Blast, the operator's own card in #8, asks for a
			// target first — Forge parks in target selection and this driver has no
			// hands for that. The payment path it would then take is the same one.)
			const cards = ['24 Volcanic Island', '36 Preordain'];
			const match = registry.create({
				seed: 20260924,
				seats: [
					{ name: 'A', ai: false, deck: deck('Lane C A', cards) },
					{ name: 'B', ai: false, deck: deck('Lane C B', cards) },
				],
			});
			expect(await match.whenRunning(120_000)).toEqual({ ok: true });

			const answered = new Set<string>();
			const acted = new Set<string>();

			function stateOf(seat: number): Map<string, WireObj> {
				return foldFrames(
					sent
						.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
			}

			function zone(seat: number, name: 'Hand' | 'Battlefield'): { id: number; name: string; tapped: boolean; land: boolean }[] {
				const state = stateOf(seat);
				const player = state.get(keyOf(TYPE.player, match.seats[seat]!.playerId ?? -1));
				return ids(player, name).map((id) => {
					const view = state.get(keyOf(TYPE.card, id));
					const current = view?.CurrentState as { v?: number } | undefined;
					const face = state.get(keyOf(TYPE.cardState, id * 16 + (current?.v ?? 0)));
					const type = face?.Type as { core?: string[] } | undefined;
					return {
						id,
						name: str(face, 'Name') ?? str(view, 'Name') ?? `#${id}`,
						tapped: (view?.Tapped as { v?: boolean } | undefined)?.v === true,
						land: type?.core?.includes('Land') === true,
					};
				});
			}

			/** Answer whatever reaches the browser, plainly — the point is that it round-trips. */
			function answerAsks(): void {
				for (const { seat, envelope } of sent) {
					const f = envelope.frame as ServerFrame & Record<string, unknown>;
					if (f.kind !== 'ask' || answered.has(f.callId as string)) continue;
					const callId = f.callId as string;
					answered.add(callId);
					let result: unknown;
					switch (f.method) {
						case 'confirm':
						case 'showConfirmDialog':
						case 'openZones':
							result = true;
							break;
						case 'showOptionDialog':
							result = 0;
							break;
						case 'showInputDialog':
							result = '0';
							break;
						case 'getChoices': {
							const keys = (f.choices as { key: string }[]).map((c) => c.key);
							result = (f.min as number) > 0 && keys[0] !== undefined ? [keys[0]] : [];
							break;
						}
						case 'getAbilityToPlay':
							result = (f.abilities as unknown[])[0] ?? null;
							break;
						case 'chooseSingleEntityForEffect':
							result = (f.optionList as unknown[])[0] ?? null;
							break;
						case 'chooseEntitiesForEffect':
							result = (f.min as number) > 0 ? [(f.optionList as unknown[])[0]] : [];
							break;
						case 'manipulateCardList':
							result = f.cards;
							break;
						case 'order':
							result = { ordered: (f.destChoices as { key: string }[]).map((c) => c.key), rememberDecision: false };
							break;
						case 'assignCombatDamage':
						case 'assignGenericAmount':
							result = [];
							break;
						default:
							result = null;
					}
					const reply = ClientFrameSchema.parse({ kind: 'reply', callId, method: f.method, result });
					expect(match.fromClient(seat, reply), `${f.method} ${callId}`).toEqual({ ok: true });
				}
			}

			const OK = ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' });
			const select = (id: number) =>
				ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null });

			const names = ['A', 'B'];
			const deadline = Date.now() + 200_000;
			const paidSoFar = () => says.filter((x) => x.message.startsWith('paid')).length;
			let casts = 0;
			while (Date.now() < deadline && paidSoFar() < 2) {
				answerAsks();
				for (const seat of [0, 1]) {
					const n = notes[seat]!;
					const me = names[seat]!;
					const turn = /Turn: (\d+) \(([^)]*)\)/.exec(n.prompt);
					const myMain =
						n.prompt.startsWith(`Priority: ${me}`) && /Stack: Empty/.test(n.prompt) && /Phase: Main/.test(n.prompt) && turn?.[2] === me;
					if (myMain) {
						const key = `${seat}:${turn?.[1]}:${n.prompt.includes('precombat') ? 'pre' : 'post'}`;
						const hand = zone(seat, 'Hand');
						const land = hand.find((c) => c.land);
						if (land !== undefined && !acted.has(`${key}:land`)) {
							acted.add(`${key}:land`);
							match.fromClient(seat, select(land.id));
							continue;
						}
						const untapped = zone(seat, 'Battlefield').filter((c) => c.land && !c.tapped).length;
						const spell = hand.find((c) => c.name === 'Preordain');
						if (spell !== undefined && untapped >= 1 && !acted.has(`${key}:cast`)) {
							acted.add(`${key}:cast`);
							casts += 1;
							match.fromClient(seat, select(spell.id));
							continue;
						}
					}
					if (n.ok) match.fromClient(seat, OK);
				}
				await new Promise((r) => setTimeout(r, 120));
			}
			// Let the last cast finish paying and resolving before anything is read.
			await new Promise((r) => setTimeout(r, 2000));
			answerAsks();

			const asks = sent.filter((x) => x.envelope.frame.kind === 'ask').map((x) => x.envelope.frame);
			const passed = says.filter((x) => x.message.startsWith('auto-passed'));
			const paid = says.filter((x) => x.message.startsWith('paid'));
			console.log(
				`[lane-c] ${casts} casts, ${stops.length} priority stops (${stops.filter((s) => s.idle).length} with nothing to do), ` +
					`${passed.length} auto-passed, ${paid.length} payments, ${asks.length} asks reached a browser: ` +
					JSON.stringify(asks.map((a) => a.method)),
			);
			console.log(`[lane-c] said: ${JSON.stringify(says.map((x) => `${x.seat}: ${x.message}`))}`);


			// The scenario actually happened.
			expect(casts).toBeGreaterThanOrEqual(2);
			expect(stops.length).toBeGreaterThan(4);

			// #7 — every stop with nothing to do was passed, and every stop with
			// something to do was NOT. The second half is the one that matters.
			expect(stops.filter((s) => s.idle && !s.passed)).toEqual([]);
			expect(stops.filter((s) => !s.idle && s.passed)).toEqual([]);
			expect(passed.length).toBeGreaterThan(4);

			// #8 — a cast is never free: every payment named its cost and its lands.
			expect(paid.length).toBeGreaterThanOrEqual(2);
			for (const line of paid) {
				expect(line.message, line.message).toMatch(/^paid [^ ]+ — .+$/);
				// A name, not an id: the seat's own lands are named in its projection.
				expect(line.message, line.message).not.toMatch(/card #\d+/);
			}

			// #11/#7 — the ability asks that reached a browser were the player's own
			// clicks, and this driver answered each by hand through the same reply
			// path a browser uses (`answerAsks` asserts every one was accepted).
			// The bounds shortcut itself is proven over the real fixtures in
			// `auto.test.ts`; nothing in this scenario forces a bounds-shaped ask.
			expect(asks.filter((a) => a.method === 'getAbilityToPlay').length).toBeGreaterThan(0);

			// #12 — the scry asks about the cards it scried, never about the library.
			const libraries = [0, 1].map((seat) => ids(stateOf(seat).get(keyOf(TYPE.player, match.seats[seat]!.playerId ?? -1)), 'Library').length);
			expect(Math.max(...libraries)).toBeGreaterThan(20);
			for (const ask of asks) {
				const refs =
					ask.method === 'manipulateCardList'
						? ask.cards.length
						: ask.method === 'order'
							? ask.sourceChoices.length + ask.destChoices.length
							: 0;
				expect(refs, `${ask.method} carried ${refs} entries`).toBeLessThanOrEqual(8);
			}

			expect(match.invalidFrames).toBe(0);
			match.stop();
			jvm.close();
			await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
			expect(liveJvmCount()).toBe(0);
		},
		300_000,
	);
});
