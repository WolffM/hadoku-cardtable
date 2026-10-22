/**
 * The measurement behind `e2e/w63-yield.spec.ts`'s reds (2026-10-09): with
 * alice yielding, bob's Bolt left his hand but the e2e never saw alice's face
 * become selectable on bob's screen, and the Bolt never resolved. The board
 * offers a player while a `setSelectables` is live on that seat's wire and at
 * no other time (`apps/ui/src/play/live/match.ts`, "Players"). So the product
 * fact this test waits on is THAT frame on bob's wire — not the prompt text the
 * sibling `yield.jvm.test.ts` driver uses — and then targets alice the way the
 * board does. Twice in one JVM, because the e2e was red in full runs and
 * green alone: a race, if it is one, needs repetition.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/w65-yield-wire.jvm.test.ts
 */
import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, inOwnMain, passUntil, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const DECKS: [string, string] = [deck('Y A', ['40 Mountain']), deck('Y B', ['40 Mountain'])];
const ALICE = 0;
const BOB = 1;

function lifeOf(s: Scenario, seat: number): number {
	const player = s.state(seat).get(deltaKey(DELTA_TYPE.player, s.match.seats[seat]?.playerId ?? -1));
	return (player?.Life as { v?: number } | undefined)?.v ?? -1;
}

/** Bob's wire since `from`, one line per frame, for the record. */
function bobWire(s: Scenario, from: number): string[] {
	return s.sent
		.slice(from)
		.filter((x) => x.seat === BOB)
		.map((x) => {
			const f = x.envelope.frame as { method?: string; message?: string; players?: unknown; enable1?: boolean };
			const extra = f.method === 'showPromptMessage' ? ` "${(f.message ?? '').slice(0, 40)}"` : f.method === 'setSelectables' ? ` players=${JSON.stringify(f.players ?? null)}` : f.method === 'updateButtons' ? ` ok=${String(f.enable1)}` : '';
			return `${Math.round(x.t)} ${f.method ?? '?'}${extra}`;
		});
}

/** Cast bob's Bolt at alice the way the BOARD does: click, wait for the selection frame, click the face. */
async function boltAliceLikeTheBoard(s: Scenario, label: string): Promise<void> {
	await waitUntil(
		() => {
			s.answerAsks();
			return s.zone(BOB, 'Hand').some((c) => c.name === 'Lightning Bolt');
		},
		`${label}: bob to hold a Lightning Bolt`,
		20_000,
		s,
	);
	const bolt = s.zone(BOB, 'Hand').find((c) => c.name === 'Lightning Bolt');
	if (bolt === undefined) throw new Error('no Lightning Bolt in bob’s hand');
	const aliceId = s.match.seats[ALICE]?.playerId as number;
	const sentMark = s.sent.length;
	const lifeBefore = lifeOf(s, ALICE);
	s.select(BOB, bolt.id);
	const t0 = performance.now();
	// The board's own condition for offering a player: a live `setSelectables` on this seat's wire.
	await waitUntil(
		() => {
			s.answerAsks();
			return s.sent.slice(sentMark).some((x) => x.seat === BOB && x.envelope.frame.method === 'setSelectables');
		},
		`${label}: a setSelectables on bob's wire after the Bolt click (bob's wire: ${bobWire(s, sentMark).join(' | ')})`,
		10_000,
		s,
	);
	const tSel = performance.now() - t0;
	const sel = s.sent.slice(sentMark).find((x) => x.seat === BOB && x.envelope.frame.method === 'setSelectables')?.envelope.frame as { players?: unknown; cards?: unknown; min?: number; max?: number } | undefined;
	console.log(`[w65-yield-wire] ${label}: setSelectables players=${JSON.stringify(sel?.players ?? null)} cards=${JSON.stringify(sel?.cards ?? null)} min=${String(sel?.min)} max=${String(sel?.max)}; alice playerId=${aliceId}; bob's wire: ${bobWire(s, sentMark).join(' | ')}`);
	s.match.fromClient(BOB, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: aliceId }, triggerEvent: null } as never);
	let alicePressed: string | null = null;
	await waitUntil(
		() => {
			s.answerAsks();
			// Without auto-yield alice gets a real window; press it once per prompt, as a player would.
			const aliceMsg = s.prompt(ALICE);
			if (alicePressed !== aliceMsg && /^Priority: alice/.test(aliceMsg) && s.buttons(ALICE)?.enable1 === true) {
				alicePressed = aliceMsg;
				s.ok(ALICE);
			}
			return lifeOf(s, ALICE) === lifeBefore - 3;
		},
		`${label}: the Bolt to resolve at alice (bob's wire: ${bobWire(s, sentMark).join(' | ')})`,
		20_000,
		s,
	);
	console.log(`[w65-yield-wire] ${label}: setSelectables on bob's wire ${Math.round(tSel)} ms after the click; alice ${lifeBefore} → ${lifeOf(s, ALICE)}`);
}

describe.skipIf(!available.ok)('auto-yield, measured on the wire the board reads (w63-yield’s reds)', () => {
	it(
		"while alice yields, bob's Bolt is offered a target on his wire, resolves at alice, twice running",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 63,
				decks: DECKS,
				names: ['alice', 'bob'],
				scenario: scenarioText('w63-yield'),
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => s.match.seats[ALICE]?.projector.turnNumber() !== null, "alice's seat to know the turn", 20_000, s);
				expect(s.match.setAutoYield(ALICE, true)).toEqual({ ok: true });
				await boltAliceLikeTheBoard(s, 'turn 1, yielding');
				expect(s.logs.some((l) => l.evt === 'auto-passed' && l.seat === ALICE && l.why === 'auto-yield'), 'alice was auto-yielded').toBe(true);

				// A second turn of bob's with auto-yield re-armed (the scenario deals two Bolts): the race, if any, gets two chances per match.
				for (const turn of [3]) {
					await passUntil(s, () => inOwnMain(s, ALICE, turn - 1), `alice's turn ${turn - 1} main`, 90_000);
					await passUntil(s, () => inOwnMain(s, BOB, turn), `bob's turn ${turn} main`, 90_000);
					expect(s.match.setAutoYield(ALICE, true)).toEqual({ ok: true });
					await boltAliceLikeTheBoard(s, `turn ${turn}, yielding`);
				}
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
