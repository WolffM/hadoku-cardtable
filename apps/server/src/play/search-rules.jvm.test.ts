/**
 * A constrained search is ONE multi-select. The operator, 2026-10-26, on Gifts Ungiven arriving as four
 * "(1 / 4)" windows: "this is obviously a situation where a multi selector should be used, not separate
 * questions … solved generally instead of hardcoded for a card".
 *
 * The fork's `ChangeZoneEffect` asks a human seat's whole set at once for every constrained search
 * (DifferentNames, DifferentCMC, DifferentPower, ShareLandType, WithTotalCMC/Power/CardTypes), and asks
 * again until the set meets the rule (`ChosenSet.meets`). The bridge sends the rule with the ask
 * (`rules`, `SearchRuleSchema`), read from the ability's parameters. Each case here answers the first
 * ask with a set that breaks the rule, sees the same question asked again, then answers a set that
 * meets it and checks the cards moved. The AI's own constrained search still takes its one-card path.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/sr \
 *   pnpm exec vitest run apps/server/src/play/search-rules.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE, idsOf, strOf, type SearchRule } from '@hadoku/forge-wire';

import { available, deck, landPayer, passUntil, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'constrained searches, against real Forge' : `constrained searches, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Island']), deck('Any B', ['40 Island'])];

type Ref = { kind: string; id: number };
type Ask = Record<string, unknown> & { method: string; callId: string; optionList?: Ref[]; max?: number; min?: number; rules?: SearchRule[] };

const clashing = (rules: readonly SearchRule[], a: number, b: number) =>
	rules.some((r) => 'clash' in r && r.clash.some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
const over = (rules: readonly SearchRule[], ids: readonly number[]) =>
	rules.some((r) => (r.kind === 'totalManaValue' || r.kind === 'totalPower') && ids.reduce((t, id) => t + (r.values[id] ?? 0), 0) > r.atMost);

/** The most cards, in offer order, that meet every rule: what a player ticks without hitting a greyed card. */
function validSet(ask: Ask): Ref[] {
	const rules = ask.rules ?? [];
	const out: Ref[] = [];
	for (const ref of ask.optionList ?? []) {
		if (out.length >= (ask.max ?? 0)) break;
		const ids = out.map((r) => r.id);
		if (ids.some((id) => clashing(rules, id, ref.id)) || over(rules, [...ids, ref.id])) continue;
		out.push(ref);
	}
	return out;
}

/** Two offered cards the rules refuse together. */
function brokenSet(ask: Ask): Ref[] {
	const rules = ask.rules ?? [];
	const options = ask.optionList ?? [];
	for (const a of options) for (const b of options) if (a.id < b.id && (clashing(rules, a.id, b.id) || over(rules, [a.id, b.id]))) return [a, b];
	throw new Error(`no two options break ${JSON.stringify(rules)}`);
}

/** The names in the other player's zone, as seat 0's state has them (an AI seat has no state of its own). */
function theirZone(s: Scenario, zone: string): string[] {
	const state = s.state(0);
	const mine = deltaKey(DELTA_TYPE.player, s.match.seats[0]?.playerId ?? -1);
	const theirs = [...state.entries()].find(([key, obj]) => key !== mine && obj._type === DELTA_TYPE.player)?.[1];
	if (theirs === undefined) throw new Error('seat 0 has no other player in its state');
	return idsOf(theirs, zone).map((id) => nameOf(s, 0, id));
}

/** A card's name as this seat's state has it. */
const nameOf = (s: Scenario, seat: number, id: number) => strOf(s.state(seat).get(deltaKey(DELTA_TYPE.card, id)), 'Name') ?? `#${id}`;

/** Seat 0 casts `name` from its scenario board and both seats pass until it resolves; `target` picks its target. */
async function castAndResolve(s: Scenario, name: string, target?: () => void): Promise<void> {
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
	let targeted = false;
	const passed = new Set<number>();
	await waitUntil(
		() => {
			s.answerAsks();
			pay();
			if (target !== undefined && !targeted && /target/i.test(s.prompt(0))) {
				targeted = true;
				target();
			}
			for (const seat of [0, 1]) {
				const at = s.sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
				if (at < 0 || passed.has(at) || !/^Stack: 1 to Resolve\.$/m.test(s.prompt(seat)) || s.buttons(seat)?.enable1 !== true) continue;
				passed.add(at);
				s.ok(seat);
			}
			return !s.zone(0, 'Hand').some((c) => c.id === card.id) && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
		},
		`${name} to resolve`,
		60_000,
		s,
	);
}

