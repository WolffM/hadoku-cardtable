/**
 * A set Forge used to ask one card at a time is ONE multi-select, beside the constrained searches of
 * `search-rules.jvm.test.ts`. The operator, 2026-10-26: "this is obviously a situation where a multi
 * selector should be used, not separate questions … solved generally instead of hardcoded for a card".
 *
 * The fork's `ChosenSet` asks a human seat once for a card of each kind (`ChangeZone`'s `EACH` types,
 * `ChooseCard`'s `ChooseEach`, `EachBasicType` and `EachDifferentPower`, `Dig`'s `ForEachColorPair`), for
 * creatures with a total power or different powers (`ChooseCard`'s `WithTotalPower`,
 * `WithDifferentPowers`) and for a dig's total mana value (`Dig`'s `WithTotalCMC`), and asks again
 * until the set meets its rules. The bridge sends the rules with the ask (`rules`, `SearchRuleSchema`;
 * one card for each kind is `slots`). Each case answers the first ask with a set the seat's own prompt
 * refuses (`searchRuleProblems`), sees the same question asked again, then answers what the prompt
 * lets a player tick and checks where the cards went.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/cs \
 *   pnpm exec vitest run apps/server/src/play/chosen-sets.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE, idsOf as zoneIds, searchRuleProblems, strOf, tickPick, type SearchRule } from '@hadoku/forge-wire';

import { available, deck, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'sets chosen at once, against real Forge' : `sets chosen at once, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Island']), deck('Any B', ['40 Island'])];

type Ref = { kind: string; id: number };
type Ask = Record<string, unknown> & { method: string; callId: string; optionList?: Ref[]; max?: number; min?: number; rules?: SearchRule[] };

const idsOf = (refs: readonly Ref[]) => refs.map((r) => r.id);

/** What a player ticks in offer order as the prompt ticks it (`tickPick`), passing over a card that would untick one already ticked, up to the most it takes. */
function validSet(ask: Ask): Ref[] {
	let ids: number[] = [];
	for (const ref of ask.optionList ?? []) {
		if (ids.length >= (ask.max ?? 0)) break;
		const next = tickPick(ask.rules, ids, ref.id);
		if (next !== null && ids.every((id) => next.includes(id))) ids = next;
	}
	return ids.map((id) => (ask.optionList ?? []).find((r) => r.id === id)!);
}

/** Two offered cards the rules refuse together. */
function brokenSet(ask: Ask): Ref[] {
	const options = ask.optionList ?? [];
	for (const a of options) for (const b of options) if (a.id < b.id && searchRuleProblems(ask.rules, [a.id, b.id]).length > 0) return [a, b];
	throw new Error(`no two options break ${JSON.stringify(ask.rules)}`);
}

/** A card's name as this seat's state has it. */
const nameOf = (s: Scenario, seat: number, id: number) => strOf(s.state(seat).get(deltaKey(DELTA_TYPE.card, id)), 'Name') ?? `#${id}`;

/** The asks seat `seat` was sent. */
const asksOf = (s: Scenario, seat: number) =>
	(s.asks as unknown as Ask[]).filter((f) => s.sent.find((x) => (x.envelope.frame as { callId?: unknown }).callId === f.callId)?.seat === seat);

/**
 * Seat 0 casts `name` from its scenario board, targeting `target` when it asks for one, and both seats
 * pass until it and anything it triggers resolve.
 */
async function castAndResolve(s: Scenario, name: string, target?: number): Promise<void> {
	await waitUntil(
		() => {
			s.keepHands();
			s.answerAsks();
			return s.prompt(0).startsWith('Priority:') && s.buttons(0)?.enable1 === true;
		},
		'seat 0 at priority',
		60_000,
		s,
	);
	const card = s.zone(0, 'Hand').find((c) => c.name === name)!;
	s.select(0, card.id);
	const pay = landPayer(s, 0);
	const passed = new Set<number>();
	let targeted = false;
	await waitUntil(
		() => {
			s.answerAsks();
			if (target !== undefined && !targeted && /Select.*target/i.test(s.prompt(0))) {
				targeted = true;
				s.select(0, target);
			}
			pay();
			// Either seat passes while the stack resolves (seat 1 is a person when it makes a choice).
			for (const seat of [0, 1]) {
				const at = s.sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
				if (at >= 0 && !passed.has(at) && /^Stack: \d+ to Resolve\.$/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true) {
					passed.add(at);
					s.ok(seat);
				}
			}
			return !s.zone(0, 'Hand').some((c) => c.id === card.id) && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
		},
		`${name} to resolve`,
		90_000,
		s,
	);
}

