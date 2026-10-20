/**
 * A drafted two-faced card is played, against real Forge.
 *
 * The cube holds a transform card, a modal double-faced card and an adventure
 * under Scryfall's combined name (`Fable of the Mirror-Breaker // Reflection of
 * Kiki-Jiki`), and that is the name a drafted deck's `.dck` carries. Forge's card
 * database files only a split card under such a name, so a deck line naming any
 * other two-faced card that way was dropped at match start ("Removed from your
 * Deck") and the drafted card never reached the game.
 *
 * Alice plays a drafted deck of Fables and Mountains: Forge keeps every card, and
 * the Fable she draws is cast and resolves.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/drafted-faces \
 *   pnpm exec vitest run apps/server/src/play/drafted-faces.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { basicLand, moveToMain, newDeck, setBasicLand, toDeckFile, writeDck } from '@hadoku/deck';
import { describe, expect, it } from 'vitest';

import { draftCardRequest } from '../http/draftPool.js';
import { loadPool } from '../room/pool.js';
import { available, deck, finishMulligan, idsOf, inOwnMain, landPayer, passUntil, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, keyOf } from './visibility.js';

const title = available.ok
	? 'a drafted two-faced card is in the deck Forge plays, and is cast, against real Forge'
	: `a drafted two-faced card is in the deck Forge plays, and is cast, against real Forge — SKIPPED: ${available.reason}`;

const cube = loadPool(resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json'));
if (!cube.ok) throw new Error(`cube pool did not load: ${cube.detail}`);
const FABLE = cube.pool.cards.find((c) => c.name === 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki');
if (FABLE === undefined) throw new Error('the cube no longer holds Fable of the Mirror-Breaker');

/** The deck the browser writes for a pool of 23 Fables, with 17 Mountains from the basics buttons. */
function fableDeck(): string {
	const card = draftCardRequest(FABLE!);
	let d = newDeck('Drafted Fables', [{ count: 23, card }]);
	d = moveToMain(d, card, 23);
	d = setBasicLand(d, basicLand('Mountain'), 17);
	return writeDck(toDeckFile(d));
}

/** The card ids this seat was last offered to click (`setWeaklySelectable`). */
function offered(s: Scenario, seat: number): number[] {
	const last = [...s.sent].reverse().find((e) => e.seat === seat && e.envelope.frame.method === 'setWeaklySelectable');
	return last === undefined ? [] : (last.envelope.frame as unknown as { cards: { id: number }[] }).cards.map((c) => c.id);
}

/** Alice's library and hand together, off her own projection of her player. */
function cardsHeld(s: Scenario): number {
	const self = s.state(0).get(keyOf(TYPE.player, s.match.seats[0]?.playerId ?? -1));
	return idsOf(self, 'Library').length + idsOf(self, 'Hand').length;
}

const FABLE_NAME = 'Fable of the Mirror-Breaker';

describe.skipIf(!available.ok)(title, () => {
	it(
		'every drafted Fable reaches the library, and one is cast and resolves',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 11, decks: [fableDeck(), deck('Islands', ['40 Island'])] });
			try {
				await finishMulligan(s);
				const removed = s.lines.filter((l) => l.t === 'frame' && /Removed/.test(String((l.frame as { message?: unknown }).message ?? '')));
				console.log(`[drafted-faces.jvm] removal reveals: ${removed.length}; alice holds ${cardsHeld(s)} in hand and library`);
				expect(removed, 'Forge removed cards from the drafted deck').toEqual([]);
				await waitUntil(() => cardsHeld(s) === 40, 'alice’s library and hand to be the whole deck, 40 cards', 20_000, s);

				let after = 0;
				const onField = (): boolean => s.zone(0, 'Battlefield').some((c) => c.name === FABLE_NAME);
				for (let turns = 0; turns < 8 && !onField(); turns++) {
					await passUntil(s, () => { const t = s.turn(0); return t !== null && t.n > after && inOwnMain(s, 0, t.n); }, 'alice’s next main phase', 120_000);
					const n = s.turn(0)!.n;
					after = n;
					const land = s.zone(0, 'Hand').find((c) => c.land);
					if (land !== undefined) {
						await waitUntil(() => { s.answerAsks(); return offered(s, 0).includes(land.id); }, 'Forge offers alice her land', 20_000, s);
						s.select(0, land.id);
						await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.id === land.id) && inOwnMain(s, 0, n); }, 'the land in play and priority back', 20_000, s);
					}
					const fable = s.zone(0, 'Hand').find((c) => c.name === FABLE_NAME);
					const untapped = s.zone(0, 'Battlefield').filter((c) => c.land && !c.tapped).length;
					console.log(`[drafted-faces.jvm] turn ${n}: ${untapped} untapped lands, Fable in hand: ${fable !== undefined}`);
					if (fable === undefined || untapped < 3) continue;
					await waitUntil(() => { s.answerAsks(); return offered(s, 0).includes(fable.id); }, 'Forge offers alice the Fable', 20_000, s);
					s.select(0, fable.id);
					const pay = landPayer(s, 0);
					await waitUntil(
						() => {
							s.answerAsks();
							pay();
							return onField() && /^Stack: Empty$/m.test(s.prompt(0));
						},
						'the Fable to resolve onto the battlefield',
						60_000,
						s,
					);
				}
				console.log(`[drafted-faces.jvm] battlefield: ${JSON.stringify(s.zone(0, 'Battlefield').map((c) => c.name))}`);
				expect(onField(), 'a drafted Fable was cast and resolved').toBe(true);
			} finally {
				await s.stop();
			}
		},
		420_000,
	);
});
