/**
 * The operator, 2026-10-20, on Tinker asking "Select artifact to sacrifice (1 left)" with Mishra's
 * Bauble the only artifact: *"it's a bad question because there is only one target"* — the ruling:
 * *"yes, auto-pick the only legal sacrifice, bone shards too."*
 *
 * And its scope, the same day: costs AND effects that make the seat sacrifice (edicts), and a forced
 * SET, not just one card: N legal cards for a sacrifice of N are all taken without asking.
 *
 * Against the real jar: the bridge names a pick of what to sacrifice (the prompt's
 * `selection.sacrifice` — Forge's cost-payment stack for a cost, the input's own ability for an
 * edict), and the server takes it when there is one way to make it, without the selection ever
 * reaching the seat. A real choice is still the seat's, and a discard cost with one card to discard
 * is not a sacrifice and is still asked.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/sac \
 *   pnpm exec vitest run apps/server/src/play/sac-autopick.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a sacrifice with one way to make it is taken for the seat, against real Forge'
	: `a sacrifice with one way to make it is taken for the seat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('sac-a', ['40 Island']), deck('sac-b', ['40 Mountain'])];

type Frame = { method?: string; selection?: { sacrifice?: { cards: { id: number }[]; min: number; max: number } }; message?: string };

/** The selections that reached `seat`'s wire from send `from` on. */
const wired = (s: Scenario, from: number, seat = 0): Frame[] =>
	s.sent
		.slice(from)
		.filter((x) => x.seat === seat)
		.map((x) => x.envelope.frame as Frame)
		.filter((f) => f.method === 'setSelectables');

/** Cast `spell` from seat 0's hand; tap a land for any payment Forge leaves open; `pick` answers a selection shown. */
async function cast(s: Scenario, spell: string, done: () => boolean, pick: (said: string) => void = () => {}): Promise<void> {
	const card = s.zone(0, 'Hand').find((c) => c.name === spell);
	if (card === undefined) throw new Error(`no ${spell} in hand`);
	s.select(0, card.id);
	await waitUntil(
		() => {
			s.answerAsks();
			const said = s.prompt(0);
			if (/Pay Mana Cost/.test(said)) {
				const land = s.zone(0, 'Battlefield').find((c) => c.land && !c.tapped);
				if (land !== undefined) s.select(0, land.id);
			} else pick(said);
			return done();
		},
		`${spell} to resolve`,
		45_000,
		s,
	);
}

async function opened(scenario: string): Promise<Scenario> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed: 20, decks: DECKS, names: ['Alice', 'Bob'], scenario });
	await finishMulligan(s);
	await waitUntil(() => inOwnMain(s, 0, 1), 'alice to hold priority in her first main', 30_000, s);
	return s;
}

const named = (s: Scenario, name: string, seat = 0) => s.zone(seat, 'Battlefield').filter((c) => c.name === name);

/** A state with alice holding `spell` beside four Swamps, and each side's creatures. */
function edict(spell: string, mine: string[], theirs: string[]): string {
	return [
		'turn=1',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		`humanhand=${spell}`,
		`humanbattlefield=${['Swamp', 'Swamp', 'Swamp', 'Swamp', ...mine].join(';')}`,
		'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
		'humangraveyard=',
		'aihand=',
		`aibattlefield=${theirs.join(';')}`,
		'ailibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
		'aigraveyard=',
	].join('\n');
}

/** Bob picks the first `n` cards of each sacrifice he is shown, as his screen would. */
function bobPicks(s: Scenario, n: number): () => number {
	let picked = 0;
	let seen = 0;
	return () => {
		const sets = wired(s, 0, 1);
		if (sets.length > seen && /to sacrifice/.test(s.prompt(1))) {
			seen = sets.length;
			const set = sets.at(-1) as Frame & { cards?: { id: number }[] };
			for (const c of (set.cards ?? []).slice(0, n)) s.select(1, c.id);
			picked += 1;
		}
		return picked;
	};
}

