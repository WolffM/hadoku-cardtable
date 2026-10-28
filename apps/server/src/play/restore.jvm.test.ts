/**
 * Turn-start snapshots and restore, against real Forge: the bridge prints the game as each
 * turn's upkeep begins (`PlayBridge.TurnSnapshot`), the server keeps the latest
 * (`Match.latestSnapshot`), and when the match's JVM is lost `MatchRegistry.restore` starts it
 * again from that snapshot on a new JVM — same id, same seats, a new epoch.
 *
 * Each case SIGKILLs the match's JVM mid-turn, restores, and checks the restored game against
 * the snapshot it came from: the restored game's own first snapshot (the restore begins the
 * same upkeep, so the bridge writes one) must say the same thing, with card ids read through
 * the cards they name — Forge gives every card a new id on apply. Library order is in that
 * text, so it is checked too. Then both seats play on.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/restore.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import type { BridgeLine } from './host.js';
import { available, deck, inOwnMain, passUntil, promptBar, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'restore from a turn-start snapshot, against real Forge' : `restore from a turn-start snapshot, against real Forge — SKIPPED: ${available.reason}`;

type Snapshot = Extract<BridgeLine, { t: 'snapshot' }>;

/** Every `snapshot` line the bridge printed, old JVM and new, in order. */
function snapshots(s: Scenario): Snapshot[] {
	return s.lines.filter((l): l is Snapshot & { hostT: number } => l.t === 'snapshot');
}

/** Keys whose value names other cards by id: `Id:` marks the card the others point at. */
const ID_REF = /\b(AttachedTo|ExiledWith|RememberedCards|Imprinting|ChosenCards|Attacking):([\d,]+)/g;
/** Zones whose order is the game's: the battlefield is rebuilt tokens first, so it is compared as a set. */
const UNORDERED = /^p\dbattlefield$/;

/**
 * A snapshot as `key → entries`, every card id replaced by the name of the card it is (the `Id:`
 * entry), so two snapshots of one position compare equal across a restore.
 */
function normalized(state: string): Record<string, string[]> {
	const names = new Map<string, string>();
	for (const entry of state.split(/[\n;=]/)) {
		const id = /\|Id:(\d+)/.exec(entry)?.[1];
		if (id !== undefined) names.set(id, entry.split('|')[0]!);
	}
	const name = (id: string): string => names.get(id) ?? `?${id}`;
	const out: Record<string, string[]> = {};
	for (const line of state.split('\n')) {
		const at = line.indexOf('=');
		if (at < 0) continue;
		const key = line.slice(0, at);
		const entries = line
			.slice(at + 1)
			.split(';')
			.filter((e) => e !== '')
			.map((e) => e.replace(/\|Id:(\d+)/, (_m, id: string) => `|Id:${name(id)}`).replace(ID_REF, (_m, k: string, ids: string) => `${k}:${ids.split(',').map(name).join(',')}`));
		out[key] = UNORDERED.test(key) ? entries.sort() : entries;
	}
	return out;
}

/** A key's entries as card names, `t:` tokens by their token name. */
function zoneNames(state: string, key: string): string[] {
	return (normalized(state)[key] ?? []).map((e) => e.split('|')[0]!.replace(/^t:/, '').replace(/\+$/, ''));
}

/** This seat's life, off its own player object on its own wire. */
function life(s: Scenario, seat: number): number {
	const playerId = s.match.seats[seat]?.playerId ?? -1;
	const obj = [...s.state(seat).values()].find((o) => o._type === 1 && o._id === playerId);
	return ((obj?.Life as { v?: number } | undefined)?.v) ?? -1;
}

/** The JVM the match runs on now: the last one spawned. */
function pidNow(s: Scenario): number {
	const spawned = s.logs.filter((l) => l.evt === 'jvm-spawned');
	return spawned[spawned.length - 1]?.pid as number;
}

/**
 * Kill the match's JVM while turn `turn` is under way, restore it, and wait for the restored game's
 * own snapshot of that turn. Returns the snapshot the restore came from and the restored game's.
 */
