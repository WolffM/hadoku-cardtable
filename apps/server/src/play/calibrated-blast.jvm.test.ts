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

import { DELTA_TYPE, deltaKey, idsOf, strOf } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';
import { foldFrames, type StateFrame } from './visibility.js';

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

				// THE ACTUAL ROOT CAUSE (confirmed against real Forge; `drawsFaceUp`'s and
				// `knownTop`'s own logic in `apps/ui/src/play/adapter.ts` traced from here):
				// `showReveal`/`releaseReveal` in `match.ts` currently show the reveal to the
				// seat BEFORE releasing the dig's own move of the three revealed cards off
				// the library's top (held in `s.behindReveal` while `s.pendingReveal` was
				// set). So at the instant the client's `drawsFaceUp(view, cardIds)` runs, the
				// revealed cards are STILL (transiently) the library's known top three —
				// indistinguishable from Courser of Kruphix's PERSISTENT "look at top" case —
				// and the notice is skipped as "the board already shows this". But the move
				// lands a moment later and nothing else ever draws these cards: no notice, no
				// board tile, nothing. The fix is to release the held frames BEFORE showing
				// the reveal (match `match.ts`'s own merge branch two lines above, which
				// already does `releaseReveal` before `openMergedChoice`): swap the order of
				// `showReveal`/`releaseReveal` in all three call sites of the R4 reveal-fold
				// branch. This assertion is RED on today's `match.ts` and GREEN once that
				// two-line reorder lands.
				const seat0PlayerId = s.match.seats[0]?.playerId ?? -1;
				// The cards the reveal ask itself names (Mountain, Mountain, Lightning Bolt) —
				// read from `sr0`'s own choices, never re-derived from the folded state (that
				// would make the comparison self-referential and prove nothing).
				const revealedIds = ((sr0!.envelope.frame as unknown as { choices?: { ref?: { kind: string; id: number } | null }[] }).choices ?? [])
					.flatMap((c) => (c.ref?.kind === 'card' ? [c.ref.id] : []));
				expect(revealedIds.length, 'the reveal names exactly the three dug cards').toBe(3);
				const atReveal = foldFrames(
					s.sent
						.slice(0, s.sent.indexOf(sr0!) + 1)
						.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
				const libAtReveal = idsOf(atReveal.get(deltaKey(DELTA_TYPE.player, seat0PlayerId)), 'Library');
				const namesAtReveal = libAtReveal.slice(0, 3).map((id) => strOf(atReveal.get(deltaKey(DELTA_TYPE.card, id)), 'Name'));
				// The claim: by the time the client has processed everything up to and
				// including the reveal frame, the three revealed cards must ALREADY be off
				// the library's top three (the dig's own move to the bottom, which `match.ts`
				// currently holds BEHIND the reveal and releases only after it, must instead
				// reach the client first). If they are still there, `adapter.ts`'s
				// `drawsFaceUp`/`knownTop` reads this one-shot reveal as a persistent,
				// already-visible library top (Courser of Kruphix's shape) and suppresses the
				// only place it would ever be shown (AF403).
				const stillOnTopWhenRevealArrives = revealedIds.every((id) => libAtReveal.slice(0, 3).includes(id));
				expect(
					stillOnTopWhenRevealArrives,
					`the three revealed cards must already be off the library's top by the time the displayOnly reveal reaches the client — ` +
						`library top as of the reveal frame: ${JSON.stringify(libAtReveal.slice(0, 5))} names ${JSON.stringify(namesAtReveal)}, revealed ids: ${JSON.stringify(revealedIds)}`,
				).toBe(false);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
