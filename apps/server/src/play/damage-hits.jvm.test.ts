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
 * Damage to a player rides beside it as `faceDamage` (Forge's `GameEventPlayerDamaged`): the life
 * total says how much, never who dealt it, and a creature's attack is drawn as that creature ramming
 * its player. Flame Rift (4 to each player) must reach both seats as one hit on each player, from
 * Flame Rift, for 4, not combat.
 *
 * Combat damage to a planeswalker is a hit on a card too, though Forge fires no `GameEventCardDamaged`
 * for it (the bridge's `countersLost`): the operator, 2026-10-17, "make sure that works when attacking
 * planeswalkers also"; "cover spells too". Seat 0's Grizzly Bears attacks the AI's Jace Beleren, and
 * apart, seat 0's Lightning Bolt targets Jace: both seats must be told one hit on Jace, from the Bears for 2,
 * from the Bolt for 3.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/damage-hits \
 *   pnpm exec vitest run apps/server/src/play/damage-hits.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, finishMulligan, inOwnMain, landPayer, startScenario, waitUntil, type Scenario } from './scenario.js';

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

type Payload = {
	packet?: { newObjects?: Record<string, { _id?: number; Zone?: { v?: string } }>; objectDeltas?: Record<string, { _id?: number; Zone?: { v?: string } }> };
	damage?: [number, number, number][];
	faceDamage?: [number, number, number, boolean][];
};

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

	it(
		'Flame Rift’s hit on each player reaches both seats as faceDamage, from Flame Rift, for 4, not combat',
		async () => {
			if (!available.ok) return;
			const state = STATE.replace('humanhand=Pyroclasm', 'humanhand=Flame Rift');
			const s = await startScenario(available.config, { seed: 83, decks: DECKS, scenario: state });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Flame Rift');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const rift = s.zone(0, 'Hand').find((c) => c.name === 'Flame Rift')!;
				await castNamed(s, 0, 'Flame Rift');
				await waitUntil(() => {
					s.answerAsks();
					return [0, 1].every((seat) => payloads(s, seat).flatMap((p) => p.faceDamage ?? []).length >= 2);
				}, 'both seats to be told both hits', 20_000, s);
				for (const seat of [0, 1]) {
					const hits = payloads(s, seat).flatMap((p) => p.faceDamage ?? []);
					console.log(`[damage-hits.jvm] seat ${seat}: faceDamage ${JSON.stringify(hits)}; flame rift #${rift.id}`);
					expect(hits, `seat ${seat}: one hit on each player, each told once`).toHaveLength(2);
					expect(new Set(hits.map(([player]) => player)).size, `seat ${seat}: two different players`).toBe(2);
					for (const h of hits) expect(h.slice(1), `seat ${seat}: from Flame Rift, for 4, not combat`).toEqual([rift.id, 4, false]);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Grizzly Bears attacking Jace Beleren: the hit on Jace reaches both seats, from the Bears, for 2, once',
		async () => {
			if (!available.ok) return;
			const state = STATE.replace('humanhand=Pyroclasm', 'humanhand=')
				.replace('humanbattlefield=Grizzly Bears;Hill Giant;Mountain;Mountain', 'humanbattlefield=Grizzly Bears;Mountain')
				.replace('aibattlefield=Llanowar Elves;Forest', 'aibattlefield=Jace Beleren|Counters:LOYALTY=5;Forest');
			const s = await startScenario(available.config, { seed: 84, decks: DECKS, scenario: state });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return s.zone(0, 'Battlefield').some((c) => c.name === 'Grizzly Bears' && !c.tapped && !c.sick) && s.zone(1, 'Battlefield').some((c) => c.name === 'Jace Beleren');
				}, 'the scenario’s Bears and Jace on the battlefield', 30_000, s);
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				const jace = s.zone(1, 'Battlefield').find((c) => c.name === 'Jace Beleren')!;
				let pressedMain1 = false;
				await waitUntil(() => {
					s.answerAsks();
					if (/^Select creatures to attack/.test(s.prompt(0))) return true;
					const msg = s.prompt(0);
					if (!pressedMain1 && /^Priority:/.test(msg) && /Main phase, precombat/.test(msg) && s.buttons(0)?.enable1 === true) {
						pressedMain1 = true;
						s.ok(0);
					}
					return false;
				}, 'Forge’s declare-attackers window to open', 20_000, s);
				// Jace first, as the defender (`InputAttack.java:225-230`), then the Bears at it.
				s.select(0, jace.id);
				s.select(0, bears.id);
				await waitUntil(() => {
					s.answerAsks();
					return s.buttons(0)?.label2 === 'Call Back';
				}, 'the Bears to be declared', 10_000, s);
				s.ok(0);
				await waitUntil(() => {
					s.answerAsks();
					return [0, 1].every((seat) => payloads(s, seat).some((p) => (p.damage ?? []).some(([target]) => target === jace.id)));
				}, 'both seats to be told the hit on Jace', 30_000, s);
				for (const seat of [0, 1]) {
					const hits = payloads(s, seat).flatMap((p) => p.damage ?? []);
					console.log(`[damage-hits.jvm] seat ${seat}: damage ${JSON.stringify(hits)}; bears #${bears.id}, jace #${jace.id}`);
					expect(hits, `seat ${seat}: one hit, on Jace, from the Bears, for 2`).toEqual([[jace.id, bears.id, 2]]);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Lightning Bolt at Jace Beleren: the hit on Jace reaches both seats, from the Bolt, for 3, once',
		async () => {
			if (!available.ok) return;
			const state = STATE.replace('humanhand=Pyroclasm', 'humanhand=Lightning Bolt')
				.replace('humanbattlefield=Grizzly Bears;Hill Giant;Mountain;Mountain', 'humanbattlefield=Mountain')
				.replace('aibattlefield=Llanowar Elves;Forest', 'aibattlefield=Jace Beleren|Counters:LOYALTY=5;Forest');
			const s = await startScenario(available.config, { seed: 85, decks: DECKS, scenario: state });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Lightning Bolt') && s.zone(1, 'Battlefield').some((c) => c.name === 'Jace Beleren');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const bolt = s.zone(0, 'Hand').find((c) => c.name === 'Lightning Bolt')!;
				const jace = s.zone(1, 'Battlefield').find((c) => c.name === 'Jace Beleren')!;
				const pay = landPayer(s, 0);
				let targeted = false;
				s.select(0, bolt.id);
				await waitUntil(() => {
					s.answerAsks();
					// Forge asks "Select any target" for Lightning Bolt.
					if (!targeted && /Select (?:any )?target/.test(s.prompt(0))) {
						targeted = true;
						s.select(0, jace.id);
					}
					pay();
					return [0, 1].every((seat) => payloads(s, seat).some((p) => (p.damage ?? []).some(([target]) => target === jace.id)));
				}, 'both seats to be told the Bolt’s hit on Jace', 30_000, s);
				for (const seat of [0, 1]) {
					const hits = payloads(s, seat).flatMap((p) => p.damage ?? []);
					console.log(`[damage-hits.jvm] seat ${seat}: damage ${JSON.stringify(hits)}; bolt #${bolt.id}, jace #${jace.id}`);
					expect(hits, `seat ${seat}: one hit, on Jace, from the Bolt, for 3`).toEqual([[jace.id, bolt.id, 3]]);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
