/**
 * Karn Liberated's −14 restarts the game, against real Forge. The operator, 2026-11-21 (match
 * m-8032ceb08b5b): the ultimate "tried to work and then when laying out all the cards put me back
 * earlier in the game".
 *
 * Forge restarts a game by looping `GameAction.playGame` while the game is `RestartedByKarn`, and each
 * pass calls `startFirstTurn(first, startGameHook)`, so the bridge's start hook ran a second time: it
 * applied the room's scenario over the new game and subscribed the bridge's listeners again, which
 * sent every log line twice. Here the scenario's board is one the restarted game must not have.
 *
 * The second suite is the rest of the ultimate: the permanent cards Karn exiled stay out of the shuffle and
 * come back under the activator's control (`karn_liberated.txt`: `RestrictFromValid$ Card.!ExiledWithSource,
 * Spell,Card.Aura`, then `ReturnFromExile`). Once with the links set by the scenario (`|Id:` and
 * `|ExiledWith:`, `GameState.java`), once with Karn's own +4 and −3 making them.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run games/magic/server/src/play/karn-restart.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, inOwnMain, passUntil, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'Karn Liberated’s ultimate restarts the game once, without the scenario, against real Forge'
	: `Karn Liberated’s ultimate restarts the game once, without the scenario, against real Forge — SKIPPED: ${available.reason}`;

const PLAINS = Array.from({ length: 20 }, () => 'Plains').join(';');

const STATE = [
	'turn=3',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=7',
	'ailife=9',
	'humanhand=',
	`humanlibrary=${PLAINS}`,
	'humanbattlefield=Karn Liberated|Counters:LOYALTY=14;Plains;Plains',
	'humangraveyard=',
	'aihand=',
	`ailibrary=${PLAINS}`,
	'aibattlefield=Grizzly Bears;Plains',
	'aigraveyard=',
].join('\n');

const ULTIMATE = /Restart the game/;
/** The opening's two questions; `finishMulligan` waits on both seats' prompts, and an AI seat has none. */
const OPENING = /keep your hand|play or draw/i;

/** Seat 0's life total, or the AI's: the one player in seat 0's view that is not seat 0 (an AI seat is never told its own id). */
function life(s: Scenario, who: 'me' | 'ai'): number {
	const mine = s.match.seats[0]?.playerId ?? -1;
	const obj = [...s.state(0).values()].find((o) => o._type === 1 && (who === 'me') === (o._id === mine));
	return (obj?.Life as { v?: number } | undefined)?.v ?? -1;
}

const names = (s: Scenario, seat: number, zone: 'Hand' | 'Battlefield' | 'Exile', of?: number): string[] => s.zone(seat, zone, of).map((c) => c.name);

describe.skipIf(!available.ok)(title, () => {
	it.each([
		{ room: 'a scenario room (coin toss and mulligan first)', skipOpening: false },
		{ room: 'a board-state room (no opening)', skipOpening: true },
	])(
		'$room: the −14 starts a new game at 20 life with every card back in the libraries, and logs each line once',
		async ({ skipOpening }) => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 1121,
				decks: [deck('Plains A', ['40 Plains']), deck('Plains B', ['40 Plains'])],
				aiOpponent: true,
				scenario: STATE,
				skipOpening,
				reply: (f) => (f.method === 'getAbilityToPlay' ? ((f.abilities as { label?: string }[]).find((a) => ULTIMATE.test(a.label ?? '')) ?? null) : undefined),
			});
			try {
				await waitUntil(
					() => {
						s.keepHands(OPENING);
						s.answerAsks();
						return inOwnMain(s, 0, 3) && names(s, 0, 'Battlefield').includes('Karn Liberated');
					},
					'seat 0 in its turn-3 main with Karn Liberated out',
					60_000,
					s,
				);
				expect(life(s, 'me')).toBe(7);
				expect(life(s, 'ai')).toBe(9);
				expect(names(s, 0, 'Battlefield', 1)).toContain('Grizzly Bears');

				const karn = s.zone(0, 'Battlefield').find((c) => c.name === 'Karn Liberated');
				if (karn === undefined) throw new Error('no Karn Liberated');
				const line = s.lines.length;
				s.select(0, karn.id);
				await passUntil(
					s,
					() => inOwnMain(s, 0, 1) && life(s, 'me') === 20,
					'the restarted game’s turn 1 to reach seat 0’s main',
					120_000,
				);

				expect(life(s, 'me'), 'seat 0 starts the new game at 20, not the scenario’s 7').toBe(20);
				expect(life(s, 'ai'), 'and so does the AI, not at the scenario’s 9').toBe(20);
				expect(names(s, 0, 'Battlefield'), 'Karn went back into the library with everything else').not.toContain('Karn Liberated');
				expect(names(s, 0, 'Battlefield', 1), 'the scenario’s Grizzly Bears are not put back').not.toContain('Grizzly Bears');
				expect(s.zone(0, 'Hand').length, 'seat 0 drew a new opening hand').toBe(7);

				await passUntil(s, () => inOwnMain(s, 0, 3), 'the restarted game’s turn 3', 120_000);
				const turnTwo = s.lines.slice(line).filter((l) => l.t === 'log' && l.players.some((p) => p.text !== null && /^Turn 2 \(/.test(p.text)));
				expect(turnTwo.length, 'the new game’s turn 2 is logged once, not once per start').toBe(1);
			} finally {
				await s.stop();
			}
		},
		240_000,
	);
});

