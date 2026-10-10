/**
 * The untap of a mana source whose mana is still unspent, measured against real
 * Forge — the operator's ask (ledger AE21; V6, AC7 before it): "i should be able
 * to untap llanowar elves if i haven't done anything with the mana and it hasn't
 * triggered anything."
 *
 * The board's click on a tapped permanent is a plain `selectCard`: Forge offers
 * each permanent whose mana activation it can take back (`AvailableActions.
 * cardHasActionable`) and undoes that one activation on the click, in any order
 * (`InputPassPriority.onCardSelected` → `PlayerControllerHuman.tryUndo` →
 * `MagicStack.undo(Card)`). The three cases:
 *
 *   1. a Forest tapped last, clicked
 *   2. Llanowar Elves tapped last, clicked — a creature, like a land
 *   3. two Forests tapped, the FIRST clicked — out of order: it untaps, the second stays
 *
 * The mana pool is not on the wire (`packages/forge-wire` carries no pool
 * property), so the pool is not asserted; `tapped` and the offer are.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/w65-elves.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const DECKS: [string, string] = [deck('Elves', ['40 Forest']), deck('Mountains', ['40 Mountain'])];

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

/** The cards Forge offers seat 0 now: its last `setWeaklySelectable` (none after a `clearWeaklySelectable`). */
function offered(s: Awaited<ReturnType<typeof startScenario>>): number[] {
	const last = [...s.lines]
		.reverse()
		.find((l) => l.t === 'frame' && l.seat === 0 && /^(set|clear)WeaklySelectable$/.test(String((l.frame as { method?: unknown } | null)?.method)));
	const frame = (last as { frame?: unknown } | undefined)?.frame as { method: string; cards?: { id: number }[] } | undefined;
	return frame?.method === 'setWeaklySelectable' ? (frame.cards ?? []).map((c) => c.id) : [];
}

/** The board's untap click as the wire carries it: a `selectCard` on the tapped permanent, once Forge offers it. */
async function clickToUntap(s: Awaited<ReturnType<typeof startScenario>>, id: number, what: string): Promise<void> {
	await waitUntil(() => { s.answerAsks(); return offered(s).includes(id); }, `${what}, tapped, offered for the untap click`, 20_000, s);
	s.select(0, id);
	await waitUntil(() => { s.answerAsks(); return board(s).some((c) => c.id === id && !c.tapped); }, `${what} untapped by the click`, 20_000, s);
}

describe.skipIf(!available.ok)(title, () => {
	it('1. control — a Forest tapped last untaps on a click', async () => {
		if (!available.ok) return;
		const s = await atMain(6501);
		try {
			const forest = board(s).find((c) => c.name === 'Forest' && !c.tapped)!;
			await tap(s, forest.id);
			console.log(line(s, 'forest tapped'));
			await clickToUntap(s, forest.id, 'the Forest');
			console.log(line(s, 'after the click'));
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('2. Llanowar Elves tapped last untap on a click, like a land', async () => {
		if (!available.ok) return;
		const s = await atMain(6502);
		try {
			const elves = board(s).find((c) => c.name === 'Llanowar Elves')!;
			await tap(s, elves.id);
			console.log(line(s, 'elves tapped'));
			await clickToUntap(s, elves.id, 'the Elves');
			console.log(line(s, 'after the click'));
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('3. two Forests tapped, the FIRST clicked — it untaps out of order, the second stays tapped', async () => {
		if (!available.ok) return;
		const s = await atMain(6503);
		try {
			const [f1, f2] = board(s).filter((c) => c.name === 'Forest');
			await tap(s, f1!.id);
			await tap(s, f2!.id);
			console.log(line(s, 'two forests tapped'));
			await clickToUntap(s, f1!.id, 'the first Forest');
			console.log(line(s, 'after the click on the first'));
			expect(board(s).find((c) => c.id === f2!.id)?.tapped, 'the second Forest still tapped').toBe(true);
			await clickToUntap(s, f2!.id, 'the second Forest');
		} finally {
			await s.stop();
		}
	}, 180_000);
});
