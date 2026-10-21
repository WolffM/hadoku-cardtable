/**
 * A trampler's damage, divided only when there is something to divide — against real Forge.
 *
 * The operator, 2026-10-20: *"just had a 7/7 blocked by a 6/6 and the 6/6 had to assign damage i
 * guess because it had trample? it's a bit nonsense."* Forge asks a trampler's controller to divide
 * its damage whenever it is blocked (`PlayerControllerHuman.assignCombatDamage`), even when the one
 * blocker needs all of it: Vaultborn Tyrant (6/6, trample) blocked by Atraxa, Grand Unifier (7/7)
 * has exactly one legal assignment, all six to Atraxa. That is a question with one answer, and the
 * server answers those itself (`auto.ts`'s `onlyAnswer`).
 *
 * The same attack is still a question when there is something to decide: the Tyrant blocked by
 * Grizzly Bears (2 is lethal, 4 can trample over), and the Tyrant with deathtouch (Ohran Frostfang:
 * attacking creatures you control have deathtouch) blocked by Atraxa (1 is lethal).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/da \
 *   pnpm exec vitest run apps/server/src/play/combat-damage-one-answer.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, passUntil, startScenario, toDeclareAttackers, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'combat-damage-one-answer: a trampler with nothing to divide is not asked, against real Forge'
	: `combat-damage-one-answer: a trampler with nothing to divide is not asked, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Forests', ['40 Forest']), deck('Plains', ['40 Plains'])];

/** Seat 0 holds the Tyrant (and `extra`) at its own Main 1; seat 1, a human, holds `blocker`. */
function state(blocker: string, extra = ''): string {
	return [
		'turn=1',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		'humanhand=',
		`humanbattlefield=Vaultborn Tyrant${extra === '' ? '' : `;${extra}`}`,
		'humanlibrary=Forest;Forest;Forest;Forest;Forest;Forest',
		'humangraveyard=',
		'aihand=',
		`aibattlefield=${blocker}`,
		'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
		'aigraveyard=',
	].join('\n');
}

type Outcome = { asked: boolean; why: string | null; frame: Record<string, unknown> | null };

/**
 * Attack with the Tyrant, block it with seat 1's `blocker`, and pass until combat damage is either
 * asked of seat 0 (held open, never answered) or answered by the server.
 */
async function attackInto(s: Scenario, blocker: string): Promise<Outcome> {
	await finishMulligan(s);
	await waitUntil(() => {
		s.answerAsks();
		return s.zone(0, 'Battlefield').some((c) => c.name === 'Vaultborn Tyrant' && !c.tapped && !c.sick) && s.zone(1, 'Battlefield').some((c) => c.name === blocker);
	}, 'the scenario’s Tyrant and blocker on the battlefield', 30_000, s);
	const tyrant = s.zone(0, 'Battlefield').find((c) => c.name === 'Vaultborn Tyrant')!;
	const wall = s.zone(1, 'Battlefield').find((c) => c.name === blocker)!;
	await toDeclareAttackers(s, 0);
	s.select(0, tyrant.id);
	await waitUntil(() => {
		s.answerAsks();
		return s.buttons(0)?.label2 === 'Call Back';
	}, 'the Tyrant to be declared', 10_000, s);
	s.ok(0);
	await waitUntil(() => {
		s.answerAsks();
		return /^Select creatures to block/.test(s.prompt(1)) && s.buttons(1)?.enable1 === true;
	}, 'the block window to open for seat 1', 30_000, s);
	s.select(1, wall.id);
	await waitUntil(() => {
		const view = [...s.state(1).values()].find((o) => o._type === 0 && o._id === wall.id);
		return (view?.Blocking as { v?: boolean } | undefined)?.v === true;
	}, `${blocker} to be declared blocking`, 10_000, s);
	s.ok(1);
	const asked = (): Record<string, unknown> | undefined =>
		s.sent.find((x) => x.seat === 0 && x.envelope.frame.kind === 'ask' && x.envelope.frame.method === 'assignCombatDamage')?.envelope.frame as
			| Record<string, unknown>
			| undefined;
	const auto = (): Record<string, unknown> | undefined => s.logs.find((l) => l.evt === 'ask-auto-answered' && l.method === 'assignCombatDamage');
	await passUntil(s, () => asked() !== undefined || auto() !== undefined, 'combat damage to be asked of seat 0 or answered for it', 60_000);
	const frame = asked() ?? null;
	const why = (auto()?.why as string | undefined) ?? null;
	console.log(`[da] ${blocker}: asked=${frame !== null} why=${JSON.stringify(why)} frame=${JSON.stringify(frame)}`);
	return { asked: frame !== null, why, frame };
}

const holdDamage = (f: { method?: unknown }): boolean => f.method === 'assignCombatDamage';

describe.skipIf(!available.ok)(title, () => {
	it(
		'Vaultborn Tyrant (6/6 trample) blocked by Atraxa (7/7): all six go to Atraxa, and nobody is asked',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 91, decks: DECKS, scenario: state('Atraxa, Grand Unifier'), hold: holdDamage });
			try {
				const out = await attackInto(s, 'Atraxa, Grand Unifier');
				expect(out.asked, 'the Tyrant’s controller is never asked to divide damage it cannot divide').toBe(false);
				expect(out.why).toMatch(/one/);
				const atraxa = s.zone(1, 'Battlefield').find((c) => c.name === 'Atraxa, Grand Unifier');
				await waitUntil(() => {
					s.answerAsks();
					const view = [...s.state(1).values()].find((o) => o._type === 0 && o._id === atraxa?.id);
					return (view?.Damage as { v?: number } | undefined)?.v === 6;
				}, 'Atraxa to be dealt the six', 20_000, s);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);

	it(
		'Vaultborn Tyrant blocked by Grizzly Bears: four can trample over, so seat 0 is asked',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 92, decks: DECKS, scenario: state('Grizzly Bears'), hold: holdDamage });
			try {
				const out = await attackInto(s, 'Grizzly Bears');
				expect(out.asked, 'a real division reaches the seat').toBe(true);
				expect(out.why).toBeNull();
				expect(out.frame).toMatchObject({ damage: 6 });
			} finally {
				await s.stop();
			}
		},
		180_000,
	);

	it(
		'Vaultborn Tyrant with deathtouch (Ohran Frostfang) blocked by Atraxa: one is lethal, so seat 0 is asked',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 93,
				decks: DECKS,
				scenario: state('Atraxa, Grand Unifier', 'Ohran Frostfang'),
				hold: holdDamage,
			});
			try {
				const out = await attackInto(s, 'Atraxa, Grand Unifier');
				expect(out.asked, 'a real division reaches the seat').toBe(true);
				expect(out.why).toBeNull();
				expect(out.frame).toMatchObject({ damage: 6 });
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});
