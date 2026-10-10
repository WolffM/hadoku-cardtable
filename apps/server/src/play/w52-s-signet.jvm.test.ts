/**
 * Wave 52 §S, item 2 — a seat holding a Signet and nothing castable is auto-passed
 * exactly where a land-only seat is (`auto-pass-land.jvm.test.ts`), against real
 * Forge with w52's jar.
 *
 * The blast radius this guards: w52's fork commit offers a mana ability that also
 * costs mana (Azorius Signet, `{1},{T}`) at priority. A Signet is not a land, so
 * `decideStop`'s "nothing but lands is actionable" pass would have become a stop in
 * every priority window for a seat holding one. The bridge now names the offered
 * cards whose every playable ability is a mana ability (`setWeaklySelectable.
 * manaOnly`), and `nonManaSources` leaves them out.
 *
 * `scenarios/w52-s-signet.state`: seat 0 casts Raging Goblin; seat 1 holds an empty
 * hand, Azorius Signet and two Islands. Seat 1 never acts. The test asserts its
 * stack window's offer named the Signet (the new jar), that every offered card was
 * a mana source, that the server passed it, and that the Goblin resolved.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/w52-s \
 *   pnpm exec vitest run apps/server/src/play/w52-s-signet.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, type WireObj } from './visibility.js';

const title = available.ok
	? 'wave 52 §S: a seat holding a Signet and nothing castable is passed like a land-only seat, against real Forge'
	: `wave 52 §S: a seat holding a Signet and nothing castable is passed like a land-only seat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Islands', ['40 Island'])];

function stackIds(s: Scenario, seat: number): number[] {
	const game = [...s.state(seat).values()].find((o: WireObj) => o._type === TYPE.game);
	return idsOf(game, 'Stack');
}

type Offer = { cards: { id: number }[]; manaOnly?: { id: number }[] };

/** The cards Forge offers `seat` now: its last `setWeaklySelectable`, none after a `clearWeaklySelectable`. */
function offeredTo(s: Scenario, seat: number): number[] {
	const last = [...s.lines]
		.reverse()
		.find((l) => l.t === 'frame' && l.seat === seat && /^(set|clear)WeaklySelectable$/.test(String((l.frame as { method?: unknown } | null)?.method)));
	const frame = (last as { frame?: unknown } | undefined)?.frame as ({ method: string } & Partial<Offer>) | undefined;
	return frame?.method === 'setWeaklySelectable' ? (frame.cards ?? []).map((c) => c.id) : [];
}

describe.skipIf(!available.ok)(title, () => {
	it(
		"seat 1's window with seat 0's spell on the stack offers the Signet, and is auto-passed without seat 1 acting",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 52, decks: DECKS, scenario: scenarioText('w52-s-signet') });
			try {
				await finishMulligan(s);
				const logsBefore = s.logs.length;
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Raging Goblin');
					},
					"seat 0's scripted Raging Goblin",
					20_000,
					s,
				);
				const goblin = s.zone(0, 'Hand').find((c) => c.name === 'Raging Goblin');
				if (goblin === undefined) throw new Error('no Raging Goblin in hand');
				// One select, sent once Forge's own offer names the Goblin — the scenario-start
				// race (`PlayBridge.java`'s `refreshActionable`) is over then. Never a retry: a
				// second `selectCard` sent while Forge still handles the first runs beside it on
				// another thread (`GameProtocolHandler`, `FThreads.invokeInBackgroundThread`),
				// and on main's 38013980995 that left a view's property map unserializable —
				// every later `getAbilityToPlay` failed to encode (`ArrayIndexOutOfBounds… 214`)
				// and the Goblin never reached the stack.
				await waitUntil(() => { s.answerAsks(); return offeredTo(s, 0).includes(goblin.id); }, 'Forge offers seat 0 the Goblin', 20_000, s);
				s.select(0, goblin.id);
				const payLand = landPayer(s, 0);
				await waitUntil(
					() => {
						s.answerAsks();
						payLand();
						return stackIds(s, 0).length > 0;
					},
					"seat 0's Raging Goblin to reach the stack",
					45_000,
					s,
				);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Raging Goblin');
					},
					'Raging Goblin to resolve without any act from seat 1',
					20_000,
					s,
				);

				const signet = s.zone(1, 'Battlefield').find((c) => c.name === 'Azorius Signet');
				expect(signet, 'seat 1 controls the scripted Signet').toBeDefined();
				// this window is auto-passed (asserted below), so `match.ts`
				// withholds its `showPromptMessage` whole — read `s.lines` (the raw
				// bridge stream), not `s.sent` (this seat's own wire), for the same
				// reason `auto-pass-land.jvm.test.ts` and `w52-s-augur.jvm.test.ts` do.
				// `setWeaklySelectable` is never withheld, so it is unmoved either way.
				const windowAt = s.lines.findIndex(
					(l) =>
						l.t === 'frame' &&
						l.seat === 1 &&
						(l.frame as { method?: unknown } | null)?.method === 'showPromptMessage' &&
						/Stack: 1 to Resolve/.test((l.frame as { message?: string }).message ?? ''),
				);
				expect(windowAt, "seat 1 was shown a window with seat 0's spell on the stack").toBeGreaterThanOrEqual(0);
				const nextAt = s.lines.findIndex(
					(l, i) => i > windowAt && l.t === 'frame' && l.seat === 1 && (l.frame as { method?: unknown } | null)?.method === 'showPromptMessage',
				);
				const offer = [...s.lines.slice(0, nextAt === -1 ? s.lines.length : nextAt)]
					.reverse()
					.find((l) => l.t === 'frame' && l.seat === 1 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable') as
					| { frame: Offer }
					| undefined;
				const offered = offer?.frame.cards.map((c) => c.id) ?? [];
				expect(offered, 'the new jar offers the Signet at priority').toContain(signet?.id);
				expect(new Set(offer?.frame.manaOnly?.map((c) => c.id))).toEqual(new Set(offered));
				expect(s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' && l.seat === 1).length).toBeGreaterThan(0);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
