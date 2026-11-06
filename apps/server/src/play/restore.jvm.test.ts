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
import { available, deck, inOwnMain, landPayer, passUntil, promptBar, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'restore from a turn-start snapshot, against real Forge' : `restore from a turn-start snapshot, against real Forge — SKIPPED: ${available.reason}`;

type Snapshot = Extract<BridgeLine, { t: 'snapshot' }>;

/** Every `snapshot` line the bridge printed, old JVM and new, in order. */
function snapshots(s: Scenario): Snapshot[] {
	return s.lines.filter((l): l is Snapshot & { hostT: number } => l.t === 'snapshot');
}

/** Keys whose value names other cards by id: `Id:` marks the card the others point at. */
const ID_REF = /\b(AttachedTo|ExiledWith|RememberedCards|Imprinting|ChosenCards|Attacking):([\d,]+)/g;
/** A control condition's source, `ControlUntil:<kinds>@<id>`. */
const UNTIL_REF = /\b(ControlUntil:[A-Za-z+]+)@(\d+)/g;
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
			.map((e) =>
				e
					.replace(/\|Id:(\d+)/, (_m, id: string) => `|Id:${name(id)}`)
					.replace(ID_REF, (_m, k: string, ids: string) => `${k}:${ids.split(',').map(name).join(',')}`)
					.replace(UNTIL_REF, (_m, k: string, id: string) => `${k}@${name(id)}`),
			);
		// A delayed trigger names its host and remembered cards by id: `<host>|<activator>|<kind>|<intrinsic>|<c<id>,…>|<params>`.
		if (key === 'delayedtrigger') {
			const fields = (line.slice(at + 1)).split('|');
			fields[0] = name(fields[0]!);
			fields[4] = (fields[4] ?? '').replace(/c(\d+)/g, (_m, id: string) => `c${name(id)}`);
			out[key] = [...(out[key] ?? []), fields.join('|')];
			continue;
		}
		// An effect card, or a return, is Base64 of `key=value` lines naming its host, and what it remembers,
		// chose, moved or waits on, by id.
		if (key === 'effect' || key === 'return') {
			const fields = Buffer.from(line.slice(at + 1), 'base64')
				.toString('utf8')
				.split('\n')
				.filter((f) => f !== '')
				.map((f) => {
					const eq = f.indexOf('=');
					const k = f.slice(0, eq);
					const v = f.slice(eq + 1);
					if (k === 'host') return `host=${name(v)}`;
					if (k === 'remembered') return `remembered=${v.replace(/\bc(\d+)/g, (_m, id: string) => `c${name(id)}`)}`;
					if (k === 'imprinted' || k === 'chosencards') return `${k}=${v === '' ? '' : v.split(',').map(name).join(',')}`;
					if (k === 'until') return `until=${v.replace(/\bcard:(\d+):/g, (_m, id: string) => `card:${name(id)}:`)}`;
					if (k === 'moved') return `moved=${v.replace(/>([\d/]+)(?=,|$)/g, (_m, ids: string) => `>${ids.split('/').map(name).join('/')}`)}`;
					return f;
				});
			out[key] = [...(out[key] ?? []), fields.join('|')];
			continue;
		}
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

/**
 * Pass to turn `turn`'s first main and have its active seat play a land from hand, when it holds one.
 * Returns that seat. A caller takes the seat from here, never from `inOwnMain` afterwards: once the land
 * is down the server may pass the seat out of its main phase itself, and a later `inOwnMain` then names
 * the other seat (restore.jvm's "allowed" red on main, 2026-11-05).
 */
async function playALand(s: Scenario, turn: number): Promise<number> {
	await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, turn) || inOwnMain(s, 1, turn)), `turn ${turn}, its first main`, 120_000);
	const seat = inOwnMain(s, 0, turn) ? 0 : 1;
	expect(s.match.activeSeat()?.seat, `turn ${turn} is seat ${seat}'s`).toBe(seat);
	const land = s.zone(seat, 'Hand').find((c) => c.land);
	if (land === undefined) return seat;
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
	return seat;
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
				await playALand(s, 1);
				await playALand(s, 2);
				const active = await playALand(s, 3);
				// One snapshot per turn, from the first.
				expect(snapshots(s).map((l) => l.turn)).toEqual([1, 2, 3]);
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
				// The snapshot line is printed while the board applies, before the seats' resync: wait for the view —
				// the turn AND the restored cards, which only the resync carries (the apply's own deltas drop them).
				const viewTurn = (): number | undefined => ([...s.state(0).values()].find((o) => o._type === 3)?.Turn as { v?: number } | undefined)?.v;
				// The image key is on the card's state view, not the card.
				const wurm = () => [...s.state(0).values()].find((o) => o._type === 4 && (o.Name as { v?: string } | undefined)?.v === 'Wurm Token');
				await waitUntil(() => viewTurn() === 5 && wurm() !== undefined, 'the restored view to show turn 5 and its Wurm token', 20_000, s);
				expect((wurm()?.ImageKey as { v?: string } | undefined)?.v).toMatch(/^t:g_5_5_wurm_trample\|RTR\|/);
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