async function killAndRestore(s: Scenario, turn: number): Promise<{ from: Snapshot; again: Snapshot; restoreMs: number }> {
	const from = snapshots(s).findLast((l) => l.turn === turn);
	if (from === undefined) throw new Error(`no snapshot of turn ${turn}`);
	expect(s.match.latestSnapshot).toEqual({ turn: from.turn, state: from.state });
	const before = s.match;
	const lines = s.lines.length;
	process.kill(pidNow(s), 'SIGKILL');
	await waitUntil(() => before.status === 'failed', 'the killed match to fail', 20_000, s);
	const at = Date.now();
	const { match: restored, ...how } = s.restore();
	expect(how).toEqual({ from: 'snapshot', turn });
	expect(restored.id).toBe(before.id);
	expect(restored.epoch).not.toBe(before.epoch);
	expect(restored.seats.map((x) => x.owner)).toEqual(before.seats.map((x) => x.owner));
	await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restored game's own snapshot", 120_000, s);
	const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
	const restoreMs = Date.now() - at;
	console.log(`[jvm] restore: turn ${from.turn}, snapshot ${Buffer.byteLength(from.state)} bytes taken in ${from.ms} ms; restored to its upkeep in ${restoreMs} ms`);
	return { from, again, restoreMs };
}

/** Each seat's battlefield as card ids, by name: what the restore changes. */
function battlefieldIds(s: Scenario, seat: number): number[] {
	return s.zone(seat, 'Battlefield').map((c) => c.id);
}

/**
 * `goal`, as a `passUntil` predicate that also declares no attack: `passUntil` presses only priority
 * stops, and a seat with creatures is asked to declare attackers in every combat it passes through.
 */
function noAttacks(s: Scenario, goal: () => boolean): () => boolean {
	return () => {
		for (const seat of [0, 1]) {
			const at = s.sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
			const msg = (s.sent[at]?.envelope.frame as unknown as { message?: string } | undefined)?.message ?? '';
			if (at < 0 || s.pressed.has(at) || !/^Select creatures to attack/.test(msg) || promptBar(s, seat)?.enable1 !== true) continue;
			s.ok(seat);
		}
		return goal();
	};
}

