/**
 * Wave 52 §S (A, B) against real Forge — the operator's Augur of Skulls, match
 * m-6ce49e226aef, 2026-10-06:
 *
 *  - (A) *"i would expect the shortcutter not to skip past my upkeep if i have an
 *    active ability in play that requires upkeep."* The bridge names, per priority
 *    window, the permanents with an ability restricted to the current phase
 *    (`setWeaklySelectable.phaseRestricted`), and `decideStop` keeps a non-stop
 *    phase for them (`StopPolicy.stopForPhaseAbility`). The control: a castable
 *    instant in hand and no Augur, whose upkeep is passed exactly as before — wave
 *    28's rule that a stop must never depend on the hand.
 *  - (B) *"after selecting the creature, and then selecting the sacrifice ability it
 *    AGAIN asks me if i want to sacrifice the augur of skulls. thats a redundant
 *    ask."* The bridge names the ability a Yes/No confirm belongs to
 *    (`showPromptMessage.confirmAbility`) and the server answers Yes when the seat
 *    just chose that ability (`chosenCostConfirm`). Mirri's Guile's optional upkeep
 *    trigger is the same Yes/No shape and must still be asked.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/w52-s \
 *   pnpm exec vitest run apps/server/src/play/w52-s-augur.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'wave 52 §S: the upkeep-only ability stops the upkeep, and its chosen cost confirms itself, against real Forge'
	: `wave 52 §S: the upkeep-only ability stops the upkeep, and its chosen cost confirms itself, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Swamps A', ['40 Swamp']), deck('Swamps B', ['40 Swamp'])];

const UPKEEP = /^Phase: Upkeep step$/m;

describe.skipIf(!available.ok)(title, () => {
	it(
		'Augur and two Swamps: the upkeep stops; choosing the sacrifice asks nothing more; the optional trigger still asks',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 52,
				decks: DECKS,
				scenario: scenarioText('w52-s-augur'),
				// Augur offers two abilities when it is clicked; the seat picks the sacrifice.
				reply: (f) => {
					if (f.method !== 'getAbilityToPlay') return undefined;
					const offered = f.abilities as { label?: string }[];
					return offered.find((a) => /discard/i.test(a.label ?? '')) ?? offered[0] ?? null;
				},
			});
			try {
				await finishMulligan(s);
				const logsBefore = s.logs.length;
				const opponent = s.match.seats[1]?.playerId;
				if (opponent === null || opponent === undefined) throw new Error('seat 1 has no player');

				let triggerAsked = false;
				let upkeepStopped = false;
				let augurClicked = false;
				let targeted = false;
				let stopAt = -1;
				const pressed = new Set<number>();
				await waitUntil(
					() => {
						s.answerAsks();
						if (s.zone(0, 'Graveyard').some((c) => c.name === 'Augur of Skulls')) return true;
						const at = s.sent.map((x, i) => (x.seat === 0 && x.envelope.frame.method === 'showPromptMessage' ? i : -1)).filter((i) => i >= 0).pop();
						if (at === undefined || pressed.has(at)) return false;
						const msg = s.prompt(0);
						// The target selection's OK stays dead until a target is chosen.
						if (/target player/i.test(msg) && !targeted) {
							targeted = true;
							pressed.add(at);
							s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: opponent }, triggerEvent: null } as never);
							return false;
						}
						if (s.buttons(0)?.enable1 !== true) return false;
						if (/Mirri's Guile/.test(msg) && s.buttons(0)?.label1 === 'Yes') {
							// The optional trigger's "may": a real choice, asked. Decline it, so no
							// library rearrangement follows.
							triggerAsked = true;
							pressed.add(at);
							s.cancel(0);
						} else if (/sacrifice/i.test(msg) && s.buttons(0)?.label1 === 'Yes') {
							// Reaching here at all means the cost confirm was put to the seat.
							pressed.add(at);
							s.ok(0);
						} else if (msg.startsWith('Priority:') && UPKEEP.test(msg) && /^Stack: Empty$/m.test(msg)) {
							upkeepStopped = true;
							if (stopAt < 0) stopAt = at;
							const augur = s.zone(0, 'Battlefield').find((c) => c.name === 'Augur of Skulls');
							if (augur !== undefined && !augurClicked) {
								augurClicked = true;
								pressed.add(at);
								s.select(0, augur.id);
							}
						} else if (msg.startsWith('Priority:') && UPKEEP.test(msg)) {
							// The trigger on the stack, with Augur actionable: pass it so it resolves.
							pressed.add(at);
							s.ok(0);
						}
						return false;
					},
					'Augur of Skulls to be sacrificed in the upkeep',
					90_000,
					s,
				);

				const mine = s.logs.slice(logsBefore).filter((l) => l.seat === 0);
				expect(upkeepStopped, 'seat 0 was given its upkeep with an empty stack').toBe(true);
				// The stop is the FIRST empty-stack upkeep window seat 0 was shown: none was
				// passed before it. (Mirri's trigger on the stack is passed as the seat's own
				// item, `passOwnSpell`; after the activation Augur is gone — ordinary passes.)
				const emptyUpkeeps = s.sent
					.map((x, i) => ({ x, i }))
					.filter(({ x }) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage')
					.filter(({ x }) => {
						const m = (x.envelope.frame as unknown as { message: string }).message;
						return m.startsWith('Priority:') && UPKEEP.test(m) && /^Stack: Empty$/m.test(m);
					})
					.map(({ i }) => i);
				expect(emptyUpkeeps[0]).toBe(stopAt);
				expect(triggerAsked, "Mirri's Guile's optional trigger was put to the seat").toBe(true);
				// The seat chose the sacrifice and was asked nothing more: the cost confirm
				// was answered by the server and never sent to the seat.
				const sacAsk = s.sent.filter(
					(x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage' && /Sacrifice Augur of Skulls\?/.test((x.envelope.frame as unknown as { message: string }).message),
				);
				expect(sacAsk, 'the sacrifice confirm never reached the seat').toEqual([]);
				expect(mine.filter((l) => l.evt === 'auto-confirmed')).toHaveLength(1);
				// The bridge named the restricted permanent in the upkeep's offer, and only it.
				const augurId = s.zone(0, 'Graveyard').find((c) => c.name === 'Augur of Skulls')?.id;
				const restricted = s.sent
					.filter((x) => x.seat === 0 && x.envelope.frame.method === 'setWeaklySelectable')
					.flatMap((x) => ((x.envelope.frame as unknown as { phaseRestricted?: { id: number }[] }).phaseRestricted ?? []).map((c) => c.id));
				expect(restricted.length).toBeGreaterThan(0);
				expect(new Set(restricted)).toEqual(new Set([augurId]));
			} catch (err) {
				console.log(`[augur-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		180_000,
	);

	it(
		'a castable instant in hand and no Augur: the upkeep is passed, as wave 28 decided',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 52, decks: DECKS, scenario: scenarioText('w52-s-instant') });
			try {
				await finishMulligan(s);
				await waitUntil(
					() => {
						s.answerAsks();
						return inOwnMain(s, 0, 1);
					},
					"seat 0's own Main 1",
					60_000,
					s,
				);
				const ritual = s.zone(0, 'Hand').find((c) => c.name === 'Dark Ritual')?.id;
				expect(ritual).toBeDefined();
				// The upkeep's offer named Dark Ritual and no restricted permanent…
				//
				// this window is the one the server auto-passes right
				// below, so `match.ts` withholds its `showPromptMessage` whole rather
				// than forwarding it — read `s.lines` (the raw bridge stream Forge
				// itself sent), not `s.sent` (this seat's own wire), for exactly that
				// reason; `setWeaklySelectable` is never withheld, so it is unmoved
				// either way.
				const upkeepPrompt = s.lines.findIndex(
					(l) =>
						l.t === 'frame' &&
						l.seat === 0 &&
						(l.frame as { method?: unknown } | null)?.method === 'showPromptMessage' &&
						UPKEEP.test((l.frame as { message?: string }).message ?? ''),
				);
				expect(upkeepPrompt, 'seat 0 was shown an upkeep window').toBeGreaterThanOrEqual(0);
				const offer = [...s.lines.slice(0, upkeepPrompt + 1)]
					.reverse()
					.find((l) => l.t === 'frame' && l.seat === 0 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable') as
					| { frame: { cards: { id: number }[]; phaseRestricted?: { id: number }[] } }
					| undefined;
				expect(offer?.frame.cards.map((c) => c.id)).toContain(ritual);
				expect(offer?.frame.phaseRestricted).toEqual([]);
				// …and the server passed it.
				expect(s.logs.filter((l) => l.evt === 'auto-passed' && l.seat === 0 && l.phase === 'Upkeep step')).toHaveLength(1);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
