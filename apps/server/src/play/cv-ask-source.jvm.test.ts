/**
 * An ask names the card it was raised for, and Forge's text for that effect. The operator,
 * 2026-10-15, on Cavern of Souls: its creature-type question showed a bare "Choose 1", and the
 * land floated back to the hand while it was open. `chooseSomeType` asks `getGui().one(message,
 * types)` with no ability, so the bridge reads the source off the live game when it opens the ask
 * (`PlayBridge.java`'s `askSource`): here the "As … enters" replacement running.
 *
 * Against the real jar, `scenarios/cv-cavern.state`: alice plays Cavern of Souls from her hand.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/cv-ask-source.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

type Frame = ServerFrame & Record<string, unknown>;

/** The land's own play, and "Goblin" for the creature type. */
function reply(f: Frame): unknown {
	if (f.method === 'getAbilityToPlay') return (f.abilities as unknown[])[0];
	if (f.method === 'getChoices') {
		const goblin = (f.choices as { key: string; label: string }[]).find((c) => c.label === 'Goblin');
		return goblin === undefined ? undefined : [goblin.key];
	}
	return undefined;
}

describe.skipIf(!available.ok)(title('an ask carries its source card, against real Forge'), () => {
	it('Cavern of Souls played from the hand: its creature-type question names Cavern and Forge’s text for the effect', async () => {
		const s = await startScenario(available.ok ? available.config : (undefined as never), {
			seed: 11,
			decks: [deck('cv-a', ['20 Mountain']), deck('cv-b', ['20 Mountain'])],
			names: ['Alice', 'Bob'],
			scenario: scenarioText('cv-cavern'),
			reply,
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => inOwnMain(s, 0, 1), 'alice to hold priority in her first main', 30_000, s);
			const cavern = s.zone(0, 'Hand').find((c) => c.name === 'Cavern of Souls');
			if (cavern === undefined) throw new Error('alice holds no Cavern of Souls');
			s.select(0, cavern.id);
			await waitUntil(
				() => {
					s.answerAsks();
					return s.zone(0, 'Battlefield').some((c) => c.id === cavern.id);
				},
				'Cavern of Souls to enter the battlefield',
				60_000,
				s,
			);
			const asked = s.asks.filter((a) => a.method === 'getChoices') as Frame[];
			console.log(`[cv] cavern asked: ${JSON.stringify(asked.map((a) => ({ message: a.message, source: a.source })))}`);
			const forwarded = s.logs.filter((l) => l.evt === 'ask-forwarded' && l.method === 'getChoices');
			const answered = s.logs.filter((l) => l.evt === 'ask-answered' && l.method === 'getChoices');
			console.log(`[cv] logged: ${JSON.stringify([...forwarded, ...answered])}`);
			expect(asked).toHaveLength(1);
			expect(asked[0]!.source).toEqual({ card: { kind: 'card', id: cavern.id }, text: 'As Cavern of Souls enters, choose a creature type.' });
			expect(forwarded.map((l) => [l.source, l.title])).toEqual([[cavern.id, asked[0]!.message]]);
			expect(answered.map((l) => [l.source, l.title])).toEqual([[cavern.id, asked[0]!.message]]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});
