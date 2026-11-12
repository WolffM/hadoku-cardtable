/**
 * The game log's public half (`GameLogMeta`), against real Forge.
 *
 * The operator, 2026-11-09: *"the game log is quite ugly and it drops several
 * decisions … some things like what was targeted or damage dealt or what a
 * resolution did is not visible."* The log panel now groups a game into turns,
 * nests a response under what it answered, and puts what a resolution did under
 * the spell that did it. All of that rides on fields `PlayBridge.GameLogForward`
 * sends beside each line's words, and this suite reads them off the bridge's own
 * lines.
 *
 *  1. `lg-gamelog` (its `.state` says what is on its stack) runs one turn through
 *     most of Forge's log entry kinds, then Opt and bob's draw step.
 *  2. A response from the other seat: bob answers alice's Lightning Bolt with
 *     Unsummon on its own target, so the Bolt fizzles; then alice's Grizzly Bears
 *     resolves, said as what entered rather than as its printed type line.
 */
import { describe, expect, it } from 'vitest';

import type { GameLogMeta } from '@hadoku/forge-wire';

import type { BridgeLine } from './bridge-protocol.js';
import { available, castNamed, deck, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'the game log says who did what, to what, paid with what, in answer to what, against real Forge'
	: `the game log says who did what, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Log A', ['40 Island']), deck('Log B', ['40 Forest'])];
const ALICE = 0;
const BOB = 1;

type LogLine = Extract<BridgeLine, { t: 'log' }>;

interface Said {
	type: string;
	meta: GameLogMeta;
	alice: string | null;
	bob: string | null;
}

function said(s: Scenario): Said[] {
	const ids = playerIds(s);
	return s.lines
		.filter((l): l is LogLine & { t: 'log'; hostT: number } => l.t === 'log')
		.map((l) => ({
			type: l.type,
			meta: l.meta ?? {},
			alice: l.players.find((p) => p.player === ids[ALICE])?.text ?? null,
			bob: l.players.find((p) => p.player === ids[BOB])?.text ?? null,
		}));
}

/** Forge's player ids, by seat. */
function playerIds(s: Scenario): [number, number] {
	const a = s.match.seats[ALICE]?.playerId;
	const b = s.match.seats[BOB]?.playerId;
	if (a === null || a === undefined || b === null || b === undefined) throw new Error('both seats hold a Forge player');
	return [a, b];
}

/** The seat's own priority in its Main Phase 2, nothing on the stack. */
function inMain2(s: Scenario, seat: number): boolean {
	return (
		s.prompt(seat).startsWith(`Priority: ${s.names[seat]}`) &&
		/^Phase: Main phase, postcombat$/m.test(s.prompt(seat)) &&
		/^Stack: Empty$/m.test(s.prompt(seat)) &&
		s.buttons(seat)?.enable1 === true
	);
}

/**
 * Press OK on every new prompt of either seat whose bar is live, until `done`, except a seat
 * `held` holds back. Unlike `passUntil`, which presses only at a policy stop with an empty stack,
 * this passes priority over a full stack too, and answers a scry with its first button (Top).
 */
async function drive(s: Scenario, done: () => boolean, label: string, ms: number, held: (seat: number) => boolean = () => false): Promise<void> {
	await waitUntil(
		() => {
			s.keepHands();
			s.answerAsks();
			if (done()) return true;
			for (const seat of [ALICE, BOB]) {
				if (held(seat)) continue;
				const at = s.sent
					.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
					.filter((i) => i >= 0)
					.pop();
				if (at === undefined || s.pressed.has(at) || s.buttons(seat)?.enable1 !== true) continue;
				s.ok(seat);
			}
			return false;
		},
		label,
		ms,
		s,
	);
}

function dump(lines: readonly Said[]): string {
	return lines.map((l) => `${l.type} ${JSON.stringify(l.meta)} | ${l.alice ?? '∅'} | ${l.bob ?? '∅'}`).join('\n');
}

/** The one line whose words (alice's, else bob's) match. */
function one(lines: readonly Said[], re: RegExp, all: string): Said {
	const hits = lines.filter((l) => re.test(l.alice ?? l.bob ?? ''));
	expect(hits, `exactly one line matches ${re}\n${all}`).toHaveLength(1);
	return hits[0]!;
}

const RESPONSE = `# Alice's Lightning Bolt is on the stack at Bob's Llanowar Elves; Bob holds Unsummon and an Island.
turn=1
activeplayer=human
activephase=MAIN1
humanlife=20
ailife=20
humanhand=Grizzly Bears
humanbattlefield=Forest;Forest
humanlibrary=Forest;Forest;Forest;Forest;Forest
humanputonstack=Lightning Bolt->301
aihand=Unsummon
aibattlefield=Llanowar Elves|Id:301;Island
ailibrary=Island;Island;Island;Island;Island
`;

describe.skipIf(!available.ok)(title, () => {
	it(
		'one turn of lg-gamelog: every line has its actor, casts carry their stack ids and payment, results carry what they came of',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 11, decks: DECKS, names: ['alice', 'bob'], scenario: scenarioText('lg-gamelog') });
			try {
				await drive(s, () => inMain2(s, ALICE), "alice's Main Phase 2 with the stack resolved", 120_000);
				const opt = s.zone(ALICE, 'Hand').find((c) => c.name === 'Opt');
				if (opt === undefined) throw new Error('alice holds an Opt');
				s.select(ALICE, opt.id);
				await drive(s, () => !s.zone(ALICE, 'Hand').some((c) => c.id === opt.id) && inMain2(s, ALICE), 'Opt resolves', 60_000);
				await drive(s, () => inOwnMain(s, BOB, 2), "bob's turn 2", 120_000);

				const [aliceId, bobId] = playerIds(s);
				const lines = said(s);
				const all = dump(lines);
				console.log(`[game-log]\n${all}`);

				expect(lines.filter((l) => l.meta.actor === undefined).map((l) => l.alice ?? l.bob), `every line says whose doing it was\n${all}`).toEqual([]);

				// The stack, bottom first: each of alice's nine spells went on top of the one before.
				const casts = lines.filter((l) => l.type === 'STACK_ADD' && l.meta.actor === aliceId && l.meta.stack !== undefined);
				expect(casts.length, all).toBe(10);
				for (let i = 1; i < 9; i++) expect(casts[i]!.meta.parent, `${casts[i]!.alice} answers the spell under it\n${all}`).toBe(casts[i - 1]!.meta.stack);

				// Opt's payment is on its cast, and nothing else says it.
				expect(one(lines, /^alice cast Opt$/, all).meta.mana).toBe('{U}');
				expect(lines.filter((l) => l.type === 'MANA' || /\b(taps|picked)\b/.test(l.alice ?? '')).map((l) => l.alice), all).toEqual([]);
				expect(lines.filter((l) => /untaps their permanents/.test(l.alice ?? l.bob ?? '')), all).toEqual([]);

				// A resolution's results sit under it: Doom Blade's death, Lightning Bolt's damage and life.
				const blade = one(lines, /^alice cast Doom Blade/, all).meta.stack;
				expect(one(lines, /^Doomed Traveler was put into graveyard from battlefield/i, all).meta.of).toBe(blade);
				expect(one(lines, /^Doom Blade - /, all).meta.resolves).toBe(blade);
				const bolt = one(lines, /^alice cast Lightning Bolt/, all).meta.stack;
				expect(one(lines, /^Lightning Bolt deals 3 non-combat damage/, all).meta.of).toBe(bolt);
				expect(one(lines, /^Life: bob 22 > 19$/, all).meta).toMatchObject({ of: bolt, actor: bobId, life: { player: bobId, from: 22, to: 19 } });
				// Bob's dies trigger went on the stack on top of the Bolt.
				expect(one(lines, /^bob triggered Doomed Traveler$/, all).meta).toMatchObject({ actor: bobId, parent: bolt });

				// Unsummon's target was public when it was targeted: both seats read its name, though by
				// the time the line is written the Elves are in bob's hand.
				const unsummon = one(lines, /^Unsummon - /, all);
				expect(unsummon.alice).toMatch(/Llanowar Elves/);
				expect(unsummon.bob).toMatch(/Llanowar Elves/);

				// Combat belongs to no spell; the turn line carries its number.
				expect(one(lines, /^alice assigned Grizzly Bears to attack bob/, all).meta.of).toBeUndefined();
				expect(one(lines, /^Turn 2 \(bob\)$/, all).meta).toMatchObject({ turn: 2, actor: bobId });

				// A player's name opens a line as they wrote it.
				expect(lines.filter((l) => /^(Alice|Bob) /.test(l.alice ?? '')).map((l) => l.alice), all).toEqual([]);

				// Still: nothing alice holds unseen is named to bob.
				expect(lines.filter((l) => /Brainstorm|Counterspell/.test(l.bob ?? '')).map((l) => l.bob), all).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'a response nests under what it answered; a fizzle says so; a creature spell says how it entered',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 12, decks: DECKS, names: ['alice', 'bob'], scenario: RESPONSE });
			try {
				const bobAtPriority = (): boolean =>
					s.prompt(BOB).startsWith('Priority: bob') && /^Stack: 1 to Resolve/m.test(s.prompt(BOB)) && s.buttons(BOB)?.enable1 === true;
				await drive(s, bobAtPriority, "bob's priority over alice's Lightning Bolt", 60_000, (seat) => seat === BOB);
				const unsummon = s.zone(BOB, 'Hand').find((c) => c.name === 'Unsummon');
				if (unsummon === undefined) throw new Error('bob holds Unsummon');
				s.select(BOB, unsummon.id);
				// Its target: the one card Forge offers (the Elves, under the id Forge gave them).
				const offered = (): number[] => {
					const last = s.sent.filter((x) => x.seat === BOB && x.envelope.frame.method === 'setSelectables').pop();
					return ((last?.envelope.frame as unknown as { cards?: { id: number }[] } | undefined)?.cards ?? []).map((c) => c.id);
				};
				await waitUntil(
					() => {
						s.answerAsks();
						return /Select target creature/.test(s.prompt(BOB)) && offered().length === 1;
					},
					"Unsummon's target prompt",
					20_000,
					s,
				);
				s.select(BOB, offered()[0]!);
				await drive(
					s,
					() => s.zone(BOB, 'Hand').some((c) => c.name === 'Llanowar Elves') && inOwnMain(s, ALICE, 1),
					"Unsummon and the Bolt resolve, back to alice's main",
					60_000,
				);
				await castNamed(s, ALICE, 'Grizzly Bears');

				const [aliceId, bobId] = playerIds(s);
				const lines = said(s);
				const all = dump(lines);
				console.log(`[game-log response]\n${all}`);

				const bolt = one(lines, /^alice cast Lightning Bolt/, all).meta;
				expect(bolt.actor).toBe(aliceId);
				expect(one(lines, /^bob cast Unsummon/, all).meta).toMatchObject({ actor: bobId, parent: bolt.stack });
				const fizzled = one(lines, /^Lightning Bolt fizzles: no legal target\.$/, all);
				expect(fizzled.meta.resolves).toBe(bolt.stack);
				expect(fizzled.bob).toBe('Lightning Bolt fizzles: no legal target.');
				const cast = one(lines, /^alice cast Grizzly Bears$/, all).meta;
				expect(cast.mana).toBe('{G}{G}');
				expect(one(lines, /^Grizzly Bears enters as a 2\/2\.$/, all).meta.resolves).toBe(cast.stack);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
