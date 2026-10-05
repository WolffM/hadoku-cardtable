/**
 * Wave 32, Q12 and Q10 — what a seat is offered at Declare Blockers, against a REAL
 * Forge match.
 *
 * Q12, the operator: *"i was not able to assign blockers at all. is it because the
 * creature was summoning sick?"* No — and the cause is in `docs/planning/wave32-evidence/
 * q12-blockers.md`. This suite drives a real attack at a seat that holds a
 * summoning-sick creature and reads what that seat is offered and what it can do with it.
 *
 * Q10, the operator: *"no creatures, no block."* A seat with no creature is not stopped at
 * its Declare Blockers step, and a seat WITH one still is.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/S \
 *   pnpm exec vitest run apps/server/src/play/blockers.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, inOwnMain, isStop, passUntil, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a real attack at a seat, against real Forge'
	: `a real attack at a seat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Q A', ['20 Mountain', '40 Memnite']), deck('Q B', ['20 Mountain', '40 Memnite'])];

/**
 * Turn 1: the first seat casts a Memnite. Turn 2: the second does too iff `defenderCasts`.
 * Returns once the first seat is in its turn-3 main phase, where its turn-1 Memnite can attack.
 */
async function setUp(s: Scenario, defenderCasts: boolean): Promise<{ attacker: number; defender: number }> {
	await waitUntil(() => { s.keepHands(); s.answerAsks(); return [0, 1].some((x) => inOwnMain(s, x, 1)); }, 'turn 1 main', 90_000);
	const attacker = [0, 1].find((x) => inOwnMain(s, x, 1)) as number;
	const defender = 1 - attacker;
	await castNamed(s, attacker, 'Memnite');
	await passUntil(s, () => inOwnMain(s, defender, 2), `seat ${defender}'s turn 2 main`);
	if (defenderCasts) await castNamed(s, defender, 'Memnite');
	await passUntil(s, () => inOwnMain(s, attacker, 3), `seat ${attacker}'s turn 3 main`);
	return { attacker, defender };
}

/**
 * Walk the attacker through its declaration — select its one able creature, confirm with OK —
 * and return as soon as `until` holds of the DEFENDER. Every stop on the way is pressed once.
 */
