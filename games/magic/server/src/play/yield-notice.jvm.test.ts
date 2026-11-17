/**
 * The operator, 2026-11-17 (m-564d54162f9e, Herald's attack): *"clicking auto-yield should pass
 * through the active decision"* — Auto Yield pressed on the open Declare Blockers window did nothing
 * until they pressed OK themselves.
 *
 * Against a REAL Forge match: seat 0 attacks with Memnite into seat 1's untapped Memnite
 * (`w46-c-blocker-idle.state`), so Forge's own `InputBlock` opens for seat 1 — OK live (no blocks),
 * Cancel dead. With seat 1's Auto Yield on, the server presses that OK for it: no block, seat 1
 * takes the damage, and no live bar of that window ever reaches seat 1's wire.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run games/magic/server/src/play/yield-notice.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'Auto Yield passes the Declare Blockers notice, against real Forge'
	: `Auto Yield passes the Declare Blockers notice, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('YN A', ['40 Mountain']), deck('YN B', ['40 Mountain'])];
const ATTACKER = 0;
const DEFENDER = 1;
const BLOCKS = /^Select creatures to block|declare blockers/i;

function lifeOf(s: Scenario, seat: number): number {
	const player = s.state(seat).get(deltaKey(DELTA_TYPE.player, s.match.seats[seat]?.playerId ?? -1));
	return ((player?.Life as { v?: number } | undefined)?.v) ?? -1;
}

async function creatureOf(s: Scenario, seat: number): Promise<number> {
	await waitUntil(
		() => {
			s.answerAsks();
			return s.zone(seat, 'Battlefield').some((c) => c.creature);
		},
		`seat ${seat}'s scripted creature`,
		20_000,
		s,
	);
	const card = s.zone(seat, 'Battlefield').find((c) => c.creature);
	if (card === undefined) throw new Error(`no creature on seat ${seat}'s battlefield`);
	return card.id;
}

/** Seat 0 attacks with its Memnite: its own priority stops pressed, `InputAttack` answered, until `until`. */
async function attack(s: Scenario, creature: number, until: () => boolean): Promise<void> {
	let declared = false;
	let confirmed = false;
	await waitUntil(
		() => {
			s.answerAsks();
			if (until()) return true;
			const msg = s.prompt(ATTACKER);
			const b = s.buttons(ATTACKER);
			if (/^Select creatures to attack/.test(msg) && b?.enable1 === true) {
				if (!declared) {
					declared = true;
					s.select(ATTACKER, creature);
				} else if (!confirmed && b.label2 === 'Call Back') {
					confirmed = true;
					s.ok(ATTACKER);
				}
				return false;
			}
			if (/^Priority:/.test(msg) && b?.enable1 === true) s.ok(ATTACKER);
			return false;
		},
		'the attack',
		60_000,
		s,
	);
}

/**
 * Every live bar seat 1's own wire carried under a block prompt, from send-index `from`. InputBlock sends its
 * bar before its prompt (run 44156821118), so that bar goes out under the prompt before it; the pass that
 * follows the block prompt sends a dead one.
 */
function liveBlockBars(s: Scenario, from: number): unknown[] {
	let prompt = '';
	return s.sent.filter((x, i) => {
		if (x.seat !== DEFENDER) return false;
		const f = x.envelope.frame as { method: string; message?: string; enable1?: boolean };
		if (f.method === 'showPromptMessage') prompt = f.message ?? '';
		return i >= from && f.method === 'updateButtons' && f.enable1 === true && BLOCKS.test(prompt);
	});
}

const notices = (s: Scenario) => s.logs.filter((l) => l.evt === 'auto-passed' && l.seat === DEFENDER && l.phase === 'notice');

describe.skipIf(!available.ok)(title, () => {
	it(
		'pressed while the block window is open: its OK is pressed for the seat — no block, the damage taken',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4611, decks: DECKS, scenario: scenarioText('w46-c-blocker-idle') });
			try {
				await finishMulligan(s);
				const attacker = await creatureOf(s, ATTACKER);
				await creatureOf(s, DEFENDER);
				const life = lifeOf(s, DEFENDER);
				await attack(s, attacker, () => BLOCKS.test(s.prompt(DEFENDER)) && s.buttons(DEFENDER)?.enable1 === true);
				expect(s.buttons(DEFENDER)?.enable2, 'the block window is a notice: Cancel dead').toBe(false);

				expect(s.match.setAutoYield(DEFENDER, true)).toEqual({ ok: true });
				await waitUntil(
					() => {
						s.answerAsks();
						if (/^Priority:/.test(s.prompt(ATTACKER)) && s.buttons(ATTACKER)?.enable1 === true) s.ok(ATTACKER);
						return lifeOf(s, DEFENDER) < life;
					},
					'the unblocked Memnite to hit seat 1, with no press of seat 1’s own',
					30_000,
					s,
				);
				expect(lifeOf(s, DEFENDER)).toBe(life - 1);
				expect(notices(s).map((l) => l.why)).toEqual(['auto-yield']);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);

	it(
		'on before the attack: the block window is answered for the seat, and no live bar is left under its prompt',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4612, decks: DECKS, scenario: scenarioText('w46-c-blocker-idle') });
			try {
				await finishMulligan(s);
				const attacker = await creatureOf(s, ATTACKER);
				await creatureOf(s, DEFENDER);
				const life = lifeOf(s, DEFENDER);
				expect(s.match.setAutoYield(DEFENDER, true)).toEqual({ ok: true });
				const from = s.sent.length;
				await attack(s, attacker, () => lifeOf(s, DEFENDER) < life);
				expect(lifeOf(s, DEFENDER)).toBe(life - 1);
				expect(notices(s).length, 'the block window was passed as a notice').toBe(1);
				expect(liveBlockBars(s, from), 'no live bar under the block prompt on seat 1’s wire').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});