/*
 * Restart turn (`docs/planning/restart-turn-plan.md`): the same restore, asked for by the seat whose
 * turn it is and allowed by the other, with the old JVM still playing. The turn starts again from its
 * own snapshot: what the active seat did this turn is undone, and it draws the same card again.
 */
describe.skipIf(!available.ok)(`${title}: restart turn`, () => {
	const decks = (): [string, string] => [deck('Restart A', ['16 Forest', '12 Mountain', '12 Grizzly Bears']), deck('Restart B', ['16 Forest', '12 Mountain', '12 Hill Giant'])];

	it(
		'allowed: the land played this turn is back in hand, the board is the snapshot’s, the same card is drawn, and both seats play on',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 31, decks: decks() });
			try {
				await playALand(s, 1);
				const active = await playALand(s, 2);
				const from = snapshots(s).findLast((l) => l.turn === 2)!;
				const landsNow = s.zone(active, 'Battlefield').filter((c) => c.land).length;
				expect(landsNow, 'a land was played this turn').toBeGreaterThan(zoneNames(from.state, `p${active}battlefield`).length);
				expect(s.match.restartState()).toMatchObject({ turn: 2, ask: null, declined: false, restorable: true });

				const before = s.match;
				const lines = s.lines.length;
				expect(before.restartAct(1 - active, 'ask'), 'only the active seat asks').toEqual({ ok: false, error: 'not-your-turn' });
				expect(before.restartAct(active, 'ask')).toEqual({ ok: true });
				expect(before.restartAct(1 - active, 'allow')).toEqual({ ok: true });
				expect(s.match).not.toBe(before);
				expect(s.match.id).toBe(before.id);
				expect(s.match.epoch).not.toBe(before.epoch);

				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.turn).toBe(2);
				expect(normalized(again.state)).toEqual(normalized(from.state));

				await passUntil(s, noAttacks(s, () => inOwnMain(s, active, 2)), 'the restarted turn 2, its first main', 120_000);
				expect(s.zone(active, 'Battlefield').map((c) => c.name).sort()).toEqual(zoneNames(from.state, `p${active}battlefield`).sort());
				expect(s.zone(1 - active, 'Battlefield').map((c) => c.name).sort()).toEqual(zoneNames(from.state, `p${1 - active}battlefield`).sort());
				expect(s.zone(active, 'Hand').map((c) => c.name)).toEqual([...zoneNames(from.state, `p${active}hand`), zoneNames(from.state, `p${active}library`)[0]]);
				expect(s.logs.find((l) => l.evt === 'restart-turn')).toMatchObject({ seat: active, turn: 2, allowedBy: 'opponent' });

				await playALand(s, 2);
				await playALand(s, 3);
				expect(snapshots(s).at(-1)?.turn).toBe(3);
			} finally {
				await s.stop();
			}
		},
		420_000,
	);

	it(
		'a turn whose snapshot cannot hold the whole game names what it lacks, and is not restarted',
		async () => {
			if (!available.ok) return;
			// Seat 0 takes seat 1's Grizzly Bears "until the end of your next turn" as the board applies: a
			// condition kept by the end-of-turn handler, not by a card, which no text carries yet
			// (control-condition). The host is seat 0's Forest.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest|Id:501',
				'humanprecast=501:CustomScript:DB$ GainControl | ValidTgts$ Creature | LoseControl$ UntilTheEndOfYourNextTurn->601',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain;Grizzly Bears|Id:601',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				expect(s.zone(0, 'Battlefield').map((c) => c.name), 'seat 0 took the Bears').toContain('Grizzly Bears');
				expect(snapshots(s).find((l) => l.turn === 4)?.lossy).toEqual(['control-condition']);
				expect(s.match.restartState()).toMatchObject({ turn: 4, restorable: false });
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: false, error: 'not-restorable' });
				expect(s.logs.find((l) => l.evt === 'snapshot-lossy')).toMatchObject({ turn: 4, kinds: ['control-condition'] });
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a turn with a command the snapshot cannot write is named by what made it and not restarted: a pump until your next turn',
		async () => {
			if (!available.ok) return;
			// Seat 0's Grizzly Bears gets +1/+1 until seat 0's next turn as the board applies: the end is a command
			// waiting in the cleanup step, which no text line writes yet. The snapshot names it by its ability.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Grizzly Bears|Id:501',
				'humanprecast=501:CustomScript:DB$ Pump | Defined$ Self | NumAtt$ +1 | NumDef$ +1 | Duration$ UntilYourNextTurn',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				expect(snapshots(s).find((l) => l.turn === 4)?.lossy).toEqual(['command:Pump']);
				expect(s.match.restartState()).toMatchObject({ turn: 4, restorable: false });
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: false, error: 'not-restorable' });
				expect(s.logs.find((l) => l.evt === 'snapshot-lossy')).toMatchObject({ turn: 4, kinds: ['command:Pump'] });
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a player\'s keyword from a static does not stop a restart: Leyline of Sanctity\'s hexproof comes back with the Leyline',
		async () => {
			if (!available.ok) return;
			// Seat 0 has hexproof from Leyline of Sanctity: Forge keeps it on a keyword card in seat 0's command zone
			// (its "can't be targeted" static lives there), which the text does not write; the Leyline's static gives
			// it again on the restored board. Before the fork kept that card in its zone, the restore's empty command
			// line took it out after the Leyline made it: the keyword stayed, its static did not, and seat 0 could be
			// targeted.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Leyline of Sanctity',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				expect(s.zone(0, 'Command').map((c) => c.name), "seat 0's keyword card").toEqual(['Keyword Effects']);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy).toBeUndefined();

				const lines = s.lines.length;
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(0, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));
				await passUntil(s, noAttacks(s, () => inOwnMain(s, 1, 4)), 'the restarted turn 4, its first main', 120_000);
				await waitUntil(() => s.zone(0, 'Command').some((c) => c.name === 'Keyword Effects'), "seat 0's keyword card, and so its hexproof static, back in its command zone", 20_000, s);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a card exiled until its exiler leaves comes through a restart and still comes back: Banisher Priest, then a Lightning Bolt',
		async () => {
			if (!available.ok) return;
			// Seat 0's Banisher Priest exiles seat 1's Grizzly Bears until the Priest leaves the battlefield, as the
			// board applies. The return is a command waiting on the Priest. Turn 4 is restarted; then seat 1 bolts
			// the Priest, and the Bears must come back, which only the return, made again, does.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Banisher Priest|Id:501',
				'humanprecast=501:TrigExile->601',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain;Grizzly Bears|Id:601',
				'aihand=Lightning Bolt',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				expect(s.zone(1, 'Exile').map((c) => c.name), 'the Priest exiled the Bears').toEqual(['Grizzly Bears']);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'the return is written').toBeUndefined();
				expect(normalized(from.state).return).toEqual([expect.stringMatching(/^host=Banisher Priest\|at=\d+\|activator=P0\|moved=Battlefield>Exile>Grizzly Bears\|until=card:Banisher Priest:leavesplay$/)]);

				const lines = s.lines.length;
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(0, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));

				await passUntil(s, noAttacks(s, () => inOwnMain(s, 1, 4)), 'the restarted turn 4, its first main', 120_000);
				const priest = s.zone(0, 'Battlefield').find((c) => c.name === 'Banisher Priest')!;
				const payLands = landPayer(s, 1);
				s.select(1, s.zone(1, 'Hand').find((c) => c.name === 'Lightning Bolt')!.id);
				let aimed = false;
				await passUntil(
					s,
					() => {
						if (!aimed && /target/i.test(s.prompt(1))) {
							aimed = true;
							s.select(1, priest.id);
						}
						payLands();
						return s.zone(1, 'Battlefield').some((c) => c.name === 'Grizzly Bears');
					},
					'the Priest bolted and the Bears back on seat 1\'s battlefield',
					60_000,
				);
				expect(s.zone(1, 'Exile')).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a control that ends when its source leaves comes through a restart with its condition: Sower of Temptation',
		async () => {
			if (!available.ok) return;
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Sower of Temptation|Id:501|ExecuteScript:TrigChange->601',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain;Grizzly Bears|Id:601',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'Sower\'s condition is written').toBeUndefined();
				expect(normalized(from.state).p0battlefield).toEqual(
					expect.arrayContaining([expect.stringMatching(/^Grizzly Bears\|.*\|Owner:P1\|BaseController:P1\|GainedControl:P0\|ControlUntil:LeavesPlay@Sower of Temptation(\||$)/)]),
				);

				const lines = s.lines.length;
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(0, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				// The restored control writes its condition again: it was put back on the restored Sower.
				expect(normalized(again.state)).toEqual(normalized(from.state));
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'stolen permanents come through a restart in their layers: an Aura\'s control, an effect\'s, and a reanimated creature\'s',
		async () => {
			if (!available.ok) return;
			// Seat 0 controls three of seat 1's creatures three ways. Control Magic's Bears: base controller
			// its owner, control from the Aura's static, so the Aura leaving would give them back. The Hill
			// Giant: control a resolved effect gave for good. The Elves: put onto the battlefield under seat
			// 0, so seat 0 is their base controller.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Control Magic|AttachedTo:601;Grizzly Bears|Id:601|Owner:P1|BaseController:P1;Hill Giant|Owner:P1|BaseController:P1|GainedControl:P0;Llanowar Elves|Owner:P1',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'every layer of control is written').toBeUndefined();
				const field = normalized(from.state).p0battlefield ?? [];
				expect(field).toEqual(
					expect.arrayContaining([
						expect.stringMatching(/^Grizzly Bears\|.*\|Owner:P1\|BaseController:P1(\||$)/),
						expect.stringMatching(/^Hill Giant\|.*\|Owner:P1\|BaseController:P1\|GainedControl:P0(\||$)/),
						expect.stringMatching(/^Llanowar Elves\|.*\|Owner:P1(\||$)/),
					]),
				);
				expect(field.find((e) => e.startsWith('Grizzly Bears')), "the Aura's control is the static's, never written").not.toMatch(/GainedControl/);
				expect(field.find((e) => e.startsWith('Llanowar Elves')), 'a base controller needs no layer').not.toMatch(/BaseController/);

				const lines = s.lines.length;
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(0, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));
				await passUntil(s, noAttacks(s, () => inOwnMain(s, 1, 4)), 'the restarted turn 4, its first main', 120_000);
				expect(s.zone(0, 'Battlefield').map((c) => c.name)).toEqual(expect.arrayContaining(['Grizzly Bears', 'Hill Giant', 'Llanowar Elves']));
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'the monarch, the initiative, night, speed and radiation come through a restart as they were, with nothing left unwritten',
		async () => {
			if (!available.ok) return;
			// Seat 1 is the monarch, seat 0 has the initiative, and it is night: turn 4 is seat 1's, so
			// no upkeep venture runs, and no spell is cast, so night stays night. Seat 0 has speed 2 and
			// seat 1 three rad counters: both effect cards come back from those lines alone. Seat 1's
			// library is lands, so its radiation mill in main costs no life.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'monarch=P1|CN2',
				'initiative=P0|CLB',
				'daytime=night',
				'humanspeed=2',
				'aicounters=RAD=3',
				'humanbattlefield=Forest',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'nothing the text cannot hold').toBeUndefined();
				expect(normalized(from.state)).toMatchObject({ monarch: ['P1|CN2'], monarchbeginturn: ['P1'], initiative: ['P0|CLB'], daytime: ['night'], p0speed: ['2'], p1counters: ['RAD=3'] });
				expect(s.match.restartState()).toMatchObject({ turn: 4, restorable: true });

				const lines = s.lines.length;
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(0, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.turn).toBe(4);
				expect(again.lossy, 'one of each effect card, each its holder\'s own').toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));
				expect(s.lines.slice(lines).filter((l) => l.t === 'log' && /monarch|initiative/i.test(JSON.stringify(l)) && /becomes|takes/i.test(JSON.stringify(l))), 'no "becomes the monarch" or "takes the initiative" ran again').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a delayed trigger waiting for the upkeep comes through a restart and fires once more: Casey Jones\'s random discard',
		async () => {
			if (!available.ok) return;
			// Casey Jones's own delayed trigger, run as the board applies on seat 1's turn 3: at the beginning of
			// seat 0's next upkeep, discard three cards at random. Turn 4's snapshot is taken as that upkeep begins,
			// before the trigger fires, so it must carry the trigger; the restart then plays the upkeep again.
			const scenario = [
				'turn=3',
				'activeplayer=ai',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanhand=Grizzly Bears;Hill Giant;Llanowar Elves',
				'humanbattlefield=Forest;Casey Jones, Vigilante|ExecuteScript:DelTrig',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 0, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'the delayed trigger is written').toBeUndefined();
				expect(normalized(from.state).delayedtrigger).toEqual([expect.stringMatching(/^Casey Jones, Vigilante\|P0\|delayed\|/)]);
				// It fired as the upkeep went on: three cards discarded, then the draw.
				expect(s.zone(0, 'Hand')).toHaveLength(1);
				expect(s.zone(0, 'Graveyard')).toHaveLength(3);

				const lines = s.lines.length;
				expect(s.match.restartAct(0, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(1, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));
				// The restored upkeep fires it again: the three cards the snapshot holds in hand go, then the draw.
				await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, 4)), 'the restarted turn 4, its first main', 120_000);
				await waitUntil(() => s.zone(0, 'Hand').length === 1 && s.zone(0, 'Graveyard').length === 3, 'the discard again, then the draw', 30_000, s);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'an emblem and a boon come through a restart, rebuilt from the abilities that made them: Elspeth\'s emblem, Swiftspear\'s Teachings',
		async () => {
			if (!available.ok) return;
			// As the board applies on seat 1's turn 3, seat 0's Elspeth, Knight-Errant uses her -8 (her fourth
			// ability; the first is casting her) and Swiftspear's Teachings resolves from seat 0's graveyard: an
			// emblem and a one-time boon, both lasting the game. Turn 4's snapshot must carry both, and the
			// restarted turn must have them back, made again by the same abilities.
			const scenario = [
				'turn=3',
				'activeplayer=ai',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Elspeth, Knight-Errant|Counters:LOYALTY=9|Id:501',
				"humangraveyard=Swiftspear's Teachings|Id:502",
				'humanprecast=501:3;502',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 0, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'both effect cards are written').toBeUndefined();
				expect(normalized(from.state).effect).toEqual([
					expect.stringMatching(/^host=Elspeth, Knight-Errant\|at=\d+\|owner=P0\|.*\|name=Emblem — Elspeth, Knight-Errant\|/),
					expect.stringMatching(/^host=Swiftspear's Teachings\|at=\d+\|owner=P0\|.*\|name=Swiftspear's Teachings \(\d+\)'s Boon\|/),
				]);
				// Forge names a boon after its host's toString, which carries the host's id: "Swiftspear's Teachings (101)'s Boon".
				const command = (): string[] => s.zone(0, 'Command').map((c) => c.name).sort();
				expect(command()).toEqual(['Emblem — Elspeth, Knight-Errant', expect.stringMatching(/^Swiftspear's Teachings \(\d+\)'s Boon$/)]);

				const lines = s.lines.length;
				expect(s.match.restartAct(0, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(1, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));
				await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, 4)), 'the restarted turn 4, its first main', 120_000);
				await waitUntil(() => command().length === 2, 'the emblem and the boon in seat 0\'s command zone again', 20_000, s);
				expect(command()).toEqual(['Emblem — Elspeth, Knight-Errant', expect.stringMatching(/^Swiftspear's Teachings \(\d+\)'s Boon$/)]);
				// The emblem works again, not only its text: seat 0's Forest on the battlefield is indestructible.
				const keywords = (o: Record<string, unknown>): string[] => (o.Keywords as { v?: string[] } | undefined)?.v ?? [];
				const indestructibleForest = (): boolean =>
					[...s.state(0).values()].some((o) => o._type === 4 && (o.Name as { v?: string } | undefined)?.v === 'Forest' && keywords(o).includes('Indestructible'));
				await waitUntil(indestructibleForest, "the emblem's indestructible on seat 0's Forest", 20_000, s);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a card on an adventure comes through a restart still castable from exile: Lovestruck Beast after Heart\'s Desire',
		async () => {
			if (!available.ok) return;
			// Seat 0 casts Heart's Desire on turn 3: the card goes on an adventure, exiled with an effect that lets
			// its owner cast the creature from exile. Seat 1's turn 4 is restarted from its snapshot; on turn 5
			// seat 0 casts Lovestruck Beast from exile, which only that effect, made again, allows.
			const scenario = [
				'turn=3',
				'activeplayer=human',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest;Forest;Forest',
				'humanhand=Lovestruck Beast',
				'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			// Which half a click on the card casts: Heart's Desire from hand, then the creature from exile.
			let adventure = true;
			const reply = (f: Record<string, unknown>): unknown =>
				f.method === 'getAbilityToPlay'
					? ((f.abilities as { label?: string }[]).find((a) => /Create a 1\/1 white Human creature token/.test(a.label ?? '') === adventure) ?? null)
					: undefined;
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true, reply });
			try {
				await passUntil(s, () => inOwnMain(s, 0, 3), 'turn 3, its first main', 60_000);
				const payLands = landPayer(s, 0);
				s.select(0, s.zone(0, 'Hand').find((c) => c.name === 'Lovestruck Beast')!.id);
				await passUntil(
					s,
					() => {
						payLands();
						return s.zone(0, 'Exile').some((c) => c.name === 'Lovestruck Beast');
					},
					'Heart\'s Desire paid for and resolved: Lovestruck Beast on an adventure, in exile',
					60_000,
				);
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 1, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'the adventure effect is written').toBeUndefined();
				expect(normalized(from.state).effect).toEqual([expect.stringMatching(/^host=Lovestruck Beast\|at=\d+\|owner=P0\|.*\|remembered=cLovestruck Beast\|/)]);
				expect(normalized(from.state).p0exile?.join(';')).not.toMatch(/OnAdventure/);

				const lines = s.lines.length;
				expect(s.match.restartAct(1, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(0, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));

				await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, 5)), 'turn 5, its first main', 120_000);
				const beast = s.zone(0, 'Exile').find((c) => c.name === 'Lovestruck Beast');
				expect(beast, 'Lovestruck Beast is still in exile').toBeDefined();
				adventure = false;
				const payAgain = landPayer(s, 0);
				s.select(0, beast!.id);
				await passUntil(
					s,
					() => {
						payAgain();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Lovestruck Beast');
					},
					'Lovestruck Beast cast from exile and resolved',
					60_000,
				);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'effects with a duration come through a restart and end when they would have: until your next turn, and until the end of your next turn',
		async () => {
			if (!available.ok) return;
			// On seat 1's turn 3: seat 1's Chronomantic Escape as the board applies (creatures can't attack it
			// until its next turn), and seat 0's Reckless Impulse from the stack (seat 0 may play the two exiled
			// cards until the end of its next turn; cast on seat 1's turn, so that is turn 4). Turn 4 is restarted: Reckless
			// Impulse's effect must end with turn 4 as it would have, not last to seat 0's turn after, and
			// Chronomantic Escape's as turn 5 begins.
			const scenario = [
				'turn=3',
				'activeplayer=ai',
				'activephase=MAIN1',
				'humanlife=20',
				'ailife=20',
				'humanbattlefield=Forest',
				'humangraveyard=Reckless Impulse|Id:502',
				// Put on the stack, not precast: a precast resolves only the top ability, Dig, and never its Effect.
				'humanputonstack=502',
				'humanlibrary=Grizzly Bears;Hill Giant;' + Array.from({ length: 20 }, () => 'Forest').join(';'),
				'aibattlefield=Mountain',
				'aigraveyard=Chronomantic Escape|Id:602',
				'aiprecast=602',
				'ailibrary=' + Array.from({ length: 20 }, () => 'Mountain').join(';'),
			].join('\n');
			const s = await startScenario(available.config, { seed: 3, decks: decks(), scenario, skipOpening: true });
			try {
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 4) && inOwnMain(s, 0, 4)), 'turn 4, its first main', 120_000);
				const from = snapshots(s).find((l) => l.turn === 4)!;
				expect(from.lossy, 'both effects and their ends are written').toBeUndefined();
				expect(normalized(from.state).effect).toEqual([
					expect.stringMatching(/^host=Chronomantic Escape\|.*\|owner=P1\|.*\|until=phase:cleanup:until:P1\|/),
					expect.stringMatching(/^host=Reckless Impulse\|.*\|owner=P0\|.*\|until=phase:endofturn:untilend:P0\|.*\|remembered=cHill Giant,cGrizzly Bears\|/),
				]);

				const lines = s.lines.length;
				expect(s.match.restartAct(0, 'ask')).toEqual({ ok: true });
				expect(s.match.restartAct(1, 'allow')).toEqual({ ok: true });
				await waitUntil(() => s.lines.slice(lines).some((l) => l.t === 'snapshot'), "the restarted turn's own snapshot", 120_000, s);
				const again = s.lines.slice(lines).find((l): l is Snapshot & { hostT: number } => l.t === 'snapshot')!;
				expect(again.lossy).toBeUndefined();
				expect(normalized(again.state)).toEqual(normalized(from.state));
				await passUntil(s, noAttacks(s, () => inOwnMain(s, 0, 4)), 'the restarted turn 4, its first main', 120_000);
				expect(s.zone(0, 'Command')).toHaveLength(1);
				expect(s.zone(1, 'Command')).toHaveLength(1);

				// Both end on time: turn 5's snapshot holds neither, and neither seat's command zone has one.
				await passUntil(s, noAttacks(s, () => snapshots(s).some((l) => l.turn === 5) && inOwnMain(s, 1, 5)), 'turn 5, its first main', 120_000);
				const next = snapshots(s).findLast((l) => l.turn === 5)!;
				expect(next.lossy).toBeUndefined();
				expect(normalized(next.state).effect).toBeUndefined();
				expect(s.zone(0, 'Command')).toEqual([]);
				expect(s.zone(1, 'Command')).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'declined: the game goes on untouched, on the same match, and the active seat cannot ask again this turn',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 31, decks: decks() });
			try {
				const active = await playALand(s, 1);
				const before = s.match;
				const battlefield = s.zone(active, 'Battlefield').map((c) => c.id);
				expect(before.restartAct(active, 'ask')).toEqual({ ok: true });
				expect(before.restartAct(1 - active, 'decline')).toEqual({ ok: true });
				expect(s.match).toBe(before);
				expect(before.restartAct(active, 'ask')).toEqual({ ok: false, error: 'declined-this-turn' });
				expect(s.zone(active, 'Battlefield').map((c) => c.id)).toEqual(battlefield);
				await playALand(s, 2);
				expect(s.match).toBe(before);
				expect(s.match.restartState()).toMatchObject({ turn: 2, declined: false, restorable: true });
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
