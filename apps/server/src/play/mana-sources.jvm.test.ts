/**
 * Every kind of mana source, against real Forge, as one table — the guard for the
 * class of bug that kept coming back one source at a time (the Signet, the Elves,
 * the painland, the River: ~24 fix commits since 2026-10-05,
 * docs/planning/test-audit-2026-10-12.md §4.3).
 *
 * Two actions, each a table over source kinds, each row its own real match:
 *
 * 1. **Tap it at priority, then click it again: it untaps** — the operator's ask
 *    (ledger AE21): "i should be able to untap llanowar elves if i haven't done
 *    anything with the mana". The board's click on a tapped permanent is a plain
 *    `selectCard`: Forge offers each permanent whose mana activation it can take
 *    back (`AvailableActions.cardHasActionable`) and undoes that one activation on
 *    the click, in any order (`InputPassPriority.onCardSelected` →
 *    `PlayerControllerHuman.tryUndo` → `MagicStack.undo(Card)`). Each row taps the
 *    source and a Forest after it, then clicks the SOURCE — out of order — so the
 *    row also holds that the later Forest stays tapped.
 * 2. **The opponent's spell holds the window only for a non-mana ability.** Seat 1
 *    holds nothing but the source while seat 0's Raging Goblin is on the stack. A
 *    source whose every playable ability makes mana is named `manaOnly` by the
 *    bridge and the server passes seat 1 (`nonManaSources`); one with another
 *    ability (Ghost Quarter's, Mishra's Factory's) is a real decision and stops.
 *
 * The mana pool is not on the wire (`packages/forge-wire` carries no pool
 * property), so it is not asserted; `tapped`, the offer and the stop are.
 *
 * Folds in what `w65-elves.jvm.test.ts` (Forest, Elves, two Forests out of order)
 * and `w52-s-signet.jvm.test.ts` (the Signet window) proved one card each.
 */

import { describe, expect, it } from 'vitest';

import {
	available,
	deck,
	finishMulligan,
	inOwnMain,
	landPayer,
	startScenario,
	waitUntil,
	type Scenario,
} from './scenario.js';

