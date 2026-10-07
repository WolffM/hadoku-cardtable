/**
 * Wave 35 §S item 1 — R13, "Secluded Glen's 'you may reveal a Faerie' was
 * decided for me." The playtest log shows no auto-answered choice and every
 * choice took a person 2.7–112 s, so the reveal never reached the seat as a
 * question: either Forge decided it, or the server pressed OK on an input
 * (`match.ts`'s `maybeAutoPass`). This scenario plays the land and records
 * every frame seat 0 is sent, so the answer is read off a real run rather
 * than theorized from the card script — see `wave35-evidence/s1-secluded-glen.md`
 * for the full write-up and the conclusion.
 *
 * Secluded Glen's text (`forge-gui/res/cardsfolder/s/secluded_glen.txt`):
 *
 *   R:Event$ Moved | ... | ReplaceWith$ DBTap | ...
 *   SVar:DBTap:DB$ Tap | ETB$ True | Defined$ Self | UnlessCost$ Reveal<1/Faerie> | UnlessPayer$ You | ...
 *
 * `AbilityUtils.handleUnlessCost` routes `UnlessCost` through
 * `PlayerController.payCostToPreventEffect` →
 * `PlaySpellAbility.payCostDuringAbilityResolve` → (for a `CostReveal` part)
 * `payCostPart` → `controller.chooseCardsForCost(..., isOptional=true, ...)`
 * (`PlayerControllerHuman.java:2619`), which opens a REAL
 * `InputSelectCardsFromList` (`min=max=1`, cancel allowed) — the same input
 * class the module header of `apps/ui/src/play/live/match.ts` already
 * documents as one of the two inputs that call `setSelectables`.
 *
 * **Finding (both cases below, proven against the real jar): Forge DOES ask,
 * our bridge and server DO forward it unaltered, and neither suspected cause
 * reproduces.** `setSelectables([faerieSeerId], 1, 1)` plus an enabled Cancel
 * button reach seat 0 every time; selecting the Faerie Seer reveals it and the
 * land enters untapped, and Cancel (or declining) enters it tapped. Our
 * server's `maybeAutoPass` never presses this window's buttons regardless —
 * OK is disabled until something is selected (`decideStop`'s own
 * `!facts.confirmLive` guard refuses before the window classification is even
 * reached), and the window is classified `'other'` either way (the prompt
 * does not start with `Priority: `) so `decideStop` would refuse a second,
 * independent way. See the evidence doc for why this still looks like
 * "decided for me" to a player, and why that is not a fix available to this
 * lane's files.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-s/work \
 *   pnpm exec vitest run apps/server/src/play/scenario-glen.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? "R13 diagnosis: Secluded Glen's reveal, against real Forge"
	: `R13 diagnosis: Secluded Glen's reveal, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Glen A', ['40 Mountain']), deck('Glen B', ['40 Mountain'])];

/** Every frame seat 0 is sent from `from`, timestamped off `t0`, as readable lines. */
function dump(s: Scenario, from: number, t0: number): string[] {
	const out: string[] = [];
	for (const x of s.sent.slice(from)) {
		if (x.seat !== 0) continue;
		const f = x.envelope.frame as unknown as Record<string, unknown>;
		const m = String(f.method ?? f.kind);
		const at = `+${Math.round(x.t - t0)}ms`;
		if (m === 'showPromptMessage') out.push(`${at} PROMPT ${JSON.stringify(f.message)}`);
		else if (m === 'updateButtons') out.push(`${at} BUTTONS [${String(f.label1)}${f.enable1 === true ? '' : '-'}] [${String(f.label2)}${f.enable2 === true ? '' : '-'}]`);
		else if (m === 'setSelectables') out.push(`${at} SELECTABLES ${JSON.stringify((f.cards as { id: number }[]).map((c) => c.id))} min=${String(f.min)} max=${String(f.max)}`);
		else if (m === 'clearSelectables') out.push(`${at} SELECTABLES cleared`);
		else if (m === 'setWeaklySelectable') out.push(`${at} ACTIONABLE ${JSON.stringify((f.cards as { id: number }[]).map((c) => c.id))}`);
		else if (m === 'clearWeaklySelectable') out.push(`${at} ACTIONABLE cleared`);
		else if (f.kind === 'ask') out.push(`${at} ASK ${m} ${JSON.stringify(f)}`);
		else if (m === 'applyDelta' || m === 'setGameView') continue;
		else out.push(`${at} ${m}`);
	}
	return out;
}

