/**
 * The operator, 2026-11-20: *"game should smartly keep priority for players if they have the ability
 * to tap a creature down before declare attacks. i just had a situation where it passed through to
 * declare attackers even though my opponent had a way to tap my guy down"* (Nomad Decoy, match
 * m-67088feb4f6e). The bridge names, at another player's Beginning of Combat, the permanents whose
 * playable ability can tap one of that player's would-be attackers (`setWeaklySelectable.tappers`),
 * and `judgeStop` keeps that step for them (`StopPolicy.stopToTap`). The controls: the same Decoy
 * with no mana to pay for it, and the same Decoy with nothing able to attack — the step is passed.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/tapstop \
 *   pnpm exec vitest run games/magic/server/src/play/tap-before-attacks.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a permanent that can tap an attacker stops the other player’s Beginning of Combat, against real Forge'
	: `a permanent that can tap an attacker stops the other player’s Beginning of Combat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Plains', ['40 Plains']), deck('Forests', ['40 Forest'])];

const COMBAT_BEGIN = 'Beginning of Combat Step';

/** The `tappers` of every offer Forge itself sent seat 0. */
function tappersOffered(s: Scenario): number[] {
	return s.lines.flatMap((l) =>
		l.t === 'frame' && l.seat === 0 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable'
			? ((l.frame as { tappers?: { id: number }[] }).tappers ?? []).map((c) => c.id)
			: [],
	);
}

/** The empty-stack priority windows of `phase` that reached seat 0's wire. */
function stopsIn(s: Scenario, phase: string): number {
	return s.sent.filter((x) => {
		if (x.seat !== 0 || x.envelope.frame.method !== 'showPromptMessage') return false;
		const msg = (x.envelope.frame as unknown as { message: string }).message;
		return msg.startsWith('Priority:') && msg.includes(`\nPhase: ${phase}\n`) && /^Stack: Empty$/m.test(msg);
	}).length;
}

const passedIn = (s: Scenario, phase: string): boolean => s.logs.some((l) => l.evt === 'auto-passed' && l.seat === 0 && l.phase === phase);

/** A card on `of`'s battlefield, as seat 0's wire shows it. */
const card = (s: Scenario, of: number, name: string): number => {
	const id = s.zone(0, 'Battlefield', of).find((c) => c.name === name)?.id;
	if (id === undefined) throw new Error(`no ${name} on seat ${of}’s battlefield`);
	return id;
};

/**
 * The AI's turn 2 until seat 0's own turn 3 begins. Every window that reaches seat 0 is answered with
 * OK, except that with `tap` set seat 0's first Beginning of Combat stop activates Master Decoy, and
 * its target prompt is answered with Craw Wurm.
 */
async function theirTurn(name: string, tap: boolean): Promise<{ s: Scenario; tapped: boolean }> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed: 23, decks: DECKS, scenario: scenarioText(name), skipOpening: true, aiOpponent: true });
	let activated = false;
	let targeted = false;
	let answered = -1;
	await waitUntil(
		() => {
			s.answerAsks();
			const turn = s.turn(0);
			if (turn !== null && turn.n === 3) return true;
			const at = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
			if (at <= answered) return false;
			const msg = (s.sent[at]!.envelope.frame as unknown as { message: string }).message;
			if (tap && activated && !targeted && /Select target/.test(msg)) {
				answered = at;
				targeted = true;
				s.select(0, card(s, 1, 'Craw Wurm'));
				return false;
			}
			if (s.buttons(0)?.enable1 !== true) return false;
			answered = at;
			if (tap && !activated && msg.startsWith('Priority:') && msg.includes(`\nPhase: ${COMBAT_BEGIN}\n`)) {
				activated = true;
				s.select(0, card(s, 0, 'Master Decoy'));
				return false;
			}
			s.ok(0);
			return false;
		},
		"the AI's turn, to seat 0's turn 3",
		90_000,
		s,
	);
	return { s, tapped: targeted };
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'their Craw Wurm, a Master Decoy and a Plains: Beginning of Combat stops for the Decoy, and the tapped Wurm never attacks',
		async () => {
			const { s, tapped } = await theirTurn('tap-before-attacks', true);
			try {
				expect(tapped).toBe(true);
				expect(new Set(tappersOffered(s))).toEqual(new Set([card(s, 0, 'Master Decoy')]));
				expect(stopsIn(s, COMBAT_BEGIN)).toBeGreaterThan(0);
				// The step's first window was kept for the Decoy; once it is tapped the step is passed, which is right.
				const decoy = card(s, 0, 'Master Decoy');
				expect(
					s.logs.some(
						(l) => l.evt === 'prompt-forwarded' && l.seat === 0 && l.rule === 'has-play' && (l.plays as { id: number }[] | undefined)?.some((p) => p.id === decoy),
					),
				).toBe(true);
				// The Wurm was tapped before attacks, so nobody attacked and seat 0 took nothing.
				expect(stopsIn(s, 'Declare Blockers Step')).toBe(0);
				expect(s.match.live()?.life[0]).toBe(20);
				expect(s.zone(0, 'Battlefield', 1).find((c) => c.name === 'Craw Wurm')?.tapped).toBe(true);
			} catch (err) {
				console.log(`[tap-before-attacks-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		150_000,
	);

	for (const [name, why] of [
		['tap-before-attacks-unpaid', 'the Decoy’s Plains tapped, so it cannot be paid for'],
		['tap-before-attacks-no-attacker', 'their only creature already tapped, so nothing could attack'],
	] as const) {
		it(
			`${why}: Beginning of Combat is passed`,
			async () => {
				const { s } = await theirTurn(name, false);
				try {
					expect(tappersOffered(s)).toEqual([]);
					expect(stopsIn(s, COMBAT_BEGIN)).toBe(0);
					expect(passedIn(s, COMBAT_BEGIN)).toBe(true);
				} catch (err) {
					console.log(`[tap-before-attacks-timeline]\n${timeline(s, 0)}`);
					throw err;
				} finally {
					await s.stop();
				}
			},
			150_000,
		);
	}
});