async function attack(s: Scenario, attacker: number, defender: number, until: () => boolean): Promise<void> {
	const pressed = new Set<number>();
	let declared = false;
	let confirmed = false;
	await waitUntil(() => {
		s.answerAsks();
		if (until()) return true;
		const msg = s.prompt(attacker);
		const b = s.buttons(attacker);
		if (/^Select creatures to attack/.test(msg) && b?.enable1 === true && !declared) {
			const able = s.zone(attacker, 'Battlefield').find((c) => c.creature && !c.sick && !c.tapped);
			if (able === undefined) throw new Error('no creature could attack');
			declared = true;
			s.select(attacker, able.id);
			return false;
		}
		if (declared && !confirmed && /^Select creatures to attack/.test(msg) && b?.enable1 === true && b.label2 === 'Call Back') {
			confirmed = true;
			s.ok(attacker);
			return false;
		}
		for (const seat of [0, 1]) {
			const at = s.sent
				.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
				.filter((i) => i >= 0)
				.pop();
			if (at === undefined || pressed.has(at)) continue;
			const pm = (s.sent[at]?.envelope.frame as unknown as { message: string }).message;
			if (seat === defender && /Declare Blockers Step/.test(pm)) continue;
			if (!isStop(pm, seat, s) || s.buttons(seat)?.enable1 !== true) continue;
			pressed.add(at);
			s.ok(seat);
		}
		return false;
	}, 'the attack to reach the defender', 60_000);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Q12: a seat attacked while it holds a summoning-sick creature is offered the block, and can make it',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 32, decks: DECKS });
			const report: string[] = [];
			try {
				const { attacker, defender } = await setUp(s, true);
				const sick = s.zone(defender, 'Battlefield').find((c) => c.creature);
				expect(sick?.sick, 'the defender’s creature is summoning sick — the case Q12 asks about').toBe(true);
				report.push(`defender seat ${defender} battlefield: ${JSON.stringify(s.zone(defender, 'Battlefield'))}`);
				const mark = s.sent.length;

				await attack(s, attacker, defender, () => /^Select creatures to block/.test(s.prompt(defender)));
				// Whatever Forge sends right behind the block prompt arrives; then read what is open.
				await new Promise((r) => setTimeout(r, 600));
				report.push(`600 ms after the block prompt the defender's prompt is: ${JSON.stringify(s.prompt(defender))}`);
				const window = s.sent.slice(mark).filter((x) => x.seat === defender);
				const t0 = window[0]?.t ?? 0;
				for (const x of window) {
					const f = x.envelope.frame as unknown as Record<string, unknown>;
					const m = String(f.method);
					const at = `+${Math.round(x.t - t0)}ms s${defender}`;
					if (m === 'setWeaklySelectable' || m === 'setHighlighted' || m === 'clearWeaklySelectable') report.push(`  ${at} ${m} ${JSON.stringify(f.cards ?? f.entities ?? '')}`);
					else if (m === 'showPromptMessage') report.push(`  ${at} PROMPT ${JSON.stringify(f.message)}`);
					else if (m === 'updateButtons') report.push(`  ${at} BUTTONS [${String(f.label1)}${f.enable1 === true ? '' : '-'}] [${String(f.label2)}${f.enable2 === true ? '' : '-'}]`);
				}
				const offered = s.sent
					.slice(mark)
					.filter((x) => x.seat === defender && x.envelope.frame.method === 'setWeaklySelectable')
					.map((x) => (x.envelope.frame as unknown as { cards: { id: number }[] }).cards.map((c) => c.id))
					.filter((ids) => ids.length > 0)
					.at(-1);
				report.push(`offered as blockers: ${JSON.stringify(offered)}`);
				writeFileSync('/tmp/claude-1000/S/q12-run.txt', report.join('\n'));
				console.log(`[q12]\n${report.join('\n')}`);

				// The block input is still OPEN — it was not ended by a pass nobody asked for …
				expect(s.prompt(defender)).toMatch(/^Select creatures to block/);
				expect(s.buttons(defender)?.enable1).toBe(true);
				// … Forge offers the summoning-sick creature as a blocker …
				expect(offered).toContain(sick?.id);
				// … and the server never pressed OK for the defender.
				expect(s.logs.filter((l) => l.evt === 'auto-passed' && l.seat === defender && l.phase === 'Declare Blockers Step')).toEqual([]);

				// The block can be made: the creature, then OK, and Forge marks it blocking.
				s.select(defender, sick?.id as number);
				await waitUntil(() => {
					const view = [...s.state(defender).values()].find((o) => o._type === 0 && o._id === sick?.id);
					return (view?.Blocking as { v?: boolean } | undefined)?.v === true;
				}, 'the creature to be declared blocking', 10_000);
				s.ok(defender);
				// Wave 46 §C: with nothing else castable here, the ordinary priority
				// window that follows a declared block now auto-passes on its own
				// (`StopPolicy.blockStopIsTheDeclaration`) — and can do it fast enough
				// that a 25ms poll checking the CURRENT prompt text can race straight
				// past "Declare Blockers Step" to whatever phase comes after. The
				// `auto-passed` log is the durable, non-racy record that the window
				// was reached and answered either way, so this accepts it as equally
				// proof the window happened.
				await waitUntil(
					() =>
						/Declare Blockers Step/.test(s.prompt(defender)) ||
						s.logs.some((l) => l.evt === 'auto-passed' && l.seat === defender && l.phase === 'Declare Blockers Step'),
					'the Declare Blockers priority window after the block',
					10_000,
				);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Q10: a seat attacked with no creature is passed through Declare Blockers; with one it is not',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 32, decks: DECKS });
			try {
				const { attacker, defender } = await setUp(s, false);
				expect(s.zone(defender, 'Battlefield').some((c) => c.creature), 'the defender has no creature').toBe(false);
				// The window opens and is passed for the seat — the stop it would have had is gone.
				const passedBlockers = (): boolean => s.logs.some((l) => l.evt === 'auto-passed' && l.seat === defender && l.phase === 'Declare Blockers Step');
				await attack(s, attacker, defender, passedBlockers);
				expect(passedBlockers()).toBe(true);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