/** How the test answers the `nth` ruled ask, given a namer for the offered cards. */
type Answer = (ask: Ask, nth: number, name: (id: number) => string) => Ref[];

/** The offered cards named `wanted`, one each, in that order. */
function named(ask: Ask, name: (id: number) => string, wanted: readonly string[]): Ref[] {
	const out: Ref[] = [];
	for (const want of wanted) {
		const ref = (ask.optionList ?? []).find((r) => name(r.id) === want && !out.includes(r));
		if (ref === undefined) throw new Error(`no ${want} left among ${JSON.stringify((ask.optionList ?? []).map((r) => name(r.id)))}`);
		out.push(ref);
	}
	return out;
}

/**
 * Seat 0 casts `card` in `scenario` against Forge's AI, answers its one ruled ask first with a set the
 * prompt refuses and then with a valid one (or as `answer` says), and hands the two asks and the set
 * taken to `check`.
 */
async function chosenOnce(
	scenario: string,
	card: string,
	seed: number,
	check: (s: Scenario, first: Ask, taken: Ref[]) => void,
	answer: Answer = (ask, nth) => (nth === 0 ? brokenSet(ask) : validSet(ask)),
): Promise<void> {
	if (!available.ok) return;
	const searches: { ask: Ask; answer: Ref[] }[] = [];
	const at: { s?: Scenario } = {};
	const reply = (frame: Record<string, unknown>): unknown => {
		const f = frame as Ask;
		if (f.method !== 'chooseEntitiesForEffect' || f.rules === undefined) return undefined;
		const chosen = answer(f, searches.length, (id) => nameOf(at.s!, 0, id));
		searches.push({ ask: f, answer: chosen });
		return chosen;
	};
	const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText(scenario), skipOpening: true, aiOpponent: true, reply });
	at.s = s;
	try {
		await castAndResolve(s, card);
		const mine = asksOf(s, 0);
		console.log(`[${scenario}] seat 0 asks ${JSON.stringify(mine.map((a) => [a.method, a.optionList?.length, a.min, a.max, a.rules?.map((r) => r.kind)]))}`);
		expect(mine.filter((a) => a.method === 'chooseSingleEntityForEffect'), 'no one-card-at-a-time window').toEqual([]);
		expect(searches, 'the refused set asked again, then the valid one taken').toHaveLength(2);
		const [first, second] = searches;
		expect(second!.ask.rules).toEqual(first!.ask.rules);
		expect(searchRuleProblems(first!.ask.rules, idsOf(first!.answer)), 'the first answer is one the prompt refuses').not.toEqual([]);
		expect(searchRuleProblems(second!.ask.rules, idsOf(second!.answer)), 'the second answer is one the prompt takes').toEqual([]);
		check(s, first!.ask, second!.answer);
	} finally {
		await s.stop();
	}
}

const names = (s: Scenario, refs: readonly Ref[]) => refs.map((r) => nameOf(s, 0, r.id)).sort();
const zoneNames = (s: Scenario, zone: Parameters<Scenario['zone']>[1]) => s.zone(0, zone).map((c) => c.name).sort();
const slotsOf = (ask: Ask) => ask.rules?.find((r): r is Extract<SearchRule, { kind: 'slots' }> => r.kind === 'slots');