/** A reply that answers seat 0's constrained searches: first with a broken set, then with a valid one. */
function searchReplies() {
	const searches: { ask: Ask; answer: Ref[] }[] = [];
	const reply = (frame: Record<string, unknown>): unknown => {
		const f = frame as Ask;
		if (f.method !== 'chooseEntitiesForEffect' || f.rules === undefined) return undefined;
		const answer = searches.length === 0 ? brokenSet(f) : validSet(f);
		searches.push({ ask: f, answer });
		return answer;
	};
	return { searches, reply };
}

/** The asks seat `seat` was sent from `from` on. */
const asksOf = (s: Scenario, seat: number, from: number) =>
	(s.asks.slice(from) as unknown as Ask[]).filter((f) => s.sent.find((x) => (x.envelope.frame as { callId?: unknown }).callId === f.callId)?.seat === seat);

describe.skipIf(!available.ok)(title, () => {
	it(
		'Gifts Ungiven (tr-gifts): one pick of up to four with different names, a repeated name refused, the four found split between graveyard and hand',
		async () => {
			if (!available.ok) return;
			const { searches, reply } = searchReplies();
			// The library's names as seat 0 sees them while it searches: once the search is over, a card
			// left in the library is hidden again, and whether its name is still in the state by the time
			// the test reads it depends on how far the game has got (one red in a loaded run).
			const seen = new Map<number, string>();
			let live: Scenario | undefined;
			// The opponent's pick (no rules) takes its first two.
			const both = (f: Record<string, unknown>): unknown => {
				if (f.method === 'chooseEntitiesForEffect' && f.rules !== undefined && live !== undefined) {
					for (const r of f.optionList as Ref[]) if (!seen.has(r.id)) seen.set(r.id, nameOf(live, 0, r.id));
				}
				return reply(f) ?? (f.method === 'chooseEntitiesForEffect' ? (f.optionList as Ref[]).slice(0, f.max as number) : undefined);
			};
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-gifts'), reply: both });
			live = s;
			try {
				const oppId = s.match.seats[1]?.playerId as number;
				await castAndResolve(s, 'Gifts Ungiven', () =>
					s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never),
				);
				const mine = asksOf(s, 0, 0);
				console.log(`[sr-gifts] seat 0 asks ${JSON.stringify(mine.map((a) => [a.method, a.title, a.optionList?.length, a.min, a.max, a.rules?.map((r) => r.kind)]))}`);
				expect(mine.filter((a) => a.method === 'chooseSingleEntityForEffect'), 'no one-card-at-a-time window').toEqual([]);
				expect(searches, 'the broken set asked again, then the valid one taken').toHaveLength(2);
				const [first, second] = searches;
				expect(first!.ask.max).toBe(4);
				expect(first!.ask.rules?.map((r) => r.kind)).toEqual(['differentNames']);
				// The library's two Counterspells, two Brainstorms and two Islands: the only pairs that share a name.
				const clash = (first!.ask.rules![0] as Extract<SearchRule, { clash: unknown }>).clash;
				expect(clash.map(([a, b]) => [seen.get(a), seen.get(b)]).sort()).toEqual([
					['Brainstorm', 'Brainstorm'],
					['Counterspell', 'Counterspell'],
					['Island', 'Island'],
				]);
				expect(second!.ask.rules).toEqual(first!.ask.rules);
				const found = second!.answer.map((r) => r.id);
				expect(new Set(found.map((id) => nameOf(s, 0, id))).size).toBe(4);
				// The opponent's pick carries no rule of the caster's search.
				const theirs = asksOf(s, 1, 0).filter((a) => a.method === 'chooseEntitiesForEffect');
				expect(theirs).toHaveLength(1);
				expect(theirs[0]).toMatchObject({ min: 2, max: 2 });
				expect(theirs[0]!.rules).toBeUndefined();
				expect(theirs[0]!.optionList!.map((r) => r.id).sort()).toEqual([...found].sort());
				const grave = s.zone(0, 'Graveyard').map((c) => c.id);
				const hand = s.zone(0, 'Hand').map((c) => c.id);
				expect(found.filter((id) => grave.includes(id)), 'two of the four in the graveyard').toHaveLength(2);
				expect(found.filter((id) => hand.includes(id)), 'two of the four in the hand').toHaveLength(2);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Seasons Past (mp-seasons): one pick with different mana values, a repeated mana value refused, the valid set returned to hand',
		async () => {
			if (!available.ok) return;
			const { searches, reply } = searchReplies();
			const s = await startScenario(available.config, { seed: 2, decks: DECKS, scenario: scenarioText('mp-seasons'), skipOpening: true, reply });
			try {
				await castAndResolve(s, 'Seasons Past');
				expect(asksOf(s, 0, 0).filter((a) => a.method === 'chooseSingleEntityForEffect')).toEqual([]);
				expect(searches).toHaveLength(2);
				expect(searches[0]!.ask.rules?.map((r) => r.kind)).toEqual(['differentManaValues']);
				const back = searches[1]!.answer.map((r) => r.id);
				// Bolt or Ponder, Counterspell or Bears, and Hill Giant: three of five.
				expect(back).toHaveLength(3);
				const hand = s.zone(0, 'Hand').map((c) => c.id);
				expect(back.every((id) => hand.includes(id)), 'the three returned to hand').toBe(true);
				expect(s.zone(0, 'Graveyard')).toHaveLength(2);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'Lively Dirge (mp-dirge): one pick of up to two with total mana value 4 or less, a set over it refused, the valid set returned',
		async () => {
			if (!available.ok) return;
			const { searches, reply } = searchReplies();
			// Spree: the second mode alone.
			const modes = (f: Record<string, unknown>): unknown => {
				if (f.method === 'getChoices') {
					const choices = f.choices as { key: string; label: string }[];
					const ret = choices.find((c) => /return up to two creature/i.test(c.label));
					if (ret !== undefined) return [ret.key];
				}
				return reply(f);
			};
			const s = await startScenario(available.config, { seed: 3, decks: DECKS, scenario: scenarioText('mp-dirge'), skipOpening: true, reply: modes });
			try {
				await castAndResolve(s, 'Lively Dirge');
				expect(asksOf(s, 0, 0).filter((a) => a.method === 'chooseSingleEntityForEffect')).toEqual([]);
				expect(searches).toHaveLength(2);
				const rule = searches[0]!.ask.rules?.[0];
				expect(rule?.kind).toBe('totalManaValue');
				expect(rule).toMatchObject({ atMost: 4 });
				const values = (rule as Extract<SearchRule, { values: Record<string, number> }>).values;
				const byName = Object.fromEntries(Object.entries(values).map(([id, v]) => [nameOf(s, 0, Number(id)), v]));
				expect(byName).toEqual({ 'Grizzly Bears': 2, 'Hill Giant': 4, 'Llanowar Elves': 1, Ornithopter: 0 });
				const back = searches[1]!.answer.map((r) => r.id);
				expect(back).toHaveLength(2);
				const field = s.zone(0, 'Battlefield').map((c) => c.id);
				expect(back.every((id) => field.includes(id)), 'the two returned to the battlefield').toBe(true);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'the AI’s own constrained search (mp-ai-landscape: Myriad Landscape, two basics that share a land type) still resolves on its one-card path',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4, decks: DECKS, scenario: scenarioText('mp-ai-landscape'), skipOpening: true, aiOpponent: true });
			try {
				const theirs = () => theirZone(s, 'Battlefield');
				await passUntil(s, () => theirs().includes('Myriad Landscape'), 'the AI’s board', 30_000);
				await passUntil(s, () => !theirs().some((n) => n === 'Myriad Landscape'), 'the AI to use Myriad Landscape', 120_000);
				await passUntil(s, () => theirs().length >= 4, 'the lands it found to arrive', 30_000);
				const found = theirs().filter((n) => n !== 'Plains');
				console.log(`[sr-ai-landscape] the AI's battlefield ${JSON.stringify(theirs())}`);
				expect(found.length, 'one or two basics found').toBeGreaterThanOrEqual(1);
				expect(new Set(found).size, 'every land found shares one basic type').toBe(1);
				expect(asksOf(s, 0, 0).filter((a) => a.rules !== undefined), 'no rules on any ask of seat 0').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
