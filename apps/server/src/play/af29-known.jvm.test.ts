/**
 * What a seat was shown, it keeps — and only while the card stays put (`visibility.ts`, "What a seat
 * was shown"). The leak side of that rule, against real Forge: a library card seat 0 was shown, then
 * shuffled away, must leave seat 0's state — and never be sent again — however long ago it was seen.
 *
 * Scenario `af29-lantern`: Lantern of Insight shows both seats bob's top card, Lightning Bolt; alice
 * sacrifices it to make bob shuffle.
 */
import { describe, expect, it } from 'vitest';

import { identifyingStrings, leaked } from './fixtures/transcript.js';
import { available, deck, finishMulligan, idsOf, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';
import { TYPE, keyOf } from './visibility.js';

const title = available.ok
	? 'a shown card stops being shown when it is shuffled away, against real Forge'
	: `a shown card stops being shown when it is shuffled away, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Known A', ['40 Mountain']), deck('Known B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		"Lantern of Insight shows seat 0 bob's top card; once bob shuffles, seat 0 holds no card of his library and is sent the name no more",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4101, decks: DECKS, scenario: scenarioText('af29-lantern') });
			try {
				await finishMulligan(s);
				await waitUntil(
					() => {
						s.answerAsks();
						return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Lantern of Insight');
					},
					'seat 0 to hold priority at its own turn-1 main phase, Lantern on the table',
					20_000,
					s,
				);
				const bob = s.match.seats[1]?.playerId as number;
				const library = (): number[] => idsOf(s.state(0).get(keyOf(TYPE.player, bob)), 'Library');
				const heldBy0 = (id: number): string[] => identifyingStrings(s.state(0), id);
				const before = library();
				const [bolt, shock] = before as [number, number];
				console.log(`[af29-known] bob's library on seat 0: ${JSON.stringify(before)}; top holds ${JSON.stringify(heldBy0(bolt))}`);
				expect(heldBy0(bolt), "Lantern shows seat 0 bob's top card").toContain('Lightning Bolt');
				expect(heldBy0(shock), 'and nothing under it').toEqual([]);

				const lantern = s.zone(0, 'Battlefield').find((c) => c.name === 'Lantern of Insight')!;
				const mark = s.sent.length;
				s.select(0, lantern.id);
				let targeted = false;
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && /target/i.test(s.prompt(0))) {
							targeted = true;
							s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: bob }, triggerEvent: null } as never);
						}
						for (const seat of [0, 1]) if (/^Stack: [1-9]/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true) s.ok(seat);
						const now = library();
						return now.length === before.length && now.some((id, i) => id !== before[i]);
					},
					"bob's library to be shuffled",
					30_000,
					s,
				);
				const after = library();
				const seat0After = s.sent
					.slice(mark)
					.filter((x) => x.seat === 0)
					.map((x) => JSON.stringify(x.envelope.frame))
					.join('\n');
				const stillHeld = after.filter((id) => heldBy0(id).length > 0);
				console.log(`[af29-known] after the shuffle: ${JSON.stringify(after)}; seat 0 holds names for ${JSON.stringify(stillHeld)}; Lantern gone=${!s.zone(0, 'Battlefield').some((c) => c.name === 'Lantern of Insight')}`);
				expect(stillHeld, 'seat 0 holds no card of the shuffled library').toEqual([]);
				expect(heldBy0(bolt), 'the Lightning Bolt it was shown included').toEqual([]);
				expect(leaked(['Shock'], seat0After), 'the card never shown is never sent').toEqual([]);
				await new Promise((r) => setTimeout(r, 1_000));
				const later = s.sent.slice(mark).filter((x) => x.seat === 0 && (x.envelope.frame.method === 'applyDelta' || x.envelope.frame.method === 'setGameView'));
				const bobKey = keyOf(TYPE.player, bob);
				/** The first packet that moves bob's library list: the shuffle. */
				const shuffledAt = later.findIndex((x) => {
					const packet = (x.envelope.frame as { payload?: { packet?: { newObjects: Record<string, object>; objectDeltas: Record<string, object> } } }).payload?.packet;
					return packet !== undefined && [packet.newObjects[bobKey], packet.objectDeltas[bobKey]].some((o) => o !== undefined && 'Library' in o);
				});
				expect(shuffledAt, 'the shuffle reached seat 0').toBeGreaterThanOrEqual(0);
				const afterShuffle = later.slice(shuffledAt + 1).map((x) => JSON.stringify(x.envelope.frame)).join('\n');
				expect(leaked(['Lightning Bolt'], afterShuffle), 'and the shuffled Lightning Bolt is never named again').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);
});