/** Tinker resolved: it is in her graveyard. */
const tinkered = (s: Scenario): boolean => s.zone(0, 'Graveyard').some((c) => c.name === 'Tinker');

describe.skipIf(!available.ok)(title, () => {
	it('Tinker with only the Bauble: the Bauble is sacrificed for her, and the selection never reaches her', async () => {
		const s = await opened(scenarioText('tk-tinker'));
		try {
			const [bauble] = named(s, "Mishra's Bauble");
			const from = s.lines.length;
			const sentFrom = s.sent.length;
			await cast(s, 'Tinker', () => tinkered(s));
			const frames = forgeFrames(s, 0, from) as Frame[];
			expect(frames.filter((f) => f.method === 'setSelectables'), 'Forge offered the sacrifice').toHaveLength(1);
			expect(frames.filter((f) => f.selection?.sacrifice !== undefined).map((f) => f.selection?.sacrifice)).toEqual([{ cards: [{ kind: 'card', id: bauble!.id }], min: 1, max: 1 }]);
			expect(wired(s, sentFrom), 'no selection reached her').toEqual([]);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([expect.objectContaining({ seat: 0, why: 'the only legal sacrifice', cards: [{ id: bauble!.id, name: "Mishra's Bauble" }] })]);
			expect(named(s, "Mishra's Bauble"), 'the Bauble was sacrificed').toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('Tinker with two artifacts: she is asked, and picks', async () => {
		const s = await opened(scenarioText('tk-tinker-two'));
		try {
			const [bauble] = named(s, "Mishra's Bauble");
			const sentFrom = s.sent.length;
			let picked = false;
			await cast(
				s,
				'Tinker',
				() => tinkered(s),
				(said) => {
					if (!picked && /to sacrifice/.test(said)) {
						picked = true;
						s.select(0, bauble!.id);
					}
				},
			);
			expect(picked, 'the sacrifice was asked').toBe(true);
			expect(wired(s, sentFrom), 'the selection reached her').toHaveLength(1);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([]);
			expect(named(s, 'Ornithopter'), 'the Ornithopter stayed').toHaveLength(1);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('Innocent Blood: alice\'s one creature is sacrificed for her; bob, with two, is asked', async () => {
		const s = await opened(edict('Innocent Blood', ['Grizzly Bears'], ['Hill Giant', 'Llanowar Elves']));
		try {
			const [bears] = named(s, 'Grizzly Bears');
			const sentFrom = s.sent.length;
			const bob = bobPicks(s, 1);
			await cast(s, 'Innocent Blood', () => {
				bob();
				return s.zone(0, 'Graveyard').some((c) => c.name === 'Innocent Blood') && named(s, 'Grizzly Bears').length === 0;
			});
			expect(bob(), 'bob was asked once').toBe(1);
			expect(wired(s, sentFrom), 'no selection reached alice').toEqual([]);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([expect.objectContaining({ seat: 0, why: 'the only legal sacrifice', cards: [{ id: bears!.id, name: 'Grizzly Bears' }] })]);
			expect([...named(s, 'Hill Giant', 1), ...named(s, 'Llanowar Elves', 1)], 'bob kept one of his two').toHaveLength(1);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('Barter in Blood: alice\'s two creatures are both sacrificed for her; bob, with three, is asked', async () => {
		const s = await opened(edict('Barter in Blood', ['Grizzly Bears', 'Llanowar Elves'], ['Hill Giant', 'Hill Giant', 'Llanowar Elves']));
		try {
			const mine = [...named(s, 'Grizzly Bears'), ...named(s, 'Llanowar Elves')].map((c) => c.id).sort((a, b) => a - b);
			const sentFrom = s.sent.length;
			const bob = bobPicks(s, 2);
			await cast(s, 'Barter in Blood', () => {
				bob();
				return s.zone(0, 'Graveyard').some((c) => c.name === 'Barter in Blood') && s.zone(1, 'Battlefield').filter((c) => c.creature).length === 1;
			});
			expect(bob(), 'bob was asked once').toBe(1);
			expect(wired(s, sentFrom), 'no selection reached alice').toEqual([]);
			const picked = s.logs.filter((l) => l.evt === 'auto-picked');
			expect(picked).toHaveLength(1);
			expect(picked[0]).toMatchObject({ seat: 0, why: 'the only legal sacrifice' });
			expect((picked[0]!.cards as { id: number }[]).map((c) => c.id).sort((a, b) => a - b), 'both of hers, in one pick').toEqual(mine);
			expect(s.zone(0, 'Battlefield').filter((c) => c.creature), 'alice has no creature left').toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('improvise with one untapped artifact is not tapped for her: a pick of up to one is her choice', async () => {
		const state = [
			'turn=1',
			'activeplayer=human',
			'activephase=MAIN1',
			'humanlife=20',
			'ailife=20',
			'humanhand=Kappa Cannoneer',
			"humanbattlefield=Island;Island;Island;Island;Island;Island;Mishra's Bauble",
			'humanlibrary=Island;Island;Island;Island;Island;Island',
			'humangraveyard=',
			'aihand=',
			'aibattlefield=Mountain',
			'ailibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
			'aigraveyard=',
		].join('\n');
		const s = await opened(state);
		try {
			const [bauble] = named(s, "Mishra's Bauble");
			const sentFrom = s.sent.length;
			const card = s.zone(0, 'Hand').find((c) => c.name === 'Kappa Cannoneer')!;
			s.select(0, card.id);
			await waitUntil(() => { s.answerAsks(); return /for Improvise/.test(s.prompt(0)); }, "Forge's Improvise question", 20_000, s);
			await new Promise((r) => setTimeout(r, 3_000));
			expect(s.prompt(0), 'the Improvise question still waits').toMatch(/for Improvise/);
			expect(wired(s, sentFrom).map((f) => f as Frame & { cards?: { id: number }[]; min?: number; max?: number }).map((f) => ({ cards: f.cards?.map((c) => c.id), min: f.min, max: f.max })), 'the pick reached her').toEqual([
				{ cards: [bauble!.id], min: 0, max: 1 },
			]);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([]);
			expect(named(s, "Mishra's Bauble")[0]?.tapped, 'the Bauble is untapped').toBe(false);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('a discard cost with one card to discard is not a sacrifice: it is still asked', async () => {
		const state = [
			'turn=1',
			'activeplayer=human',
			'activephase=MAIN1',
			'humanlife=20',
			'ailife=20',
			'humanhand=Thrill of Possibility;Island',
			'humanbattlefield=Mountain;Mountain',
			'humanlibrary=Island;Island;Island;Island;Island;Island',
			'humangraveyard=',
			'aihand=',
			'aibattlefield=Mountain',
			'ailibrary=Mountain;Mountain;Mountain;Mountain;Mountain;Mountain',
			'aigraveyard=',
		].join('\n');
		const s = await opened(state);
		try {
			const [island] = s.zone(0, 'Hand').filter((c) => c.name === 'Island');
			const from = s.lines.length;
			const sentFrom = s.sent.length;
			let asked = false;
			await cast(
				s,
				'Thrill of Possibility',
				() => s.zone(0, 'Graveyard').some((c) => c.name === 'Thrill of Possibility'),
				(said) => {
					if (!asked && /to discard/.test(said)) {
						asked = true;
						s.select(0, island!.id);
					}
				},
			);
			expect(asked, 'the discard was asked').toBe(true);
			const frames = forgeFrames(s, 0, from) as Frame[];
			expect(frames.some((f) => f.selection?.sacrifice !== undefined)).toBe(false);
			expect(wired(s, sentFrom), 'the selection reached her').toHaveLength(1);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});