const title = available.ok
	? 'every kind of mana source, against real Forge'
	: `every kind of mana source, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Forests', ['40 Forest']), deck('Islands', ['40 Island'])];

/** A scenario's `[state]` text: seat 0 at its own first main phase. */
function state(zones: { hand0?: string; field0: string; field1: string }): string {
	return [
		'turn=1',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		`humanhand=${zones.hand0 ?? ''}`,
		`humanbattlefield=${zones.field0}`,
		'humanlibrary=Forest;Forest;Forest;Forest;Forest;Forest',
		'humangraveyard=',
		'aihand=',
		`aibattlefield=${zones.field1}`,
		'ailibrary=Island;Island;Island;Island;Island;Island',
		'aigraveyard=',
	].join('\n');
}

/** The cards Forge offers `seat` now: its last `setWeaklySelectable` (none after a `clearWeaklySelectable`). */
function offeredTo(s: Scenario, seat: number): number[] {
	const last = [...s.lines]
		.reverse()
		.find((l) => l.t === 'frame' && l.seat === seat && /^(set|clear)WeaklySelectable$/.test(String((l.frame as { method?: unknown } | null)?.method)));
	const frame = (last as { frame?: unknown } | undefined)?.frame as { method: string; cards?: { id: number }[] } | undefined;
	return frame?.method === 'setWeaklySelectable' ? (frame.cards ?? []).map((c) => c.id) : [];
}

const tappedOn = (s: Scenario, id: number): boolean => s.zone(0, 'Battlefield').some((c) => c.id === id && c.tapped);

/** Click `id` at seat 0's priority, once Forge offers it, and wait for Forge to show it tapped. */
async function tap(s: Scenario, id: number, what: string): Promise<void> {
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && offeredTo(s, 0).includes(id); }, `${what} offered at priority`, 20_000, s);
	s.select(0, id);
	await waitUntil(() => { s.answerAsks(); return tappedOn(s, id); }, `${what} tapped`, 20_000, s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, `priority back after tapping ${what}`, 20_000, s);
}

interface UntapRow {
	/** The source on seat 0's battlefield, a Forge card name. */
	source: string;
	kind: string;
	/** Anything else the source needs to be activated (a Signet's {1}). */
	with?: string;
}

const UNTAP: readonly UntapRow[] = [
	{ kind: 'basic land', source: 'Forest' },
	{ kind: 'mana creature', source: 'Llanowar Elves' },
	{ kind: 'painland (its painless {C})', source: 'Adarkar Wastes' },
	{ kind: 'Tron land', source: "Urza's Tower" },
	{ kind: 'man-land', source: "Mishra's Factory" },
	{ kind: 'land with a non-mana ability', source: 'Ghost Quarter' },
	{ kind: 'Signet', source: 'Azorius Signet', with: 'Island' },
];

interface HoldRow {
	source: string;
	kind: string;
	/** Seat 1 is stopped in seat 0's spell's window: the source has a playable ability that is not a mana ability. */
	stops: boolean;
}

const HOLD: readonly HoldRow[] = [
	{ kind: 'basic land', source: 'Island', stops: false },
	{ kind: 'mana creature', source: 'Llanowar Elves', stops: false },
	{ kind: 'painland', source: 'Adarkar Wastes', stops: false },
	{ kind: 'Signet', source: 'Azorius Signet;Island', stops: false },
	{ kind: 'land with a non-mana ability', source: 'Ghost Quarter', stops: true },
	{ kind: 'man-land', source: "Mishra's Factory", stops: true },
];

describe.skipIf(!available.ok)(title, () => {
	for (const row of UNTAP) {
		it(`untap: a ${row.kind} (${row.source}) tapped at priority untaps on a click, before a Forest tapped after it`, async () => {
			if (!available.ok) return;
			const field0 = [row.source, ...(row.with === undefined ? [] : [row.with]), 'Forest'].join(';');
			const s = await startScenario(available.config, { seed: 6501, decks: DECKS, scenario: state({ field0, field1: 'Island' }) });
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "seat 0's main phase with the scripted board", 60_000, s);
				const source = s.zone(0, 'Battlefield').find((c) => c.name === row.source)!;
				const forest = s.zone(0, 'Battlefield').find((c) => c.name === 'Forest' && c.id !== source.id)!;
				// A Signet's {1} is paid by tapping the land beside it, the way the board pays it.
				const pay = landPayer(s, 0);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && offeredTo(s, 0).includes(source.id); }, `${row.source} offered at priority`, 20_000, s);
				s.select(0, source.id);
				await waitUntil(() => { s.answerAsks(); pay(); return tappedOn(s, source.id) && inOwnMain(s, 0, 1); }, `${row.source} tapped`, 20_000, s);
				await tap(s, forest.id, 'the Forest');
				console.log(`[mana-sources] ${row.source}: tapped, the Forest after it`);

				await waitUntil(() => { s.answerAsks(); return offeredTo(s, 0).includes(source.id); }, `${row.source}, tapped, offered for the untap click`, 20_000, s);
				s.select(0, source.id);
				await waitUntil(() => { s.answerAsks(); return !tappedOn(s, source.id); }, `${row.source} untapped by the click`, 20_000, s);
				expect(tappedOn(s, forest.id), 'the Forest tapped after it stays tapped').toBe(true);
			} finally {
				await s.stop();
			}
		}, 120_000);
	}

	for (const row of HOLD) {
		const name = row.source.split(';')[0]!;
		it(`hold: seat 1 holding only a ${row.kind} (${name}) is ${row.stops ? 'stopped' : 'passed'} in seat 0's spell's window`, async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 52,
				decks: DECKS,
				scenario: state({ hand0: 'Raging Goblin', field0: 'Mountain', field1: row.source }),
			});
			try {
				await finishMulligan(s);
				const logsBefore = s.logs.length;
				await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Hand').some((c) => c.name === 'Raging Goblin'); }, "seat 0's scripted Raging Goblin", 20_000, s);
				const goblin = s.zone(0, 'Hand').find((c) => c.name === 'Raging Goblin')!;
				// One select, once Forge's own offer names the Goblin: a second `selectCard` while
				// Forge still handles the first runs beside it on another thread (main's 38013980995).
				await waitUntil(() => { s.answerAsks(); return offeredTo(s, 0).includes(goblin.id); }, 'Forge offers seat 0 the Goblin', 20_000, s);
				s.select(0, goblin.id);
				const pay = landPayer(s, 0);
				// Cast: out of the hand. Not "on the stack" — a passed seat 1 lets it resolve
				// within a poll (run 38298019713 sampled the stack empty either side of it).
				await waitUntil(() => { s.answerAsks(); pay(); return !s.zone(0, 'Hand').some((c) => c.id === goblin.id); }, "seat 0's Raging Goblin cast", 45_000, s);

				// Seat 1's window over the Goblin, as Forge sent it: the raw stream, because a
				// passed window's prompt is withheld from the seat's own wire.
				const windowAt = (): number =>
					s.lines.findIndex(
						(l) =>
							l.t === 'frame' &&
							l.seat === 1 &&
							(l.frame as { method?: unknown }).method === 'showPromptMessage' &&
							/Stack: 1 to Resolve/.test((l.frame as { message?: string }).message ?? ''),
					);
				await waitUntil(() => { s.answerAsks(); return windowAt() >= 0; }, "seat 1's window over the Goblin", 20_000, s);
				const source = s.zone(1, 'Battlefield').find((c) => c.name === name)!;
				const passed = (): boolean => s.logs.slice(logsBefore).some((l) => l.evt === 'auto-passed' && l.seat === 1);
				const shown = (): boolean =>
					s.sent.some(
						(x) =>
							x.seat === 1 &&
							x.envelope.frame.method === 'showPromptMessage' &&
							/Stack: 1 to Resolve/.test((x.envelope.frame as { message?: string }).message ?? ''),
					) && s.buttons(1)?.enable1 === true;
				await waitUntil(() => { s.answerAsks(); return passed() || shown(); }, "the server's decision on seat 1's window", 20_000, s);

				const offer = [...s.lines]
					.reverse()
					.find((l) => l.t === 'frame' && l.seat === 1 && (l.frame as { method?: unknown }).method === 'setWeaklySelectable') as
					| { frame: { cards: { id: number }[]; manaOnly?: { id: number }[] } }
					| undefined;
				const manaOnly = new Set(offer?.frame.manaOnly?.map((c) => c.id));
				console.log(
					`[mana-sources] hold ${name}: offered ${JSON.stringify(offer?.frame.cards.map((c) => c.id))}, manaOnly ${JSON.stringify([...manaOnly])}, ` +
						`${passed() ? 'passed' : 'stopped'}`,
				);
				expect(offer?.frame.cards.map((c) => c.id), `Forge offers seat 1 the ${name}`).toContain(source.id);
				expect(manaOnly.has(source.id), `the bridge names the ${name} mana-only`).toBe(!row.stops);
				expect(passed(), `seat 1 ${row.stops ? 'stopped' : 'passed'}`).toBe(!row.stops);
				if (row.stops) s.ok(1);
				await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.name === 'Raging Goblin'); }, 'the Goblin to resolve', 20_000, s);
			} finally {
				await s.stop();
			}
		}, 120_000);
	}
});
