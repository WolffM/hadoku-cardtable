/**
 * Wave 35 §S item 3 — R4, "Thoughtseize: three steps (look at hand, choose,
 * 'looking at cards in your hand') should be one choice." See
 * `wave35-evidence/s3-thoughtseize.md` for the full diagnosis write-up.
 *
 * Thoughtseize (`forge-gui/res/cardsfolder/t/thoughtseize.txt`):
 *
 *   A:SP$ Discard | ValidTgts$ Player | NumCards$ 1 | DiscardValid$ Card.nonLand | Mode$ RevealYouChoose | ...
 *
 * `DiscardEffect.resolve`'s `RevealYouChoose` branch
 * (`forge-game/.../DiscardEffect.java:225-271`), for a 2-player game, is
 * THREE real Forge asks (confirmed against the real jar before the fold
 * below existed — the first `it` here still proves the diagnosis):
 *
 *   1. `getChoices(message, -1, -1, wholeHand)` to the CASTER — a REVEAL
 *      (`GameAction.reveal` → `PlayerControllerHuman.reveal` → its
 *      non-floating branch, `getGui().reveal(fm, collection)` →
 *      `AbstractGuiGame.reveal` is `getChoices(msg, -1, -1, items)`).
 *   2. `getChoices(message, min, max, validOnly)` to the CASTER — the real
 *      choice (`chooseCardsToDiscardFrom` → `useSelectCardsInput` returns
 *      false for an OPPONENT's hand with this bridge's preferences →
 *      `getGui().many(...)`, which for `max === 1` is `getChoices` too),
 *      already correctly excluding lands (`DiscardValid$ Card.nonLand` is
 *      Forge's OWN filter).
 *   3. `getChoices(message, -1, -1, [theOneCardTaken])` to the DISCARDER — a
 *      second REVEAL, of just what was chosen, no decision at all.
 *
 * `apps/server/src/play/match.ts`'s `onFrame` now folds 1 into 2 (one
 * synthetic `chooseSingleEntityForEffect` ask reaches the browser, with the
 * whole hand visible via `delayedReveal` and only the valid cards in
 * `optionList`) and drops 3 unconditionally (the operator's ruling) — see
 * that file's own header above `newMatchId`. The second `it` proves the fold
 * end to end against the real jar.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-s/work \
 *   pnpm exec vitest run apps/server/src/play/scenario-thoughtseize.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'R4: casting Thoughtseize, against real Forge'
	: `R4: casting Thoughtseize, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Seize A', ['40 Mountain']), deck('Seize B', ['40 Mountain'])];

/** Every frame `seat` is sent from `from`, timestamped off `t0`, as readable lines. */
function dump(s: Scenario, seat: number, from: number, t0: number): string[] {
	const out: string[] = [];
	for (const x of s.sent.slice(from)) {
		if (x.seat !== seat) continue;
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
		else if (m === 'message') out.push(`${at} MESSAGE ${JSON.stringify(f.message)}`);
		else if (m === 'applyDelta' || m === 'setGameView') continue;
		else out.push(`${at} ${m}`);
	}
	return out;
}

interface Hand {
	seize: { id: number };
	mystic: { id: number };
	guide: { id: number };
	mtn: { id: number };
}

