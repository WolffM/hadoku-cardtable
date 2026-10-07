/**
 * "it shouldn't be revealed to the opponent yet when we do this. only once
 * something is actually on the stack should it be shown to the opponent."
 * (the operator, on an earlier playtest).
 *
 * Measured against a REAL Forge jar, two scenarios: `bolt-player.state` (seat 0
 * holds Lightning Bolt and one untapped Mountain, turn 1 main phase 1; "any
 * target" lets it hit the opponent directly, no creature needed) and
 * `auto-target.state` (Doom Blade, {1}{B}, two Swamps, Memnite the one legal
 * target) — the second one specifically to drive a MANUAL, tap-one-land-at-a-
 * time payment under `MANUAL_PAYMENT_POLICY`, the way the operator actually
 * plays (the server's default `forgeAuto` policy auto-pays a single-source
 * cost in one press, which the `bolt-player` cases alone would never
 * contradict).
 *
 * The finding, written up in full in `docs/planning/wave40-evidence/
 * A-timeline.md`: Forge's own `moveToStack` (`PlaySpellAbility.java:624`) puts
 * the card in the Stack zone in the JVM's OWN object graph before targeting
 * is set up (`:677`) and before the cost is paid (`:683`) — but the bridge
 * never pushes a wire delta about that card to the OTHER seat until the whole
 * `playAbility` call has committed (cast fully paid and on the stack) or
 * rolled back (cancelled, back in hand), REGARDLESS of how many separate
 * manual taps the payment takes to get there (each tap's own delta carries
 * only that land's `Tapped` state, never the cast card). Across real runs —
 * cast to completion (single auto-pay AND two-tap manual pay), cancel at the
 * target step, cancel mid-way through a two-tap manual pay (one land tapped,
 * the second never touched), and a Fireball cast Forge itself abandons for
 * want of a valid target count — the opponent's own socket never carried the
 * card's name before the commit point. **V3 already holds** for this path;
 * `visibility.ts` needed no change. These tests pin it so a future change to
 * the bridge or to `visibility.ts` cannot reopen it unnoticed.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/cast-hidden.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_STOP_POLICY } from './auto.js';
import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

/** Evidence files land under the harness's own run directory, never a literal `/tmp`. */
function evidencePath(name: string): string {
	return join(process.env.CARDTABLE_PLAY_WORK_DIR ?? tmpdir(), 'evidence', name);
}

/**
 * The policy a seat runs under when it pays by clicking its own lands one at a
 * time — exactly `STRICT_PAYMENT_POLICY`'s own stated purpose (`auto.ts`), but
 * spelled out with `'ask'` rather than `'auto'`: `decidePay` (`auto.ts:1098`)
 * returns null unconditionally for `'ask'`, so the SERVER never presses Auto
 * regardless of source count. A forced two-source payment (both Swamps needed,
 * no excess) is exactly the case `'auto'` could still resolve server-side via
 * `plannedSources`, which `'ask'` cannot — needed here so the test actually
 * exercises two separate manual taps rather than one server-side auto-pay.
 */
const MANUAL_PAYMENT_POLICY = { ...DEFAULT_STOP_POLICY, unambiguousPayment: 'ask' } as const;

