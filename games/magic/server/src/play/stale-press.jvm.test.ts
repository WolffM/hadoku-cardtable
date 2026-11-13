/**
 * A press that reaches the server before Forge has answered the seat's own act, against real Forge.
 *
 * Forge ignores bar state (`InputBase.selectButtonOK` checks only `isFinished()`), and an act that
 * arrives between two inputs goes to the next one. So an OK sent one round trip after a card click
 * lands on whatever that click opened: on Swords to Plowshares' target prompt it is
 * `InputSelectTargets.onOk` with nothing picked, and the spell is lost. The server refuses that press
 * while the bar the click disabled is still the seat's last (`SeatState.staleBar`), and Forge's next
 * window re-arms it. Both acts here are sent back to back, synchronously, which is the race at its
 * tightest.
 */

import { ClientFrameSchema } from '@hadoku/forge-wire';
import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'an OK sent right after the seat’s own act is refused until Forge shows the next window, against real Forge'
	: `an OK sent right after the seat’s own act is refused until Forge shows the next window, against real Forge — SKIPPED: ${available.reason}`;

const OK = ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' });
const click = (id: number) => ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null });
const refusals = (s: Scenario) => s.logs.filter((l) => l.evt === 'press-refused' && l.seat === 0).length;

describe.skipIf(!available.ok)(title, () => {
	it('Swords to Plowshares then OK, and a Plains then OK: each OK refused, the target picked, the spell resolved, the land played, the next OK taken', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 18,
			decks: [deck('Swords', ['40 Plains']), deck('Bears', ['40 Forest'])],
			scenario: scenarioText('stale-press'),
		});
		const lineFrom = s.lines.length;
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);

			// The spell, then OK: without the refusal, the OK closes the target prompt with nothing picked and the spell is lost.
			const swords = s.zone(0, 'Hand').find((c) => c.name === 'Swords to Plowshares')!;
			const bears = s.zone(1, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
			expect(s.match.fromClient(0, click(swords.id))).toEqual({ ok: true });
			const castPress = s.match.fromClient(0, OK);
			await waitUntil(() => { s.answerAsks(); return /Select target creature/.test(s.prompt(0)); }, "Swords' target prompt", 20_000, s);
			s.select(0, bears.id);
			await waitUntil(
				() => {
					s.answerAsks();
					return !s.zone(1, 'Battlefield').some((c) => c.id === bears.id) && s.zone(0, 'Graveyard').some((c) => c.id === swords.id);
				},
				'the bear exiled and Swords in the graveyard',
				30_000,
				s,
			);
			expect(castPress).toMatchObject({ ok: false, error: expect.stringMatching(/^press-refused/) });
			expect(refusals(s)).toBe(1);

			// A land, then OK: without the refusal, the OK passes the main phase. With it, the land is played and
			// Forge's next priority window re-arms the bar.
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase again", 20_000, s);
			const plains = s.zone(0, 'Hand').find((c) => c.name === 'Plains')!;
			expect(s.match.fromClient(0, click(plains.id))).toEqual({ ok: true });
			const landPress = s.match.fromClient(0, OK);
			await waitUntil(
				() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.id === plains.id) && inOwnMain(s, 0, 1); },
				'the Plains played and the priority bar live again',
				20_000,
				s,
			);
			expect(landPress).toMatchObject({ ok: false, error: expect.stringMatching(/^press-refused/) });
			expect(refusals(s)).toBe(2);
			// The re-armed bar takes the next press.
			expect(s.match.fromClient(0, OK)).toEqual({ ok: true });
			expect(refusals(s)).toBe(2);
		} catch (err) {
			console.log(`[stale-press-timeline]\n${timeline(s, 0, lineFrom)}`);
			throw err;
		} finally {
			await s.stop();
		}
	}, 180_000);
});
