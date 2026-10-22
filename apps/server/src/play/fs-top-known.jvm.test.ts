/**
 * A library's top cards a seat looked at stay known to that seat while they stay on top, in order
 * (`visibility.ts`, "What a seat looked at on top of a library"). The operator, 2026-10-19: *"when
 * 'fate seal' happens and the card stays on top, it should stay revealed for the player who has that
 * knowledge … I notice it was there for a moment but then disappeared."* Against real Forge:
 *
 *   1. `fs-fate-seal`: alice's Jace, the Mind Sculptor +2 looks at bob's top card, Lightning Bolt, and
 *      keeps it there. Alice's state names it at every state frame until bob draws it; bob's state never
 *      shows alice anything of his library; Shock, under it, never reaches alice.
 *   2. `fs-scry-keep`: alice's Serum Visions draws, then scries 2 and keeps both. Her state names both
 *      at every state frame after; bob is never sent either.
 */
import { describe, expect, it } from 'vitest';

import { DELTA_TYPE, deltaKey, idsOf } from '@hadoku/forge-wire';

import { identifyingStrings } from './fixtures/transcript.js';
import { available, deck, finishMulligan, inOwnMain, passUntil, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { foldFrames, type StateFrame, type WireObj } from './visibility.js';

const title = available.ok
	? 'a looked-at library top stays known to the seat that looked, against real Forge'
	: `a looked-at library top stays known to the seat that looked, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Top A', ['40 Island']), deck('Top B', ['40 Mountain'])];

/** Every state frame `seat` was sent from `from` on, with the state it held after each. */
function statesAfter(s: Scenario, seat: number, from: number): { at: number; state: Map<string, WireObj> }[] {
	const frames: StateFrame[] = [];
	const out: { at: number; state: Map<string, WireObj> }[] = [];
	s.sent.forEach((x, i) => {
		if (x.seat !== seat || x.envelope.frame.kind !== 'notify') return;
		const f = x.envelope.frame as unknown as StateFrame;
		if (f.method !== 'setGameView' && f.method !== 'applyDelta' && f.method !== 'openView') return;
		frames.push(f);
		if (i >= from) out.push({ at: i, state: foldFrames(frames) });
	});
	return out;
}

/** `holder`'s library top first as `state` holds it: each id with the name the seat holds for it, if any. */
function topOf(state: ReadonlyMap<string, WireObj>, holder: number, n: number): string[] {
	return idsOf(state.get(deltaKey(DELTA_TYPE.player, holder)), 'Library')
		.slice(0, n)
		.map((id) => `${id}:${identifyingStrings(state, id)[0] ?? '?'}`);
}

/** Every string `seat` was sent in a state frame from `from` on. */
function sentText(s: Scenario, seat: number, from: number): string {
	return s.sent
		.slice(from)
		.filter((x) => x.seat === seat && (x.envelope.frame.method === 'applyDelta' || x.envelope.frame.method === 'setGameView'))
		.map((x) => JSON.stringify(x.envelope.frame))
		.join('\n');
}

describe.skipIf(!available.ok)(title, () => {
	it(
		"Fate Seal: Jace's +2 keeps bob's Lightning Bolt on top — alice's state names it until bob draws it, and Shock under it never reaches her",
		async () => {
			if (!available.ok) return;
			// The look is one sheet of bob's library, Top | Bottom (`./arrange.ts`'s `digAsk`): nothing moved to Bottom keeps the Bolt on top.
			const s = await startScenario(available.config, {
				seed: 4301,
				decks: DECKS,
				scenario: scenarioText('fs-fate-seal'),
				reply: (f) => (f.method === 'order' ? { ordered: [], rememberDecision: false } : undefined),
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'seat 0 to hold priority at its own turn-1 main phase', 20_000, s);
				const bob = s.match.seats[1]?.playerId as number;
				const library = (): number[] => idsOf(s.state(1).get(deltaKey(DELTA_TYPE.player, bob)), 'Library');
				const [bolt] = library() as [number];
				const jace = s.zone(0, 'Battlefield').find((c) => c.name === 'Jace, the Mind Sculptor')!;
				const mark = s.sent.length;
				s.select(0, jace.id);
				let targeted = false;
				let looked = -1;
				await waitUntil(
					() => {
						s.answerAsks();
						if (looked < 0) looked = s.sent.findIndex((x, i) => i >= mark && x.seat === 0 && x.envelope.frame.kind === 'ask' && x.envelope.frame.method === 'order');
						if (!targeted && /target/i.test(s.prompt(0))) {
							targeted = true;
							s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: bob }, triggerEvent: null } as never);
						}
						for (const seat of [0, 1]) if (/^Stack: [1-9]/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true) s.ok(seat);
						return looked >= 0 && inOwnMain(s, 0, 1) && /^Stack: Empty$/m.test(s.prompt(0));
					},
					"Jace's +2 to resolve with the Bolt kept on top",
					30_000,
					s,
				);
				expect(library()[0], 'Lightning Bolt is still on top of bob\'s library').toBe(bolt);
				const resolved = s.sent.length;
				await passUntil(s, () => s.zone(1, 'Hand').length > 0 || idsOf(s.state(1).get(deltaKey(DELTA_TYPE.player, bob)), 'Hand').length > 0, "bob's turn-2 draw");

				const states = statesAfter(s, 0, resolved);
				for (const { at, state } of statesAfter(s, 0, mark)) console.log(`[fs-fate-seal] seat0 #${at} ${s.sent[at]?.envelope.frame.method} bob top ${JSON.stringify(topOf(state, bob, 2))}`);
				const drawnAt = states.findIndex(({ state }) => !idsOf(state.get(deltaKey(DELTA_TYPE.player, bob)), 'Library').includes(bolt));
				const onTop = states.slice(0, drawnAt < 0 ? states.length : drawnAt);
				const forgot = onTop.filter(({ state }) => !identifyingStrings(state, bolt).includes('Lightning Bolt')).map(({ at }) => at);
				console.log(`[fs-fate-seal] ${onTop.length} state frames to seat 0 with the Bolt on top after the look; seat 0 lacks its name in ${JSON.stringify(forgot)}`);
				expect(onTop.length, 'seat 0 was sent state frames while the Bolt stayed on top').toBeGreaterThan(1);
				expect(forgot, "seat 0 names bob's kept top card at every state frame while it stays on top").toEqual([]);
				expect(sentText(s, 0, mark).includes('"Shock"'), 'Shock, never looked at, never reaches seat 0').toBe(false);
				const seat1 = statesAfter(s, 1, mark).at(-1)!.state;
				const told = String(seat1.get(deltaKey(DELTA_TYPE.card, bolt))?.PlayerMayLook ? JSON.stringify(seat1.get(deltaKey(DELTA_TYPE.card, bolt))?.PlayerMayLook) : 'none');
				console.log(`[fs-fate-seal] seat 1's own Bolt PlayerMayLook: ${told}`);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		"Scry keep: Serum Visions keeps Lightning Bolt and Shock on top — alice's state names both, top first, and bob is never sent either",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4302, decks: DECKS, scenario: scenarioText('fs-scry-keep') });
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'seat 0 to hold priority at its own turn-1 main phase', 20_000, s);
				const alice = s.match.seats[0]?.playerId as number;
				const visions = s.zone(0, 'Hand').find((c) => c.name === 'Serum Visions')!;
				const library = (): number[] => idsOf(s.state(0).get(deltaKey(DELTA_TYPE.player, alice)), 'Library');
				const [, bolt, shock] = library() as [number, number, number];
				const mark = s.sent.length;
				s.select(0, visions.id);
				let ordered = false;
				await waitUntil(
					() => {
						ordered ||= s.answerAsks().some((f) => f.method === 'order');
						if (s.buttons(0)?.label1 === 'Auto' && s.buttons(0)?.enable1 === true) s.ok(0);
						for (const seat of [0, 1]) if (/^Stack: [1-9]/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true) s.ok(seat);
						return ordered && /^Stack: Empty$/m.test(s.prompt(0)) && s.zone(0, 'Hand').length === 1;
					},
					'Serum Visions to resolve',
					30_000,
					s,
				);
				const resolved = s.sent.length;
				const top = library().slice(0, 2);
				console.log(`[fs-scry-keep] alice's library top after the scry ${JSON.stringify(top)} (bolt ${bolt}, shock ${shock})`);
				await passUntil(s, () => [0, 1].some((seat) => (s.turn(seat)?.n ?? 0) >= 2), 'turn 2');
				for (const { at, state } of statesAfter(s, 0, mark)) console.log(`[fs-scry-keep] seat0 #${at} ${s.sent[at]?.envelope.frame.method} alice top ${JSON.stringify(topOf(state, alice, 3))}`);
				const states = statesAfter(s, 0, resolved);
				const forgot = states.filter(({ state }) => top.some((id) => identifyingStrings(state, id).length === 0)).map(({ at }) => at);
				console.log(`[fs-scry-keep] ${states.length} state frames to seat 0 after the scry; seat 0 lacks a kept card's name in ${JSON.stringify(forgot)}`);
				expect(states.length, 'seat 0 was sent state frames after the scry').toBeGreaterThan(1);
				expect(forgot, 'seat 0 names both kept cards at every state frame while they stay on top').toEqual([]);
				const toBob = sentText(s, 1, mark);
				expect({ bolt: toBob.includes('"Lightning Bolt"'), shock: toBob.includes('"Shock"') }, 'bob is sent neither').toEqual({ bolt: false, shock: false });
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
