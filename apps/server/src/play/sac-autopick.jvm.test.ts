/**
 * The operator, 2026-10-20, on Tinker asking "Select artifact to sacrifice (1 left)" with Mishra's
 * Bauble the only artifact: *"it's a bad question because there is only one target"* — the ruling:
 * *"yes, auto-pick the only legal sacrifice, bone shards too."*
 *
 * Against the real jar: the bridge names a sacrifice cost's selection (`setSelectables.sacrifice`, the
 * prompt's `selection.sacrifice`, from Forge's cost-payment stack), and the server takes the sacrifice
 * when there is one way to pay it, without the selection ever reaching the seat. Two artifacts are
 * still the seat's choice, and a discard cost with one card to discard is not a sacrifice and is
 * still asked.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/sac \
 *   pnpm exec vitest run apps/server/src/play/sac-autopick.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a sacrifice cost with one way to pay it is taken for the seat, against real Forge'
	: `a sacrifice cost with one way to pay it is taken for the seat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('sac-a', ['40 Island']), deck('sac-b', ['40 Mountain'])];

type Frame = { method?: string; sacrifice?: unknown; selection?: { sacrifice?: { cards: { id: number }[]; min: number; max: number } }; message?: string };

/** The selections that reached seat 0's wire from send `from` on. */
const wired = (s: Scenario, from: number): Frame[] =>
	s.sent
		.slice(from)
		.filter((x) => x.seat === 0)
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

const named = (s: Scenario, name: string) => s.zone(0, 'Battlefield').filter((c) => c.name === name);

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
			expect(frames.filter((f) => f.method === 'setSelectables').map((f) => f.sacrifice), 'Forge offered the sacrifice, named as one').toEqual([true]);
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
			expect(wired(s, sentFrom).map((f) => f.sacrifice), 'the selection reached her').toEqual([true]);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([]);
			expect(named(s, 'Ornithopter'), 'the Ornithopter stayed').toHaveLength(1);
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
			expect(frames.filter((f) => f.method === 'setSelectables').map((f) => f.sacrifice), 'not named a sacrifice').toEqual([undefined]);
			expect(frames.some((f) => f.selection?.sacrifice !== undefined)).toBe(false);
			expect(wired(s, sentFrom), 'the selection reached her').toHaveLength(1);
			expect(s.logs.filter((l) => l.evt === 'auto-picked')).toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});
