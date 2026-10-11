/**
 * A Clue ({2}, Sacrifice: draw a card) is offered at priority whenever its controller's untapped
 * lands make two mana, against real Forge.
 *
 * The operator, 2026-10-11 (match m-131c6008692a, Izzet Control): "clue wasn't clickable until
 * after i tapped lands. clue should be activatable there because i clearly did have 2 mana." Each
 * case holds a Clue and two lands from that deck, or its board, and reads the highlight Forge sends
 * seat 0 for its own first main phase.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/w70-clue \
 *   pnpm exec vitest run apps/server/src/play/w70-clue.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'w70 clue: a Clue is offered with two lands untapped, against real Forge'
	: `w70 clue: a Clue is offered with two lands untapped, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Plains', ['40 Plains'])];
const CLUE = 'T:c_a_clue_draw';

function state(battlefield: string[], hand: string[] = []): string {
	return [
		'turn=1',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		`humanhand=${hand.join(';')}`,
		`humanbattlefield=${[CLUE, ...battlefield].join(';')}`,
		'humanlibrary=Island;Island;Island;Island;Island;Island',
		'humangraveyard=',
		'aihand=',
		'aibattlefield=Plains;Plains',
		'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
		'aigraveyard=',
	].join('\n');
}

const MAIN1 = /^Priority: A\nTurn: 1 \(A\)\nPhase: Main phase, precombat\nStack: Empty$/;

/** The cards Forge highlighted for seat 0's own first main: the last offer sent before that prompt. */
function mainOffer(s: Scenario): number[] | null {
	const frames = forgeFrames(s, 0);
	const prompt = frames.findLastIndex((f) => f.method === 'showPromptMessage' && MAIN1.test(f.message ?? ''));
	if (prompt === -1) return null;
	const offer = frames.slice(0, prompt).findLast((f) => f.method === 'setWeaklySelectable' || f.method === 'clearWeaklySelectable');
	return offer?.method === 'setWeaklySelectable' ? (offer.cards ?? []).map((c) => c.id) : [];
}

const CASES: { name: string; battlefield: string[]; hand?: string[] }[] = [
	{ name: 'Mountain and Island', battlefield: ['Mountain', 'Island'] },
	{ name: 'two Shivan Reefs', battlefield: ['Shivan Reef', 'Shivan Reef'] },
	{ name: 'Wandering Fumarole and Drownyard Temple', battlefield: ['Wandering Fumarole', 'Drownyard Temple'] },
	{ name: 'Smoldering Marsh and Sunken Hollow', battlefield: ['Smoldering Marsh', 'Sunken Hollow'] },
	{ name: "Pyromancer's Goggles and a Mountain", battlefield: ["Pyromancer's Goggles", 'Mountain'] },
	{
		name: 'the Izzet board: five lands, Thing in the Ice, spells in hand',
		battlefield: ['Shivan Reef', 'Wandering Fumarole', 'Smoldering Marsh', 'Mountain', 'Drownyard Temple', 'Thing in the Ice'],
		hand: ['Fall of the Titans', 'Fiery Temper', 'Lightning Axe'],
	},
];

describe.skipIf(!available.ok)(title, () => {
	for (const c of CASES) {
		it(
			`Clue beside ${c.name}: offered at priority`,
			async () => {
				if (!available.ok) return;
				const s = await startScenario(available.config, { seed: 70, decks: DECKS, scenario: state(c.battlefield, c.hand) });
				try {
					await finishMulligan(s);
					await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((x) => x.name.startsWith('Clue')) && mainOffer(s) !== null; }, "seat 0's own first main", 30_000, s);
					const board = s.zone(0, 'Battlefield');
					const clue = board.find((x) => x.name.startsWith('Clue'))!;
					const offered = mainOffer(s) ?? [];
					const names = [...board, ...s.zone(0, 'Hand')].filter((x) => offered.includes(x.id)).map((x) => x.name);
					console.log(`[w70-clue.jvm] ${c.name}: clue ${offered.includes(clue.id) ? 'offered' : 'NOT offered'}; offered [${names.join(', ')}]`);
					expect(offered, `the Clue is offered beside ${c.name}`).toContain(clue.id);
				} finally {
					await s.stop();
				}
			},
			120_000,
		);
	}
});
