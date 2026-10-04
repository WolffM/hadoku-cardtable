/**
 * Wave 37 §A — a scenario starts the same way every time. Against a REAL Forge jar,
 * start `lone-spell` (Memnite, seat 1) and `bolt-player` (Lightning Bolt, seat 0) over
 * and over, and require that every actionable set the seat is sent — from the scenario's
 * own push in the start-game hook through its first priority window — names the scripted
 * card.
 *
 * The race this guards (cause and file:line in `docs/planning/wave37-evidence/A-repro.md`):
 * the in-JVM Forge client resolves a frame's card references on its netty thread at
 * DECODE time, while the delta that creates the scenario's new cards is applied later on
 * the seat's `seat-N-ui` thread. A `setWeaklySelectable` decoded before that delta is
 * applied arrives with its cards dropped — the empty first window CI kept failing on.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-start.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 *
 * `CARDTABLE_SCENARIO_START_RUNS` (default 10) is the starts per scenario; the mutation
 * proof in A-repro.md ran 50 per scenario. Starts run one at a time: `Scenario.stop()`
 * waits for the PROCESS's live-JVM count to reach zero, so two matches in one process
 * would each wait on the other. Load comes from running several processes at once.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a scenario start, against real Forge'
	: `a scenario start, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

const RUNS = Number(process.env.CARDTABLE_SCENARIO_START_RUNS ?? '10');

interface Case {
	readonly scenario: string;
	readonly seat: 0 | 1;
	readonly card: string;
}

const CASES: readonly Case[] = [
	{ scenario: 'lone-spell', seat: 1, card: 'Memnite' },
	{ scenario: 'bolt-player', seat: 0, card: 'Lightning Bolt' },
];

interface Outcome {
	readonly label: string;
	/** Every `setWeaklySelectable` the seat was sent up to its first priority window, as card-id lists. */
	readonly pushes: number[][];
	/** Whether the push the first priority window shows (the last one) names the card. */
	readonly windowOk: boolean;
	/** Whether EVERY push up to that window names it. */
	readonly allOk: boolean;
	readonly error?: string;
}

async function startOnce(c: Case, seed: number): Promise<Outcome> {
	if (!available.ok) throw new Error('unreachable: caller checks available.ok');
	const label = `${c.scenario} seed ${seed}`;
	const s: Scenario = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText(c.scenario) });
	try {
		await finishMulligan(s);
		try {
			await waitUntil(
				() => {
					s.answerAsks();
					return inOwnMain(s, c.seat, 1);
				},
				`seat ${c.seat}'s first priority window`,
				90_000,
				s,
			);
		} catch (err) {
			const where = [0, 1].map((seat) => `seat ${seat}: ${JSON.stringify(s.prompt(seat))} ${JSON.stringify(s.buttons(seat))}`).join('; ');
			return { label, pushes: [], windowOk: false, allOk: false, error: `${err instanceof Error ? err.message : String(err)} — ${where}` };
		}
		const card = s.zone(c.seat, 'Hand').find((x) => x.name === c.card);
		if (card === undefined) {
			return { label, pushes: [], windowOk: false, allOk: false, error: `no ${c.card} in seat ${c.seat}'s hand at its first priority window` };
		}
		const pushes = s.sent
			.filter((x) => x.seat === c.seat && x.envelope.frame.method === 'setWeaklySelectable')
			.map((x) => (x.envelope.frame as unknown as { cards: { id: number }[] }).cards.map((r) => r.id));
		const names = (ids: number[]): boolean => ids.includes(card.id);
		return {
			label,
			pushes,
			windowOk: pushes.length > 0 && names(pushes[pushes.length - 1] ?? []),
			allOk: pushes.length > 0 && pushes.every(names),
		};
	} finally {
		await s.stop();
	}
}

async function runAll(c: Case): Promise<Outcome[]> {
	const out: Outcome[] = [];
	for (let i = 0; i < RUNS; i++) out.push(await startOnce(c, 1000 + i));
	return out;
}

describe.skipIf(!available.ok)(title, () => {
	for (const c of CASES) {
		it(
			`${c.scenario}: every actionable set seat ${c.seat} is sent through its first priority window names ${c.card}, ${RUNS} starts`,
			async () => {
				const results = await runAll(c);
				const windowLost = results.filter((r) => !r.windowOk);
				const pushLost = results.filter((r) => !r.allOk);
				console.log(
					`[scenario-start] ${c.scenario}: ${results.length} starts, first window lost ${windowLost.length}, any push lost ${pushLost.length}` +
						pushLost.map((r) => `\n  ${r.label}: ${r.error ?? r.pushes.map((p) => `[${p.join(',')}]`).join(' ')}`).join(''),
				);
				expect(results).toHaveLength(RUNS);
				expect(windowLost.map((r) => r.label)).toEqual([]);
				expect(pushLost.map((r) => r.label)).toEqual([]);
			},
			RUNS * 120_000,
		);
	}
});
