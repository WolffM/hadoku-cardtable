/**
 * What Forge's two extra-turn properties say, read off the frames real Forge sends both seats: the
 * operator, 2026-10-19, *"when a player has extra turns, this kind of thing should be visible
 * somewhere around their portrait"*. The board's status zone (`apps/ui/src/play/Board.tsx`,
 * `SeatStatus`) draws `PlayerView.ExtraTurnCount` as the turns to come and `PlayerView.IsExtraTurn`
 * as the mark that this turn is one; this is where their semantics are pinned.
 *
 * Seat 0 casts Time Walk in its turn 1. Forge recounts every player's `ExtraTurnCount` when the
 * turn is added (`PhaseHandler.addExtraTurn`), and the count of the player whose turn begins when
 * one starts (`getNextActivePlayer`), which also sets THAT player's `IsExtraTurn` — and nobody
 * else's, so the flag outlives the extra turn on the player who took it.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/extra-turn.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { keyOf, TYPE } from './visibility.js';
import { available, castNamed, deck, finishMulligan, inOwnMain, passUntil, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'extra turns: ExtraTurnCount and IsExtraTurn on both seats’ frames through a Time Walk, against real Forge'
	: `extra turns: ExtraTurnCount and IsExtraTurn on both seats’ frames through a Time Walk, against real Forge — SKIPPED: ${available.reason}`;

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Time Walk',
	'humanbattlefield=Island;Island',
	'humanlibrary=Island;Island;Island;Island;Island;Island',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains;Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

interface Turns {
	count: number;
	isExtra: boolean;
}

/**
 * What seat `seat` holds for each player's two properties right now. A property set back to its
 * default (0, false) leaves the folded state rather than holding it, which is what absent means here.
 */
function turnsOn(s: Scenario, seat: number): [Turns, Turns] {
	const state = s.state(seat);
	const read = (who: number): Turns => {
		const p = state.get(keyOf(TYPE.player, s.match.seats[who]!.playerId ?? -1));
		return { count: (p?.ExtraTurnCount as { v?: number } | undefined)?.v ?? 0, isExtra: (p?.IsExtraTurn as { v?: boolean } | undefined)?.v ?? false };
	};
	return [read(0), read(1)];
}

/** Every change to either property in the frames sent `seat`, in order, with the turn the seat's prompt was on. */
function changes(s: Scenario, seat: number): string[] {
	const out: string[] = [];
	const ids = [0, 1].map((who) => s.match.seats[who]!.playerId);
	for (const { seat: to, envelope } of s.sent) {
		if (to !== seat) continue;
		const f = envelope.frame as unknown as { method?: string; payload?: { packet?: { objectDeltas?: Record<string, Record<string, unknown>> } } };
		if (f.method !== 'applyDelta') continue;
		for (const obj of Object.values(f.payload?.packet?.objectDeltas ?? {})) {
			if (obj._type !== TYPE.player) continue;
			const who = ids.indexOf(obj._id as number);
			for (const k of ['ExtraTurnCount', 'IsExtraTurn'] as const) {
				if (k in obj) out.push(`seat${who}.${k}=${obj[k] === null ? 'cleared' : JSON.stringify((obj[k] as { v?: unknown }).v)}`);
			}
		}
	}
	return out;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Time Walk: one turn to come on both seats until it starts; during it the caster’s flag is up and the count is 0; the flag stays on the caster into the next turn',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1019, decks: [deck('Islands', ['40 Island']), deck('Plains', ['40 Plains'])], scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Time Walk');
				}, 'seat 0 in its own main with Time Walk in hand', 30_000, s);
				for (const seat of [0, 1]) console.log(`[st-jvm] before: seat ${seat} sees ${JSON.stringify(turnsOn(s, seat))}`);

				await castNamed(s, 0, 'Time Walk');
				for (const seat of [0, 1]) {
					const [caster, other] = turnsOn(s, seat);
					console.log(`[st-jvm] resolved: seat ${seat} sees ${JSON.stringify([caster, other])}`);
					expect(caster.count, `seat ${seat}: the caster has one extra turn to come`).toBe(1);
					expect(other.count, `seat ${seat}: the other has none`).toBe(0);
					expect(caster.isExtra, `seat ${seat}: turn 1 is not an extra one`).toBe(false);
				}

				await passUntil(s, () => inOwnMain(s, 0, 2), 'seat 0’s extra turn (turn 2) to reach its main phase');
				for (const seat of [0, 1]) {
					const [caster, other] = turnsOn(s, seat);
					console.log(`[st-jvm] extra turn: seat ${seat} sees ${JSON.stringify([caster, other])}`);
					expect(caster.isExtra, `seat ${seat}: turn 2 is the caster's extra turn`).toBe(true);
					expect(caster.count, `seat ${seat}: and none is left to come`).toBe(0);
					expect(other.isExtra).toBe(false);
				}

				await passUntil(s, () => inOwnMain(s, 1, 3), 'seat 1’s turn 3 to reach its main phase');
				for (const seat of [0, 1]) {
					const [caster, other] = turnsOn(s, seat);
					console.log(`[st-jvm] next turn: seat ${seat} sees ${JSON.stringify([caster, other])}`);
					expect(other.isExtra, `seat ${seat}: turn 3 is not an extra one for the player taking it`).toBe(false);
					expect(caster.count, `seat ${seat}: nothing to come`).toBe(0);
				}
			} finally {
				for (const seat of [0, 1]) console.log(`[st-jvm] seat ${seat} changes: ${changes(s, seat).join(' ')}`);
				await s.stop();
			}
		},
		180_000,
	);
});
