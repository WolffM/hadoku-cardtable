/**
 * A library search is not a reveal (`visibility.ts`, `learn`). The operator, 2026-11-11: *"oracle of mul daya -
 * opponent can see revealed top of deck, but i can't see it."* A fetchland's search asks with a `delayedReveal`
 * of the WHOLE library; kept as a reveal, the shuffle after it was unreadable (every card in it was looked at),
 * so the searcher went on knowing every card in its library — and the board, which reads a whole library known
 * as a search still open (`apps/ui/src/play/adapter.ts`, `knownTop`), drew no top for the owner while the
 * opponent, told only Oracle's top card, saw it. Against real Forge: alice cracks Misty Rainforest with Oracle
 * of Mul Daya out; after the shuffle each seat names exactly one card of her library, the top one.
 */
import { describe, expect, it } from 'vitest';

import { DELTA_TYPE, deltaKey, idsOf } from '@hadoku/forge-wire';

import { identifyingStrings } from './fixtures/transcript.js';
import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'a library search is not kept as a reveal, against real Forge'
	: `a library search is not kept as a reveal, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Top A', ['40 Island']), deck('Top B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		"Oracle of Mul Daya after a fetch: each seat names alice's top card and no other card of her library",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4401, decks: DECKS, scenario: scenarioText('oracle-top-revealed') });
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'seat 0 to hold priority at its own turn-1 main phase', 20_000, s);
				const alice = s.match.seats[0]?.playerId as number;
				const misty = s.zone(0, 'Battlefield').find((c) => c.name === 'Misty Rainforest')!;
				s.select(0, misty.id);
				let searched = false;
				await waitUntil(
					() => {
						searched ||= s.answerAsks().some((f) => f.method === 'chooseSingleEntityForEffect');
						for (const seat of [0, 1]) if (/^Stack: [1-9]/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true) s.ok(seat);
						return searched && !s.zone(0, 'Battlefield').some((c) => c.id === misty.id) && /^Stack: Empty$/m.test(s.prompt(0));
					},
					'the fetch to resolve',
					30_000,
					s,
				);
				const libraryOf = (seat: number): number[] => idsOf(s.state(seat).get(deltaKey(DELTA_TYPE.player, alice)), 'Library');
				await waitUntil(() => [0, 1].every((seat) => libraryOf(seat).length === 5), "both seats to hold alice's library after the fetch", 10_000, s);
				const library = libraryOf(0);
				await everySeatNamesTop(s, alice, library[0]!);
				for (const seat of [0, 1]) {
					const state = s.state(seat);
					const named = library.filter((id) => identifyingStrings(state, id).length > 0);
					expect(named, `seat ${seat} names only alice's top card`).toEqual([library[0]]);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

async function everySeatNamesTop(s: Awaited<ReturnType<typeof startScenario>>, holder: number, top: number): Promise<void> {
	await waitUntil(
		() => [0, 1].every((seat) => idsOf(s.state(seat).get(deltaKey(DELTA_TYPE.player, holder)), 'Library')[0] === top && identifyingStrings(s.state(seat), top).length > 0),
		"both seats to name alice's top card",
		10_000,
		s,
	);
}
