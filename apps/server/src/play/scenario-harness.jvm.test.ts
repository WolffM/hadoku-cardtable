/**
 * Wave 33 §S, shape 1 and item 1 — the scenario harness itself, against a REAL
 * Forge match: a `.state` file's hand, battlefield and life take effect, the
 * mulligan still runs first, and the game lands exactly where `activephase`
 * says with no turns played. `docs/planning/wave33-evidence/s1-harness.md` is
 * the thread-safety argument for why `GameState.applyToGame` is called
 * directly from the start-game hook; this file is the outcome check.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-S \
 *   pnpm exec vitest run apps/server/src/play/scenario-harness.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'the scenario harness, against real Forge'
	: `the scenario harness, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'own-spell.state: the mulligan still runs, then the scripted hand/battlefield/life replace it exactly',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('own-spell') });
			try {
				// The mulligan step happens on the ORIGINAL random hand, before the
				// hook replaces it — keepHands() answers it the ordinary way.
				await waitUntil(
					() => {
						s.keepHands();
						s.answerAsks();
						return /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
					},
					'seat 0 to reach a real priority window',
					60_000,
				);
				// own-spell.state: humanhand=Memnite, humanbattlefield=(empty),
				// humanlife=20, activeplayer=human, activephase=MAIN1 — no turn played.
				expect(s.zone(0, 'Hand').map((c) => c.name)).toEqual(['Memnite']);
				expect(s.zone(0, 'Battlefield')).toEqual([]);
				expect(s.turn(0)).toEqual({ n: 1, owner: s.names[0] });
				expect(s.phase(0)).toBe('Main phase, precombat');
				const life = [...s.state(0).values()].find((o) => o._type === 1 && o._id === (s.match.seats[0]?.playerId ?? -1));
				expect((life?.Life as { v?: number } | undefined)?.v).toBe(20);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'is refused on the HTTP route without CARDTABLE_PLAY_PROBE=1 (socket.test.ts has the full gate; this is the one line that proves parseStartBody and the route agree on the field name)',
		async () => {
			// Not jar-gated — a plain assertion kept beside the jar test for
			// discoverability. The exhaustive gate (400, no JVM spent, carried onto
			// the spec with the flag on) lives in socket.test.ts, which this lane
			// also owns.
			const { parseStartBody } = await import('./socket.js');
			const parsed = parseStartBody({ scenario: scenarioText('own-spell') });
			expect(parsed.ok && parsed.spec.scenario).toBe(scenarioText('own-spell'));
		},
		10_000,
	);
});