const title = available.ok ? "a cast stays hidden until it is on the stack (V3), against real Forge" : `V3, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

/** Every frame this seat received, JSON-stringified, individually — so "contains the name" never false-positives across two frames. */
function framesOf(s: Scenario, from: number, seat: number): string[] {
	return s.sent.slice(from).filter((x) => x.seat === seat).map((x) => JSON.stringify(x.envelope.frame));
}

async function castAtOpponent(
	s: Scenario,
	caster: 0 | 1,
	cardName: string,
	onTargetPrompt: () => void,
): Promise<void> {
	await finishMulligan(s);
	await new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 90_000;
		const tick = (): void => {
			s.answerAsks();
			if (inOwnMain(s, caster, 1)) return resolve();
			if (Date.now() > deadline) return reject(new Error('timed out waiting for the caster’s main 1'));
			setTimeout(tick, 25);
		};
		tick();
	});
	const card = s.zone(caster, 'Hand').find((c) => c.name === cardName);
	if (card === undefined) throw new Error(`no ${cardName} in hand`);
	s.select(caster, card.id);
	let acted = false;
	await new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 20_000;
		const tick = (): void => {
			s.answerAsks();
			if (!acted && /target/i.test(s.prompt(caster))) {
				acted = true;
				onTargetPrompt();
			}
			if (acted) return resolve();
			if (Date.now() > deadline) return reject(new Error('timed out waiting for the target prompt'));
			setTimeout(tick, 25);
		};
		tick();
	});
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'the other seat sees nothing between the first ask and the spell landing on the stack, then sees it there',
		async () => {
			if (!available.ok) return;
			const s: Scenario = await startScenario(available.config, { seed: 4040, decks: DECKS, scenario: scenarioText('bolt-player') });
			try {
				const markAll = s.sent.length;
				const oppId = s.match.seats[1]?.playerId as number;
				await castAtOpponent(s, 0, 'Lightning Bolt', () => {
					s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never);
				});

				// Let the cast fully resolve (through the stack and beyond), draining
				// every ask as it comes — real Forge, no shortcuts.
				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 20_000;
					const tick = (): void => {
						s.answerAsks();
						if (/Stack: Empty/.test(s.prompt(0)) && s.sent.slice(markAll).some((x) => x.seat === 1)) return resolve();
						if (Date.now() > deadline) return reject(new Error('timed out waiting for the cast to resolve'));
						setTimeout(tick, 25);
					};
					tick();
				});

				// seat 1's OWN frame sequence, in order — not cross-referenced against
				// seat 0's. The first frame (if any) that names the card must be the
				// SAME frame that places it on the stack; nothing earlier may name it.
				const seat1 = s.sent.slice(markAll).filter((x) => x.seat === 1);
				const firstNamedIdx = seat1.findIndex((x) => JSON.stringify(x.envelope.frame).includes('Lightning Bolt'));
				expect(firstNamedIdx, 'the opponent was never shown the card at all, even once it was on the stack').toBeGreaterThanOrEqual(0);

				const revealFrame = seat1[firstNamedIdx]?.envelope.frame as { payload?: { packet?: { newObjects?: Record<string, { Name?: { v?: string }; Zone?: { v?: string } }> } } };
				const bolt = Object.values(revealFrame.payload?.packet?.newObjects ?? {}).find((o) => o.Name?.v === 'Lightning Bolt');
				expect(bolt?.Zone?.v, 'the card was named before it was on the stack').toBe('Stack');
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'the other seat sees nothing at all when the cast is cancelled at the target step',
		async () => {
			if (!available.ok) return;
			const s: Scenario = await startScenario(available.config, { seed: 4041, decks: DECKS, scenario: scenarioText('bolt-player') });
			try {
				const markAll = s.sent.length;
				await castAtOpponent(s, 0, 'Lightning Bolt', () => {
					s.cancel(0);
				});

				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 20_000;
					const tick = (): void => {
						s.answerAsks();
						if (s.zone(0, 'Hand').some((c) => c.name === 'Lightning Bolt')) return resolve();
						if (Date.now() > deadline) return reject(new Error('the bolt never rolled back to hand'));
						setTimeout(tick, 25);
					};
					tick();
				});

				const seat1Frames = framesOf(s, markAll, 1);
				const leaked = seat1Frames.filter((f) => f.includes('Lightning Bolt'));
				expect(leaked, 'the opponent was shown the cancelled card').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'manual payment, one land tap at a time (Doom Blade, {1}{B}, two Swamps) — the opponent sees nothing between taps',
		async () => {
			if (!available.ok) return;
			const s: Scenario = await startScenario(available.config, {
				seed: 4043,
				decks: DECKS,
				scenario: scenarioText('auto-target'),
				policy: MANUAL_PAYMENT_POLICY,
			});
			try {
				await finishMulligan(s);
				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 90_000;
					const tick = (): void => {
						s.answerAsks();
						if (inOwnMain(s, 0, 1)) return resolve();
						if (Date.now() > deadline) return reject(new Error('timed out waiting for main 1'));
						setTimeout(tick, 25);
					};
					tick();
				});

				const doomBlade = s.zone(0, 'Hand').find((c) => c.name === 'Doom Blade');
				if (doomBlade === undefined) throw new Error('no Doom Blade in hand');
				const markAll = s.sent.length;
				s.select(0, doomBlade.id);

				// Target: Memnite, the scenario's one legal (nonblack) creature.
				let targeted = false;
				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 20_000;
					const tick = (): void => {
						s.answerAsks();
						if (!targeted && /Select target/.test(s.prompt(0))) {
							targeted = true;
							const memnite = s.zone(1, 'Battlefield').find((c) => c.name === 'Memnite');
							if (memnite === undefined) throw new Error('no Memnite on seat 1’s battlefield');
							s.select(0, memnite.id);
						}
						if (targeted) return resolve();
						if (Date.now() > deadline) return reject(new Error('timed out waiting for the target prompt'));
						setTimeout(tick, 25);
					};
					tick();
				});

				// Pay Mana Cost: tap the FIRST Swamp, alone, and capture every frame
				// seat 1 gets up to and including that tap — before the second tap.
				await waitUntil(() => { s.answerAsks(); return /Pay Mana Cost/i.test(s.prompt(0)); }, 'Pay Mana Cost', 20_000, s);
				const swamps = s.zone(0, 'Battlefield').filter((c) => c.name === 'Swamp');
				if (swamps.length !== 2) throw new Error(`expected 2 Swamps, found ${swamps.length}`);
				const markTap1 = s.sent.length;
				s.select(0, swamps[0]!.id);
				// `getAbilityToPlay` fires for a land tap too (even with one ability), and
				// its OWN `playAbility` (the mana ability itself) is not reentrant — the
				// bridge logs "Should wait till previous call to playAbility finishes" if a
				// second `selectCard` arrives before it settles. Wait for the FACT (this
				// Swamp is actually tapped), never a fixed delay — a fixed 500ms delay here
				// raced that exact warning once, under host load, and read as a spurious
				// test timeout further down.
				await waitUntil(
					() => { s.answerAsks(); return s.zone(0, 'Battlefield').find((c) => c.id === swamps[0]!.id)?.tapped === true; },
					'Swamp 1 to actually finish tapping',
					20_000,
					s,
				);
				const afterTap1 = s.sent.slice(markTap1);

				const tap1Evidence = evidencePath('measure-manual-pay-tap1.json');
				mkdirSync(dirname(tap1Evidence), { recursive: true });
				writeFileSync(tap1Evidence, JSON.stringify(afterTap1.map((x) => ({ seat: x.seat, frame: x.envelope.frame })), null, 2));
				const seat1AfterTap1 = afterTap1.filter((x) => x.seat === 1);
				const leakAfterTap1 = seat1AfterTap1.filter((x) => JSON.stringify(x.envelope.frame).includes('Doom Blade'));
				const summaryEvidence = evidencePath('measure-manual-pay-summary.txt');
				mkdirSync(dirname(summaryEvidence), { recursive: true });
				writeFileSync(
					summaryEvidence,
					`swamps=${JSON.stringify(swamps)}\npromptAfterTap1=${JSON.stringify(s.prompt(0))}\nbuttonsAfterTap1=${JSON.stringify(s.buttons(0))}\nseat1 frames after tap 1: ${seat1AfterTap1.length}\nleaked "Doom Blade" after tap 1, before tap 2: ${leakAfterTap1.length}\n${JSON.stringify(leakAfterTap1.map((x) => x.envelope.frame))}`,
				);

				// Now tap the second Swamp, completing payment, and let the cast resolve.
				s.select(0, swamps[1]!.id);
				await waitUntil(() => { s.answerAsks(); return /Stack: 1 to Resolve/.test(s.prompt(0)); }, 'the spell to resolve to the stack', 20_000, s);

				const seat1Whole = s.sent.slice(markAll).filter((x) => x.seat === 1);
				const firstNamedIdx = seat1Whole.findIndex((x) => JSON.stringify(x.envelope.frame).includes('Doom Blade'));
				const firstNamedEvidence = evidencePath('measure-manual-pay-firstnamed.txt');
				mkdirSync(dirname(firstNamedEvidence), { recursive: true });
				writeFileSync(
					firstNamedEvidence,
					`firstNamedIdx=${firstNamedIdx}\n${firstNamedIdx >= 0 ? JSON.stringify(seat1Whole[firstNamedIdx]!.envelope.frame) : 'NEVER'}`,
				);
				expect(leakAfterTap1, 'the opponent was shown Doom Blade between the first and second tap').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'cancel AFTER tapping the first of two lands, before the second — the opponent never sees the name',
		async () => {
			if (!available.ok) return;
			const s: Scenario = await startScenario(available.config, {
				seed: 4044,
				decks: DECKS,
				scenario: scenarioText('auto-target'),
				policy: MANUAL_PAYMENT_POLICY,
			});
			try {
				await finishMulligan(s);
				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 90_000;
					const tick = (): void => {
						s.answerAsks();
						if (inOwnMain(s, 0, 1)) return resolve();
						if (Date.now() > deadline) return reject(new Error('timed out waiting for main 1'));
						setTimeout(tick, 25);
					};
					tick();
				});

				const doomBlade = s.zone(0, 'Hand').find((c) => c.name === 'Doom Blade');
				if (doomBlade === undefined) throw new Error('no Doom Blade in hand');
				const markAll = s.sent.length;
				s.select(0, doomBlade.id);

				let targeted = false;
				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 20_000;
					const tick = (): void => {
						s.answerAsks();
						if (!targeted && /Select target/.test(s.prompt(0))) {
							targeted = true;
							const memnite = s.zone(1, 'Battlefield').find((c) => c.name === 'Memnite');
							if (memnite === undefined) throw new Error('no Memnite on seat 1’s battlefield');
							s.select(0, memnite.id);
						}
						if (targeted) return resolve();
						if (Date.now() > deadline) return reject(new Error('timed out waiting for the target prompt'));
						setTimeout(tick, 25);
					};
					tick();
				});

				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 20_000;
					const tick = (): void => {
						s.answerAsks();
						if (/Pay Mana Cost/i.test(s.prompt(0))) return resolve();
						if (Date.now() > deadline) return reject(new Error('timed out waiting for Pay Mana Cost'));
						setTimeout(tick, 25);
					};
					tick();
				});
				const swamps = s.zone(0, 'Battlefield').filter((c) => c.name === 'Swamp');
				if (swamps.length !== 2) throw new Error(`expected 2 Swamps, found ${swamps.length}`);
				s.select(0, swamps[0]!.id);
				// Wait for the fact (tapped), not a fixed delay — see the sibling test's
				// comment for why: Forge's own `playAbility` for this mana ability is not
				// reentrant, and a cancel sent too early just races it.
				await waitUntil(
					() => { s.answerAsks(); return s.zone(0, 'Battlefield').find((c) => c.id === swamps[0]!.id)?.tapped === true; },
					'Swamp 1 to actually finish tapping',
					20_000,
					s,
				);

				// Cancel now — ONE Swamp tapped, the second never touched.
				s.cancel(0);
				await new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 20_000;
					const tick = (): void => {
						s.answerAsks();
						if (s.zone(0, 'Hand').some((c) => c.name === 'Doom Blade')) return resolve();
						if (Date.now() > deadline) return reject(new Error('Doom Blade never rolled back to hand'));
						setTimeout(tick, 25);
					};
					tick();
				});

				const seat1Frames = framesOf(s, markAll, 1);
				const leaked = seat1Frames.filter((f) => f.includes('Doom Blade'));
				expect(leaked, 'the opponent was shown the cancelled Doom Blade').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
