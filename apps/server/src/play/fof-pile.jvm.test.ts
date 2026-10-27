/**
 * Fact or Fiction's pile choice, against real Forge — the shape
 * `rules.ts`'s `pileChoiceOf` (apps/ui/src/play/prompts/rules.ts) assumes:
 * `PlayerControllerHuman.chooseCardsPile` sends ONE flat `getChoices` list,
 * `[pile-1 header, ...pile1's cards, pile-2 header, ...pile2's cards]`, each
 * header a fake `CardView` at `Integer.MIN_VALUE`/`MIN_VALUE + 1`
 * (`PlayerControllerHuman.java:2576-2620`). This proves that shape against a
 * real jar, on both legs: the caster reveals and chooses (Fact or Fiction's
 * own Chooser default), the opponent separates (`chooseCardsForEffect`, which
 * `useSelectCardsInput`'s zone check sends over the wire as an `order` ask,
 * title "Divide cards into two piles" — never a board-click input, since the
 * revealed cards sit in the Library zone). `fof-pile.state` gives BOTH seats
 * the spell and a known top five, so the test swaps which one casts to prove
 * the opposite seat too — chooser and separator trade seats, not just roles.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/fof \
 *   pnpm exec vitest run apps/server/src/play/fof-pile.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'Fact or Fiction’s pile choice, against real Forge'
	: `Fact or Fiction’s pile choice, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('FoF A', ['40 Island']), deck('FoF B', ['40 Island'])];

interface Choice {
	key: string;
	label: string;
	ref: { kind: string; id: number } | null;
}

/** Forge's own sentinel ids for `chooseCardsPile`'s two pseudo-card headers — see this file's header. */
const PILE_HEADER_IDS = [-2147483648, -2147483647] as const;

/** The pile-choice ask's two headers, found the same way `rules.ts`'s `pileChoiceOf` finds them. */
function pilesOf(choices: Choice[]): [number, number] {
	const at = (id: number) => choices.findIndex((c) => c.ref?.kind === 'card' && c.ref.id === id);
	return [at(PILE_HEADER_IDS[0]), at(PILE_HEADER_IDS[1])];
}

/**
 * Drives one Fact or Fiction from cast to resolution: `caster` casts it,
 * the OTHER seat separates the revealed five into a fixed, non-trivial split
 * (the first two cards revealed into pile 1, the rest into pile 2), and
 * `caster` answers the pile-choice ask with `wantPile`.
 */
async function castAndChoose(caster: 0 | 1, wantPile: 1 | 2): Promise<{ hand: string[]; graveyard: string[]; sawHeaders: boolean }> {
	if (!available.ok) throw new Error('unreachable');
	const text = caster === 0 ? scenarioText('fof-pile') : scenarioText('fof-pile').replace('activeplayer=human', 'activeplayer=ai');
	let sawHeaders = false;
	const s = await startScenario(available.config, {
		seed: 2602,
		decks: DECKS,
		scenario: text,
		reply: (f) => {
			if (f.method === 'order' && /Divide cards into two piles/i.test(String(f.title))) {
				const source = f.sourceChoices as Choice[];
				// Pile 1 is whatever the separator "ordered" (moved) — never the trivial
				// all-or-nothing default, so the test proves a real split actually lands.
				const move = source.filter((c) => c.ref?.kind === 'card').slice(0, 2).map((c) => c.key);
				return { ordered: move, rememberDecision: false };
			}
			if (f.method === 'getChoices' && /Choose a pile/i.test(String(f.message))) {
				const choices = f.choices as Choice[];
				const [h1, h2] = pilesOf(choices);
				sawHeaders = h1 >= 0 && h2 >= 0 && h1 < h2;
				return [choices[wantPile === 1 ? h1 : h2]!.key];
			}
			return undefined;
		},
	});
	try {
		await finishMulligan(s);
		await waitUntil(() => { s.answerAsks(); return inOwnMain(s, caster, 1); }, `seat ${caster} holds priority at their own turn-1 main phase`, 20_000, s);
		const fof = s.zone(caster, 'Hand').find((c) => c.name === 'Fact or Fiction');
		if (fof === undefined) throw new Error('unreachable: the scenario gives this seat Fact or Fiction');
		s.select(caster, fof.id);
		await waitUntil(
			() => {
				s.answerAsks();
				// Mana's own "Auto" pay and either seat's priority stop are both a
				// plain OK press — pressing it whenever it is offered is what gets the
				// spell cast and its two piles' effect all the way to resolution.
				for (const seat of [0, 1] as const) if (s.buttons(seat)?.enable1 === true) s.ok(seat);
				return s.zone(caster, 'Graveyard').some((c) => c.name === 'Fact or Fiction');
			},
			'Fact or Fiction cast, paid for and resolved',
			30_000,
			s,
		);
		const hand = s.zone(caster, 'Hand').map((c) => c.name).sort();
		const graveyard = s.zone(caster, 'Graveyard').map((c) => c.name).filter((n) => n !== 'Fact or Fiction').sort();
		return { hand, graveyard, sawHeaders };
	} finally {
		await s.stop();
	}
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'the caster casts, the opponent separates, the caster picks the full pile: it reaches their hand',
		async () => {
			if (!available.ok) return;
			const { hand, graveyard, sawHeaders } = await castAndChoose(0, 1);
			expect(sawHeaders, 'the pile-choice ask carried Forge’s own two sentinel headers, in order').toBe(true);
			// The separator's reply moved the first two revealed cards (Llanowar Elves, Lightning Bolt) into pile 1.
			expect(hand).toEqual(['Lightning Bolt', 'Llanowar Elves']);
			expect(graveyard).toEqual(['Brainstorm', 'Opt', 'Ponder']);
		},
		120_000,
	);

	it(
		'the caster picks the OTHER pile: the three left-behind cards reach their hand instead',
		async () => {
			if (!available.ok) return;
			const { hand, graveyard } = await castAndChoose(0, 2);
			expect(hand).toEqual(['Brainstorm', 'Opt', 'Ponder']);
			expect(graveyard).toEqual(['Lightning Bolt', 'Llanowar Elves']);
		},
		120_000,
	);

	it(
		'the opposite seat: seat 1 casts, seat 0 separates (still a real chooseCardsForEffect), seat 1 chooses',
		async () => {
			if (!available.ok) return;
			const { hand, graveyard, sawHeaders } = await castAndChoose(1, 1);
			expect(sawHeaders, 'the pile-choice ask carried Forge’s own two sentinel headers, in order').toBe(true);
			expect(hand).toEqual(['Lightning Bolt', 'Llanowar Elves']);
			expect(graveyard).toEqual(['Brainstorm', 'Opt', 'Ponder']);
		},
		120_000,
	);
});
