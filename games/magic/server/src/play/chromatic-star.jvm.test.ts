/**
 * Chromatic Star's draw trigger, against real Forge. ohmusama, 2026-11-21: "Chromatic Star does not
 * hold priority". Their match (m-14c9cfc10b3a) was in the default mode, which passes a seat's own
 * stack item on purpose (Q17, `auto.ts`'s `own-spell`); the operator: "just make sure that full
 * control works as expected in this case".
 *
 * `scenarios/chromatic-star.state`: an Island, Chromatic Star and Opt. Sacrifice the Star for blue:
 * in full control alice is given priority with the Star's trigger on the stack and nothing is passed
 * for her; she passes, draws, and has her Main 1 back with the blue still floating. In the default
 * mode the same window is passed for her (`own-spell`) and she still has her Main 1 back after the draw.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run games/magic/server/src/play/chromatic-star.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, inOwnMain, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

type Frame = ServerFrame & Record<string, unknown>;

/** Blue, for the Star's colour; everything else is answered plainly. */
function reply(f: Frame): unknown {
	if (f.method !== 'getChoices' || !/Select Mana to Produce/.test(String(f.message))) return undefined;
	const blue = (f.choices as { key: string; label: string }[]).find((c) => /blue/i.test(c.label));
	return blue === undefined ? undefined : [blue.key];
}

const TRIGGER_WINDOW = /^Stack: 1 to Resolve/m;

/** The priority prompts seat 0's own wire carried with one item on the stack, since `from`. */
const triggerWindowsShown = (s: Scenario, from: number): string[] =>
	s.sent
		.slice(from)
		.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage')
		.map((x) => String((x.envelope.frame as unknown as Frame).message))
		.filter((m) => m.startsWith('Priority:') && TRIGGER_WINDOW.test(m));

describe.skipIf(!available.ok)(title("Chromatic Star's draw trigger and priority, against real Forge"), () => {
	for (const mode of ['full control', 'default'] as const) {
		it(`${mode}: ${mode === 'full control' ? 'alice holds priority over the Star’s trigger, then has her Main 1 back with the mana floating' : 'the Star’s trigger is passed for her (own-spell), and she has her Main 1 back after the draw'}`, async () => {
			const s = await startScenario(available.ok ? available.config : (undefined as never), {
				seed: 21,
				decks: [deck('star-a', ['20 Island']), deck('star-b', ['20 Island'])],
				names: ['Alice', 'Bob'],
				scenario: scenarioText('chromatic-star'),
				reply,
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => inOwnMain(s, 0, 3), 'alice to hold priority in her turn-3 main', 30_000, s);
				if (mode === 'full control') expect(s.match.setFullControl(0, true)).toEqual({ ok: true });
				const star = s.zone(0, 'Battlefield').find((c) => c.name === 'Chromatic Star');
				if (star === undefined) throw new Error('no Chromatic Star');
				const handBefore = s.zone(0, 'Hand').length;
				const sentFrom = s.sent.length;
				const logsFrom = s.logs.length;
				const pay = landPayer(s, 0);
				s.select(0, star.id);
				const step = (): void => {
					s.answerAsks();
					pay();
				};

				if (mode === 'full control') {
					await waitUntil(
						() => {
							step();
							return triggerWindowsShown(s, sentFrom).length > 0 && s.buttons(0)?.enable1 === true;
						},
						'alice to be given priority with the Star’s trigger on the stack',
						60_000,
						s,
					);
					expect(s.zone(0, 'Graveyard').some((c) => c.id === star.id || c.name === 'Chromatic Star'), 'the Star was sacrificed').toBe(true);
					expect(s.zone(0, 'Hand'), 'the trigger has not resolved: no card drawn yet').toHaveLength(handBefore);
					expect(s.logs.slice(logsFrom).filter((l) => l.evt === 'auto-passed' && l.seat === 0), 'nothing was passed for alice').toEqual([]);
					s.ok(0);
				}

				await waitUntil(
					() => {
						step();
						return s.zone(0, 'Hand').length === handBefore + 1 && inOwnMain(s, 0, 3);
					},
					'the trigger to resolve and alice to hold her Main 1 again',
					60_000,
					s,
				);
				const passed = s.logs.slice(logsFrom).filter((l) => l.evt === 'auto-passed' && l.seat === 0);
				console.log(`[chromatic-star] ${mode}: auto-passed ${JSON.stringify(passed.map((l) => l.rule))} trigger windows shown ${triggerWindowsShown(s, sentFrom).length}`);
				if (mode === 'full control') {
					expect(passed, 'full control passed nothing for alice').toEqual([]);
				} else {
					expect(passed.map((l) => l.rule), 'the default mode passes her own trigger').toEqual(['own-spell']);
					expect(triggerWindowsShown(s, sentFrom), 'the passed window never reached her').toEqual([]);
				}
				expect(s.prompt(0), 'the blue still floats into her Main 1').toMatch(/Main phase, precombat/);
			} finally {
				await s.stop();
			}
		}, 180_000);
	}
});
