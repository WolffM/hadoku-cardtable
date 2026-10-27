/**
 * Wave 19, lane C, against a REAL Forge match in a child JVM.
 *
 * `auto.test.ts` holds the rules and the wiring; this holds the thing the
 * operator actually complained about, end to end:
 *
 *  - **#7** *"having to confirm through all the phases even when nothing is
 *    playable"* — every priority stop where Forge itself named nothing
 *    actionable is passed, and every pass LOGS which phase it was. A stop where
 *    Forge named something is never passed. (Wave 25 §D, item 3 stopped the pass
 *    also telling the seat in words; the log is what this run reads.)
 *  - **#8** *"i casted galvanic blast without even having mana?"* — every cast
 *    leaves Forge's own `MANA` log lines, one per land that tapped for it.
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
 * `match.jvm.test.ts` — and **`CARDTABLE_PLAY_WORK_DIR` must point at scratch**, or
 * the run sweeps production's run directories.
 *
 * The deck is all-Preordain/Galvanic Blast over duals so both a scry and a cast
 * happen within two turns; the driver is deliberately crude (play a land, cast
 * the first spell it can afford, press OK) because what is asserted is what
 * FORGE was asked and what the seat was told, not the quality of the play.
 *
 * ## Wave 24 §E added a second scenario: the two windows the model must explain
 *
 * The second test below is a DIAGNOSIS, and it exists because the two requests
 * it covers look identical in prose and are completely different in the frame:
 *
 *  - **#16** *"tapping Evolving Wilds asks whether to sacrifice — ridiculous
 *    question"*. The claim under test is the frame's SHAPE: Forge asks through
 *    `InputConfirm`, so what reaches a seat is a prose `showPromptMessage` with
 *    `card: null` plus a Yes/No `updateButtons` — no ask, no cost, no reference
 *    to the ability being paid for. That is why no rule can tell it apart from an
 *    optional-trigger confirm, which IS a real game choice.
 *  - **#22** *"Stoneforge Mystic waited for a click on Plains when there was
 *    only one way to pay"*. Stoneforge's ability costs `{1}{W}, {T}`
 *    (`cardsfolder/s/stoneforge_mystic.txt`), so it is two mana off two lands:
 *    TWO sources and one assignment. The claim under test is that the multiset
 *    Forge sends carries no weighting — `UI_SHOW_AUTOTAP_PREVIEW` defaults to
 *    `"false"` (`ForgePreferences.java:101`) and the bridge does not set it — so
 *    `plannedSources` is empty and the payment correctly stays a stop.
 *
 * Both are recorded as data (`CARDTABLE_PLAY_DUMP`) and summarised into
 * `docs/planning/w24-e-evidence.md`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientFrameSchema, type ServerFrame, deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import {
	DEFAULT_STOP_POLICY,
	FULL_CONTROL_POLICY,
	STRICT_PAYMENT_POLICY,
	answerability,
	decidePay,
	decideStop,
	isOwnMainPhaseEntry,
	readPromptFacts,
	type PromptFacts,
	type SeatNotes,
} from './auto.js';
import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine } from './host.js';
import { createMatchRegistry } from './match.js';
import { finishMulligan, scenarioText, startScenario, waitUntil as waitUntilScenario } from './scenario.js';
import { foldFrames, type StateFrame, type WireObj } from './visibility.js';
import type { ServerEnvelope } from '@hadoku/shared';

const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_JVM: '0' });
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

/**
 * Forge's cleanup discard, a hand of eight. Its OK stays dead until a card is
 * picked, so a driver that only presses a live OK parks there for good.
 */
const CLEANUP_DISCARD = /^Cleanup Phase\nSelect \d+ card\(s\) to discard/;

