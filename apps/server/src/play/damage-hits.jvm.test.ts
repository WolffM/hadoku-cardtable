/**
 * Damage dealt, on the wire, against real Forge.
 *
 * The operator, 2026-10-15: an opponent's Slagstorm and five creatures "instantly went to the
 * graveyard". Forge applies a sweeper and its state-based deaths before the delta is built, so a
 * creature killed by it is already in its graveyard, damage wiped, in the one frame that shows the
 * resolution: the view alone never says it was hit. The bridge sends Forge's own
 * `GameEventCardDamaged` beside the frame (`damage`). Seat 0 casts Pyroclasm (2 to each creature)
 * over its own Grizzly Bears (dies) and Hill Giant (lives) and the AI's Llanowar Elves (dies): both
 * seats must be told all three hits, from Pyroclasm, for 2, no later than the frame that buries the
 * Bears.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/damage-hits \
 *   pnpm exec vitest run apps/server/src/play/damage-hits.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'damage-hits: a sweeper’s hits reach both seats, killed creatures included, against real Forge'
	: `damage-hits: a sweeper’s hits reach both seats, killed creatures included, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Forests', ['40 Forest'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Pyroclasm',
	'humanbattlefield=Grizzly Bears;Hill Giant;Mountain;Mountain',
	'humanlibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Llanowar Elves;Forest',
	'ailibrary=Forest;Forest;Forest;Forest;Forest;Forest',
	'aigraveyard=',
].join('\n');

type Payload = { packet?: { newObjects?: Record<string, { _id?: number; Zone?: { v?: string } }>; objectDeltas?: Record<string, { _id?: number; Zone?: { v?: string } }> }; damage?: [number, number, number][] };

/** Each state frame `seat` was sent, in order, as its payload. */
function payloads(s: Scenario, seat: number): Payload[] {
	return s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify' && (x.envelope.frame as { method?: string }).method === 'applyDelta')
		.map((x) => (x.envelope.frame as unknown as { payload: Payload }).payload);
}

function buries(p: Payload, cardId: number): boolean {
	return [...Object.values(p.packet?.newObjects ?? {}), ...Object.values(p.packet?.objectDeltas ?? {})].some((o) => o._id === cardId && o.Zone?.v === 'Graveyard');
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Pyroclasm’s three hits — on the Bears it kills, the Giant it does not and the AI’s Elves — reach both seats by the frame that buries the Bears',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 82, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Pyroclasm');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const pyro = s.zone(0, 'Hand').find((c) => c.name === 'Pyroclasm')!;
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				const giant = s.zone(0, 'Battlefield').find((c) => c.name === 'Hill Giant')!;
				const elves = s.zone(1, 'Battlefield').find((c) => c.name === 'Llanowar Elves')!;
				await castNamed(s, 0, 'Pyroclasm');
				await waitUntil(() => s.zone(0, 'Graveyard').some((c) => c.id === bears.id), 'the Bears to die', 20_000, s);
				for (const seat of [0, 1]) {
					const frames = payloads(s, seat);
					const buried = frames.findIndex((p) => buries(p, bears.id));
					const hits = frames.slice(0, buried + 1).flatMap((p) => p.damage ?? []);
					console.log(`[damage-hits.jvm] seat ${seat}: buried in frame ${buried} of ${frames.length}; hits by then ${JSON.stringify(hits)}; pyroclasm #${pyro.id}, bears #${bears.id}, giant #${giant.id}, elves #${elves.id}`);
					expect(buried, `seat ${seat} was sent the frame that buries the Bears`).toBeGreaterThanOrEqual(0);
					for (const target of [bears, giant, elves]) {
						expect(hits, `seat ${seat}: Pyroclasm hit ${target.name} for 2`).toContainEqual([target.id, pyro.id, 2]);
					}
					expect(frames.flatMap((p) => p.damage ?? []), `seat ${seat}: each hit told once`).toHaveLength(3);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
