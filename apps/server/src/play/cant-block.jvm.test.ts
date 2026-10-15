/**
 * Which creatures can't block, on the wire, against real Forge.
 *
 * The operator, 2026-10-15: "would be nice if we had an indicator for can't block". Forge's view has
 * no property for it: the engine decides it in `CombatUtil.canBlock(Card, boolean)`. Seat 0 holds a
 * Bloodghast (its own "can't block"), a Llanowar Elves wearing Pacifism ("can't attack or block"),
 * a tapped Hill Giant and a plain Grizzly Bears. Both seats must be told the first two can't block,
 * and neither of the others: a tapped creature is not one that can't block.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/cant-block \
 *   pnpm exec vitest run apps/server/src/play/cant-block.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'cant-block: the frame names the creatures that can’t block, against real Forge'
	: `cant-block: the frame names the creatures that can’t block, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Swamps', ['40 Swamp']), deck('Plains', ['40 Plains'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Bloodghast;Llanowar Elves|Id:101;Pacifism|AttachedTo:101;Hill Giant|Tapped;Grizzly Bears;Swamp',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

/** The latest `cantBlock` snapshot `seat` was sent, or null when none has been. */
function latestCantBlock(s: Scenario, seat: number): number[] | null {
	const snapshots = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { cantBlock?: number[] } }).payload?.cantBlock)
		.filter((p): p is number[] => Array.isArray(p));
	return snapshots.at(-1) ?? null;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Bloodghast and a Pacified Llanowar Elves are named for both seats; a tapped Hill Giant and a plain Grizzly Bears are not',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 81, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Bloodghast');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const ghast = board.find((c) => c.name === 'Bloodghast')!;
				const giant = board.find((c) => c.name === 'Hill Giant')!;
				const pacified = board.find((c) => c.name === 'Llanowar Elves')!;
				const plain = board.find((c) => c.name === 'Grizzly Bears')!;
				for (const seat of [0, 1]) {
					const named = latestCantBlock(s, seat);
					const names = board.filter((c) => named?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
					console.log(`[cb-cant-block.jvm] seat ${seat}: cantBlock=${JSON.stringify(named)} → [${names.join(', ')}]; bloodghast #${ghast.id}, pacified elves #${pacified.id}, plain bears #${plain.id}, tapped giant #${giant.id}`);
					expect(named, `seat ${seat} was sent a cantBlock snapshot`).not.toBeNull();
					expect(named, `seat ${seat}: Bloodghast can't block`).toContain(ghast.id);
					expect(named, `seat ${seat}: the Pacified Llanowar Elves can't block`).toContain(pacified.id);
					expect(named, `seat ${seat}: the plain Grizzly Bears can block`).not.toContain(plain.id);
					expect(named, `seat ${seat}: a tapped Hill Giant is not one that can't block`).not.toContain(giant.id);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