/** Pass to turn `turn`'s first main and have its active seat play a land from hand, when it holds one. */
async function playALand(s: Scenario, turn: number): Promise<void> {
	await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, turn) || inOwnMain(s, 1, turn)), `turn ${turn}, its first main`, 120_000);
	const seat = inOwnMain(s, 0, turn) ? 0 : 1;
	const land = s.zone(seat, 'Hand').find((c) => c.land);
	if (land === undefined) return;
	const was = s.zone(seat, 'Battlefield').filter((c) => c.land).length;
	let clickedAt = 0;
	// Read as priority.jvm.test.ts does: the land count, not the window after it, which the server
	// may pass itself. A click Forge dropped under load is made again.
	await waitUntil(
		() => {
			s.answerAsks();
			if (s.zone(seat, 'Battlefield').filter((c) => c.land).length > was) return true;
			if (Date.now() - clickedAt > 3000 && s.zone(seat, 'Hand').some((c) => c.id === land.id)) {
				clickedAt = Date.now();
				s.select(seat, land.id);
			}
			return false;
		},
		`seat ${seat}'s land on turn ${turn}`,
		30_000,
		s,
	);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'a match played to turn 3, its JVM killed mid-turn: restored to that upkeep with every zone, library order, life and the turn, then both seats play on',
		async () => {
			if (!available.ok) return;
			const lands = ['16 Forest', '12 Mountain'];
			const decks: [string, string] = [deck('Restore A', [...lands, '12 Grizzly Bears']), deck('Restore B', [...lands, '12 Hill Giant'])];
			const s = await startScenario(available.config, { seed: 31, decks });
			try {
				for (const turn of [1, 2, 3]) await playALand(s, turn);
				// One snapshot per turn, from the first.
				expect(snapshots(s).map((l) => l.turn)).toEqual([1, 2, 3]);
				const active = inOwnMain(s, 0, 3) ? 0 : 1;
				const turn3 = snapshots(s).at(-1)!.state;
				expect(zoneNames(turn3, 'p0battlefield').length + zoneNames(turn3, 'p1battlefield').length).toBeGreaterThan(0);
				const idsBefore = battlefieldIds(s, 0);

				const { from, again } = await killAndRestore(s, 3);
				expect(again.turn).toBe(3);
				expect(normalized(again.state)).toEqual(normalized(from.state));
				expect(zoneNames(from.state, 'p0library').length).toBeGreaterThan(20);

				await passUntil(s, noAttacks(s, () => inOwnMain(s, active, 3)), 'the restored turn 3, its first main', 120_000);
				const p = normalized(from.state);
				expect([life(s, 0), life(s, 1)]).toEqual([Number(p.p0life?.[0]), Number(p.p1life?.[0])]);
				expect(s.zone(0, 'Battlefield').map((c) => c.name).sort()).toEqual(zoneNames(from.state, 'p0battlefield').sort());
				expect(s.zone(1, 'Battlefield').map((c) => c.name).sort()).toEqual(zoneNames(from.state, 'p1battlefield').sort());
				expect(s.zone(1 - active, 'Hand').map((c) => c.name)).toEqual(zoneNames(from.state, `p${1 - active}hand`));
				// The active seat drew this turn's card: its snapshot hand plus the top of its library, in order.
				expect(s.zone(active, 'Hand').map((c) => c.name)).toEqual([...zoneNames(from.state, `p${active}hand`), zoneNames(from.state, `p${active}library`)[0]]);
				// ASSUMED in the plan, measured here: Forge gives every card a new id on apply.
				const idsAfter = battlefieldIds(s, 0);
				console.log(`[jvm] seat 0 battlefield ids before ${JSON.stringify(idsBefore)} after ${JSON.stringify(idsAfter)}`);
				expect(idsAfter.some((id) => idsBefore.includes(id))).toBe(false);

				// Both seats act: the active one plays a land, then each passes into the other's turn.
				await playALand(s, 3);
				await playALand(s, 4);
				expect(snapshots(s).at(-1)?.turn).toBe(4);
				expect(snapshots(s).at(-1)?.turn).toBe(4);
			} finally {
				await s.stop();
			}
		},
		420_000,
	);

	it(
		'a built-out board — attachments, tokens, counters, a planeswalker, life not 20 — comes back from its snapshot as it was',
		async () => {
			if (!available.ok) return;
			const decks: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];
			const s = await startScenario(available.config, { seed: 5, decks, scenario: scenarioText('tr-midgame'), skipOpening: true });
			try {
				// tr-midgame opens on turn 6, seat 0's main: the next turn's upkeep is the first snapshot.
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 7) && inOwnMain(s, 1, 7)), 'turn 7, its first main', 120_000);
				const { from, again } = await killAndRestore(s, 7);
				expect(normalized(again.state)).toEqual(normalized(from.state));
				const p = normalized(from.state);
				// What tr-midgame built, as the snapshot carries it.
				expect(p.p0battlefield).toEqual(
					expect.arrayContaining([
						expect.stringMatching(/^Bonesplitter\|.*\|AttachedTo:Llanowar Elves/),
						expect.stringMatching(/^Rancor\|.*\|AttachedTo:Hill Giant/),
						expect.stringMatching(/^Llanowar Elves\|.*\|Counters:P1P1=1/),
						expect.stringMatching(/^Elspeth, Sun's Champion\|.*\|Counters:LOYALTY=5/),
						expect.stringMatching(/^t:/),
					]),
				);
				expect(p.p1battlefield).toEqual(expect.arrayContaining([expect.stringMatching(/^Colossal Dreadmaw\|.*\|Counters:P1P1=1/), expect.stringMatching(/^t:/)]));

				await passUntil(s, noAttacks(s, () => inOwnMain(s, 1, 7)), 'the restored turn 7, its first main', 120_000);
				expect([life(s, 0), life(s, 1)]).toEqual([14, 11]);
				const named = (seat: number, name: string): Record<string, unknown> => {
					const id = s.zone(seat, 'Battlefield').find((c) => c.name === name)?.id;
					return [...s.state(seat).values()].find((o) => o._type === 0 && o._id === id) as Record<string, unknown>;
				};
				const counters = (o: Record<string, unknown>): [string, number][] => ((o.Counters as { v?: [string, number][] } | undefined)?.v ?? []) as [string, number][];
				const attached = (o: Record<string, unknown>): number => ((o.AttachedCards as { v?: unknown[] } | undefined)?.v ?? []).length;
				expect(counters(named(0, 'Llanowar Elves'))).toEqual([['+1/+1', 1]]);
				expect(counters(named(0, "Elspeth, Sun's Champion"))).toEqual([['Loyalty', 5]]);
				expect(counters(named(1, 'Colossal Dreadmaw'))).toEqual([['+1/+1', 1]]);
				expect(attached(named(0, 'Llanowar Elves'))).toBe(1);
				expect(attached(named(0, 'Hill Giant'))).toBe(1);
				expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Soldier Token')).toBe(true);
				expect(s.zone(1, 'Battlefield').some((c) => c.name === 'Goblin Token')).toBe(true);

				await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, 8)), "seat 0's turn 8, its first main", 120_000);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a restore puts the board back as it was: no replacement effect runs, a token keeps its printing, and the turn shows at once',
		async () => {
			if (!available.ok) return;
			// 2026-10-28 (m-b7b9edfcefd6): the restored game asked "pay 2 life?" for a Temple Garden that
			// had been on the battlefield for turns, drew the board half-built until it was answered,
			// showed turn 1, and drew Advent of the Wurm's token as Wurmcoil Engine's. The shocklands are
			// seat 1's, whose asks this harness answers, so a regression is a log line, not a hang.
			const scenario = [
				'turn=4',
				'activeplayer=human',
				'activephase=MAIN1',
				// Without a life line Forge sets each player to -1, and the game ends as it applies.
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Temple of Plenty;Forest;Forest;Jace, Architect of Thought|Counters:LOYALTY=3;T:g_5_5_wurm_trample|Set:RTR',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Sacred Foundry;Sacred Foundry;Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const decks: [string, string] = [deck('Any A', ['40 Forest']), deck('Any B', ['40 Mountain'])];
			const s = await startScenario(available.config, { seed: 3, decks, scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 5)), 'turn 5, its upkeep', 120_000);
				const lines = s.lines.length;
				const { from, again } = await killAndRestore(s, 5);
				const replaced = s.lines.slice(lines).filter((l) => l.t === 'log' && (l as { type?: string }).type === 'EFFECT_REPLACED');
				expect(replaced).toEqual([]);
				expect(normalized(again.state)).toEqual(normalized(from.state));
				expect(normalized(from.state).p0battlefield).toEqual(expect.arrayContaining([expect.stringMatching(/^t:.*Image:g_5_5_wurm_trample\/RTR\//)]));
				// The snapshot line is printed while the board applies, before the seats' resync: wait for the view.
				const viewTurn = (): number | undefined => ([...s.state(0).values()].find((o) => o._type === 3)?.Turn as { v?: number } | undefined)?.v;
				await waitUntil(() => viewTurn() === 5, 'the restored view to show turn 5', 20_000, s);
				// The image key is on the card's state view, not the card.
				const wurm = [...s.state(0).values()].find((o) => o._type === 4 && (o.Name as { v?: string } | undefined)?.v === 'Wurm Token');
				expect((wurm?.ImageKey as { v?: string } | undefined)?.v).toMatch(/^t:g_5_5_wurm_trample\|RTR\|/);
				const p = normalized(from.state);
				const want = [Number(p.p0life?.[0]), Number(p.p1life?.[0])];
				await waitUntil(() => life(s, 0) === want[0] && life(s, 1) === want[1], `life ${want.join('/')} on the wire`, 20_000, s);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a big board — 60-card libraries, 30 permanents a side, full graveyards — measures what a snapshot costs and still comes back as it was',
		async () => {
			if (!available.ok) return;
			const repeat = (n: number, cards: readonly string[]): string => Array.from({ length: n }, (_, i) => cards[i % cards.length]).join(';');
			const side = (who: 'human' | 'ai', base: number): string[] => [
				`${who}life=${who === 'human' ? 9 : 13}`,
				`${who}hand=${repeat(6, ['Lightning Bolt', 'Giant Growth', 'Shock', 'Forest'])}`,
				`${who}battlefield=${[
					repeat(12, ['Forest', 'Mountain', 'Island']),
					repeat(8, ['Grizzly Bears', 'Hill Giant', 'Llanowar Elves|Counters:P1P1=2', 'Boggart Brute|Tapped']),
					`Colossal Dreadmaw|Id:${base}`,
					`Bonesplitter|AttachedTo:${base}`,
					`Hill Giant|Id:${base + 1}`,
					`Rancor|AttachedTo:${base + 1}`,
					repeat(6, ['T:w_1_1_soldier', 'T:r_1_1_goblin']),
				].join(';')}`,
				`${who}library=${repeat(60, ['Mountain', 'Grizzly Bears', 'Forest', 'Lightning Bolt', 'Hill Giant', 'Island'])}`,
				`${who}graveyard=${repeat(15, ['Shock', 'Grizzly Bears', 'Giant Growth'])}`,
			];
			const scenario = ['turn=9', 'activeplayer=human', 'activephase=MAIN1', ...side('human', 501), ...side('ai', 601)].join('\n');
			const decks: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];
			const s = await startScenario(available.config, { seed: 9, decks, scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 10) && inOwnMain(s, 1, 10)), 'turn 10, its first main', 120_000);
				const { from, again } = await killAndRestore(s, 10);
				expect(normalized(again.state)).toEqual(normalized(from.state));
				expect(zoneNames(from.state, 'p0library')).toHaveLength(60);
				expect(zoneNames(from.state, 'p1library')).toHaveLength(60);
				await passUntil(s, noAttacks(s, () => inOwnMain(s, 1, 10)), 'the restored turn 10, its first main', 120_000);
				expect([life(s, 0), life(s, 1)]).toEqual([9, 13]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
