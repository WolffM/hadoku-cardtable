/**
 * The operator, 2026-10-24, against real Forge: *"unecessary stops during end step and combat. i guess
 * it was because inkmoth nexus was activatable, but it was already tapped so it wouldn't have been able
 * to do anything"*, and of the Beginning of Combat stop: *"this stop IS useful for man-lands, but it's
 * not useful if the ability isn't even castable. same with when i only have one mana and i can make
 * inkmoth a creature, but it has to tap itself to do it so it wouldn't be able to block."*
 *
 * An ability whose only effect is to make its own permanent a creature is a play only while that
 * creature could still attack (its controller's turn, before attackers) or block (the other turn,
 * before blockers), untapped, not already that creature, and paid without tapping it. The fork's scan
 * decides it once (`AvailableActions.Scan#animates`), for the stop on the seat's own Beginning of
 * Combat and for "has a play" alike.
 *
 * How the scan pays: `ComputerUtilMana.chooseManaAbility` never picks a mana ability of the card being
 * paid for, so an Inkmoth Nexus with no other source is unaffordable to the scan already; the
 * self-paid cases pin that.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/animate \
 *   pnpm exec vitest run apps/server/src/play/animate-self.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'an ability that makes its own permanent a creature stops only where that creature could fight, against real Forge'
	: `an ability that makes its own permanent a creature stops only where that creature could fight, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Forests', ['40 Forest'])];

const ANIMATE = /becomes a 1\/1/;

/** The `animates` of every offer Forge itself sent seat 0. */
function animatesOffered(s: Scenario): number[] {
	return s.lines.flatMap((l) =>
		l.t === 'frame' && l.seat === 0 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable'
			? ((l.frame as { animates?: { id: number }[] }).animates ?? []).map((c) => c.id)
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

const inkmoth = (s: Scenario): number => {
	const id = s.zone(0, 'Battlefield').find((c) => c.name === 'Inkmoth Nexus')?.id;
	if (id === undefined) throw new Error('no Inkmoth Nexus on seat 0’s battlefield');
	return id;
};

/** Pick the animation out of a click's ability list. */
const pickAnimate = (f: Record<string, unknown>): unknown =>
	f.method === 'getAbilityToPlay' ? ((f.abilities as { label?: string }[]).find((a) => ANIMATE.test(a.label ?? '')) ?? null) : undefined;

/** Seat 0's own Main 1, then OK: Beginning of Combat either reaches the seat or is passed by the server. */
async function ownCombat(name: string): Promise<{ s: Scenario; stopped: boolean }> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed: 23, decks: DECKS, scenario: scenarioText(name) });
	await finishMulligan(s);
	await waitUntil(
		() => {
			s.answerAsks();
			return inOwnMain(s, 0, 1);
		},
		"seat 0's own Main 1",
		60_000,
		s,
	);
	s.ok(0);
	await waitUntil(
		() => {
			s.answerAsks();
			return stopsIn(s, 'Beginning of Combat Step') > 0 || passedIn(s, 'Beginning of Combat Step');
		},
		"seat 0's Beginning of Combat, stopped or passed",
		60_000,
		s,
	);
	return { s, stopped: stopsIn(s, 'Beginning of Combat Step') > 0 };
}

/**
 * The AI's turn 2 until seat 0's own turn 3 begins. Every window that reaches seat 0 is answered
 * with OK (a declaration with nothing declared), except that `animateAt` seat 0's first stop in that
 * phase activates Inkmoth Nexus's animation instead.
 */
async function theirTurn(name: string, animateAt?: string): Promise<Scenario> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed: 23, decks: DECKS, scenario: scenarioText(name), skipOpening: true, aiOpponent: true, reply: pickAnimate });
	let animated = false;
	let answered = -1;
	await waitUntil(
		() => {
			s.answerAsks();
			const turn = s.turn(0);
			if (turn !== null && turn.n === 3) return true;
			const at = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
			if (at <= answered || s.buttons(0)?.enable1 !== true) return false;
			const msg = (s.sent[at]!.envelope.frame as unknown as { message: string }).message;
			answered = at;
			if (!animated && animateAt !== undefined && msg.startsWith('Priority:') && msg.includes(`\nPhase: ${animateAt}\n`)) {
				animated = true;
				s.select(0, inkmoth(s));
				return false;
			}
			s.ok(0);
			return false;
		},
		"the AI's turn, to seat 0's turn 3",
		90_000,
		s,
	);
	if (animateAt !== undefined) expect(animated).toBe(true);
	return s;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'a tapped Inkmoth Nexus and a Mountain: Beginning of Combat is passed, and the Inkmoth is no play',
		async () => {
			const { s, stopped } = await ownCombat('animate-tapped');
			try {
				expect(stopped).toBe(false);
				expect(animatesOffered(s)).toEqual([]);
			} catch (err) {
				console.log(`[animate-self-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'an untapped Inkmoth Nexus and no other source: Beginning of Combat is passed',
		async () => {
			const { s, stopped } = await ownCombat('animate-self-paid');
			try {
				expect(stopped).toBe(false);
				expect(animatesOffered(s)).toEqual([]);
			} catch (err) {
				console.log(`[animate-self-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'the control — an untapped Inkmoth Nexus and a Mountain: Beginning of Combat stops, for the Inkmoth',
		async () => {
			const { s, stopped } = await ownCombat('animate-control');
			try {
				expect(stopped).toBe(true);
				expect(new Set(animatesOffered(s))).toEqual(new Set([inkmoth(s)]));
			} catch (err) {
				console.log(`[animate-self-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'their attack, an Inkmoth Nexus and two Mountains: Declare Attackers stops for a block, and after the block and in the End step it is no play',
		async () => {
			const s = await theirTurn('animate-their-turn');
			try {
				expect(stopsIn(s, 'Declare Attackers Step')).toBe(1);
				expect(stopsIn(s, 'Declare Blockers Step')).toBe(0);
				expect(stopsIn(s, 'End step')).toBe(0);
				expect(passedIn(s, 'End step')).toBe(true);
			} catch (err) {
				console.log(`[animate-self-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		150_000,
	);

	it(
		'their attack, the Inkmoth Nexus animated in Declare Attackers: once it is a creature, its ability is no play',
		async () => {
			const s = await theirTurn('animate-their-turn', 'Declare Attackers Step');
			try {
				expect(stopsIn(s, 'Declare Attackers Step')).toBe(1);
				expect(stopsIn(s, 'Declare Blockers Step')).toBe(0);
				expect(stopsIn(s, 'End step')).toBe(0);
			} catch (err) {
				console.log(`[animate-self-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		150_000,
	);

	it(
		'their attack, an Inkmoth Nexus and no other source: no window of their turn stops for it',
		async () => {
			const s = await theirTurn('animate-their-turn-self-paid');
			try {
				expect(stopsIn(s, 'Declare Attackers Step')).toBe(0);
				expect(stopsIn(s, 'Declare Blockers Step')).toBe(0);
				expect(stopsIn(s, 'End step')).toBe(0);
			} catch (err) {
				console.log(`[animate-self-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});