describe.skipIf(!available.ok)(title, () => {
	it(
		'Shard Convergence (ChangeZone EACH): one pick of a Plains, Island, Swamp and Mountain; two Plains refused; Volcanic Island fills one slot',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-shard', 'Shard Convergence', 11, (s, first, taken) => {
				expect(first.max).toBe(4);
				const slots = slotsOf(first)!;
				expect(slots.fill).toBe(false);
				expect(slots.slots.map((ids) => ids.map((id) => nameOf(s, 0, id)).sort())).toEqual([
					['Plains', 'Plains'],
					['Island', 'Volcanic Island'],
					['Swamp'],
					['Volcanic Island'],
				]);
				// Forest fits no slot, so it is not offered.
				expect(names(s, first.optionList!)).toEqual(['Island', 'Plains', 'Plains', 'Swamp', 'Volcanic Island']);
				expect(names(s, taken)).toEqual(['Island', 'Plains', 'Swamp', 'Volcanic Island']);
				expect(zoneNames(s, 'Hand')).toEqual(['Island', 'Plains', 'Swamp', 'Volcanic Island']);
			});
		},
		300_000,
	);

	it(
		'Guided Passage (ChangeZone EACH, the opponent chooses): Dryad Arbor as both the creature and the land refused; three different cards to hand',
		async () => {
			if (!available.ok) return;
			const searches: { seat: number; ask: Ask; answer: Ref[] }[] = [];
			const at: { s?: Scenario } = {};
			const seatOf = (f: Ask) => at.s!.sent.find((x) => (x.envelope.frame as { callId?: unknown }).callId === f.callId)?.seat ?? -1;
			const reply = (frame: Record<string, unknown>): unknown => {
				const f = frame as Ask;
				if (f.method !== 'chooseEntitiesForEffect' || f.rules === undefined) return undefined;
				const seat = seatOf(f);
				const answer = named(f, (id) => nameOf(at.s!, seat, id), searches.length === 0 ? ['Dryad Arbor', 'Lightning Bolt'] : ['Dryad Arbor', 'Forest', 'Lightning Bolt']);
				searches.push({ seat, ask: f, answer });
				return answer;
			};
			const s = await startScenario(available.config, { seed: 21, decks: DECKS, scenario: scenarioText('set-passage'), skipOpening: true, reply });
			at.s = s;
			try {
				await castAndResolve(s, 'Guided Passage');
				expect(searches.map((x) => x.seat), 'the opponent chooses, asked again after the set with Dryad Arbor as two kinds').toEqual([1, 1]);
				const [first, second] = searches;
				const slots = slotsOf(first!.ask)!;
				expect(slots).toMatchObject({ fill: true, distinct: true, kinds: ['Creature.YouOwn', 'Land.YouOwn', 'Card.nonCreature+nonLand+YouOwn'] });
				expect(searchRuleProblems(first!.ask.rules, idsOf(first!.answer)), 'the prompt refuses Dryad Arbor as two kinds').not.toEqual([]);
				expect(searchRuleProblems(second!.ask.rules, idsOf(second!.answer))).toEqual([]);
				expect(zoneNames(s, 'Hand')).toEqual(['Dryad Arbor', 'Forest', 'Lightning Bolt']);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Cataclysm (ChooseCard ChooseEach): one pick that must fill every kind some permanent fits; two lands refused; the rest sacrificed',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-cataclysm', 'Cataclysm', 12, (s, first, taken) => {
				const slots = slotsOf(first)!;
				expect(slots.fill).toBe(true);
				expect(slots.slots).toHaveLength(4);
				expect(slots.slots[2]).toEqual([]);
				expect(names(s, taken)).toEqual(['Grizzly Bears', 'Ornithopter', 'Plains']);
				expect(zoneNames(s, 'Battlefield')).toEqual(['Grizzly Bears', 'Ornithopter', 'Plains']);
			});
		},
		300_000,
	);

	it(
		'Cataclysm: Ornithopter chosen as both the artifact and the creature, with Glorious Anthem and a Plains; a set with no enchantment refused; Grizzly Bears and the other Plains sacrificed',
		async () => {
			if (!available.ok) return;
			await chosenOnce(
				'set-cataclysm-share',
				'Cataclysm',
				19,
				(s, first, taken) => {
					expect(slotsOf(first)).toMatchObject({ fill: true });
					expect(names(s, taken)).toEqual(['Glorious Anthem', 'Ornithopter', 'Plains']);
					expect(zoneNames(s, 'Battlefield')).toEqual(['Glorious Anthem', 'Ornithopter', 'Plains']);
					expect(zoneNames(s, 'Graveyard')).toEqual(['Cataclysm', 'Grizzly Bears', 'Plains', 'Plains', 'Plains']);
				},
				(ask, nth, name) => named(ask, name, nth === 0 ? ['Ornithopter', 'Plains'] : ['Ornithopter', 'Glorious Anthem', 'Plains']),
			);
		},
		300_000,
	);

	it(
		'Sundering Titan (ChooseCard EachBasicType, every player’s lands): the AI’s Volcanic Island chosen as both the Island and the Mountain; a set with no Forest refused; exactly the chosen lands destroyed as it enters and as it leaves',
		async () => {
			if (!available.ok) return;
			const searches: { ask: Ask; answer: Ref[] }[] = [];
			const at: { s?: Scenario } = {};
			const name = (id: number) => nameOf(at.s!, 0, id);
			const answers = [
				(ask: Ask) => named(ask, name, ['Volcanic Island', 'Plains', 'Swamp']),
				(ask: Ask) => named(ask, name, ['Volcanic Island', 'Plains', 'Swamp', 'Forest']),
				validSet,
			];
			// Every land on the battlefield, either player's, as seat 0 sees it; read as each ask arrives.
			const field = () => [0, 1].flatMap((seat) => zoneIds(at.s!.state(0).get(deltaKey(DELTA_TYPE.player, at.s!.match.seats[seat]?.playerId ?? -1)), 'Battlefield'));
			const fieldAt: number[][] = [];
			const reply = (frame: Record<string, unknown>): unknown => {
				const f = frame as Ask;
				if (f.method !== 'chooseEntitiesForEffect' || f.rules === undefined) return undefined;
				fieldAt.push(field());
				const answer = answers[Math.min(searches.length, answers.length - 1)]!(f);
				searches.push({ ask: f, answer });
				return answer;
			};
			const s = await startScenario(available.config, { seed: 20, decks: DECKS, scenario: scenarioText('set-titan'), skipOpening: true, aiOpponent: true, reply });
			at.s = s;
			try {
				await castAndResolve(s, 'Sundering Titan');
				expect(searches, 'the set with no Forest asked again, then the valid one taken').toHaveLength(2);
				const [first, second] = searches;
				const slots = slotsOf(first!.ask)!;
				expect(slots).toMatchObject({ fill: true });
				expect(slots.slots).toHaveLength(5);
				expect(names(s, first!.ask.optionList!)).toContain('Mountain');
				expect(searchRuleProblems(first!.ask.rules, idsOf(first!.answer))).not.toEqual([]);
				expect(searchRuleProblems(second!.ask.rules, idsOf(second!.answer))).toEqual([]);
				const destroyed = idsOf(second!.answer);
				const titan = s.zone(0, 'Battlefield').find((c) => c.name === 'Sundering Titan')!;
				expect(titan, 'Sundering Titan on the battlefield').toBeDefined();
				expect(fieldAt[0]).toContain(titan.id);
				expect(field().sort()).toEqual(fieldAt[0]!.filter((id) => !destroyed.includes(id)).sort());
				expect(zoneNames(s, 'Battlefield')).toEqual(['Forest', 'Forest', 'Island', 'Plains', 'Plains', 'Sundering Titan', 'Swamp']);

				await castAndResolve(s, 'Unsummon', titan.id);
				expect(searches, 'one more ask as it leaves').toHaveLength(3);
				const leaving = idsOf(searches[2]!.answer);
				expect(searchRuleProblems(searches[2]!.ask.rules, leaving)).toEqual([]);
				expect(leaving.length).toBeGreaterThan(0);
				expect(fieldAt[2]).not.toContain(titan.id);
				expect(field().sort()).toEqual(fieldAt[2]!.filter((id) => !leaving.includes(id)).sort());
				expect(s.zone(0, 'Hand').map((c) => c.name)).toEqual(['Sundering Titan']);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Global Ruin (ChooseCard EachBasicType): one pick of a land of each basic type; two Plains refused; Volcanic Island the Mountain',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-ruin', 'Global Ruin', 13, (s, first, taken) => {
				expect(slotsOf(first)).toMatchObject({ fill: true });
				expect(names(s, taken)).toEqual(['Forest', 'Island', 'Plains', 'Volcanic Island']);
				expect(zoneNames(s, 'Battlefield')).toEqual(['Forest', 'Island', 'Plains', 'Volcanic Island']);
			});
		},
		300_000,
	);

	it(
		'Celestial Judgment (ChooseCard EachDifferentPower): one pick of a creature of each power; both Bears refused; the other Bears destroyed',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-judgment', 'Celestial Judgment', 14, (s, first, taken) => {
				expect(slotsOf(first)?.slots).toHaveLength(3);
				expect(names(s, taken).filter((n) => n === 'Grizzly Bears')).toHaveLength(1);
				expect(zoneNames(s, 'Battlefield').filter((n) => n !== 'Plains')).toEqual(['Grizzly Bears', 'Ornithopter']);
			});
		},
		300_000,
	);

	it(
		'Slaughter the Strong (ChooseCard WithTotalPower): one pick of creatures with total power 4 or less; Bears and Hill Giant refused; Hill Giant sacrificed',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-slaughter', 'Slaughter the Strong', 15, (s, first, taken) => {
				expect(first.rules?.map((r) => r.kind)).toEqual(['totalPower']);
				expect(first.rules?.[0]).toMatchObject({ atMost: 4 });
				expect(names(s, taken)).toEqual(['Grizzly Bears', 'Grizzly Bears', 'Ornithopter']);
				expect(zoneNames(s, 'Battlefield').filter((n) => n !== 'Plains')).toEqual(['Grizzly Bears', 'Grizzly Bears', 'Ornithopter']);
			});
		},
		300_000,
	);

	it(
		'Sigarda’s Vanguard (ChooseCard WithDifferentPowers): one pick of creatures with different powers; both Bears refused',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-vanguard', "Sigarda's Vanguard", 18, (s, first, taken) => {
				expect(first.rules?.map((r) => r.kind)).toEqual(['differentPowers']);
				expect(names(s, first.optionList!)).toEqual(['Grizzly Bears', 'Grizzly Bears', 'Ornithopter', "Sigarda's Vanguard"]);
				expect(names(s, taken)).toEqual(['Grizzly Bears', 'Ornithopter', "Sigarda's Vanguard"]);
			});
		},
		300_000,
	);

	it(
		'Michelangelo’s Technique (Dig WithTotalCMC): the dig is one pick in the search prompt, a set over 6 refused, the valid one on the battlefield',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-technique', "Michelangelo's Technique", 16, (s, first, taken) => {
				expect(first.rules?.map((r) => r.kind)).toEqual(['totalManaValue']);
				expect(first.rules?.[0]).toMatchObject({ atMost: 6 });
				expect(taken.length).toBeGreaterThan(0);
				const field = s.zone(0, 'Battlefield').map((c) => c.id);
				expect(idsOf(taken).every((id) => field.includes(id)), 'the chosen creatures on the battlefield').toBe(true);
			});
		},
		300_000,
	);

	it(
		'Niv-Mizzet Reborn (Dig ForEachColorPair): one pick of a card of each colour pair; both Izzet Charms refused; one Charm and the Helix to hand',
		async () => {
			if (!available.ok) return;
			await chosenOnce('set-niv', 'Niv-Mizzet Reborn', 17, (s, first, taken) => {
				const slots = slotsOf(first)!;
				expect(slots.fill).toBe(true);
				expect(slots.slots).toHaveLength(10);
				// The two Izzet Charms and Lightning Helix; Lightning Bolt fits no pair. (The Charm left goes back
				// into the library, where the seat can no longer name it.)
				expect(first.optionList).toHaveLength(3);
				expect(names(s, taken)).toEqual(['Izzet Charm', 'Lightning Helix']);
				expect(zoneNames(s, 'Hand')).toEqual(['Izzet Charm', 'Lightning Helix']);
			});
		},
		300_000,
	);
});
