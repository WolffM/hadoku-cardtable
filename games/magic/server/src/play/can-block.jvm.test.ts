/**
 * Who may block whom, on the wire, against real Forge.
 *
 * The operator, 2026-11-20: "when blocking, i shouldn't be given choices for blockers that are
 * invalid. for example, a creature with protection from creatures cannot be blocked. i was able to
 * drag an arrow to select it, but then the arrow disappeared." The board aimed every blocker at
 * every attacker, and `InputBlock` refused the illegal pair without a word
 * (`CombatUtil.canBlock(currentAttacker, card, combat)`). The bridge now sends `canBlock`, and the
 * board aims a blocker only at an attacker it names it for.
 *
 * Seat 0 attacks with a Beloved Chaplain (protection from creatures) and a Grizzly Bears; seat 1
 * holds a Hill Giant. The snapshot must name the Giant for the Bears and nothing for the Chaplain,
 * and Forge must agree with it: the Giant's click against the Chaplain is refused, against the
 * Bears it blocks.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/can-block \
 *   pnpm exec vitest run games/magic/server/src/play/can-block.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'can-block: the frame names who may block each attacker, and Forge agrees, against real Forge'
	: `can-block: the frame names who may block each attacker, and Forge agrees, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Plains', ['40 Plains']), deck('Mountains', ['40 Mountain'])];

/** Lands on Declare Attackers with the attack declared; `scenario-blockers.jvm.test.ts` says why not on Declare Blockers. */
const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=COMBAT_DECLARE_ATTACKERS',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Beloved Chaplain|Attacking;Grizzly Bears|Attacking',
	'humanlibrary=Plains;Plains;Plains;Plains',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Hill Giant',
	'ailibrary=Mountain;Mountain;Mountain;Mountain',
	'aigraveyard=',
].join('\n');

/** The latest `canBlock` snapshot `seat` was sent, as a map, or null when none has been. */
function latestCanBlock(s: Scenario, seat: number): Map<number, number[]> | null {
	const snapshot = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { canBlock?: [number, number[]][] } }).payload?.canBlock)
		.filter((p): p is [number, number[]][] => Array.isArray(p) && p.length > 0)
		.at(-1);
	return snapshot === undefined ? null : new Map(snapshot);
}

/** Forge marked `id` the current attacker (`InputBlock.setCurrentAttacker` → `setHighlighted`) for `seat`, at line `from` or after. */
function markedSince(s: Scenario, seat: number, id: number, from: number): boolean {
	return s.lines.slice(from).some((l) => {
		const line = l as { t: string; seat?: number; frame?: { method?: unknown; on?: unknown; entities?: { kind?: unknown; id?: unknown }[] } };
		return line.t === 'frame' && line.seat === seat && line.frame?.method === 'setHighlighted' && line.frame.on === true && line.frame.entities?.some((e) => e.kind === 'card' && e.id === id) === true;
	});
}

function blocking(s: Scenario, seat: number, id: number): boolean {
	const view = [...s.state(seat).values()].find((o) => o._type === 0 && o._id === id);
	return (view?.Blocking as { v?: boolean } | undefined)?.v === true;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'a Hill Giant is named for the Grizzly Bears and not the Beloved Chaplain, and Forge takes exactly the named block',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 82, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				let pressed = false;
				await waitUntil(
					() => {
						s.answerAsks();
						const msg = s.prompt(0);
						if (!pressed && /^Priority:/.test(msg) && /Declare Attackers Step/.test(msg) && s.buttons(0)?.enable1 === true) {
							pressed = true;
							s.ok(0);
						}
						return /^Select creatures to block/.test(s.prompt(1));
					},
					'the block-assignment input to open for the defender',
					30_000,
					s,
				);
				const chaplain = s.zone(0, 'Battlefield').find((c) => c.name === 'Beloved Chaplain')!;
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				const giant = s.zone(1, 'Battlefield').find((c) => c.name === 'Hill Giant')!;

				for (const seat of [0, 1]) {
					const pairs = latestCanBlock(s, seat);
					console.log(`[can-block.jvm] seat ${seat}: canBlock=${JSON.stringify(pairs === null ? null : [...pairs])}; chaplain #${chaplain.id}, bears #${bears.id}, giant #${giant.id}`);
					expect(pairs, `seat ${seat} was sent a canBlock snapshot`).not.toBeNull();
					expect(pairs!.get(chaplain.id), `seat ${seat}: nothing may block the Beloved Chaplain`).toEqual([]);
					expect(pairs!.get(bears.id), `seat ${seat}: the Hill Giant may block the Grizzly Bears`).toEqual([giant.id]);
				}

				// Forge agrees: the Chaplain made current, the Giant's click is refused.
				let from = s.lines.length;
				s.select(1, chaplain.id);
				await waitUntil(() => markedSince(s, 1, chaplain.id, from), 'the Chaplain to be the current attacker', 10_000, s);
				s.select(1, giant.id);
				// The Bears made current, the same click blocks — and only then is the Giant blocking at all.
				from = s.lines.length;
				s.select(1, bears.id);
				await waitUntil(() => markedSince(s, 1, bears.id, from), 'the Bears to be the current attacker', 10_000, s);
				expect(blocking(s, 1, giant.id), 'Forge refused the Giant against the Chaplain').toBe(false);
				s.select(1, giant.id);
				await waitUntil(() => blocking(s, 1, giant.id), 'the Giant to block the Bears', 10_000, s);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});
