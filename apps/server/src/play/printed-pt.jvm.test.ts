/**
 * Which creatures' power and toughness are not the printed ones, on the wire, against real Forge.
 *
 * The operator, 2026-10-17: "creature gave +1/0 to enhance a creatures power, it should have shown the
 * number in green if the stats have been changed." The view carries only the current numbers; the
 * board knew a printed base only for the drafted cube's own cards, so a constructed deck's buffed
 * creature drew plain. The bridge's `printedPT` names Forge's own printed base for every battlefield
 * creature whose numbers differ.
 *
 * Seat 0 controls Glorious Anthem (+1/+1 to its creatures), Grizzly Bears and Tarmogoyf; seat 1
 * controls Grizzly Bears of its own. Both seats must be told seat 0's Bears was printed 2/2 (it is
 * 3/3); neither seat 1's unbuffed Bears nor Tarmogoyf (its `*` is no printed number) is named.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/printed-pt \
 *   pnpm exec vitest run apps/server/src/play/printed-pt.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'printed-pt: the frame names each changed creature’s printed power and toughness, against real Forge'
	: `printed-pt: the frame names each changed creature’s printed power and toughness, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Forests', ['40 Forest']), deck('Plains', ['40 Plains'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Glorious Anthem;Grizzly Bears;Tarmogoyf;Forest',
	'humanlibrary=Forest;Forest;Forest;Forest;Forest;Forest',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Grizzly Bears',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

/** The latest `printedPT` snapshot `seat` was sent, as a map, or null when none has been. */
function latestPrintedPT(s: Scenario, seat: number): Map<number, [number, number]> | null {
	const snapshots = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { printedPT?: [number, number, number][] } }).payload?.printedPT)
		.filter((p): p is [number, number, number][] => Array.isArray(p));
	const last = snapshots.at(-1);
	return last === undefined ? null : new Map(last.map(([id, p, t]) => [id, [p, t]]));
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'an anthem’s Grizzly Bears was printed 2/2, on both sides; an unbuffed Bears and a Tarmogoyf are not named',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 86, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Tarmogoyf');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				const goyf = s.zone(0, 'Battlefield').find((c) => c.name === 'Tarmogoyf')!;
				const theirs = s.zone(1, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				await waitUntil(() => {
					s.answerAsks();
					return [0, 1].every((seat) => latestPrintedPT(s, seat)?.has(bears.id) === true);
				}, 'both seats to be sent a printedPT snapshot naming the buffed Bears', 10_000, s).catch(() => undefined);
				for (const seat of [0, 1]) {
					const printed = latestPrintedPT(s, seat);
					console.log(`[printed-pt.jvm] seat ${seat}: printedPT ${JSON.stringify([...(printed ?? [])])}; bears #${bears.id}, goyf #${goyf.id}, theirs #${theirs.id}`);
					expect(printed, `seat ${seat} was sent a printedPT snapshot`).not.toBeNull();
					expect(printed!.get(bears.id), `seat ${seat}: the anthem’s Bears was printed 2/2`).toEqual([2, 2]);
					expect(printed!.has(theirs.id), `seat ${seat}: an unbuffed Bears is not named`).toBe(false);
					expect(printed!.has(goyf.id), `seat ${seat}: Tarmogoyf’s * is no printed number`).toBe(false);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
