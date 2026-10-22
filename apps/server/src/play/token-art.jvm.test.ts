/**
 * What Forge sends for a token, against real Forge — the facts the board's token art is keyed on.
 *
 * The operator, 2026-10-17: *"phyrexian wurm tokens are still wrong. i see a wurmcoil die, and i see
 * the toxic/trample tokens."* Seat 0's Wurmcoil Engine dies to its own Wrath of God and leaves two
 * 3/3 colourless Phyrexian Wurm tokens, one with deathtouch and one with lifelink. Forge names both
 * "Phyrexian Wurm Token" — the same name as the green toxic/trample Wurm of Phyrexia: All Will Be
 * One Commander — so the name alone cannot pick the art. Each must arrive with its own tokenscript
 * in its `ImageKey` (`t:c_3_3_a_phyrexian_wurm_deathtouch…`), which is what `@hadoku/carddata/art`'s
 * token rows are keyed by.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/token-art \
 *   pnpm exec vitest run apps/server/src/play/token-art.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { readFileSync } from 'node:fs';

import { artIdIndexFromTable, tokenArtId, type ArtIdTableFile } from '@hadoku/carddata/art';
import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { available, castNamed, deck, finishMulligan, inOwnMain, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'token-art: a token arrives with its own tokenscript in its image key, against real Forge'
	: `token-art: a token arrives with its own tokenscript in its image key, against real Forge — SKIPPED: ${available.reason}`;

/** The board's own table (`apps/ui/src/draft/art-ids.json`), read the way the adapter reads it. */
const ART_IDS = artIdIndexFromTable(JSON.parse(readFileSync(new URL('../../../ui/src/draft/art-ids.json', import.meta.url), 'utf8')) as ArtIdTableFile);
/** Scryfall's Wurmcoil Wurms — named plain "Wurm" there — by edition and keyword, and Phyrexia: All Will Be One Commander's toxic one. */
const WURMCOIL = {
	'2XM': { deathtouch: 'b68e816f-f9ac-435b-ad0b-ceedbe72447a', lifelink: 'a6ee0db9-ac89-4ab6-ac2e-8a7527d9ecbd' },
	SOM: { deathtouch: '3e46e703-2157-41e5-9c21-c17af43e0d3f', lifelink: 'ee53b9a0-8e07-404d-87ae-ff8397a0ba29' },
} as Record<string, { deathtouch: string; lifelink: string }>;
const TOXIC = '594c55d3-d435-4dec-bc92-011442a43684';

const DECKS: [string, string] = [deck('Plains', ['40 Plains']), deck('Forests', ['40 Forest'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Wrath of God',
	'humanbattlefield=Wurmcoil Engine;Plains;Plains;Plains;Plains',
	'humanlibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Forest',
	'ailibrary=Forest;Forest;Forest;Forest;Forest;Forest',
	'aigraveyard=',
].join('\n');

describe.skipIf(!available.ok)(title, () => {
	it(
		'Wurmcoil Engine’s two Phyrexian Wurms carry the deathtouch and the lifelink tokenscript — on both seats',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 87, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Wrath of God');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				await castNamed(s, 0, 'Wrath of God');
				const wurms = () => s.zone(0, 'Battlefield').filter((c) => c.name === 'Phyrexian Wurm Token');
				await waitUntil(() => {
					s.answerAsks();
					return wurms().length === 2;
				}, 'two Phyrexian Wurm tokens on seat 0’s battlefield', 30_000, s);
				const ids = wurms().map((c) => c.id);
				for (const seat of [0, 1]) {
					const state = s.state(seat);
					const str = (o: unknown): string | undefined => (o as { v?: string } | undefined)?.v;
					const faces = ids.map((id) => {
						const view = state.get(deltaKey(DELTA_TYPE.card, id));
						const current = view?.CurrentState as { v?: number } | undefined;
						const face = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + (current?.v ?? 0)));
						const imageKey = str(face?.ImageKey) ?? '';
						return { imageKey, setCode: str(face?.SetCode) ?? '', art: tokenArtId(ART_IDS, imageKey) };
					});
					console.log(`[token-art.jvm] seat ${seat}: ${JSON.stringify(faces)}`);
					const [deathtouch, lifelink] = [...faces].sort((x, y) => x.imageKey.localeCompare(y.imageKey));
					expect(deathtouch!.imageKey, `seat ${seat}: one is the deathtouch Wurm`).toMatch(/^t:c_3_3_a_phyrexian_wurm_deathtouch\|/);
					expect(lifelink!.imageKey, `seat ${seat}: the other the lifelink Wurm`).toMatch(/^t:c_3_3_a_phyrexian_wurm_lifelink\|/);
					// And the board draws each as itself: the printing of Forge's own edition when Scryfall has it, never the toxic one.
					const printings = WURMCOIL[deathtouch!.setCode] ?? WURMCOIL.SOM!;
					expect(deathtouch!.art, `seat ${seat}: the deathtouch Wurm's art`).toBe(printings.deathtouch);
					expect(lifelink!.art, `seat ${seat}: the lifelink Wurm's art`).toBe(printings.lifelink);
					expect([deathtouch!.art, lifelink!.art]).not.toContain(TOXIC);
				}
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});