/** The AI's player id: the one player in seat 0's view that is not seat 0. */
function aiId(s: Scenario): number {
	const mine = s.match.seats[0]?.playerId ?? -1;
	const obj = [...s.state(0).values()].find((o) => o._type === 1 && o._id !== mine);
	if (obj === undefined) throw new Error('no other player in seat 0’s view');
	return obj._id as number;
}

/** A card's loyalty as seat 0 holds it, or null when the card is not in its view. */
function loyalty(s: Scenario, id: number): number | null {
	const obj = [...s.state(0).values()].find((o) => o._type === 0 && o._id === id);
	if (obj === undefined) return null;
	const counters = ((obj.Counters as { v?: [string, number][] } | undefined)?.v ?? []) as [string, number][];
	return counters.find(([kind]) => /loyalty/i.test(kind))?.[1] ?? 0;
}

/** Every card name in `zone` on both sides, as seat 0 sees them. */
const both = (s: Scenario, zone: 'Battlefield' | 'Exile'): string[] => [...names(s, 0, zone), ...names(s, 0, zone, 1)];

const exiledTitle = available.ok
	? 'Karn Liberated’s ultimate brings back the permanents he exiled, against real Forge'
	: `Karn Liberated’s ultimate brings back the permanents he exiled, against real Forge — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(exiledTitle, () => {
	/** The ability `getAbilityToPlay` picks next; Karn's three are offered together on every click. */
	let want = ULTIMATE;
	const pickWanted = (f: Record<string, unknown>): unknown =>
		f.method === 'getAbilityToPlay' ? ((f.abilities as { label?: string }[]).find((a) => want.test(a.label ?? '')) ?? null) : undefined;

	/** Wait for seat 0's own main of turn `n` with Karn out, answering the opening on the way. */
	async function toMain(s: Scenario, n: number): Promise<number> {
		await passUntil(s, () => inOwnMain(s, 0, n) && names(s, 0, 'Battlefield').includes('Karn Liberated'), `seat 0’s turn-${n} main with Karn out`, 120_000);
		const karn = s.zone(0, 'Battlefield').find((c) => c.name === 'Karn Liberated');
		if (karn === undefined) throw new Error('no Karn Liberated');
		return karn.id;
	}

	/** Restart, then reach the new game's first main for seat 0. */
	async function ultimate(s: Scenario, karn: number): Promise<void> {
		want = ULTIMATE;
		s.select(0, karn);
		await passUntil(s, () => inOwnMain(s, 0, 1) && life(s, 'me') === 20, 'the restarted game’s turn 1 to reach seat 0’s main', 120_000);
	}

	it(
		'links set by the scenario: the creature and the artifact Karn exiled come back under seat 0, while the Aura and the instant he exiled and the card something else exiled are shuffled in',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 1122,
				decks: [deck('Plains A', ['40 Plains']), deck('Plains B', ['40 Plains'])],
				aiOpponent: true,
				skipOpening: true,
				scenario: [
					'turn=3',
					'activeplayer=human',
					'activephase=MAIN1',
					'humanlife=7',
					'ailife=9',
					'humanhand=',
					`humanlibrary=${PLAINS}`,
					'humanbattlefield=Karn Liberated|Id:9001|Counters:LOYALTY=14;Plains;Plains',
					'humanexile=Lightning Bolt|ExiledWith:9001',
					'humangraveyard=',
					'aihand=',
					`ailibrary=${PLAINS}`,
					'aibattlefield=Plains',
					'aiexile=Serra Angel|ExiledWith:9001;Sol Ring|ExiledWith:9001;Pacifism|ExiledWith:9001;Hill Giant',
					'aigraveyard=',
				].join('\n'),
				reply: pickWanted,
			});
			try {
				const karn = await toMain(s, 3);
				expect(both(s, 'Exile').sort()).toEqual(['Hill Giant', 'Lightning Bolt', 'Pacifism', 'Serra Angel', 'Sol Ring']);
				await ultimate(s, karn);

				expect(names(s, 0, 'Battlefield').sort(), 'Karn’s exiled permanents, under seat 0').toEqual(['Serra Angel', 'Sol Ring']);
				expect(names(s, 0, 'Battlefield', 1), 'the AI starts the new game with nothing out').toEqual([]);
				expect(both(s, 'Exile'), 'nothing stays in exile: the Aura, the instant and the card Karn never touched are shuffled in').toEqual([]);
				expect(life(s, 'me')).toBe(20);
				expect(life(s, 'ai')).toBe(20);
			} finally {
				await s.stop();
			}
		},
		240_000,
	);

	it(
		'played for real: the card Karn’s +4 took from the AI’s hand and the permanent his −3 exiled come back under seat 0',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 1123,
				decks: [deck('Plains A', ['40 Plains']), deck('Plains B', ['40 Plains'])],
				aiOpponent: true,
				skipOpening: true,
				scenario: [
					'turn=3',
					'activeplayer=human',
					'activephase=MAIN1',
					'humanlife=20',
					'ailife=20',
					'humanhand=',
					`humanlibrary=${PLAINS}`,
					'humanbattlefield=Karn Liberated|Counters:LOYALTY=13;Plains;Plains',
					'humangraveyard=',
					// Nothing the AI can cast: Grizzly Bears wants green, and its lands make white.
					'aihand=Grizzly Bears',
					`ailibrary=${PLAINS}`,
					'aibattlefield=Sol Ring;Plains',
					'aiexile=Hill Giant',
					'aigraveyard=',
				].join('\n'),
				reply: pickWanted,
			});
			/** Click Karn for `ability` and answer its target with `target`, until his loyalty reads `after`. */
			const activate = async (karn: number, ability: RegExp, target: { card: number } | { player: number }, after: number): Promise<void> => {
				want = ability;
				const since = s.sent.length;
				let targeted = false;
				s.select(0, karn);
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && s.sent.some((x, i) => i >= since && x.seat === 0 && (x.envelope.frame as { method?: string }).method === 'setSelectables')) {
							targeted = true;
							if ('card' in target) s.select(0, target.card);
							else s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: target.player }, triggerEvent: null } as never);
						}
						return loyalty(s, karn) === after;
					},
					`Karn at ${after} loyalty`,
					30_000,
					s,
				);
			};
			try {
				let karn = await toMain(s, 3);
				await activate(karn, /Target player exiles/, { player: aiId(s) }, 17);
				await waitUntil(() => (s.answerAsks(), names(s, 0, 'Exile', 1).includes('Grizzly Bears')), 'Grizzly Bears exiled from the AI’s hand', 30_000, s);

				karn = await toMain(s, 5);
				const ring = s.zone(0, 'Battlefield', 1).find((c) => c.name === 'Sol Ring');
				if (ring === undefined) throw new Error('no Sol Ring on the AI’s side');
				await activate(karn, /Exile target permanent/, { card: ring.id }, 14);
				await waitUntil(() => (s.answerAsks(), names(s, 0, 'Exile', 1).includes('Sol Ring')), 'Sol Ring exiled', 30_000, s);

				karn = await toMain(s, 7);
				await ultimate(s, karn);

				expect(names(s, 0, 'Battlefield').sort(), 'what Karn exiled, under seat 0').toEqual(['Grizzly Bears', 'Sol Ring']);
				expect(names(s, 0, 'Battlefield', 1)).toEqual([]);
				expect(both(s, 'Exile'), 'the Hill Giant Karn never touched is shuffled in').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