/** Start the scenario, play Secluded Glen from hand, and wait for the reveal selection to open. */
async function clickGlenAndWaitForReveal(seed: number): Promise<{ s: Scenario; mark: number; t0: number; faerieId: number }> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText('secluded-glen') });
	await finishMulligan(s);
	await waitUntil(() => s.zone(0, 'Hand').some((c) => c.name === 'Secluded Glen'), "seat 0's hand to reflect the scripted Secluded Glen", 20_000);
	const glen = s.zone(0, 'Hand').find((c) => c.name === 'Secluded Glen');
	const faerie = s.zone(0, 'Hand').find((c) => c.name === 'Faerie Seer');
	if (glen === undefined) throw new Error('no Secluded Glen in hand');
	if (faerie === undefined) throw new Error('no Faerie Seer in hand');
	const mark = s.sent.length;
	const t0 = performance.now();
	s.select(0, glen.id);
	// `getAbilityToPlay` (one ability, "Play land") must be answered for Forge's
	// game thread to proceed into the land-play replacement effect at all, and
	// `tempShowZones` (a SEPARATE ask the input's constructor fires on the EDT
	// while it sets up) must be drained too, or `InputSelectEntitiesFromList`'s
	// own `onStop` — which reads back what that ask revealed — never finishes.
	// Wait for the PROMPT this specific input shows, not merely `setSelectables`:
	// the two frames are not atomic (same race `match.ts`'s own `payingMana`
	// documents), and a check against `setSelectables` alone can pass one tick
	// before `updateButtons` catches up, reading the PREVIOUS input's bar.
	await waitUntil(
		() => {
			s.answerAsks();
			return /Select 1 Faerie/.test(s.prompt(0)) && s.buttons(0)?.enable2 === true;
		},
		'Forge to open the reveal selection, with its own prompt and bar',
		20_000,
	);
	return { s, mark, t0, faerieId: faerie.id };
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Forge DOES ask: a real selection (not an auto-decision) opens, naming the Faerie Seer',
		async () => {
			if (!available.ok) return;
			const { s, mark, t0, faerieId } = await clickGlenAndWaitForReveal(1335);
			try {
				const lines = dump(s, mark, t0);
				console.log(`[w35-s1]\n${lines.join('\n')}`);

				// The selection names the Faerie Seer, exactly min=max=1.
				const sel = s.sent.slice(mark).map((x) => x.envelope.frame).find((f) => f.kind === 'notify' && f.method === 'setSelectables') as
					| { method: 'setSelectables'; cards: { id: number }[]; min: number; max: number }
					| undefined;
				expect(sel, 'no setSelectables ever arrived — this would be "Forge decided it"').toBeDefined();
				expect(sel!.cards.map((c) => c.id)).toEqual([faerieId]);
				expect(sel!.min).toBe(1);
				expect(sel!.max).toBe(1);

				// Not yet landed: the game thread is genuinely parked on this choice.
				expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Secluded Glen')).toBe(false);

				// Cancel is live (declining is always an option); OK is not (nothing
				// selected yet) — so our own `maybeAutoPass` could not press OK here
				// even if its window classification were wrong, because
				// `decideStop`'s `!facts.confirmLive` guard refuses first.
				const btn = s.buttons(0);
				expect(btn?.enable1).toBe(false);
				expect(btn?.enable2).toBe(true);

				// And our server never pressed anything on its own: the land is still
				// sitting unresolved after the selection opened, with no further
				// frame from the server acting for the seat.
				expect(s.zone(0, 'Hand').some((c) => c.name === 'Faerie Seer')).toBe(true);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);

	it(
		'revealing the Faerie Seer: the land enters UNTAPPED, and the card is revealed, not spent',
		async () => {
			if (!available.ok) return;
			const { s, faerieId } = await clickGlenAndWaitForReveal(1336);
			try {
				s.select(0, faerieId);
				await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.name === 'Secluded Glen'); }, 'Secluded Glen to resolve', 20_000);
				const glen = s.zone(0, 'Battlefield').find((c) => c.name === 'Secluded Glen');
				expect(glen?.tapped).toBe(false);
				// Revealed, not exiled or discarded: still in hand afterward.
				expect(s.zone(0, 'Hand').some((c) => c.name === 'Faerie Seer')).toBe(true);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);

	it(
		'declining the reveal (Cancel): the land enters TAPPED',
		async () => {
			if (!available.ok) return;
			const { s } = await clickGlenAndWaitForReveal(1337);
			try {
				s.cancel(0);
				await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.name === 'Secluded Glen'); }, 'Secluded Glen to resolve', 20_000);
				const glen = s.zone(0, 'Battlefield').find((c) => c.name === 'Secluded Glen');
				expect(glen?.tapped).toBe(true);
				expect(s.zone(0, 'Hand').some((c) => c.name === 'Faerie Seer')).toBe(true);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);
});
