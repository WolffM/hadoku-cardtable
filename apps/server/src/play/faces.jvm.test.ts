/**
 * A card's faces, as the seat is asked to choose between them — against real Forge.
 *
 * The operator, 2026-10-17: *"flip cards should show both art and let you pick left/right"*. Forge
 * offers an adventure's two spells, a modal double-faced card's spell and land, and a split card's
 * halves as one `getAbilityToPlay`, and its labels do not say which face is which. The bridge names
 * each ability's face (`PlayBridge.java`'s `faceAbilities`), and the seat draws those faces side by
 * side (`apps/ui/src/play/prompts/ChoicePrompts.tsx`'s `facedAbilities`).
 *
 * Scenario `faces`: alice selects each card in turn; the offer must name both faces, one per ability.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/faces \
 *   pnpm exec vitest run apps/server/src/play/faces.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'faces: an offer between a card’s faces names each ability’s face, against real Forge'
	: `faces: an offer between a card’s faces names each ability’s face, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Forests', ['40 Forest'])];

/** Select `name` in seat 0's hand and return the `getAbilityToPlay` it opens, answered with none. */
async function offerFor(s: Scenario, name: string): Promise<{ id: number; label?: string; face?: string }[]> {
	const c = s.zone(0, 'Hand').find((x) => x.name === name);
	if (c === undefined) throw new Error(`no ${name} in hand`);
	const mark = s.sent.length;
	s.select(0, c.id);
	let ask: Record<string, unknown> | undefined;
	await waitUntil(
		() => {
			ask = s.sent.slice(mark).map((x) => x.envelope.frame as Record<string, unknown>).find((f) => f.kind === 'ask' && f.method === 'getAbilityToPlay');
			return ask !== undefined;
		},
		`${name}: the offer between its faces`,
		20_000,
		s,
	);
	s.match.fromClient(0, { kind: 'reply', callId: ask!.callId, method: 'getAbilityToPlay', result: null } as never);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, `${name}: back to alice’s main phase`, 20_000, s);
	return ask!.abilities as { id: number; label?: string; face?: string }[];
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'an adventure, a modal double-faced card and a split card each name both faces',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 17,
				decks: DECKS,
				scenario: scenarioText('faces'),
				hold: (f) => f.method === 'getAbilityToPlay',
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').length >= 4; }, 'alice’s main phase with the scenario’s hand', 30_000, s);
				const got: Record<string, (string | undefined)[]> = {};
				for (const name of ['Bonecrusher Giant', 'Shatterskull Smashing', 'Fire // Ice']) {
					const offer = await offerFor(s, name);
					console.log(`[faces.jvm] ${name}: ${JSON.stringify(offer)}`);
					got[name] = offer.map((a) => a.face);
				}
				expect(got).toEqual({
					'Bonecrusher Giant': ['Bonecrusher Giant', 'Stomp'],
					'Shatterskull Smashing': ['Shatterskull Smashing', 'Shatterskull, the Hammer Pass'],
					'Fire // Ice': ['Fire', 'Ice'],
				});
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});
