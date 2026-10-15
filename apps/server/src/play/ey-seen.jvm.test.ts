/**
 * What the other seat was shown, the owner is told — and nobody else is (`visibility.ts`, "What the
 * other seats were shown"). Against real Forge, scenario `thoughtseize`: seat 0 casts Thoughtseize
 * at seat 1 and takes Elvish Mystic. Seat 1's own state then names seat 0 in the `PlayerMayLook` of
 * exactly the two cards still in its hand, and seat 0 is never sent a `PlayerMayLook` naming
 * anyone but itself.
 */
import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, idsOf, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';
import { TYPE, keyOf } from './visibility.js';

const title = available.ok
	? "the owner is told which of its cards the other seat saw, against real Forge"
	: `the owner is told which of its cards the other seat saw, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Seen A', ['40 Mountain']), deck('Seen B', ['40 Mountain'])];

/** Every player id any `PlayerMayLook` in these frames names. */
function lookIds(frames: readonly string[]): number[] {
	const ids = new Set<number>();
	for (const frame of frames) {
		for (const [, list] of frame.matchAll(/"PlayerMayLook":\{"t":"(?:list|set)","v":\[([^\]]*)\]/g)) {
			for (const [, id] of (list ?? '').matchAll(/"v":(\d+)/g)) ids.add(Number(id));
		}
	}
	return [...ids].sort();
}

describe.skipIf(!available.ok)(title, () => {
	it(
		"Thoughtseize: seat 1 is told seat 0 knows its two remaining cards; seat 0 is told nothing of anyone's knowledge",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4201, decks: DECKS, scenario: scenarioText('thoughtseize') });
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'seat 0 to hold priority at its own turn-1 main phase', 20_000, s);
				const seize = s.zone(0, 'Hand').find((c) => c.name === 'Thoughtseize')!;
				const alice = s.match.seats[0]?.playerId as number;
				const bob = s.match.seats[1]?.playerId as number;
				const mark = s.sent.length;
				s.select(0, seize.id);
				let targeted = false;
				let answered = false;
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && /target/i.test(s.prompt(0))) {
							targeted = true;
							s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: bob }, triggerEvent: null } as never);
						}
						if (s.buttons(0)?.label1 === 'Auto' && s.buttons(0)?.enable1 === true) s.ok(0);
						const ask = s.sent
							.slice(mark)
							.map((x) => x.envelope.frame)
							.find((f) => f.kind === 'ask' && f.method === 'chooseSingleEntityForEffect') as Extract<ServerFrame, { kind: 'ask'; method: 'chooseSingleEntityForEffect' }> | undefined;
						if (!answered && ask !== undefined) {
							answered = true;
							const mystic = s.zone(1, 'Hand').find((c) => c.name === 'Elvish Mystic')!;
							s.match.fromClient(0, { kind: 'reply', callId: ask.callId, method: 'chooseSingleEntityForEffect', result: { kind: 'card', id: mystic.id } } as never);
						}
						return answered && s.zone(1, 'Graveyard').length === 1;
					},
					'Thoughtseize to take Elvish Mystic',
					30_000,
					s,
				);
				const kept = s.zone(1, 'Hand');
				const lookOnBob = (id: number): number[] => idsOf(s.state(1).get(keyOf(TYPE.card, id)), 'PlayerMayLook');
				await waitUntil(() => kept.every((c) => lookOnBob(c.id).includes(alice)), "seat 1's state to name seat 0 on its kept cards", 10_000, s);
				const seat0 = s.sent.filter((x) => x.seat === 0).map((x) => JSON.stringify(x.envelope.frame));
				const evidence = { alice, bob, kept: kept.map((c) => ({ name: c.name, look: lookOnBob(c.id) })), seat0Looks: lookIds(seat0) };
				console.log(`[ey-seen] ${JSON.stringify(evidence)}`);
				expect(kept.map((c) => c.name).sort()).toEqual(['Goblin Guide', 'Mountain']);
				expect(kept.map((c) => lookOnBob(c.id).filter((p) => p !== bob)), 'seat 0 on each kept card, and nobody else').toEqual([[alice], [alice]]);
				expect(lookIds(seat0), 'seat 0 is named alone in every look it receives').toEqual([alice]);
				const bobLibrary = idsOf(s.state(1).get(keyOf(TYPE.player, bob)), 'Library');
				expect(bobLibrary.filter((id) => lookOnBob(id).includes(alice)), 'nothing in the library').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);
});