async function castThoughtseize(seed: number): Promise<{ s: Scenario; hand: Hand; oppId: number; mark: number; t0: number }> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText('thoughtseize') });
	await finishMulligan(s);
	await waitUntil(() => s.zone(0, 'Hand').some((c) => c.name === 'Thoughtseize'), "seat 0's hand to reflect Thoughtseize", 20_000, s);
	const seize = s.zone(0, 'Hand').find((c) => c.name === 'Thoughtseize');
	const mystic = s.zone(1, 'Hand').find((c) => c.name === 'Elvish Mystic');
	const guide = s.zone(1, 'Hand').find((c) => c.name === 'Goblin Guide');
	const mtn = s.zone(1, 'Hand').find((c) => c.name === 'Mountain');
	if (seize === undefined) throw new Error('no Thoughtseize in hand');
	if (mystic === undefined) throw new Error("no Elvish Mystic in seat 1's hand");
	if (guide === undefined) throw new Error("no Goblin Guide in seat 1's hand");
	if (mtn === undefined) throw new Error("no Mountain in seat 1's hand");
	const oppId = s.match.seats[1]?.playerId as number;
	/*
	 * `finishMulligan` returning is not the same fact as seat 0 actually
	 * holding priority at its own turn-1 main phase (memory "jar casts wait
	 * for priority": a select sent right after `finishMulligan` is dropped
	 * under load — Forge needs a frame or two after the handoff before the
	 * real cast window is current, and `select` sends a raw act with no
	 * precondition of its own). Gate on `inOwnMain` first, the same signal
	 * every other scenario file in this suite uses to find its own first
	 * act.
	 */
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "seat 0 to hold priority at its own turn-1 main phase", 20_000, s);
	const mark = s.sent.length;
	const t0 = performance.now();
	s.select(0, seize.id);
	let targeted = false;
	let paid = false;
	await waitUntil(
		() => {
			s.answerAsks();
			if (!targeted && /target/i.test(s.prompt(0))) {
				targeted = true;
				s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never);
			}
			if (!paid && s.buttons(0)?.label1 === 'Auto' && s.buttons(0)?.enable1 === true) {
				paid = true;
				s.ok(0);
			}
			return paid;
		},
		'Thoughtseize targeted and paid for',
		20_000,
		s,
	);
	return { s, hand: { seize, mystic, guide, mtn }, oppId, mark, t0 };
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'the fold: ONE ask reaches the caster (the whole hand visible, only nonland choosable), and the discarder sees NO ask at all',
		async () => {
			if (!available.ok) return;
			const { s, hand, mark, t0 } = await castThoughtseize(3001);
			try {
				const mergedAsk = await waitUntil(
					() => {
						s.answerAsks();
						return s.sent.slice(mark).some((x) => x.seat === 0 && x.envelope.frame.kind === 'ask' && x.envelope.frame.method === 'chooseSingleEntityForEffect');
					},
					'the merged chooseSingleEntityForEffect ask',
					20_000,
					s,
				).then(
					() =>
						s.sent
							.slice(mark)
							.map((x) => x.envelope.frame)
							.find((f) => f.kind === 'ask' && f.method === 'chooseSingleEntityForEffect') as Extract<ServerFrame, { kind: 'ask'; method: 'chooseSingleEntityForEffect' }>,
				);

				// No raw `getChoices` ever reached seat 0 for this effect — no
				// separate "look at hand" step in front of the real choice (other
				// asks, like `getAbilityToPlay` for casting the spell itself and
				// `openZones` for the targeting input, are unrelated to the fold and
				// still arrive normally).
				const seat0Asks = s.sent.slice(mark).filter((x) => x.seat === 0 && x.envelope.frame.kind === 'ask');
				expect(seat0Asks.map((x) => (x.envelope.frame as { method: string }).method)).not.toContain('getChoices');
				expect(seat0Asks.filter((x) => (x.envelope.frame as { method: string }).method === 'chooseSingleEntityForEffect')).toHaveLength(1);

				// The choosable set is nonland only — Mountain is excluded.
				const optionIds = mergedAsk.optionList.filter((r) => r.kind === 'card').map((r) => r.id);
				expect(new Set(optionIds)).toEqual(new Set([hand.mystic.id, hand.guide.id]));

				// But the WHOLE hand — including the land — is still shown, via the
				// same `delayedReveal` shape `ChoicePrompts.tsx` already draws greyed
				// for a library search (the "Rampant Growth shape").
				expect(mergedAsk.delayedReveal).not.toBeNull();
				const revealedIds = (mergedAsk.delayedReveal?.cards ?? []).map((c) => c.id);
				expect(new Set(revealedIds)).toEqual(new Set([hand.mystic.id, hand.guide.id, hand.mtn.id]));

				// Answer it: pick Elvish Mystic.
				s.match.fromClient(0, { kind: 'reply', callId: mergedAsk.callId, method: 'chooseSingleEntityForEffect', result: { kind: 'card', id: hand.mystic.id } } as never);
				await waitUntil(() => s.zone(1, 'Hand').length < 3, 'the discard to land', 20_000, s);

				// The discarder (seat 1) got no ask at all for this whole effect —
				// the settled ruling: "nobody gets a confirmation afterwards."
				await new Promise((r) => setTimeout(r, 1000));
				s.answerAsks();
				const seat1Asks = s.sent.slice(mark).filter((x) => x.seat === 1 && x.envelope.frame.kind === 'ask');
				const lines0 = dump(s, 0, mark, t0);
				const lines1 = dump(s, 1, mark, t0);
				const summary = [
					`discarded=${JSON.stringify(s.zone(1, 'Graveyard').map((c) => c.name))}`,
					`seat1 hand now: ${JSON.stringify(s.zone(1, 'Hand').map((c) => c.name))}`,
					`seat0 asks: ${JSON.stringify(seat0Asks.map((x) => (x.envelope.frame as { method: string }).method))}`,
					`seat1 asks: ${JSON.stringify(seat1Asks.map((x) => (x.envelope.frame as { method: string }).method))}`,
					'--- frames SEAT 0 (caster) ---',
					...lines0,
					'--- frames SEAT 1 (discarder) ---',
					...lines1,
				];
				console.log(`[w35-s3-fold]\n${summary.join('\n')}`);

				expect(seat1Asks, `the discarder was sent an ask it should not have been:\n${summary.join('\n')}`).toEqual([]);
				expect(s.zone(1, 'Hand').some((c) => c.id === hand.mystic.id)).toBe(false);
				expect(s.zone(1, 'Hand').some((c) => c.id === hand.guide.id)).toBe(true);
				expect(s.zone(1, 'Hand').some((c) => c.id === hand.mtn.id)).toBe(true);
				expect(s.zone(1, 'Graveyard').some((c) => c.id === hand.mystic.id)).toBe(true);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);

	it(
		'the land is never a legal choice: picking the land is refused by Forge itself',
		async () => {
			if (!available.ok) return;
			const { s, hand, mark } = await castThoughtseize(3002);
			try {
				const mergedAsk = await waitUntil(
					() => {
						s.answerAsks();
						return s.sent.slice(mark).some((x) => x.seat === 0 && x.envelope.frame.kind === 'ask' && x.envelope.frame.method === 'chooseSingleEntityForEffect');
					},
					'the merged ask',
					20_000,
					s,
				).then(
					() =>
						s.sent
							.slice(mark)
							.map((x) => x.envelope.frame)
							.find((f) => f.kind === 'ask' && f.method === 'chooseSingleEntityForEffect') as Extract<ServerFrame, { kind: 'ask'; method: 'chooseSingleEntityForEffect' }>,
				);
				expect(mergedAsk.optionList.some((r) => r.kind === 'card' && r.id === hand.mtn.id), 'the land was offered as a choosable option').toBe(false);
				// Answer with the land anyway (a malicious or buggy client): `match.ts`
				// only maps a ref to a key if the merge's own `optionList` offered it
				// (`keyByRef`, built from `choose.choices` alone — the land was never
				// in it), so this maps to NO key and is forwarded as an EMPTY choice —
				// the SERVER never fabricates a choice Forge did not offer. Measured:
				// Forge's own response to an empty reply for a MANDATORY (non-optional)
				// `getChoices` is not "nothing chosen" but its own default of the
				// first valid option (`choices[0]`, here Elvish Mystic) — Forge
				// remains the one authority on what counts as a legal pick, and in
				// neither case does the land ever reach the graveyard.
				s.match.fromClient(0, { kind: 'reply', callId: mergedAsk.callId, method: 'chooseSingleEntityForEffect', result: { kind: 'card', id: hand.mtn.id } } as never);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(1, 'Hand').length < 3;
					},
					'the discard to resolve (with SOME valid card, never the land)',
					20_000,
					s,
				);
				console.log(
					'[w35-s3-land-debug]',
					JSON.stringify({
						handNow: s.zone(1, 'Hand').map((c) => ({ id: c.id, name: c.name })),
						graveyard: s.zone(1, 'Graveyard').map((c) => ({ id: c.id, name: c.name })),
					}),
				);
				expect(s.zone(1, 'Hand').some((c) => c.id === hand.mtn.id), 'the land left the hand').toBe(true);
				expect(s.zone(1, 'Graveyard').some((c) => c.id === hand.mtn.id), 'the land was discarded').toBe(false);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);
});
