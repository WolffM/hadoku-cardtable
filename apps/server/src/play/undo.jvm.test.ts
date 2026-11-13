/**
 * Undo (`docs/planning/undo-plan.md`), against real Forge: one press takes back one action, the last first, back to
 * when the opponent last had priority, once the opponent allows. Forge's `UndoManager` keeps a whole-game checkpoint
 * at each of the seat's priority prompts; `PlayBridge.java` tells the server whether each seat can take one back
 * (`undo` lines) and rewinds on `rewind`, which `Match.restartAct(seat, 'ask', 'undo')` sends once the other seat
 * (or, on the press, the AI) allows.
 *
 * The default stop policy passes the caster's priority on its own spell (Q17, `passOwnSpell`), so the opponent
 * receives priority at once and, by ruling 2, the cast is already out of reach. These suites hold the stack
 * windows, as full control does, so a cast stays undoable while its caster holds priority over it.
 */

import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { DEFAULT_STOP_POLICY, type StopPolicy } from './auto.js';
import type { BridgeLine } from './bridge-protocol.js';
import { RESTART_ASK_MS } from '@hadoku/game-server/play/match/shell';
import { available, deck, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'undo, against real Forge' : `undo, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Undo A', ['20 Forest', '20 Grizzly Bears']), deck('Undo B', ['20 Forest', '20 Grizzly Bears'])];

const HOLD_STACK: StopPolicy = { ...DEFAULT_STOP_POLICY, passOwnSpell: false, passStackWindows: false };

type UndoLine = Extract<BridgeLine, { t: 'undo' }>;

/** Seat 0 in its first main of turn 3 with `field` on its battlefield and `hand` in hand; seat 1 has a Forest. */
function board(field: string[], hand: string[]): string {
	return [
		'turn=3',
		'activeplayer=human',
		'activephase=MAIN1',
		'humanlife=20',
		'ailife=20',
		`humanhand=${hand.join(';')}`,
		`humanbattlefield=${field.join(';')}`,
		'humanlibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
		'aihand=Grizzly Bears',
		'aibattlefield=Forest',
		'ailibrary=' + Array.from({ length: 20 }, () => 'Forest').join(';'),
	].join('\n');
}

/** Green, when Mana Confluence asks its colour, so the Bears' cost is paid without a payment prompt (a {W} left it open). */
function green(f: ServerFrame & Record<string, unknown>): unknown {
	if (f.method !== 'getChoices' || !/Select Mana to Produce/.test(String(f.message))) return undefined;
	const choice = (f.choices as { key: string; label: string }[]).find((c) => /green/i.test(c.label));
	return choice === undefined ? undefined : [choice.key];
}

function start(field: string[], hand: string[], aiOpponent: boolean): Promise<Scenario> {
	if (!available.ok) throw new Error('unreachable');
	return startScenario(available.config, { seed: 5, decks: DECKS, scenario: board(field, hand), skipOpening: true, aiOpponent, policy: HOLD_STACK, reply: green });
}

const lastUndo = (s: Scenario, seat: number): UndoLine | null => (s.lines.findLast((l) => l.t === 'undo' && l.seat === seat) as UndoLine | undefined) ?? null;
const undoable = (s: Scenario): number[] => s.match.restartState().undoable;
const handNames = (s: Scenario): string[] => s.zone(0, 'Hand').map((c) => c.name).sort();
const field = (s: Scenario): { name: string; tapped: boolean }[] =>
	s.zone(0, 'Battlefield').map((c) => ({ name: c.name, tapped: c.tapped })).sort((a, b) => a.name.localeCompare(b.name) || Number(a.tapped) - Number(b.tapped));
const life = (s: Scenario, seat: number): number | null => s.match.live()?.life[seat] ?? null;
const logged = (s: Scenario, evt: string): Record<string, unknown>[] => s.logs.filter((l) => l.evt === evt);

/** The game's log as seat 0 holds it now: what was said, less what a take-back cut. */
function seat0Log(s: Scenario): string[] {
	const said = (s.match as unknown as { session: { seats: { says: { message: string; log?: unknown }[] }[] } }).session.seats[0]!.says;
	return said.filter((f) => f.log !== undefined).map((f) => f.message);
}

async function priority(s: Scenario, seat: number, label: string, stack: 'empty' | 'items' = 'empty'): Promise<void> {
	await waitUntil(
		() => {
			s.answerAsks();
			const p = s.prompt(seat);
			return p.startsWith(`Priority: ${s.names[seat]}`) && (stack === 'empty' ? /^Stack: Empty$/m : /^Stack: \d+ to Resolve/m).test(p) && s.buttons(seat)?.enable1 === true;
		},
		label,
		30_000,
		s,
	);
}

/** Click the card in seat 0's hand, and wait for seat 0's next priority prompt. */
async function play(s: Scenario, name: string, stack: 'empty' | 'items'): Promise<void> {
	const card = s.zone(0, 'Hand').find((c) => c.name === name);
	if (card === undefined) throw new Error(`no ${name} in hand`);
	s.select(0, card.id);
	await waitUntil(() => { s.answerAsks(); return !s.zone(0, 'Hand').some((c) => c.id === card.id); }, `${name} left the hand`, 30_000, s);
	await priority(s, 0, `priority back after ${name}`, stack);
}

/** Click an untapped permanent of seat 0's at priority (a mana ability), and wait for it to show tapped. */
async function tap(s: Scenario, name: string): Promise<number> {
	const card = s.zone(0, 'Battlefield').find((c) => c.name === name && !c.tapped);
	if (card === undefined) throw new Error(`no untapped ${name}`);
	s.select(0, card.id);
	await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.id === card.id && c.tapped); }, `${name} tapped`, 20_000, s);
	return card.id;
}

/** Ask to undo for seat 0, and wait for Forge to have rewound it. */
async function undo(s: Scenario): Promise<void> {
	const done = logged(s, 'undo-done').length;
	expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: true });
	await waitUntil(() => logged(s, 'undo-done').length > done, 'the rewind answered', 20_000, s);
	expect(logged(s, 'undo-done').at(-1)).toMatchObject({ seat: 0, ok: true });
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe.skipIf(!available.ok)(`${title}: against the AI`, () => {
	it(
		'a cast is taken back on the press, then the activation before it: the card in hand, the lands untapped, the life paid back, the log as it was',
		async () => {
			const s = await start(['Forest', 'Mana Confluence'], ['Grizzly Bears'], true);
			try {
				await waitUntil(() => inOwnMain(s, 0, 3), 'turn 3, seat 0 in its first main', 120_000, s);
				const before = { hand: handNames(s), field: field(s), log: seat0Log(s) };
				expect(undoable(s), 'nothing to take back yet').toEqual([]);
				expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: false, error: 'nothing-to-undo' });

				await tap(s, 'Mana Confluence');
				await waitUntil(() => life(s, 0) === 19, 'Mana Confluence paid 1 life', 10_000, s);
				await priority(s, 0, 'priority back after the Confluence, its {G} floating');
				await play(s, 'Grizzly Bears', 'items');
				expect(field(s).every((c) => c.tapped), 'both sources paid for the Bears').toBe(true);
				expect(seat0Log(s).length).toBeGreaterThan(before.log.length);
				await waitUntil(() => undoable(s).includes(0), 'the server says seat 0 can undo', 10_000, s);

				await undo(s);
				expect(logged(s, 'undo')).toMatchObject([{ seat: 0, allowedBy: 'ai' }]);
				await priority(s, 0, 'priority again, the stack empty');
				// One press, one action: the cast. The Confluence's activation before it is the next press's.
				const forest = { name: 'Forest', tapped: false };
				await waitUntil(() => same(handNames(s), before.hand) && same(field(s), [forest, { name: 'Mana Confluence', tapped: true }]), 'the Bears back in hand, the Forest untapped', 20_000, s);
				expect(life(s, 0)).toBe(19);
				await waitUntil(() => undoable(s).includes(0), 'the activation still to take back', 10_000, s);
				await undo(s);
				await waitUntil(() => same(field(s), before.field), 'every land untapped', 20_000, s);
				await waitUntil(() => life(s, 0) === 20, 'the life Mana Confluence took is back', 10_000, s);
				expect(handNames(s)).toEqual(before.hand);
				expect(seat0Log(s), 'the cast and the payment left the log').toEqual(before.log);
				await waitUntil(() => lastUndo(s, 0)?.can === false, 'nothing older to take back', 10_000, s);
				expect(undoable(s)).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'two presses take back two actions, the last first; a tapped land still untaps on its own click, in any order',
		async () => {
			const s = await start(['Forest', 'Forest'], ['Forest', 'Grizzly Bears'], true);
			try {
				await waitUntil(() => inOwnMain(s, 0, 3), 'turn 3, seat 0 in its first main', 120_000, s);
				const start0 = { hand: handNames(s), field: field(s) };
				await play(s, 'Forest', 'empty');
				const afterLand = { hand: handNames(s), field: field(s) };
				await play(s, 'Grizzly Bears', 'items');
				await waitUntil(() => undoable(s).includes(0), 'seat 0 can undo the cast', 10_000, s);

				await undo(s);
				await waitUntil(() => same(handNames(s), afterLand.hand) && same(field(s), afterLand.field), 'the cast taken back, the land still played', 20_000, s);
				await waitUntil(() => undoable(s).includes(0), 'the land drop still to take back', 10_000, s);
				await undo(s);
				await waitUntil(() => same(handNames(s), start0.hand) && same(field(s), start0.field), 'the land back in hand', 20_000, s);
				await waitUntil(() => lastUndo(s, 0)?.can === false, 'nothing older to take back', 10_000, s);

				await priority(s, 0, 'priority, to tap lands');
				const first = await tap(s, 'Forest');
				const second = await tap(s, 'Forest');
				s.select(0, first);
				await waitUntil(() => s.zone(0, 'Battlefield').some((c) => c.id === first && !c.tapped), 'the first Forest untapped by its click', 20_000, s);
				expect(s.zone(0, 'Battlefield').find((c) => c.id === second)?.tapped, 'the later Forest stays tapped').toBe(true);
				expect(logged(s, 'undo'), 'the land click asks nobody').toHaveLength(2);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'once the AI has held priority nothing before it is offered, and a mana ability that mills ends the history too',
		async () => {
			const s = await start(['Forest', 'Forest', 'Deranged Assistant'], ['Forest', 'Grizzly Bears'], true);
			try {
				await waitUntil(() => inOwnMain(s, 0, 3), 'turn 3, seat 0 in its first main', 120_000, s);
				await play(s, 'Grizzly Bears', 'items');
				await waitUntil(() => undoable(s).includes(0), 'seat 0 can undo the cast', 10_000, s);
				s.ok(0);
				await waitUntil(() => s.zone(0, 'Battlefield').some((c) => c.name === 'Grizzly Bears'), 'the Bears resolved, the AI having passed', 30_000, s);
				await priority(s, 0, 'priority after the Bears resolved');
				expect(lastUndo(s, 0)?.can).toBe(false);
				expect(undoable(s), 'the AI had priority: the cast is out of reach').toEqual([]);

				await play(s, 'Forest', 'empty');
				await waitUntil(() => undoable(s).includes(0), 'seat 0 can undo the land drop', 10_000, s);
				await tap(s, 'Deranged Assistant');
				await waitUntil(() => s.zone(0, 'Graveyard').length > 0, 'the Assistant milled a card', 10_000, s);
				await waitUntil(() => lastUndo(s, 0)?.can === false, 'the mill ended the history', 10_000, s);
				expect(undoable(s)).toEqual([]);
				expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: false, error: 'nothing-to-undo' });
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});

describe.skipIf(!available.ok)(`${title}: human against human`, () => {
	it(
		'a decline leaves the game as it was, and greys Undo until the history moves',
		async () => {
			const s = await start(['Forest', 'Forest'], ['Grizzly Bears'], false);
			try {
				await waitUntil(() => inOwnMain(s, 0, 3), 'turn 3, seat 0 in its first main', 120_000, s);
				await play(s, 'Grizzly Bears', 'items');
				await waitUntil(() => undoable(s).includes(0), 'seat 0 can undo the cast', 10_000, s);
				const held = { hand: handNames(s), field: field(s), log: seat0Log(s) };

				expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: true });
				expect(s.match.restartState().ask).toEqual({ from: 0, kind: 'undo' });
				expect(s.match.restartAct(1, 'decline')).toEqual({ ok: true });
				expect(logged(s, 'undo-answered')).toMatchObject([{ seat: 1, allow: false, why: 'player' }]);
				expect(logged(s, 'undo'), 'nothing was taken back').toEqual([]);
				expect(undoable(s), 'a declined undo greys until the history moves').toEqual([]);
				expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: false, error: 'nothing-to-undo' });
				expect({ hand: handNames(s), field: field(s), log: seat0Log(s) }).toEqual(held);

				s.ok(0);
				await waitUntil(() => lastUndo(s, 0)?.can === false, 'the pass moved the history', 20_000, s);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'an open ask is cancelled when its asker acts, and an unanswered one counts as a decline',
		async () => {
			const s = await start(['Forest', 'Forest', 'Forest', 'Forest'], ['Forest', 'Grizzly Bears', 'Grizzly Bears'], false);
			try {
				await waitUntil(() => inOwnMain(s, 0, 3), 'turn 3, seat 0 in its first main', 120_000, s);
				await play(s, 'Forest', 'empty');
				await waitUntil(() => undoable(s).includes(0), 'seat 0 can undo the land drop', 10_000, s);
				expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: true });
				await play(s, 'Grizzly Bears', 'items');
				await waitUntil(() => s.match.restartState().ask === null, 'the ask lapsed when seat 0 acted', 10_000, s);
				expect(logged(s, 'undo-cancelled')).toMatchObject([{ seat: 0, why: 'history-moved' }]);
				expect(s.match.restartAct(1, 'allow')).toEqual({ ok: false, error: 'no-ask' });

				await waitUntil(() => undoable(s).includes(0), 'the cast to take back', 10_000, s);
				expect(s.match.restartAct(0, 'ask', 'undo')).toEqual({ ok: true });
				await waitUntil(() => logged(s, 'undo-answered').length > 0, 'the ask timed out', RESTART_ASK_MS + 10_000, s);
				expect(logged(s, 'undo-answered')).toMatchObject([{ seat: 1, allow: false, why: 'timeout' }]);
				expect(logged(s, 'undo')).toEqual([]);
				expect(undoable(s)).toEqual([]);
				expect(s.zone(0, 'Battlefield').filter((c) => c.name === 'Forest')).toHaveLength(5);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
