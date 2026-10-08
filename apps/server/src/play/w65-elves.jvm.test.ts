/**
 * The untap of a mana source whose mana is still unspent, measured against real
 * Forge — the operator's third ask (ledger AE21; V6, playtest 9 before it):
 * "i should be able to untap llanowar elves if i haven't done anything with the
 * mana and it hasn't triggered anything."
 *
 * The board's click-to-untap (`apps/ui/src/play/live/match.ts` `undoableTap`)
 * sends Forge's own Undo button (`selectButtonCancel` while the bar reads
 * "Undo (n)") for the ONE permanent it tapped last — and `noteTaps` records only
 * LANDS, so a creature is never offered that click at all. Forge's undo is
 * last-in-first-out (`MagicStack.undo()`). This file records what the wire gives
 * back for the three cases the operator means, so the next change is made where
 * the refusal actually is:
 *
 *   1. a Forest tapped last, Undo pressed            — the V6 half that ships (control)
 *   2. Llanowar Elves tapped last, Undo pressed       — does FORGE untap a creature?
 *   3. two Forests tapped, Undo pressed once          — only the LAST comes back (LIFO)
 *
 * The mana pool is not on the wire (`packages/forge-wire` carries no pool
 * property), so the pool is not asserted; `tapped` and the Undo label are.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/w65-elves.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const DECKS: [string, string] = [deck('Elves', ['40 Forest']), deck('Mountains', ['40 Mountain'])];
const UNDO = /^Undo \(\d+\)$/;

const title = available.ok
	? 'untapping a mana source with its mana unspent, against real Forge (AE21)'
	: `untapping a mana source with its mana unspent, against real Forge (AE21) — SKIPPED: ${available.reason}`;

type Seen = { id: number; name: string; tapped: boolean };

function board(s: Awaited<ReturnType<typeof startScenario>>): Seen[] {
	return s.zone(0, 'Battlefield').map((c) => ({ id: c.id, name: c.name, tapped: c.tapped }));
}

function line(s: Awaited<ReturnType<typeof startScenario>>, what: string): string {
	const b = s.buttons(0);
	return `[w65-elves] ${what}: ${board(s)
		.map((c) => `${c.name}#${c.id}${c.tapped ? '(T)' : ''}`)
		.join(' ')} | bar2=${b === null ? '-' : `${b.label2}${b.enable2 ? '' : '(off)'}`} | prompt="${s.prompt(0).split('\n')[0]}"`;
}

async function atMain(seed: number) {
	const s = await startScenario(available.ok ? available.config : (undefined as never), { seed, decks: DECKS, scenario: scenarioText('w65-elves') });
	await finishMulligan(s);
	await waitUntil(
		() => {
			s.answerAsks();
			return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Llanowar Elves');
		},
		"seat 0's main phase with the scripted board",
		60_000,
		s,
	);
	return s;
}

/** Click `id` until Forge shows it tapped (the scenario-start race drops a first select). */
async function tap(s: Awaited<ReturnType<typeof startScenario>>, id: number): Promise<void> {
	s.select(0, id);
	await waitUntil(
		() => {
			s.answerAsks();
			if (!s.zone(0, 'Battlefield').some((c) => c.id === id && c.tapped)) s.select(0, id);
			return s.zone(0, 'Battlefield').some((c) => c.id === id && c.tapped);
		},
		`card ${id} tapped`,
		20_000,
		s,
	);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'priority back after the tap', 20_000, s);
}

/** The board's untap click as the wire carries it: Forge's Undo button. */
function pressUndo(s: Awaited<ReturnType<typeof startScenario>>): boolean {
	const b = s.buttons(0);
	if (b === null || !b.enable2 || !UNDO.test(b.label2)) return false;
	s.cancel(0);
	return true;
}

describe.skipIf(!available.ok)(title, () => {
	it('1. control — a Forest tapped last untaps on Undo', async () => {
		if (!available.ok) return;
		const s = await atMain(6501);
		try {
			const forest = board(s).find((c) => c.name === 'Forest' && !c.tapped)!;
			await tap(s, forest.id);
			console.log(line(s, 'forest tapped'));
			expect(s.buttons(0)?.label2, 'Forge offers Undo after the tap').toMatch(UNDO);
			expect(pressUndo(s)).toBe(true);
			await waitUntil(() => { s.answerAsks(); return board(s).some((c) => c.id === forest.id && !c.tapped); }, 'the Forest untapped', 20_000, s);
			console.log(line(s, 'after undo'));
			expect(board(s).find((c) => c.id === forest.id)?.tapped).toBe(false);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('2. Llanowar Elves tapped last — Forge undoes a creature\'s mana ability on Undo', async () => {
		if (!available.ok) return;
		const s = await atMain(6502);
		try {
			const elves = board(s).find((c) => c.name === 'Llanowar Elves')!;
			await tap(s, elves.id);
			console.log(line(s, 'elves tapped'));
			const offered = s.buttons(0)?.label2 ?? '-';
			console.log(`[w65-elves] after the Elves tap the bar reads "${offered}"`);
			expect(offered, 'Forge offers Undo after a creature\'s mana tap').toMatch(UNDO);
			expect(pressUndo(s)).toBe(true);
			await waitUntil(() => { s.answerAsks(); return board(s).some((c) => c.id === elves.id && !c.tapped); }, 'the Elves untapped', 20_000, s);
			console.log(line(s, 'after undo'));
			expect(board(s).find((c) => c.id === elves.id)?.tapped).toBe(false);
		} finally {
			await s.stop();
		}
	}, 180_000);

	// Forge's undo is last-in-first-out: with two Forests tapped, one Undo gives back the SECOND; the
	// first stays tapped. The board's click on the first sends nothing (`undoableTap` offers only the
	// last). Expected to fail until the fork can undo an earlier mana ability out of order.
	it.fails('3. two Forests tapped, the FIRST clicked — only an out-of-order undo would untap it', async () => {
		if (!available.ok) return;
		const s = await atMain(6503);
		try {
			const [f1, f2] = board(s).filter((c) => c.name === 'Forest');
			await tap(s, f1!.id);
			await tap(s, f2!.id);
			console.log(line(s, 'two forests tapped'));
			expect(pressUndo(s)).toBe(true);
			await waitUntil(() => { s.answerAsks(); return board(s).some((c) => c.name === 'Forest' && !c.tapped); }, 'one Forest untapped', 20_000, s);
			console.log(line(s, 'after one undo'));
			// The claim the operator makes: the FIRST one comes back when it is the one clicked.
			expect(board(s).find((c) => c.id === f1!.id)?.tapped, 'the first Forest untapped').toBe(false);
			expect(board(s).find((c) => c.id === f2!.id)?.tapped, 'the second Forest still tapped').toBe(true);
		} finally {
			await s.stop();
		}
	}, 180_000);
});
