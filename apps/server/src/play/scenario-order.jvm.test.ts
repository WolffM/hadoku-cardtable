/**
 * Wave 34 §S, item 3 — Q8, exercised against a REAL Forge match for the first
 * time. w33 could not reach it: `two-triggers.state` paired TWO Dark
 * Confidants, and `PlayerControllerHuman.orderSimultaneousSa`
 * (`PlayerControllerHuman.java:2243-2271`) only prompts for an order when the
 * simultaneous abilities' own `toString()`s DIFFER, or a trigger carries
 * `OrderDuplicates$ True` — two Dark Confidants are the identical trigger text
 * twice, so `needPrompt` never goes true and Forge silently picks an order
 * itself, asking nothing. That is also why w33 never saw life drop: not a
 * broken scenario, a real-rules no-op Forge is entitled to take.
 *
 * `two-triggers.state` now pairs Dark Confidant with Phyrexian Arena instead
 * — two DIFFERENT upkeep triggers, same controller, same timing, whose
 * `toString()`s differ — which does hit `needPrompt = true` and produces a
 * genuine `order` ask (`showRememberCheckbox: true`, two `sourceChoices`) the
 * moment both triggers are queued.
 *
 * The claim under test is `auto.ts`'s `orderSimultaneous` policy
 * (`DEFAULT_STOP_POLICY: 'forge'`, `FULL_CONTROL_POLICY: 'ask'`): under the
 * default policy this ask is answered server-side with Forge's own offered
 * order (`onlyAnswer`'s `order` case) and never reaches the client at all;
 * under full control every stop comes back, so the SAME ask reaches the
 * client raw, unanswered, for the player to actually decide.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w34-s/work \
 *   pnpm exec vitest run apps/server/src/play/scenario-order.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'Q8: the order ask, exercised against real Forge'
	: `Q8: the order ask, exercised against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

/**
 * Drive from `two-triggers.state`'s landing (the OPPONENT's Cleanup Step)
 * through Cleanup → Untap → seat 0's own Upkeep, pressing OK on every
 * `Priority:` stop for either seat as it is offered — the same mechanism
 * every real game uses, never a synthetic phase jump. Stops the INSTANT both
 * upkeep triggers are on the stack, before anything downstream (the Dark
 * Confidant reveal's own `getChoices`) is touched, so a caller can read
 * `s.asks`/`s.sent`/`s.logs` for exactly the order decision under test. That
 * window is read off what Forge sent, and from its history rather than its
 * latest prompt: the server passes it before the seat sees it, and Forge has
 * moved on by the next poll.
 */
/** Forge gave seat 0 priority in its own upkeep with both triggers on the stack. */
function bothTriggersShown(s: Scenario): boolean {
	return forgeFrames(s, 0).some(
		(f) =>
			f.method === 'showPromptMessage' &&
			/^Phase: Upkeep step$/m.test(f.message ?? '') &&
			/^Turn: \d+ \(([^)]*)\)$/m.exec(f.message ?? '')?.[1] === s.names[0] &&
			/Stack: 2 to Resolve/.test(f.message ?? ''),
	);
}

async function driveToUpkeepWithBothTriggers(s: Scenario): Promise<void> {
	const pressed = new Set<number>();
	await waitUntil(
		() => {
			s.answerAsks();
			if (bothTriggersShown(s)) return true;
			for (const seat of [0, 1]) {
				const at = s.sent
					.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
					.filter((i) => i >= 0)
					.pop();
				if (at === undefined || pressed.has(at)) continue;
				const msg = (s.sent[at]?.envelope.frame as unknown as { message: string }).message;
				if (msg.startsWith('Priority:') && s.buttons(seat)?.enable1 === true) {
					pressed.add(at);
					s.ok(seat);
				}
			}
			return false;
		},
		'seat 0 at Upkeep with both upkeep triggers on the stack',
		60_000,
	);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'default policy: the order ask is answered server-side and never reaches the client',
		async () => {
			if (!available.ok) return;
			const seen: { method: string }[] = [];
			const s = await startScenario(available.config, {
				seed: 8,
				decks: DECKS,
				scenario: scenarioText('two-triggers'),
				reply: (f) => {
					seen.push(f as { method: string });
					return undefined;
				},
			});
			try {
				await finishMulligan(s);
				await driveToUpkeepWithBothTriggers(s);
				// The precondition: two DIFFERENT upkeep triggers really did land on
				// the stack together (not Forge quietly resolving one before the
				// other was even queued).
				expect(bothTriggersShown(s)).toBe(true);
				// The claim: no raw `order` ask ever reached the client...
				expect(seen.some((a) => a.method === 'order'), 'an order ask reached the client under the default policy').toBe(false);
				// ...because the server answered it with Forge's own offered order.
				const auto = s.logs.find(
					(l) => l.evt === 'ask-auto-answered' && l.seat === 0 && l.method === 'order',
				) as { why?: string } | undefined;
				expect(auto, 'the order ask was auto-answered server-side').toBeDefined();
				expect(auto?.why).toBe("Forge's own order");
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'each upkeep trigger leaves Forge’s own log line in both seats’ logs, under its controller’s name',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 8, decks: DECKS, scenario: scenarioText('two-triggers') });
			try {
				await finishMulligan(s);
				await driveToUpkeepWithBothTriggers(s);
				const said = (seat: number): string[] =>
					s.sent
						.filter((x) => x.seat === seat && x.envelope.frame.method === 'message')
						.map((x) => (x.envelope.frame as unknown as { message: string }).message)
						.filter((m) => m.includes('triggered'));
				console.log(`[trigger-log] seat 0:\n  ${said(0).join('\n  ')}\n[trigger-log] seat 1:\n  ${said(1).join('\n  ')}`);
				// `GameLogFormatter`'s cast line for a trigger: "<controller> triggered <card>", the same words on both screens.
				for (const seat of [0, 1]) {
					expect(said(seat).filter((m) => m.startsWith(`${s.names[0]} triggered Dark Confidant`)), `seat ${seat}`).toHaveLength(1);
					expect(said(seat).filter((m) => m.startsWith(`${s.names[0]} triggered Phyrexian Arena`)), `seat ${seat}`).toHaveLength(1);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'full control: a real order ask reaches the client, unanswered by the server',
		async () => {
			if (!available.ok) return;
			const seen: { method: string; showRememberCheckbox?: boolean; sourceChoices?: unknown[] }[] = [];
			const s = await startScenario(available.config, {
				seed: 8,
				decks: DECKS,
				scenario: scenarioText('two-triggers'),
				reply: (f) => {
					seen.push(f as never);
					return undefined;
				},
			});
			try {
				s.match.setFullControl(0, true);
				await finishMulligan(s);
				await driveToUpkeepWithBothTriggers(s);
				const order = seen.find((a) => a.method === 'order');
				expect(order, 'a real order ask reached the client under full control').toBeDefined();
				expect(order?.showRememberCheckbox).toBe(true);
				expect(order?.sourceChoices).toHaveLength(2);
				// The server never took this one for itself: full control short-circuits
				// `onlyAnswer` ahead of the policy (`match.ts`'s `s.fullControl ? null : …`).
				expect(s.logs.some((l) => l.evt === 'ask-auto-answered' && l.seat === 0 && l.method === 'order')).toBe(false);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
