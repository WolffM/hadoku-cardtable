/**
 * Why a permanent died, on the wire, against real Forge.
 *
 * The operator, 2026-10-15: "forge should tell the cause, that's an engine improvement to make". The
 * fork fires `GameEventCardDied(card, cause)` once a permanent has gone to its graveyard (pin
 * b6b2deff), and the bridge sends it beside the frame as `deaths`. Seat 0 casts Pyroclasm (2 to each
 * creature) over its own Grizzly Bears (dies: lethal damage) and Hill Giant (lives), then Wrath of God
 * (destroy all creatures) over the Giant and the AI's Hill Giant: both seats must be told the Bears
 * died of LETHAL_DAMAGE and the two Giants were DESTROYED.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/death-causes \
 *   pnpm exec vitest run apps/server/src/play/death-causes.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'death-causes: why each permanent died reaches both seats, against real Forge'
	: `death-causes: why each permanent died reaches both seats, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['20 Mountain', '20 Plains']), deck('Forests', ['40 Forest'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Pyroclasm;Wrath of God',
	'humanbattlefield=Grizzly Bears;Hill Giant;Mountain;Mountain;Plains;Plains;Plains;Plains',
	'humanlibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Hill Giant;Forest',
	'ailibrary=Forest;Forest;Forest;Forest;Forest;Forest',
	'aigraveyard=',
].join('\n');

/** Every `[cardId, cause]` `seat` was sent, in order. */
function deaths(s: Scenario, seat: number): [number, string][] {
	return s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.flatMap((x) => (x.envelope.frame as unknown as { payload?: { deaths?: [number, string][] } }).payload?.deaths ?? []);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Pyroclasm’s Bears died of LETHAL_DAMAGE; Wrath of God’s two Hill Giants were DESTROYED — on both seats',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 83, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Wrath of God');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				const giant = s.zone(0, 'Battlefield').find((c) => c.name === 'Hill Giant')!;
				const theirGiant = s.zone(1, 'Battlefield').find((c) => c.name === 'Hill Giant')!;
				await castNamed(s, 0, 'Pyroclasm');
				await waitUntil(() => s.zone(0, 'Graveyard').some((c) => c.id === bears.id), 'the Bears to die', 20_000, s);
				await castNamed(s, 0, 'Wrath of God');
				await waitUntil(() => s.zone(0, 'Graveyard').some((c) => c.id === giant.id) && s.zone(1, 'Graveyard').some((c) => c.id === theirGiant.id), 'both Giants to die', 20_000, s);
				for (const seat of [0, 1]) {
					const told = deaths(s, seat);
					console.log(`[death-causes.jvm] seat ${seat}: deaths ${JSON.stringify(told)}; bears #${bears.id}, giant #${giant.id}, their giant #${theirGiant.id}`);
					expect(told, `seat ${seat}: the Bears died of lethal damage`).toContainEqual([bears.id, 'LETHAL_DAMAGE']);
					expect(told, `seat ${seat}: seat 0's Hill Giant was destroyed`).toContainEqual([giant.id, 'DESTROYED']);
					expect(told, `seat ${seat}: the AI's Hill Giant was destroyed`).toContainEqual([theirGiant.id, 'DESTROYED']);
					expect(told, `seat ${seat}: each death told once`).toHaveLength(3);
				}
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});
