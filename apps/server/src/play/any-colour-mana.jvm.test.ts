/**
 * Black Lotus's colour is the player's to choose, against real Forge. The operator, 2026-10-19:
 *
 *   "black lotus immediately created white mana when tapped. that was not intended. still want to
 *   select the mana color, just not the extra question about wanting to sacrifice"
 *
 * Their match (m-305dcd0165f1) never put the colour to them: Forge sent no `getChoices` at all
 * after the sacrifice confirm, and the pool held {W}{W}{W}. Forge's priority-time scan
 * (`AvailableActions`) prices each spell in hand through the AI payer (`ComputerUtilMana`), which
 * writes "W" as Black Lotus's colour for a generic shard and then turns the Lotus down (its
 * AILogic will not spend it on a cheap spell). The colour stayed on the Lotus, and `ManaEffect`
 * read it as the player's answer the next time they tapped it.
 *
 * `scenarios/lotus-colour.state`: Mind Stone in hand, an Island and Black Lotus in play. Tap the
 * Lotus, in the default mode and in full control: the sacrifice is answered for the seat, the
 * colour is asked with all five colours, and Blue floats {U}{U}{U}.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/any-colour-mana.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, keyOf } from './visibility.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

type Frame = ServerFrame & Record<string, unknown>;

const BLUE = 2;
const isColourAsk = (f: Frame): boolean => f.method === 'getChoices' && /Select Mana to Produce/.test(String(f.message));

/** Blue, for the colour question; everything else is answered plainly. */
function reply(f: Frame): unknown {
	if (!isColourAsk(f)) return undefined;
	const blue = (f.choices as { key: string; label: string }[]).find((c) => /blue/i.test(c.label));
	return blue === undefined ? undefined : [blue.key];
}

/** Seat 0's floating mana, `ManaAtom` byte → count, off its own projected `PlayerView.Mana`. */
function pool(s: Scenario): Record<number, number> {
	const player = s.state(0).get(keyOf(TYPE.player, s.match.seats[0]?.playerId ?? -1));
	const mana = player?.Mana as { t?: string; v?: unknown } | undefined;
	const out: Record<number, number> = {};
	if (mana?.t !== 'map' || !Array.isArray(mana.v)) return out;
	for (const [k, v] of mana.v as [{ v: number }, { v: number }][]) if (v.v > 0) out[k.v] = v.v;
	return out;
}

const sentToSeat0 = (s: Scenario, from: number): Frame[] =>
	s.sent.slice(from).filter((x) => x.seat === 0).map((x) => x.envelope.frame as unknown as Frame);

describe.skipIf(!available.ok)(title('an any-colour mana source asks its colour, against real Forge'), () => {
	for (const mode of ['default', 'full control'] as const) {
		it(`${mode}: tapping Black Lotus asks no sacrifice, asks the colour of five, and Blue floats {U}{U}{U}`, async () => {
			const s = await startScenario(available.ok ? available.config : (undefined as never), {
				seed: 19,
				decks: [deck('lotus-a', ['20 Island']), deck('lotus-b', ['20 Island'])],
				names: ['Alice', 'Bob'],
				scenario: scenarioText('lotus-colour'),
				reply,
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => inOwnMain(s, 0, 3), 'alice to hold priority in her turn-3 main', 30_000, s);
				if (mode === 'full control') expect(s.match.setFullControl(0, true)).toEqual({ ok: true });
				const lotus = s.zone(0, 'Battlefield').find((c) => c.name === 'Black Lotus');
				if (lotus === undefined) throw new Error('no Black Lotus');
				const sentFrom = s.sent.length;
				s.select(0, lotus.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return !s.zone(0, 'Battlefield').some((c) => c.id === lotus.id) && Object.keys(pool(s)).length > 0;
					},
					'Black Lotus to be sacrificed and its mana to float',
					60_000,
					s,
				);
				const colour = (s.asks as Frame[]).filter(isColourAsk);
				const seen = sentToSeat0(s, sentFrom);
				console.log(
					`[lotus-colour] ${mode}: colour asks ${JSON.stringify(colour.map((a) => (a.choices as { label: string }[]).map((c) => c.label)))} pool ${JSON.stringify(pool(s))}`,
				);
				expect(colour, 'the colour was asked once').toHaveLength(1);
				expect((colour[0]!.choices as { label: string }[]).map((c) => c.label.toLowerCase()).sort()).toEqual(['black', 'blue', 'green', 'red', 'white']);
				expect(pool(s), 'Blue floats three').toEqual({ [BLUE]: 3 });
				expect(seen.filter((f) => f.method === 'showPromptMessage' && /Sacrifice/i.test(String(f.message))), 'no sacrifice confirm reached alice').toEqual([]);
				expect(s.logs.filter((l) => l.evt === 'auto-confirmed' && l.seat === 0).map((l) => l.why)).toContain('the seat chose this ability just before');
			} finally {
				await s.stop();
			}
		}, 180_000);
	}
});
