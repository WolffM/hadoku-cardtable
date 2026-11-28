/**
 * What an ability that does nothing now, or cannot be paid now, looks like on the wire, against real Forge.
 *
 * CoffeeTraveler, 2026-11-27 (prod match m-38558f39ec15): "Mosswort Bridge doesn't know when it has no card
 * under it and the secondary ability is still usable after casting the card under it." Forge's script
 * (`mosswort_bridge.txt`: `AB$ Play | Defined$ ExiledWith | … | Optional$ True`) leaves the ability
 * activatable with nothing exiled with the land, as the rules do, and the fork's play test counted it a
 * play, so it held the seat's priority all game. The operator, the same day: tuck the face-down card under
 * the permanent it is exiled with, and an empty "play the exiled card" ability is no play but stays
 * clickable. And for Karn Liberated at 1 loyalty, whose click offered +4 alone and so never opened the
 * picker: "for karn, and all planeswalkers … show all abilities every time but only make the ones that are
 * payable clickable."
 *
 * One game, seat 0's turn-1 main:
 *   - A Mosswort Bridge with nothing exiled with it, beside two Craw Wurms (power 12, the bridge's
 *     condition met), is offered for its mana alone (`manaOnly`); the other, with a face-down
 *     Grizzly Bears exiled with it is a play.
 *   - A click on Karn Liberated at 1 loyalty offers +4, and names −3 and −14 as `withheld`, in card order.
 *   - The Grizzly Bears exiled with it is face down, and BOTH seats' wires say which permanent it is
 *     exiled with (`ExiledWith`), which is what the board tucks it under. Seat 1 learns nothing else of it.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/hidden-offers \
 *   pnpm exec vitest run games/magic/server/src/play/hidden-offers.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { boolOf, DELTA_TYPE, deltaKey, intOf, type ServerFrame } from '@hadoku/forge-wire';
import { oneAbility } from '@hadoku/shared';

import { available, deck, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'hidden offers: an empty exile ability is no play, a walker names what it cannot pay, a hidden card names its keeper, against real Forge'
	: `hidden offers: an empty exile ability is no play, a walker names what it cannot pay, a hidden card names its keeper, against real Forge — SKIPPED: ${available.reason}`;

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Mosswort Bridge|Id:301;Mosswort Bridge|Id:302;Karn Liberated|Id:303|Counters:LOYALTY=1;Craw Wurm;Craw Wurm;Forest;Forest',
	'humanlibrary=Forest;Forest;Forest;Forest;Forest;Forest',
	'humangraveyard=',
	'humanexile=Grizzly Bears|Id:304|ExiledWith:302|FaceDown',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

type Frame = { method?: string; cards?: { id: number }[]; manaOnly?: { id: number }[] };

/** The last `setWeaklySelectable` seat 0 was sent that carries the bridge's offer facts. */
function lastOffer(s: Scenario): Frame | null {
	for (let i = s.lines.length - 1; i >= 0; i -= 1) {
		const l = s.lines[i]!;
		const f = (l as { frame?: Frame }).frame;
		if (l.t === 'frame' && (l as { seat?: number }).seat === 0 && f?.method === 'setWeaklySelectable' && f.manaOnly !== undefined) return f;
	}
	return null;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Mosswort Bridge, Karn Liberated at 1 loyalty and a face-down card exiled with a permanent',
		async () => {
			if (!available.ok) return;
			const karnAsks: (ServerFrame & Record<string, unknown>)[] = [];
			let karnId = -1;
			const s = await startScenario(available.config, {
				seed: 1127,
				decks: [deck('Forests', ['40 Forest']), deck('Plains', ['40 Plains'])],
				scenario: STATE,
				skipOpening: true,
				reply: (f) => {
					if (f.method !== 'getAbilityToPlay' || (f.hostCard as { id: number }).id !== karnId) return undefined;
					karnAsks.push(f);
					return null;
				},
			});
			try {
				// The scenario's `Id:`s only link its cards to each other; Forge numbers them afresh.
				const hiddenCard = (): { id: number } | undefined =>
					[...s.state(0).values()].filter((o) => o._type === DELTA_TYPE.card && intOf(o, 'ExiledWith') !== null).map((o) => ({ id: o._id as number }))[0];
				const keeper = (): number | null => intOf(s.state(0).get(deltaKey(DELTA_TYPE.card, hiddenCard()?.id ?? -1)), 'ExiledWith');
				await waitUntil(
					() => {
						s.answerAsks();
						const offer = lastOffer(s);
						const bridges = s.zone(0, 'Battlefield').filter((c) => c.name === 'Mosswort Bridge').map((c) => c.id);
						return inOwnMain(s, 0, 1) && offer !== null && bridges.length === 2 && bridges.every((id) => (offer.cards ?? []).some((c) => c.id === id));
					},
					'seat 0 in its main with both bridges offered',
					60_000,
					s,
				);
				const offer = lastOffer(s)!;
				const loaded = keeper();
				expect(loaded, 'seat 0 is told which permanent the face-down card is exiled with').not.toBeNull();
				const bridges = s.zone(0, 'Battlefield').filter((c) => c.name === 'Mosswort Bridge').map((c) => c.id);
				const empty = bridges.find((id) => id !== loaded)!;
				karnId = s.zone(0, 'Battlefield').find((c) => c.name === 'Karn Liberated')!.id;
				const hiddenId = hiddenCard()!.id;
				expect(bridges, 'two bridges, one of them holding the hidden card').toEqual(expect.arrayContaining([loaded, empty]));
				const manaOnly = (offer.manaOnly ?? []).map((c) => c.id);
				expect(manaOnly, 'the bridge with nothing exiled with it is offered for its mana alone').toContain(empty);
				expect(manaOnly, 'the bridge holding a card is a play').not.toContain(loaded);
				expect((offer.cards ?? []).map((c) => c.id), 'the empty bridge is still offered: its ability stays clickable').toContain(empty);

				s.select(0, karnId);
				await waitUntil(() => (s.answerAsks(), karnAsks.length > 0), 'a click on Karn asks which ability', 20_000, s);
				const ask = karnAsks[0] as Extract<ServerFrame, { method: 'getAbilityToPlay' }>;
				expect(ask.abilities.map((a) => a.label ?? ''), 'Forge offers +4 alone at 1 loyalty').toEqual([expect.stringMatching(/^\+4/)]);
				const withheld = (ask as { withheld?: { label: string; at: number }[] }).withheld ?? [];
				expect(withheld.map((w) => [w.label.slice(0, 3), w.at]), 'the −3 and −14 it cannot pay are named, in card order').toEqual([
					[expect.stringMatching(/^-3/), 1],
					[expect.stringMatching(/^-14/), 2],
				]);
				expect(oneAbility(ask), 'and the click is a question, so the picker opens').toBeNull();

				for (const seat of [0, 1]) {
					const hidden = s.state(seat).get(deltaKey(DELTA_TYPE.card, hiddenId));
					expect(hidden, `seat ${seat} knows the hidden card exists`).toBeDefined();
					expect(boolOf(hidden, 'Facedown'), `seat ${seat}: it is face down`).toBe(true);
					expect(intOf(hidden, 'ExiledWith'), `seat ${seat}: exiled with the loaded bridge`).toBe(loaded);
				}
				expect(s.state(1).get(deltaKey(DELTA_TYPE.card, hiddenId))?.Name, 'seat 1 is never told which card it is').toBeUndefined();
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});
