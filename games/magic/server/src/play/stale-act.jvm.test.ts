/**
 * An act made on an input Forge has moved past, against real Forge (#40).
 *
 * Forge's ActGate holds an act that arrives between two inputs and hands it to whatever input opens
 * next, so a click made on a window that is gone answered one the seat never saw: forge-monkey run
 * 42402522231's Magpie clicked Faerie Conclave and Morphling off windows superseded 4 and 18 ms
 * earlier, and Forge flashed a refusal at the next one. Every window frame now names the input it
 * was shown for, the seat's act names it back, and the bridge drops an act whose input is not the
 * one open where Forge applies it (`PlayBridge.java`'s `MatchContext.actInputs`).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/stale \
 *   pnpm exec vitest run games/magic/server/src/play/stale-act.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { available, deck, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'an act made on an input Forge has moved past, against real Forge'
	: `an act made on an input Forge has moved past, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Plains', ['40 Plains']), deck('Islands', ['40 Island'])];
const STALE = 'made on an input Forge has moved past';

describe.skipIf(!available.ok)(title, () => {
	it(
		'a click naming a past input is dropped and never applied; the same click naming the open input is applied',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 40, decks: DECKS, scenario: scenarioText('nf-nomads'), skipOpening: true, aiOpponent: true });
			try {
				expect(s.match.setFullControl(0, true)).toEqual({ ok: true });
				await waitUntil(() => s.prompt(0).startsWith('Priority: ') && s.buttons(0)?.enable1 === true, 'alice holds priority in her Main 1', 60_000, s);
				const nomads = s.zone(0, 'Battlefield').find((c) => c.name === 'Nomads en-Kor')?.id;
				expect(nomads, 'Nomads en-Kor is out').toBeDefined();
				const shown = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.input !== undefined)?.envelope.input;
				expect(shown, 'the window’s frames name the input they were shown for').toBeDefined();
				const click = ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id: nomads! }, otherCardViewsToSelect: [], triggerEvent: null });
				const applied = () =>
					s.lines.filter((l) => l.t === 'applied' && (l as { act?: { method?: string; card?: { id?: number } } }).act?.method === 'selectCard' && (l as { act: { card: { id: number } } }).act.card.id === nomads);
				const dropped = () => s.lines.filter((l) => l.t === 'dropped' && (l as { why?: string }).why === STALE);

				expect(s.match.fromClient(0, click, shown! + 1_000)).toEqual({ ok: true });
				await waitUntil(() => dropped().length === 1, 'the click on a past input dropped', 15_000, s);
				expect(dropped()[0]).toMatchObject({ seat: 0, method: 'selectCard', card: nomads });
				expect(applied(), 'never applied').toEqual([]);
				expect(s.prompt(0), 'Forge still waits on the same window').toMatch(/^Priority: /);

				expect(s.match.fromClient(0, click, shown!)).toEqual({ ok: true });
				await waitUntil(() => applied().length === 1, 'the click on the open input applied', 15_000, s);
				expect(dropped(), 'and not dropped').toHaveLength(1);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
