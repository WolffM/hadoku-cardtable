/**
 * What Forge offers is what Forge takes, against real Forge: the highlight (`setWeaklySelectable`)
 * and a click's "which ability?" (`getAbilityToPlay`) leave out a play Forge would refuse once
 * picked.
 *
 * The operator, 2026-10-11 (match m-70cba9014f79): Serra Avenger highlighted on turns it cannot be
 * cast ("it went back to my hand"), and Rishadan Port's "{1},{T}: Tap target land" offered with
 * nothing to pay its {1} ("had no way to pay it and then it untapped"). `e2e/w69-offers.spec.ts`
 * plays the same scenarios on two screens.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/w69-offers \
 *   pnpm exec vitest run apps/server/src/play/w69-offers.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'w69 offers: the highlight and the ability choice leave out what Forge would refuse, against real Forge'
	: `w69 offers: the highlight and the ability choice leave out what Forge would refuse, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Plains', ['40 Plains']), deck('Mountains', ['40 Mountain'])];
const TAP_TARGET_LAND = /tap target land/i;

/** The cards in the last `setWeaklySelectable` Forge sent `seat`; [] after a `clearWeaklySelectable`. */
function offeredTo(s: Scenario, seat: number): number[] {
	const last = forgeFrames(s, seat).findLast((f) => f.method === 'setWeaklySelectable' || f.method === 'clearWeaklySelectable');
	return last?.method === 'setWeaklySelectable' ? (last.cards ?? []).map((c) => c.id) : [];
}

/** The ability labels of every `getAbilityToPlay` Forge asked `seat` from line `from` on. */
function abilityAsks(s: Scenario, seat: number, from: number): string[][] {
	return forgeFrames(s, seat, from)
		.filter((f) => f.method === 'getAbilityToPlay')
		.map((f) => ((f as { abilities?: { label?: string }[] }).abilities ?? []).map((a) => a.label ?? ''));
}

const cardNamed = (s: Scenario, seat: number, zone: 'Hand' | 'Battlefield', name: string) => s.zone(seat, zone).find((c) => c.name === name);

async function landed(s: Scenario, name: string): Promise<void> {
	await finishMulligan(s);
	await waitUntil(() => { s.answerAsks(); return cardNamed(s, 0, 'Battlefield', name) !== undefined || cardNamed(s, 0, 'Hand', name) !== undefined; }, `seat 0's scripted ${name}`, 20_000, s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && offeredTo(s, 0).length > 0; }, "seat 0's own first main with Forge's offer", 30_000, s);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Rishadan Port with no other mana: a click asks no "Tap target land", and taps the Port for mana',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 69, decks: DECKS, scenario: scenarioText('w69-port-alone') });
			try {
				await landed(s, 'Rishadan Port');
				const port = cardNamed(s, 0, 'Battlefield', 'Rishadan Port')!;
				expect(offeredTo(s, 0), 'the Port is offered for its own {C}').toContain(port.id);
				const from = s.lines.length;
				s.select(0, port.id);
				await waitUntil(() => { s.answerAsks(); return cardNamed(s, 0, 'Battlefield', 'Rishadan Port')?.tapped === true; }, 'the Port to tap', 20_000, s);
				const asks = abilityAsks(s, 0, from);
				console.log(`[w69-offers.jvm] port alone: getAbilityToPlay asked [${asks.map((a) => a.join(' | ')).join(' ; ')}]`);
				expect(asks.flat().filter((l) => TAP_TARGET_LAND.test(l))).toEqual([]);
				expect(s.logs.filter((l) => l.evt === 'auto-cancelled')).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Rishadan Port beside a Forest: a click asks "Tap target land" too',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 69, decks: DECKS, scenario: scenarioText('w69-port-forest') });
			try {
				await landed(s, 'Rishadan Port');
				const port = cardNamed(s, 0, 'Battlefield', 'Rishadan Port')!;
				const from = s.lines.length;
				s.select(0, port.id);
				await waitUntil(() => abilityAsks(s, 0, from).length > 0, 'the ability question', 20_000, s);
				const asks = abilityAsks(s, 0, from);
				console.log(`[w69-offers.jvm] port + forest: getAbilityToPlay asked [${asks.map((a) => a.join(' | ')).join(' ; ')}]`);
				expect(asks[0]?.some((l) => TAP_TARGET_LAND.test(l))).toBe(true);
				expect(asks[0]).toHaveLength(2);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		"Serra Avenger is offered from its caster's fourth turn, never before",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 69, decks: DECKS, scenario: scenarioText('w69-serra') });
			try {
				await landed(s, 'Serra Avenger');
				const serra = cardNamed(s, 0, 'Hand', 'Serra Avenger')!;
				const toss = s.logs.find((l) => l.evt === 'coin-toss');
				const before = toss?.winner === 0 ? 1 : 0;
				const rows: { turn: number; own: number; offered: boolean }[] = [];
				const ended = new Set<string>();
				await waitUntil(
					() => {
						s.answerAsks();
						for (const seat of [0, 1]) {
							const t = s.turn(seat);
							if (t === null || t.owner !== s.names[seat] || !inOwnMain(s, seat, t.n)) continue;
							const key = `${seat}:${t.n}`;
							if (ended.has(key)) continue;
							if (seat === 0) {
								if (offeredTo(s, 0).length === 0) continue;
								rows.push({ turn: t.n, own: before + rows.length, offered: offeredTo(s, 0).includes(serra.id) });
								if (rows.at(-1)!.own >= 4) return true;
							}
							ended.add(key);
							s.cancel(seat);
						}
						return false;
					},
					"seat 0's fourth own turn",
					180_000,
					s,
				);
				for (const r of rows) console.log(`[w69-offers.jvm] serra: game turn ${r.turn}, seat 0's own turn ${r.own}: ${r.offered ? 'offered' : 'not offered'}`);
				expect(rows.filter((r) => r.own < 4 && r.offered).map((r) => r.own)).toEqual([]);
				expect(rows.at(-1)).toMatchObject({ own: 4, offered: true });
			} finally {
				await s.stop();
			}
		},
		240_000,
	);
});