function str(o: WireObj | undefined, k: string): string | null {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

/** One (prompt, buttons) window, paired off the RAW bridge stream — see {@link rowsFromRaw}'s own note. */
interface RawRow {
	message: string;
	card: unknown;
	confirmAbility: unknown;
	label1: string;
	label2: string;
	enable1: boolean;
	enable2: boolean;
	actionable: number[] | null;
	selectables: number[] | null;
}

/**
 * every row-building `it()` in this file used to pair a
 * `showPromptMessage` with WHATEVER `updateButtons` happened to be last
 * stored, read off `emit` (this seat's own wire). That already needed a
 * `JSON.stringify` de-dup for Forge's own two input orderings (buttons before
 * message, or after); what it did NOT anticipate is `match.ts`'s own
 * DISABLED-buttons correction for an UNRELATED, auto-passed window
 * ping-ponging back to this seat (a live bar left over from a window this
 * seat never acted on, corrected before the next withheld one — see
 * `match.ts`'s `decidePendingWindow`) landing in `live.buttons` BETWEEN two
 * real windows and pairing with the SECOND real window's prompt instead of
 * its own real buttons — a real, live decision recorded as dead, which the
 * driver below then never clicks. Measured directly: before this fix, lane E
 * took 200s+ and 267 rows for a run that finishes in 17s and 42 rows once
 * rows are read off the raw stream instead.
 *
 * Paired here exactly as `match.ts` pairs them — prompt and buttons, in
 * whichever order Forge sent them, for the CORRECT seat, never through
 * whatever this seat's wire happened to carry around them.
 */
function rowsFromRaw(raw: BridgeLine[], seat: number): RawRow[] {
	const rows: RawRow[] = [];
	let pendingPrompt: { message: string; card: unknown; confirmAbility: unknown } | null = null;
	let pendingButtons: { label1: string; label2: string; enable1: boolean; enable2: boolean } | null = null;
	let actionable: number[] | null = null;
	let selectables: number[] | null = null;
	const flush = (): void => {
		if (pendingPrompt === null || pendingButtons === null) return;
		const row: RawRow = {
			...pendingPrompt,
			...pendingButtons,
			actionable: actionable === null ? null : [...actionable],
			selectables: selectables === null ? null : [...selectables],
		};
		const prev = rows[rows.length - 1];
		if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(row)) rows.push(row);
		pendingPrompt = null;
		pendingButtons = null;
	};
	for (const l of raw) {
		if (l.t !== 'frame' || l.seat !== seat) continue;
		const f = l.frame as {
			method?: string;
			message?: string;
			card?: unknown;
			confirmAbility?: unknown;
			label1?: string;
			label2?: string;
			enable1?: boolean;
			enable2?: boolean;
			cards?: { id: number }[];
		} | null;
		if (f?.method === 'showPromptMessage') {
			pendingPrompt = { message: f.message ?? '', card: f.card ?? null, confirmAbility: f.confirmAbility ?? null };
			flush();
		} else if (f?.method === 'updateButtons') {
			pendingButtons = { label1: f.label1 ?? '', label2: f.label2 ?? '', enable1: f.enable1 === true, enable2: f.enable2 === true };
			flush();
		} else if (f?.method === 'setWeaklySelectable') {
			actionable = (f.cards ?? []).map((c) => c.id);
		} else if (f?.method === 'clearWeaklySelectable') {
			actionable = null;
		} else if (f?.method === 'setSelectables') {
			selectables = (f.cards ?? []).map((c) => c.id);
		} else if (f?.method === 'clearSelectables') {
			selectables = null;
		}
	}
	return rows;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'stops only where the seat can act, says what it paid, and never asks a one-answer question',
		async () => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { warm: false, log: (e) => logs.push(e) });

			/** What each seat was last told, and what happened at each priority stop. */
			const notes = [0, 1].map(() => ({ prompt: '', ok: false, actionable: null as number[] | null }));
			/** One row per priority window this seat was shown: was Forge's set empty, was it passed. */
			const stops: { seat: number; phase: string; stackEmpty: boolean; idle: boolean; ownMain: boolean; passed: boolean }[] = [];
			const says: { seat: number; message: string; type: string | null }[] = [];

			const registry = createMatchRegistry({
				host: (id, spec, events) =>
					jvm(id, spec, {
						...events,
						line: (l) => {
							raw.push(l);
							/*
							 * a row opens off the RAW bridge line, not off `emit`.
							 * `showPromptMessage` is now parked and, for a window the server
							 * auto-passes, never reaches `sent` at all (that is the fix) — so a
							 * row built from what Forge SAID, same as every other window, still
							 * opens one; `idle` still reads `notes[seat].actionable`, which
							 * `setWeaklySelectable`/`clearWeaklySelectable` keep live regardless
							 * (those are never held).
							 */
							if (l.t === 'frame') {
								const f = l.frame as { method?: unknown; message?: unknown } | null;
								if (f?.method === 'showPromptMessage' && typeof f.message === 'string' && /^Priority: /.test(f.message)) {
									const message = f.message;
									stops.push({
										seat: l.seat,
										phase: /^Phase: (.+)$/m.exec(message)?.[1] ?? '?',
										stackEmpty: /^Stack: Empty$/m.test(message),
										idle: notes[l.seat]!.actionable !== null && notes[l.seat]!.actionable!.length === 0,
										ownMain:
											isOwnMainPhaseEntry(message) &&
											!(DEFAULT_STOP_POLICY.attackStopIsTheDeclaration && /^Phase: Declare Attackers Step$/m.test(message)),
										passed: false,
									});
								}
							}
							events.line(l);
						},
					}),
				log: (e) => {
					logs.push(e);
					/*
					 * Wave 25 §D, item 3: an auto-pass no longer SAYS anything, so the
					 * log entry is the signal — the same moment, the same seat, and the
					 * only record that survives. This used to watch for the
					 * `auto-passed <phase>` line the server sent the browser.
					 */
					if (e.evt !== 'auto-passed') return;
					const last = [...stops].reverse().find((x) => x.seat === e.seat);
					if (last !== undefined) last.passed = true;
				},
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => {
					sent.push({ seat, envelope });
					const f = envelope.frame;
					if (f.method === 'setWeaklySelectable') notes[seat]!.actionable = f.cards.map((c) => c.id);
					else if (f.method === 'clearWeaklySelectable') notes[seat]!.actionable = null;
					else if (f.method === 'showPromptMessage') {
						// the row itself now opens off the raw bridge line (the
						// `line` wrapper above), because a window the server auto-passes
						// never reaches `emit` at all — that is the fix this suite is
						// proving. `notes[seat].prompt` still updates here: it drives this
						// test's OWN driver below, which only ever acts on a seat's own main
						// phase, and that phase is never withheld (it is always a stop).
						notes[seat]!.prompt = f.message;
					} else if (f.method === 'updateButtons') {
						notes[seat]!.ok = f.enable1;
					} else if (f.method === 'message') {
						says.push({ seat, message: f.message, type: f.log?.type ?? null });
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
				const player = state.get(deltaKey(DELTA_TYPE.player, match.seats[seat]!.playerId ?? -1));
				return ids(player, name).map((id) => {
					const view = state.get(deltaKey(DELTA_TYPE.card, id));
					const current = view?.CurrentState as { v?: number } | undefined;
					const face = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
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
			// Every seat is told every line; one seat's copy counts each payment once.
			const paidSoFar = () => says.filter((x) => x.type === 'MANA' && x.seat === 0).length;
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
						// Only a card Forge offered, as the board's own `selectCard` does: a
						// click Forge ignores (a second land in one turn) leaves the bar
						// disabled by the server and no new window to re-enable it.
						const offered = (id: number): boolean => n.actionable?.includes(id) === true;
						const hand = zone(seat, 'Hand');
						const land = hand.find((c) => c.land && offered(c.id));
						if (land !== undefined && !acted.has(`${key}:land`)) {
							acted.add(`${key}:land`);
							match.fromClient(seat, select(land.id));
							continue;
						}
						const untapped = zone(seat, 'Battlefield').filter((c) => c.land && !c.tapped).length;
						const spell = hand.find((c) => c.name === 'Preordain' && offered(c.id));
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
			// Item 3: the pass is silent, so it is counted off the log it still writes.
			const passed = logs.filter((l) => l.evt === 'auto-passed');
			const paid = says.filter((x) => x.type === 'MANA' && x.seat === 0);
			console.log(
				`[lane-c] ${casts} casts, ${stops.length} priority stops (${stops.filter((s) => s.idle).length} with nothing to do), ` +
					`${passed.length} auto-passed, ${paid.length} payments, ${asks.length} asks reached a browser: ` +
					JSON.stringify(asks.map((a) => a.method)),
			);
			console.log(`[lane-c] said: ${JSON.stringify(says.map((x) => `${x.seat}: ${x.message}`))}`);

			/*
			 * Wave 21 §B. Every claim below is a sweep — "no stop of this shape was
			 * passed", "no ask carried too much" — and a sweep over an empty set is
			 * green while proving nothing. The populations are therefore counted
			 * first, and each one must be non-empty before the sweep over it is
			 * believed. The numbers in the messages are what this deck and
			 * `seed: 20260924` produced over five runs: 26 stops, 22 of them
			 * idle, 4-5 with something to do, 20 auto-passed, 2 payments, 9 asks.
			 * Only the last of those moves at all — thread timing is not seeded.
			 */
			/*
			 * The LAST window each seat was shown may still be open: the loop above
			 * stops the moment it has two payments, and an auto-pass for a window
			 * opened just before that lands after it. A window with no verdict yet is
			 * not a window that was wrongly left alone — a whole-suite run under load
			 * failed the "every idle stop was passed" sweep on exactly one such row
			 * (seat 1, precombat main, stack loaded, 19 auto-passes instead of 20).
			 * So the direction that needs a verdict — "this was passed" — is asked
			 * only of windows that closed, and the direction that does not — "this was
			 * NOT passed" — is asked of every row, because `passed` can only be true
			 * if the message actually arrived (wave 21 §B).
			 */
			const openStill = new Set([0, 1].map((seat) => [...stops].reverse().find((x) => x.seat === seat)).filter((x) => x !== undefined));
			const closed = stops.filter((x) => !openStill.has(x));

			const population = {
				idleNotOwnMain: closed.filter((s) => s.idle && !s.ownMain).length,
				busy: stops.filter((s) => !s.idle).length,
				ownMain: stops.filter((s) => s.ownMain).length,
				stackLoadedIdle: stops.filter((s) => !s.stackEmpty && s.idle).length,
				asksCarryingCards: asks.filter((a) => a.method === 'manipulateCardList' || a.method === 'order').length,
			};
			console.log(`[lane-c] the populations each sweep below is over: ${JSON.stringify(population)}`);

			// The scenario actually happened.
			expect(casts).toBeGreaterThanOrEqual(2);
			expect(stops.length).toBeGreaterThan(4);

			// #7 — every stop with nothing to do was passed, and every stop with
			// something to do was NOT. The second half is the one that matters.
			//
			// Wave 20 carved one case out of the first half: a seat's OWN main phase
			// with an empty stack is a stop even with nothing to do — *"dont
			// auto-pass peoples turns"*. So the sweep is over the windows that are
			// not that, and the carve-out gets an assertion of its own below.
			expect(population.idleNotOwnMain, `no stop outside a main phase had nothing to do: ${JSON.stringify(population)}`).toBeGreaterThan(0);
			expect(closed.filter((s) => s.idle && !s.ownMain && !s.passed)).toEqual([]);
			// The half that matters, and the half that was vacuous without the count
			// beside it: a stop where FORGE named something is never passed. With no
			// busy stop in the run there is nothing for that rule to have got wrong.
			expect(population.busy, `Forge named something actionable at no stop at all: ${JSON.stringify(population)}`).toBeGreaterThan(0);
			expect(stops.filter((s) => !s.idle && s.passed)).toEqual([]);
			expect(passed.length).toBeGreaterThan(4);

			// #7, wave 20 — and no seat's own main phase with an empty stack was
			// ever passed for it, whether it had anything to do or not.
			expect(population.ownMain, `no seat ever entered its own main phase: ${JSON.stringify(population)}`).toBeGreaterThan(0);
			expect(stops.filter((s) => s.ownMain && s.passed)).toEqual([]);
			// #5, wave 20 — a window with the stack loaded and nothing to do IS
			// passed, and this scenario contains some: that is what resolves a spell
			// without two humans pressing OK.
			expect(stops.filter((s) => !s.stackEmpty && s.idle && s.passed).length).toBeGreaterThan(0);

			/*
			 * #8 — a cast is never free: Forge's own log says each mana ability that
			 * paid (`MagicStack.add`, a `MANA` entry per activation), and the bridge
			 * sends one payment's entries as one line that names its cards and the mana
			 * — a name, never an id, on the payer's log and the opponent's alike.
			 */
			expect(paid.length).toBeGreaterThanOrEqual(2);
			for (const line of paid) {
				expect(line.message, line.message).not.toMatch(/\(\d+\)|card #\d+/);
				expect(line.message, line.message).toMatch(/^[AB] taps \S.* for \{[WUBRGC]\}/);
			}
			expect(says.filter((x) => x.type === 'MANA' && x.seat === 1).map((x) => x.message), 'the opponent is told the same payments').toEqual(paid.map((x) => x.message));

			// #11/#7 — the ability asks that reached a browser were the player's own
			// clicks, and this driver answered each by hand through the same reply
			// path a browser uses (`answerAsks` asserts every one was accepted).
			// The bounds shortcut itself is proven over the real fixtures in
			// `auto.test.ts`; nothing in this scenario forces a bounds-shaped ask.
			expect(asks.filter((a) => a.method === 'getAbilityToPlay').length).toBeGreaterThan(0);

			// #12 — the scry asks about the cards it scried, never about the library.
			const libraries = [0, 1].map((seat) => ids(stateOf(seat).get(deltaKey(DELTA_TYPE.player, match.seats[seat]!.playerId ?? -1)), 'Library').length);
			expect(Math.max(...libraries)).toBeGreaterThan(20);
			// The sweep below is over the asks that carry card references at all; if
			// none did, "no ask carried the whole library" would be two empty hands.
			expect(population.asksCarryingCards, `no ask carried a card list: ${JSON.stringify(asks.map((a) => a.method))}`).toBeGreaterThan(0);
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
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
			expect(liveJvmCount()).toBe(0);
		},
		300_000,
	);
	/*
	 * Wave 24 §E — the diagnosis run. One match, two windows, both recorded.
	 *
	 * Deck: Evolving Wilds (the #16 card), Plains (the basic it fetches, and the
	 * #22 source the operator clicked) and Stoneforge Mystic (the #22 spell, whose
	 * ability costs `{1}{W}, {T}`). Nothing else, so the two windows are reached
	 * within a few turns without a driver that can play Magic.
	 */
	it(
		'records what #16 and #22 actually carry: a prose Yes/No with no cost, and a two-source payment with no plan',
		async () => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { warm: false, log: (e) => logs.push(e) });

			// rows are read off `raw` (the bridge's own stream), via
			// the shared `rowsFromRaw` — never off `emit` (this seat's wire) — see
			// that function's own header for why: `match.ts` can now correct an
			// UNRELATED window's stale live bar with a disabled `updateButtons`
			// of its own, and anchoring on whatever this seat's wire carried
			// around a prompt paired a real decision with that correction instead
			// of its own real buttons.
			const rows = (): RawRow[] => rowsFromRaw(raw, 0);
			const notes = [0, 1].map(() => ({ prompt: '', ok: false }));
			// `setWeaklySelectable`/`clearWeaklySelectable` are never held or
			// corrected by `match.ts` (only the prompt/buttons pair is), so
			// reading this off `emit` — unlike the prompt and buttons themselves —
			// is exactly as live and exactly as safe as it always was.
			const live = { actionable: null as number[] | null };

			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, { ...events, line: (l) => { raw.push(l); events.line(l); } }),
				log: (e) => logs.push(e),
				overGraceMs: 60_000,
				// The sacrifice confirm is read off `raw`, so the server answering it (w52: the seat
				// chose Evolving Wilds' ability the click before) does not hide it from this record.
				// This test RECORDS the payment windows the wire carries. Since Z4 a payment the server pays itself is withheld from the seat, so every payment is left to the seat here, and recorded.
				stopPolicy: { ...DEFAULT_STOP_POLICY, unambiguousPayment: 'ask' },
				emit: (_m, seat, envelope) => {
					sent.push({ seat, envelope });
					const f = envelope.frame;
					if (f.method === 'showPromptMessage') notes[seat]!.prompt = f.message;
					else if (f.method === 'updateButtons') notes[seat]!.ok = f.enable1;
					if (seat !== 0) return;
					if (f.method === 'setWeaklySelectable') live.actionable = f.cards.map((c) => c.id);
					else if (f.method === 'clearWeaklySelectable') live.actionable = null;
				},
			});

			const cards = ['14 Evolving Wilds', '14 Plains', '12 Stoneforge Mystic'];
			const match = registry.create({
				seed: 20260926,
				seats: [
					{ name: 'A', ai: false, deck: deck('Lane E A', cards) },
					{ name: 'B', ai: false, deck: deck('Lane E B', cards) },
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
				const player = state.get(deltaKey(DELTA_TYPE.player, match.seats[seat]!.playerId ?? -1));
				return ids(player, name).map((id) => {
					const view = state.get(deltaKey(DELTA_TYPE.card, id));
					const current = view?.CurrentState as { v?: number } | undefined;
					const face = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
					const type = face?.Type as { core?: string[] } | undefined;
					return {
						id,
						name: str(face, 'Name') ?? str(view, 'Name') ?? `#${id}`,
						tapped: (view?.Tapped as { v?: boolean } | undefined)?.v === true,
						land: type?.core?.includes('Land') === true,
					};
				});
			}

			/** Answer whatever reaches the browser plainly — the point is that it round-trips. */
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

			/*
			 * A Yes/No bar is Forge's `InputConfirm` (`InputConfirm.java:51,108`:
			 * `lblYes` / `lblNo`). TWO kinds of row wear one, and the second is a
			 * finding of this run rather than something it went looking for:
			 *
			 *  - the confirm's own prompt, which is the #16 window; and
			 *  - a PRIORITY prompt that arrived while the bar was still Yes/No,
			 *    because Forge replaces the message before it replaces the buttons.
			 *
			 * So `label1` cannot classify a priority window, and the adapter does not
			 * use it for one — only for the payment input, whose own label is `Auto`.
			 */
			const yesNoRows = (): RawRow[] => rows().filter((r) => r.label1 === 'Yes' && r.label2 === 'No');
			// a SECOND non-priority confirm is ALWAYS in this seeded
			// run — Stoneforge Mystic's own ETB ("Use triggered ability of
			// Stoneforge Mystic?") — distinct from #16's own claim. Real, not a
			// regression; split out by message rather than widening #16's claim.
			const sacrificeRows = (): RawRow[] => yesNoRows().filter((r) => r.message.startsWith('Sacrifice '));
			const otherConfirmRows = (): RawRow[] => yesNoRows().filter((r) => !r.message.startsWith('Priority: ') && !r.message.startsWith('Sacrifice '));
			const staleBarRows = (): RawRow[] => yesNoRows().filter((r) => r.message.startsWith('Priority: '));
			const paymentRows = (): RawRow[] => rows().filter((r) => r.label1 === 'Auto' && r.enable1);
			const twoSourceRows = (): RawRow[] => paymentRows().filter((r) => r.actionable !== null && new Set(r.actionable).size >= 2);

			const names = ['A', 'B'];
			const deadline = Date.now() + 200_000;
			while (Date.now() < deadline && (sacrificeRows().length === 0 || twoSourceRows().length === 0)) {
				answerAsks();
				for (const seat of [0, 1]) {
					const n = notes[seat]!;
					const me = names[seat]!;
					const turn = /Turn: (\d+) \(([^)]*)\)/.exec(n.prompt);
					if (CLEANUP_DISCARD.test(n.prompt) && !n.ok) {
						const at = sent.filter((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage').length;
						const card = zone(seat, 'Hand')[0];
						if (card !== undefined && !acted.has(`${seat}:discard:${at}`)) {
							acted.add(`${seat}:discard:${at}`);
							match.fromClient(seat, select(card.id));
						}
						continue;
					}
					const myMain =
						n.prompt.startsWith(`Priority: ${me}`) && /Stack: Empty/.test(n.prompt) && /Phase: Main/.test(n.prompt) && turn?.[2] === me;
					if (myMain && seat === 0) {
						const key = `${turn?.[1]}:${n.prompt.includes('precombat') ? 'pre' : 'post'}`;
						// Only a card Forge offered, as the board's own `selectCard` does: a
						// click Forge ignores (a second land in one turn) leaves the bar
						// disabled by the server and no new window to re-enable it.
						const offered = (id: number): boolean => live.actionable?.includes(id) === true;
						const hand = zone(0, 'Hand').filter((c) => offered(c.id));
						const board = zone(0, 'Battlefield');
						const untapped = board.filter((c) => c.land && !c.tapped);
						// A Stoneforge cast is the #22 window, and it needs two untapped lands.
						const mystic = hand.find((c) => c.name === 'Stoneforge Mystic');
						if (mystic !== undefined && untapped.length >= 2 && twoSourceRows().length === 0 && !acted.has(`${key}:cast`)) {
							acted.add(`${key}:cast`);
							match.fromClient(0, select(mystic.id));
							continue;
						}
						// An Evolving Wilds on the battlefield is the #16 window.
						const wilds = board.find((c) => c.name === 'Evolving Wilds' && !c.tapped && offered(c.id));
						if (wilds !== undefined && sacrificeRows().length === 0 && !acted.has(`${key}:wilds`)) {
							acted.add(`${key}:wilds`);
							match.fromClient(0, select(wilds.id));
							continue;
						}
						// Otherwise take the land drop, preferring a Plains once the
						// sacrifice window has been seen (Stoneforge needs real mana).
						const land = sacrificeRows().length === 0
							? (hand.find((c) => c.name === 'Evolving Wilds') ?? hand.find((c) => c.land))
							: (hand.find((c) => c.name === 'Plains') ?? hand.find((c) => c.land));
						if (land !== undefined && !acted.has(`${key}:land`)) {
							acted.add(`${key}:land`);
							match.fromClient(0, select(land.id));
							continue;
						}
					}
					if (n.ok) match.fromClient(seat, OK);
				}
				await new Promise((r) => setTimeout(r, 120));
			}
			await new Promise((r) => setTimeout(r, 1500));
			answerAsks();

			const dumpDir = process.env.CARDTABLE_PLAY_DUMP;
			if (dumpDir !== undefined) {
				mkdirSync(dumpDir, { recursive: true });
				writeFileSync(join(dumpDir, `w24-e-windows-${Date.now()}.json`), JSON.stringify({ rows: rows(), says: logs.filter((l) => l.evt === 'auto-passed' || l.evt === 'auto-paid') }, null, 1));
			}

			const notesFrom = (row: RawRow): SeatNotes => ({
				playerId: match.seats[0]!.playerId,
				prompt: {
					kind: 'notify',
					method: 'showPromptMessage',
					player: { kind: 'player', id: match.seats[0]!.playerId ?? -1 },
					message: row.message,
					card: row.card,
				} as ServerFrame,
				buttons: {
					kind: 'notify',
					method: 'updateButtons',
					owner: { kind: 'player', id: match.seats[0]!.playerId ?? -1 },
					label1: row.label1,
					label2: row.label2,
					enable1: row.enable1,
					enable2: row.enable2,
					focus1: true,
				} as ServerFrame,
				actionable: row.actionable,
				openAsks: 0,
			});

			console.log(
				`[lane-e] ${rows().length} (prompt, buttons) rows; ${sacrificeRows().length} Yes/No confirms, ` +
					`${paymentRows().length} live payments, ${twoSourceRows().length} of them with two or more sources`,
			);

			/*
			 * #16 — what the sacrifice confirm carries. Non-vacuity first: a sweep
			 * over no confirm proves nothing.
			 */
			expect(sacrificeRows().length, `no Yes/No confirm happened: ${JSON.stringify(rows().map((r) => r.label1))}`).toBeGreaterThan(0);
			for (const row of sacrificeRows()) {
				expect(row.message, row.message).toBe('Sacrifice Evolving Wilds?');
				console.log(`[lane-e] #16 confirm: ${JSON.stringify({ message: row.message, card: row.card, label1: row.label1, label2: row.label2, enable2: row.enable2 })}`);
				// Forge offers the decline: button 2 is live, and pressing it aborts
				// the activation (`HumanCostDecision.java:1295-1301` returns null).
				expect(row.enable1).toBe(true);
				expect(row.enable2).toBe(true);
				// Forge's own frame names nothing it is paid for: no card reference, no
				// cost. The bridge adds the ability the confirm belongs to (`confirmAbility`,
				// read off `InputConfirm.sa`), and since cab3a35b its card on the prompt
				// (`confirmCard`): an Evolving Wilds of seat 0's. That is what lets
				// `chosenCostConfirm` answer it.
				const seat0 = stateOf(0).get(deltaKey(DELTA_TYPE.player, match.seats[0]!.playerId ?? -1));
				const wilds = ['Battlefield', 'Graveyard', 'Hand'].flatMap((z) => ids(seat0, z)).filter((id) => {
					const view = stateOf(0).get(deltaKey(DELTA_TYPE.card, id));
					return str(view, 'Name') === 'Evolving Wilds' || str(stateOf(0).get(deltaKey(DELTA_TYPE.cardState, id * 16)), 'Name') === 'Evolving Wilds';
				});
				expect(wilds).toContain((row.confirmAbility as { hostCard?: { id: number } } | null)?.hostCard?.id);
				expect((row.card as { id?: number } | null)?.id).toBe((row.confirmAbility as { hostCard?: { id: number } } | null)?.hostCard?.id);
				const facts: PromptFacts = readPromptFacts(notesFrom(row));
				expect(facts.window).toBe('other');
				expect(facts.cost).toBeNull();
				expect(facts.phase).toBeNull();
				// So it is a stop, under every policy. That is #16's finding.
				expect(decideStop(facts, DEFAULT_STOP_POLICY)).toBeNull();
				expect(decidePay(facts, DEFAULT_STOP_POLICY)).toBeNull();
				expect(decideStop(facts, FULL_CONTROL_POLICY)).toBeNull();
			}

			/*
			 * This suite's own finding (see `otherConfirmRows`'s header): a second,
			 * unrelated Yes/No confirm this run surfaces — still the SAME general
			 * InputConfirm shape #16 is about (no cost, no ask, a stop under every
			 * policy), just not Evolving Wilds', so it is checked for that shape
			 * alone rather than folded into #16's card-specific claim above.
			 */
			for (const row of otherConfirmRows()) {
				console.log(`[lane-e] a second confirm this run found: ${JSON.stringify({ message: row.message, card: row.card })}`);
				// The prompt's card is the confirm's own ability's, or none (`confirmCard`).
				expect((row.card as { id?: number } | null)?.id ?? null).toBe((row.confirmAbility as { hostCard?: { id: number } } | null)?.hostCard?.id ?? null);
				const facts: PromptFacts = readPromptFacts(notesFrom(row));
				expect(facts.window).toBe('other');
				expect(facts.cost).toBeNull();
				expect(decideStop(facts, DEFAULT_STOP_POLICY)).toBeNull();
			}

			/*
			 * The lag, recorded: a priority prompt whose bar is still the confirm's.
			 * It is classified as the priority window it is, NOT as a confirm — which
			 * is the whole reason the adapter reads `label1` only for the payment
			 * input. This run produced some; if a later one does not, the claim is
			 * reported as unexercised rather than turned into a red.
			 */
			if (staleBarRows().length === 0) {
				console.warn('[lane-e] DID NOT HAPPEN: no priority prompt arrived while the Yes/No bar was still up.');
			} else {
				console.log(`[lane-e] ${staleBarRows().length} priority prompts arrived under a stale Yes/No bar`);
				for (const row of staleBarRows()) {
					expect(readPromptFacts(notesFrom(row)).window).toBe('priority');
				}
			}

			/*
			 * #22 — a two-source payment, and the weighting that is not on our wire.
			 */
			expect(twoSourceRows().length, `no payment offered two sources: ${JSON.stringify(paymentRows().map((r) => r.actionable))}`).toBeGreaterThan(0);
			for (const row of twoSourceRows()) {
				const facts: PromptFacts = readPromptFacts(notesFrom(row));
				console.log(
					`[lane-e] #22 payment: cost=${String(facts.cost)} sources=${JSON.stringify(facts.sources)} planned=${JSON.stringify(facts.plannedSources)}`,
				);
				expect(facts.window).toBe('payment');
				expect(facts.cost).not.toBeNull();
				expect(facts.sources!.length).toBeGreaterThan(1);
				// `UI_SHOW_AUTOTAP_PREVIEW` defaults false and the bridge does not set
				// it, so Forge's own auto-tap plan never reaches us. Flipping that pref
				// is what closes #22.
				expect(facts.plannedSources).toEqual([]);
				// The strict value is the one that asks, and it is the one this claim
				// belongs to: this line said `DEFAULT_STOP_POLICY` until wave 28 found
				// it red. The default moved to `'forgeAuto'` on 2026-09-27 (`auto.ts`,
				// `88ca6fb`) and this jar-gated file was never re-aimed — CI runs no
				// jar-gated vitest, so the red sat here latent rather than failing.
				expect(decidePay(facts, STRICT_PAYMENT_POLICY)).toBeNull();
				// Under the default the operator chose, Forge's own Auto settles it.
				expect(decidePay(facts, DEFAULT_STOP_POLICY)).toBe(facts.cost);
				// The same row WITH Forge's weighting is one payment even for the strict
				// value — the wire shape the pref produces, asserted here so the fix has
				// a test waiting.
				const weighted = readPromptFacts({ ...notesFrom(row), actionable: [...row.actionable!, ...new Set(row.actionable!)] });
				expect(new Set(weighted.plannedSources)).toEqual(new Set(weighted.sources));
				expect(decidePay(weighted, STRICT_PAYMENT_POLICY)).toBe(facts.cost);
				expect(decidePay(weighted, DEFAULT_STOP_POLICY)).toBe(facts.cost);
			}

			expect(match.invalidFrames).toBe(0);
			match.stop();
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
			expect(liveJvmCount()).toBe(0);
		},
		300_000,
	);
	/*
	 * Wave 25 §D — item 6, the diagnosis run. **This is the evidence, not a rule.**
	 *
	 * Operator, 2026-09-27: *"there is only one red mana source on my battlefield,
	 * why is galvanic blast asking me how to pay? that should be automatic."*
	 * `decidePay` already answers a payment Forge offered exactly ONE source for,
	 * so one of its guards was returning null and WHICH one is a fact. This run
	 * gets it: the operator's own card, `{R}` off a board that holds one Mountain
	 * and one Island.
	 *
	 * The deck is Mountain / Island / Galvanic Blast so the board can be built to
	 * that exact shape in two land drops, and the driver targets the OPPONENT —
	 * `addTarget` finishes the input the moment the last target is chosen
	 * (`InputSelectTargets.java:410-414`), so one `selectPlayer` takes the cast
	 * straight into `InputPayMana`.
	 */
	it(
		'records the window item 6 is: {R} with one red source among two lands',
		async () => {
			if (!available.ok) return;
			const raw: BridgeLine[] = [];
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { warm: false, log: (e) => logs.push(e) });

			// rows are read off `raw` via the shared `rowsFromRaw`,
			// never off `emit` — see that function's own header. `setWeaklySelectable`/
			// `setSelectables` (and their clears) are never held or corrected, so
			// tracking THOSE off `emit` for the driver below is still exactly as
			// safe as it always was.
			const rows = (): RawRow[] => rowsFromRaw(raw, 0);
			const live = { actionable: null as number[] | null, selectables: null as number[] | null };
			const notes = [0, 1].map(() => ({ prompt: '', ok: false }));

			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, { ...events, line: (l) => { raw.push(l); events.line(l); } }),
				log: (e) => logs.push(e),
				overGraceMs: 60_000,
				// Records the payment window too: left to the seat (Z4 withholds a payment the server pays itself).
				stopPolicy: { ...DEFAULT_STOP_POLICY, unambiguousPayment: 'ask' },
				emit: (_m, seat, envelope) => {
					sent.push({ seat, envelope });
					const f = envelope.frame;
					if (f.method === 'showPromptMessage') notes[seat]!.prompt = f.message;
					else if (f.method === 'updateButtons') notes[seat]!.ok = f.enable1;
					if (seat !== 0) return;
					if (f.method === 'setWeaklySelectable') live.actionable = f.cards.map((c) => c.id);
					else if (f.method === 'clearWeaklySelectable') live.actionable = null;
					else if (f.method === 'setSelectables') live.selectables = f.cards.map((c) => c.id);
					else if (f.method === 'clearSelectables') live.selectables = null;
				},
			});

			const cards = ['20 Mountain', '20 Island', '20 Galvanic Blast'];
			const match = registry.create({
				seed: 20260927,
				seats: [
					{ name: 'A', ai: false, deck: deck('Lane D A', cards) },
					{ name: 'B', ai: false, deck: deck('Lane D B', cards) },
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
				const player = state.get(deltaKey(DELTA_TYPE.player, match.seats[seat]!.playerId ?? -1));
				return ids(player, name).map((id) => {
					const view = state.get(deltaKey(DELTA_TYPE.card, id));
					const current = view?.CurrentState as { v?: number } | undefined;
					const face = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
					const type = face?.Type as { core?: string[] } | undefined;
					return {
						id,
						name: str(face, 'Name') ?? str(view, 'Name') ?? `#${id}`,
						tapped: (view?.Tapped as { v?: boolean } | undefined)?.v === true,
						land: type?.core?.includes('Land') === true,
					};
				});
			}

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
			const target = (id: number) =>
				ClientFrameSchema.parse({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id }, triggerEvent: null });

			/** The payment rows: Forge's own `Auto` bar, live or dead. */
			const paymentRows = (): RawRow[] => rows().filter((r) => r.label1 === 'Auto' && /^Pay Mana Cost: /m.test(r.message));
			/** Item 6's window: Galvanic Blast's `{R}`, Auto live, with the highlight Forge sent for it. */
			const blastRows = (): RawRow[] =>
				paymentRows().filter((r) => r.enable1 && r.actionable !== null && r.actionable.length > 0 && /^Pay Mana Cost: \{R\}$/m.test(r.message));
			/** Item 7's window, if this run happens to produce one: a payment Forge's own Auto is DEAD for. */
			const deadAutoRows = (): RawRow[] => paymentRows().filter((r) => !r.enable1);

			const names = ['A', 'B'];
			/** Set while a Galvanic Blast cast is in flight, so the targeting input is answered once. */
			let targeted = false;
			const deadline = Date.now() + 200_000;
			while (Date.now() < deadline && blastRows().length === 0) {
				answerAsks();
				for (const seat of [0, 1]) {
					const n = notes[seat]!;
					const me = names[seat]!;
					const turn = /Turn: (\d+) \(([^)]*)\)/.exec(n.prompt);
					if (CLEANUP_DISCARD.test(n.prompt) && !n.ok) {
						const at = sent.filter((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage').length;
						const card = zone(seat, 'Hand')[0];
						if (card !== undefined && !acted.has(`${seat}:discard:${at}`)) {
							acted.add(`${seat}:discard:${at}`);
							match.fromClient(seat, select(card.id));
						}
						continue;
					}
					// The targeting input for the cast in flight: neither a priority
					// window nor a payment, and it is the one thing seat 0 owes Forge.
					if (
						seat === 0 &&
						!targeted &&
						acted.has('cast') &&
						!n.prompt.startsWith('Priority: ') &&
						!/^Pay Mana Cost: /m.test(n.prompt) &&
						n.prompt !== ''
					) {
						targeted = true;
						match.fromClient(0, target(match.seats[1]!.playerId ?? -1));
						continue;
					}
					const myMain =
						n.prompt.startsWith(`Priority: ${me}`) && /Stack: Empty/.test(n.prompt) && /Phase: Main/.test(n.prompt) && turn?.[2] === me;
					if (myMain && seat === 0) {
						const key = `${turn?.[1]}:${n.prompt.includes('precombat') ? 'pre' : 'post'}`;
						// Only a card Forge offered, as the board's own `selectCard` does: a
						// click Forge ignores (a second land in one turn) leaves the bar
						// disabled by the server and no new window to re-enable it.
						const offered = (id: number): boolean => live.actionable?.includes(id) === true;
						const hand = zone(0, 'Hand').filter((c) => offered(c.id));
						const board = zone(0, 'Battlefield');
						const mountains = board.filter((c) => c.name === 'Mountain');
						const islands = board.filter((c) => c.name === 'Island');
						// Exactly the operator's board: ONE red source, and one land that
						// is not one. Both have a playable mana ability, which is the whole
						// point — Forge's actionable set is not "can pay this cost".
						const want = mountains.length === 0 ? 'Mountain' : islands.length === 0 ? 'Island' : null;
						if (want !== null) {
							const land = hand.find((c) => c.name === want);
							if (land !== undefined && !acted.has(`${key}:land`)) {
								acted.add(`${key}:land`);
								match.fromClient(0, select(land.id));
								continue;
							}
						} else {
							const untapped = board.filter((c) => c.land && !c.tapped).length;
							const blast = hand.find((c) => c.name === 'Galvanic Blast');
							if (blast !== undefined && untapped >= 2 && !acted.has('cast')) {
								acted.add('cast');
								match.fromClient(0, select(blast.id));
								continue;
							}
						}
					}
					if (n.ok) match.fromClient(seat, OK);
				}
				await new Promise((r) => setTimeout(r, 120));
			}
			await new Promise((r) => setTimeout(r, 1500));
			answerAsks();

			const dumpDir = process.env.CARDTABLE_PLAY_DUMP;
			if (dumpDir !== undefined) {
				mkdirSync(dumpDir, { recursive: true });
				writeFileSync(
					join(dumpDir, `w25-d-item6-${Date.now()}.json`),
					JSON.stringify({ rows: rows(), paid: logs.filter((l) => l.evt === 'auto-paid' || l.evt === 'auto-passed' || l.evt === 'auto-cancelled') }, null, 1),
				);
			}

			const notesFrom = (row: RawRow): SeatNotes => ({
				playerId: match.seats[0]!.playerId,
				prompt: {
					kind: 'notify',
					method: 'showPromptMessage',
					player: { kind: 'player', id: match.seats[0]!.playerId ?? -1 },
					message: row.message,
					card: null,
				} as ServerFrame,
				buttons: {
					kind: 'notify',
					method: 'updateButtons',
					owner: { kind: 'player', id: match.seats[0]!.playerId ?? -1 },
					label1: row.label1,
					label2: row.label2,
					enable1: row.enable1,
					enable2: row.enable2,
					focus1: true,
				} as ServerFrame,
				actionable: row.actionable,
				openAsks: 0,
			});

			console.log(`[lane-d] ${rows().length} rows, ${paymentRows().length} payment rows, ${blastRows().length} of them item 6's shape`);
			for (const row of paymentRows()) {
				console.log(`[lane-d] payment row: ${JSON.stringify({ message: row.message, label1: row.label1, enable1: row.enable1, actionable: row.actionable, selectables: row.selectables })}`);
				console.log(`[lane-d] readPromptFacts: ${JSON.stringify(readPromptFacts(notesFrom(row)))}`);
			}

			expect(blastRows().length, `no {R} payment with a highlight: ${JSON.stringify(paymentRows().map((r) => [r.message, r.actionable]))}`).toBeGreaterThan(0);
			/*
			 * The evidence, by NAME. Forge used to offer two cards for this `{R}`: the
			 * Mountain that can pay it and the Island that cannot (every card with a
			 * playable mana ability), which is why `decidePay`'s source-count arm asked.
			 * The payment highlight now offers only a source the payment would take
			 * (`InputPayMana.paysWith`), so the Island is left out and the one source pays.
			 */
			const board = new Map(zone(0, 'Battlefield').map((c) => [c.id, c.name]));
			for (const row of blastRows()) {
				const facts: PromptFacts = readPromptFacts(notesFrom(row));
				expect(facts.window).toBe('payment');
				expect(facts.cost).toBe('{R}');
				const offered = [...new Set(row.actionable!)].map((id) => board.get(id) ?? `#${id}`).sort();
				console.log(`[lane-d] item 6: Forge offered ${JSON.stringify(offered)} for ${String(facts.cost)}`);
				expect([...board.values()], 'the Island is on the board, untapped or not').toContain('Island');
				expect(offered).toEqual(['Mountain']);
				expect(facts.sources).toHaveLength(1);
				// One source for the cost: even the strict policy pays it.
				expect(decidePay(facts, STRICT_PAYMENT_POLICY)).toBe('{R}');
				expect(decidePay(facts, DEFAULT_STOP_POLICY)).toBe('{R}');
				expect(decidePay(facts, FULL_CONTROL_POLICY)).toBeNull();
				// Not an unpayable cost: Forge's Auto is live, so it can be paid.
				expect(facts.noWayToPay).toBe(false);
				expect(answerability({ kind: 'payment', facts }).verdict).toBe('answerable');
			}

			/*
			 * Item 7, if this run produced one. A payment window whose Auto is DEAD is
			 * Forge saying it found no payment, whatever it still highlights; whether
			 * Cancel is live is what makes it optional. Reported rather than turned into a red, the
			 * way this file already reports the claims a run did not exercise.
			 */
			if (deadAutoRows().length === 0) {
				console.warn('[lane-d] DID NOT HAPPEN: no payment window in this run had a dead Auto, so item 7 was not exercised live.');
			} else {
				for (const row of deadAutoRows()) {
					const facts: PromptFacts = readPromptFacts(notesFrom(row));
					console.log(`[lane-d] item 7: dead Auto, sources=${JSON.stringify(facts.sources)} noWayToPay=${String(facts.noWayToPay)}`);
					expect(facts.confirmLive).toBe(false);
					expect(facts.noWayToPay).toBe(true);
					expect(answerability({ kind: 'payment', facts }).verdict).toBe(facts.alternativePayment || facts.poolChoice ? 'answerable' : facts.cancelLive ? 'unanswerable' : 'unclassified');
				}
			}

			expect(match.invalidFrames).toBe(0);
			match.stop();
			jvm.reapOnExit();
			await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
			expect(liveJvmCount()).toBe(0);
		},
		300_000,
	);

	/*
	 * Bitterblossom, by name: a real-Forge cast of the exact card
	 * from the ledger's own timeline (`scenarios/bitterblossom.state`: seat 0's
	 * own uncontested Main Phase 1, Bitterblossom in hand, two Swamps up).
	 * `DEFAULT_STOP_POLICY`'s `forgeAuto` auto-pays {1}{B} the instant Forge's
	 * own Auto is live, then the caster's own next priority (the spell
	 * resolving on the stack) is auto-passed the same way `own-spell.state`'s
	 * own suite proves for a free spell — the claim here is that NEITHER
	 * window, payment or priority, ever reaches the seat's wire.
	 */
	it(
		'Bitterblossom: the payment and the priority that follows it never reach the seat',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 55,
				decks: [deck('Bitterblossom A', ['40 Swamp']), deck('Bitterblossom B', ['40 Swamp'])],
				scenario: scenarioText('bitterblossom'),
			});
			try {
				await finishMulligan(s);
				const bb = await waitUntilScenario(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Bitterblossom');
					},
					"seat 0's hand to reflect the scripted Bitterblossom",
					20_000,
					s,
				).then(() => s.zone(0, 'Hand').find((c) => c.name === 'Bitterblossom'));
				if (bb === undefined) throw new Error('no Bitterblossom in hand');
				await waitUntilScenario(
					() => {
						s.answerAsks();
						return s.sent.some(
							(x) =>
								x.seat === 0 &&
								x.envelope.frame.method === 'setWeaklySelectable' &&
								(x.envelope.frame as unknown as { cards: { id: number }[] }).cards.some((c) => c.id === bb.id),
						);
					},
					'Bitterblossom to be offered as actionable to seat 0',
					15_000,
					s,
				);
				const logsBefore = s.logs.length;
				const sentBefore = s.sent.length;
				s.select(0, bb.id);
				await waitUntilScenario(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Bitterblossom');
					},
					'Bitterblossom to resolve onto the battlefield without a click',
					20_000,
					s,
				);
				const sentSince = s.sent.slice(sentBefore).filter((x) => x.seat === 0);
				const paid = s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-paid' && l.seat === 0);
				const passed = s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' && l.seat === 0);
				const withheld = s.logs.slice(logsBefore).filter((l) => l.evt === 'prompt-withheld' && l.seat === 0);
				console.log(`[bitterblossom] server log: ${JSON.stringify({ paid, passed, withheld })}`);
				console.log(`[bitterblossom] seat 0's frames since the cast: ${JSON.stringify(sentSince.map((x) => x.envelope.frame.method))}`);
				expect(paid.length, 'the {1}{B} payment was auto-paid').toBeGreaterThan(0);
				expect(passed.length, 'the caster held priority on its own spell, and it was auto-passed').toBeGreaterThan(0);
				// The claim: no payment window reached the seat, and the log shows
				// the priority window right after it (the caster's own, on the
				// stack) was withheld the same way — not that no LATER, unrelated
				// priority window ever reaches the seat, which the normal game
				// keeps sending as the seat's own genuine stops resume.
				expect(sentSince.some((x) => /Pay Mana Cost/.test((x.envelope.frame as unknown as { message?: string }).message ?? ''))).toBe(false);
				// Nor any part of the payment's bar: its disabled and enabled Auto never went out.
				expect(sentSince.filter((x) => (x.envelope.frame as unknown as { label1?: string }).label1 === 'Auto')).toEqual([]);
				expect(withheld.map((l) => l.kind)).toEqual(['payment', 'priority']);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
