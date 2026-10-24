/**
 * The operator, 2026-10-24, against real Forge: *"clicking a land to untap it should work even when a
 * question is on the board … as long as nothing has triggered it should be easy to untap."* Asked
 * six times before (ledger V6, W10, AB8, AC7, AE21, AE53), every time about the priority window.
 *
 * A permanent tapped for mana whose mana still floats untaps on a click from every input, not only at
 * priority: while the spell's targets are chosen, while its cost is paid, and with a question open
 * (the click is taken by the input that comes after it). Forge offers it in each of them, and undo is
 * as strict as it is at priority (`MagicStack.undoableBy`: the mana unspent, nothing triggered): a
 * Mountain whose mana paid the cost stays tapped.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/untap \
 *   pnpm exec vitest run apps/server/src/play/untap-question.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { STRICT_PAYMENT_POLICY } from './auto.js';
import { available, deck, finishMulligan, inOwnMain, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a land tapped for mana untaps on a click while a question is open, against real Forge'
	: `a land tapped for mana untaps on a click while a question is open, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Islands', ['40 Island'])];

const state = (hand: string): string =>
	[
		'turn=1',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		`humanhand=${hand}`,
		'humanbattlefield=Forest;Mountain;Mountain',
		'humanlibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
		'humangraveyard=',
		'aihand=',
		'aibattlefield=Island',
		'ailibrary=Island;Island;Island;Island;Island;Island',
		'aigraveyard=',
	].join('\n');

/** The cards of the last actionable set Forge sent `seat`. */
function offeredTo(s: Scenario, seat: number): number[] {
	const last = [...s.lines]
		.reverse()
		.find((l) => l.t === 'frame' && l.seat === seat && /^(set|clear)WeaklySelectable$/.test(String((l.frame as { method?: unknown } | null)?.method)));
	const frame = (last as { frame?: unknown } | undefined)?.frame as { method: string; cards?: { id: number }[] } | undefined;
	return frame?.method === 'setWeaklySelectable' ? (frame.cards ?? []).map((c) => c.id) : [];
}

const tappedOn = (s: Scenario, id: number): boolean => s.zone(0, 'Battlefield').some((c) => c.id === id && c.tapped);
const named = (s: Scenario, zone: 'Hand' | 'Battlefield', name: string): number => {
	const id = s.zone(0, zone).find((c) => c.name === name)?.id;
	if (id === undefined) throw new Error(`no ${name} in seat 0's ${zone}`);
	return id;
};
const opponent = (s: Scenario): number => {
	const id = s.match.seats[1]?.playerId;
	if (id === undefined || id === null) throw new Error('no player id for seat 1');
	return id;
};

/** Seat 0's own Main 1 with the Forest tapped for {G} and the {G} floating. Returns the Forest. */
async function forestTapped(s: Scenario, hand: string): Promise<number> {
	await finishMulligan(s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === hand); }, "seat 0's main phase with the scripted board", 60_000, s);
	const forest = named(s, 'Battlefield', 'Forest');
	await waitUntil(() => { s.answerAsks(); return offeredTo(s, 0).includes(forest); }, 'the Forest offered at priority', 20_000, s);
	s.select(0, forest);
	await waitUntil(() => { s.answerAsks(); return tappedOn(s, forest) && inOwnMain(s, 0, 1); }, 'the Forest tapped, priority back', 20_000, s);
	return forest;
}

const targeting = (s: Scenario): boolean => /^Shock\b.*target/im.test(s.prompt(0)) && !paying(s);
const paying = (s: Scenario): boolean => /Pay Mana Cost/.test(s.prompt(0));

describe.skipIf(!available.ok)(title, () => {
	it(
		'while Shock’s target is chosen: the tapped Forest is offered, and a click untaps it',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 2401, decks: DECKS, scenario: state('Shock') });
			try {
				const forest = await forestTapped(s, 'Shock');
				s.select(0, named(s, 'Hand', 'Shock'));
				await waitUntil(() => { s.answerAsks(); return targeting(s); }, "Shock's targets asked", 20_000, s);
				await waitUntil(() => offeredTo(s, 0).includes(forest), 'the tapped Forest offered while targeting', 10_000, s);
				s.select(0, forest);
				await waitUntil(() => { s.answerAsks(); return !tappedOn(s, forest); }, 'the Forest untapped by the click', 10_000, s);
				expect(targeting(s), 'still choosing targets').toBe(true);
				s.cancel(0);
			} catch (err) {
				console.log(`[untap-question-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'while Shock’s cost is paid: the tapped Forest is offered and untaps; the Mountain that paid stays tapped',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 2402, decks: DECKS, scenario: state('Shock'), policy: STRICT_PAYMENT_POLICY });
			try {
				const forest = await forestTapped(s, 'Shock');
				s.select(0, named(s, 'Hand', 'Shock'));
				await waitUntil(() => { s.answerAsks(); return targeting(s); }, "Shock's targets asked", 20_000, s);
				s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: opponent(s) }, triggerEvent: null } as never);
				await waitUntil(() => { s.answerAsks(); return paying(s); }, "Shock's cost asked", 20_000, s);
				await waitUntil(() => offeredTo(s, 0).includes(forest), 'the tapped Forest offered while paying', 10_000, s);
				s.select(0, forest);
				await waitUntil(() => { s.answerAsks(); return !tappedOn(s, forest); }, 'the Forest untapped by the click', 10_000, s);
				expect(paying(s), 'still paying').toBe(true);
				const mountain = named(s, 'Battlefield', 'Mountain');
				s.select(0, mountain);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').length === 0; }, 'Shock paid and resolved', 20_000, s);
				expect(offeredTo(s, 0)).not.toContain(mountain);
				s.select(0, mountain);
				await new Promise((r) => setTimeout(r, 1500));
				s.answerAsks();
				expect(tappedOn(s, mountain), 'the Mountain whose {R} paid for Shock stays tapped').toBe(true);
			} catch (err) {
				console.log(`[untap-question-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'while Fireball asks for X: a click on the tapped Forest untaps it once the question is answered',
		async () => {
			if (!available.ok) return;
			let holding = true;
			const s = await startScenario(available.config, {
				seed: 2403,
				decks: DECKS,
				scenario: state('Fireball'),
				hold: (f) => holding && f.method !== 'getAbilityToPlay',
			});
			try {
				const forest = await forestTapped(s, 'Fireball');
				s.select(0, named(s, 'Hand', 'Fireball'));
				await waitUntil(() => { s.answerAsks(); return s.sent.some((x) => x.seat === 0 && x.envelope.frame.kind === 'ask' && x.envelope.frame.method !== 'getAbilityToPlay'); }, "Fireball's X asked", 20_000, s);
				s.select(0, forest);
				holding = false;
				await waitUntil(() => { s.answerAsks(); return !tappedOn(s, forest); }, 'the Forest untapped by the click', 15_000, s);
				s.cancel(0);
			} catch (err) {
				console.log(`[untap-question-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
