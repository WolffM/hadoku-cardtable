/**
 * m-b1bcfd5382d0, 2026-11-21: Player 80583 cast Ice, tapped Creeping Tar Pit for {U} (the browser
 * answered its "which mana ability" ask in 3 ms) and clicked an Island 15 ms later. Forge died in that
 * Island's `selectCard` with a ConcurrentModificationException, and the match went back to the start
 * of the turn on another claw.
 *
 * Here seat 0 casts Ice twelve times a game, each paid the same way: Tar Pit, its {U} chosen, and an Island
 * clicked 0–20 ms after that answer is sent, with the payment asked (the seat was in full control). The match
 * must never fail, and the Island, clicked once, must never be refused while the Tar Pit's ability ends
 * (AF664: "Should wait till previous call to playAbility finishes", and the payment stalled), and each Ice
 * must reach the stack as seat 0's (the bridge reading the hand off the game thread once lost its caster).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/mana-race \
 *   pnpm exec vitest run games/magic/server/src/play/mana-click-race.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_STOP_POLICY } from './auto.js';
import { available, deck, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a mana source clicked while the last one’s ability still resolves, against real Forge'
	: `a mana source clicked while the last one’s ability still resolves, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Plains', ['40 Plains'])];
const CASTS = 12;
/** Games, each a different Island delay. On the fork pin before the fix 3 of 6 died; 3 keep the proof affordable. */
const RUNS = Number(process.env.MANA_RACE_RUNS ?? '3');

type Frame = Record<string, unknown> & { method?: string };
type Ability = { label?: string };

const failed = (s: Scenario): Record<string, unknown> | undefined =>
	s.logs.find((l) => l.evt === 'match-failed') ?? (s.lines.find((l) => l.t === 'fatal') as Record<string, unknown> | undefined);

async function race(seed: number): Promise<{ s: Scenario; cast: number }> {
	if (!available.ok) throw new Error(available.reason);
	let tarPitAnswered = false;
	const reply = (f: Frame): unknown => {
		if (f.method !== 'getAbilityToPlay') return undefined;
		const abilities = f.abilities as Ability[];
		const ice = abilities.find((a) => /^Ice\b|Tap target permanent/i.test(a.label ?? ''));
		if (ice !== undefined) return ice;
		const blue = abilities.find((a) => /Add \{U\}/.test(a.label ?? ''));
		if (blue !== undefined) {
			tarPitAnswered = true;
			return blue;
		}
		return undefined;
	};
	const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText('mana-click-race'), skipOpening: true, aiOpponent: true, reply, policy: { ...DEFAULT_STOP_POLICY, unambiguousPayment: 'ask' } });
	let cast = 0;
	let stage: 'cast' | 'target' | 'pay' | 'resolving' = 'cast';
	let answered = -1;
	const mine = (name: string, untapped: boolean): number | undefined =>
		s.zone(0, 'Battlefield').find((c) => c.name === name && (!untapped || !c.tapped))?.id;
	await waitUntil(
		() => {
			s.answerAsks();
			if (tarPitAnswered) {
				// The Island, 0–20 ms after the Tar Pit's answer has gone (prod's was 15 ms): Forge may still be
				// resolving the Tar Pit's {U}. Forge asks the Tar Pit's ability twice; the Island goes once.
				tarPitAnswered = false;
				if (stage === 'pay') {
					stage = 'resolving';
					const island = mine('Island', true);
					if (island !== undefined) setTimeout(() => s.select(0, island), (seed * 7 + cast * 3) % 21);
				}
				return false;
			}
			if (failed(s) !== undefined) return true;
			const at = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
			if (at <= answered) return false;
			const msg = (s.sent[at]!.envelope.frame as unknown as { message: string }).message;
			if (stage === 'target' && /target/i.test(msg)) {
				const plains = s.zone(0, 'Battlefield', 1).find((c) => c.name === 'Plains');
				if (plains === undefined) return false;
				answered = at;
				stage = 'pay';
				s.select(0, plains.id);
				return false;
			}
			if (stage === 'pay' && /Pay Mana Cost/i.test(msg)) {
				const pit = mine('Creeping Tar Pit', true);
				if (pit === undefined) return false;
				answered = at;
				s.select(0, pit);
				return false;
			}
			if (!msg.startsWith('Priority:') || s.buttons(0)?.enable1 !== true) return false;
			if (!/^Stack: Empty$/m.test(msg)) return false;
			if (cast >= CASTS) return true;
			const ice = s.zone(0, 'Hand').find((c) => c.name.startsWith('Fire'));
			if (ice === undefined) return true;
			answered = at;
			stage = 'target';
			cast++;
			s.select(0, ice.id);
			return false;
		},
		`seat 0 casts Ice ${CASTS} times, each paid Tar Pit then an Island at once`,
		120_000,
		s,
	);
	return { s, cast };
}

describe.skipIf(!available.ok)(title, () => {
	for (let run = 0; run < RUNS; run++) {
		it(
			`run ${run + 1}: Ice paid with Tar Pit's {U} and an Island clicked at once, ${CASTS} times: the match never fails`,
			async () => {
				const { s, cast } = await race(31 + run);
				try {
					expect(failed(s)).toBeUndefined();
					expect(s.stderr().match(/Should wait till previous call to playAbility finishes/g) ?? []).toEqual([]);
					// Every Ice reaches the stack with its caster: read off the game thread, the hand's spells once lost it
					expect(s.stderr().match(/null activated/g) ?? []).toEqual([]);
					expect(cast).toBe(CASTS);
					expect(s.zone(0, 'Graveyard').filter((c) => c.name.startsWith('Fire')).length).toBe(CASTS);
				} catch (err) {
					console.log(`[mana-click-race] ${JSON.stringify(failed(s))}\n${s.stderr().split('\n').filter((l) => /Exception|^\s+at |Caused/.test(l)).join('\n')}\n${timeline(s, 0)}`);
					throw err;
				} finally {
					await s.stop();
				}
			},
			180_000,
		);
	}
});
