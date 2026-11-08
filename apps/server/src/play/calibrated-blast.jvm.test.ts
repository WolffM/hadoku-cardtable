/**
 * AF403 — "calibrated blast nothing revealed" (`m-bafaa3d3238f`), against
 * real Forge. Calibrated Blast's main ability is `DigUntil`
 * (`RevealedDestination$ Library`): `DigUntilEffect.resolve` calls
 * `GameAction.reveal(revealed, p, false)`, which (since `dontRevealToOwner`
 * is false) calls `PlayerController.reveal` for EVERY player in the game —
 * both seats. `PlayerControllerHuman.reveal` (zone != Hand, so
 * `useFloatingHandReveal` is false) calls `getGui().reveal(fm, collection)`
 * (`AbstractGuiGame.reveal` → `getChoices(message, -1, -1, items)`, the
 * SAME ask-shaped idiom AF5/AF76/AF181's already-landed reveals use) AND
 * THEN `getGui().updateRevealedCards(collection)` unconditionally.
 *
 * This proves what actually reaches each seat's wire for that reveal: a
 * `kind: 'ask', method: 'getChoices'` frame with `max <= 0` naming the
 * revealed cards (what `match.ts`'s `asReveal`/`showReveal` already turns
 * into `match.revealed`), or nothing at all.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/cb \
 *   pnpm exec vitest run apps/server/src/play/calibrated-blast.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? "Calibrated Blast's DigUntil reveal, against real Forge"
	: `Calibrated Blast's DigUntil reveal, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('CB A', ['40 Mountain']), deck('CB B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		"both seats' wire carries a reveal of the three dug cards (Mountain, Mountain, Lightning Bolt)",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4030, decks: DECKS, scenario: scenarioText('calibrated-blast') });
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'seat 0 holds priority at their own turn-1 main phase', 20_000, s);
				const cb = s.zone(0, 'Hand').find((c) => c.name === 'Calibrated Blast');
				if (cb === undefined) throw new Error('unreachable: the scenario gives seat 0 Calibrated Blast');
				const since = s.lines.length;
				s.select(0, cb.id);
				await waitUntil(
					() => {
						s.answerAsks();
						// Mana's own "Auto" pay and either seat's priority stop are both a
						// plain OK press. Once the spell is on the stack and its target
						// selection opens, click seat 1's Memnite — a legal `Any` target.
						for (const seat of [0, 1] as const) if (s.buttons(seat)?.enable1 === true) s.ok(seat);
						const memnite = s.zone(1, 'Battlefield').find((c) => c.name === 'Memnite');
						if (memnite !== undefined && /target/i.test(s.prompt(0))) s.select(0, memnite.id);
						return s.zone(0, 'Graveyard').some((c) => c.name === 'Calibrated Blast');
					},
					'Calibrated Blast cast, targeted and resolved',
					30_000,
					s,
				);

				// `Match`'s own reveal-fold timer is 250ms (`PENDING_REVEAL_FOLD_MS`); give
				// it a full second past resolution before reading `s.sent`, so a drop found
				// below is the product, never this test outrunning the fold.
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				s.answerAsks();

				// What Forge itself sent each seat from the cast on: every reveal-shaped
				// ask (`getChoices` with `max <= 0`) and every `applyDelta` frame.
				const revealAsk = (seat: number) =>
					forgeFrames(s, seat, since).find((f) => f.method === 'getChoices' && (f as unknown as { max?: number }).max !== undefined && (f as unknown as { max: number }).max <= 0);

				const seat0Reveal = revealAsk(0);
				const seat1Reveal = revealAsk(1);

				expect(seat0Reveal, `seat 0's own reveal never reached the wire as a getChoices(-1,-1) ask — forge frames since cast: ${JSON.stringify(forgeFrames(s, 0, since).map((f) => f.method))}`).toBeDefined();
				expect(seat1Reveal, `seat 1 (the opponent) never saw the reveal either — forge frames since cast: ${JSON.stringify(forgeFrames(s, 1, since).map((f) => f.method))}`).toBeDefined();

				const cardsOf = (f: ReturnType<typeof revealAsk>): string[] =>
					((f as unknown as { choices?: { label: string }[] } | undefined)?.choices ?? []).map((c) => c.label.replace(/\s*\(\d+\)$/, ''));
				expect(cardsOf(seat0Reveal).sort()).toEqual(['Lightning Bolt', 'Mountain', 'Mountain'].sort());
				expect(cardsOf(seat1Reveal).sort()).toEqual(['Lightning Bolt', 'Mountain', 'Mountain'].sort());

				// What actually left the server for each seat — after match.ts's own
				// ask-registration/fold/`displayOnly` handling, not just what Forge sent.
				const sentReveal = (seat: number) =>
					s.sent.find(
						(x) =>
							x.seat === seat &&
							(x.envelope.frame as { method?: string }).method === 'getChoices' &&
							((x.envelope.frame as { max?: number }).max ?? 1) <= 0,
					);
				const sr0 = sentReveal(0);
				const sr1 = sentReveal(1);
				expect(sr0, `seat 0 never got the reveal frame from match.ts — sent methods: ${JSON.stringify(s.sent.filter((x) => x.seat === 0).map((x) => (x.envelope.frame as { method?: string }).method))}`).toBeDefined();
				expect(sr1, `seat 1 never got the reveal frame from match.ts — sent methods: ${JSON.stringify(s.sent.filter((x) => x.seat === 1).map((x) => (x.envelope.frame as { method?: string }).method))}`).toBeDefined();
				expect(sr0?.envelope.displayOnly, 'seat 0 reveal marked displayOnly').toBe(true);
				expect(sr1?.envelope.displayOnly, 'seat 1 reveal marked displayOnly').toBe(true);

				// THE FIX (`apps/server/src/play/match.ts`'s `revealMustForceNotice`,
				// AF403): the reveal is still SENT before the dig's own move of these
				// three cards off the library's top is released (so Sorin, Grim
				// Nemesis's +1 keeps showing its reveal before the damage it causes —
				// `match.test.ts`'s own, older invariant), but `showReveal` peeks at
				// the already-queued `behindReveal` frames first and, finding that this
				// move takes the SAME revealed ids off the library's visible top, marks
				// the envelope `forceNotice: true`. The client (`apps/ui/src/play/live/
				// match.ts`'s `showReveal`) then skips `drawsFaceUp` entirely for this
				// reveal, instead of reading a transiently-stale pre-move snapshot that
				// looks exactly like Courser of Kruphix's PERSISTENT "look at top" case.
				expect(sr0?.envelope.forceNotice, 'seat 0: the move behind this reveal takes the cards off the top, so the client must not trust drawsFaceUp').toBe(true);
				expect(sr1?.envelope.forceNotice, 'seat 1: same reveal, same move, same flag').toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
