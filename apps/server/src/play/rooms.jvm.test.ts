/**
 * A Room's doors, as the wire says them — against real Forge.
 *
 * The operator, 2026-10-19: *"cards like 'Walk-In Closet' it's hard to tell whats actually going on.
 * which room was played, which room is active? has the door been unlocked?"* Forge keeps a Room's
 * unlocked doors as a set and shows them as the card's current state (`Card.updateRooms`): neither
 * door is `EmptyRoom`, one door is that door's split state, both are `Original`. The view sends that
 * state as `CurrentState`, beside `Room` and both halves (`CardView.updateState`).
 *
 * Scenario `rooms`: a Room put on the battlefield without being cast has both doors locked; Forge
 * offers its two unlocks as one choice, and the bridge must name each one's door (`PlayBridge.java`'s
 * `faceAbilities`) so the seat can draw the doors to pick. Then alice casts Walk-In Closet from her
 * hand and pays to unlock Forgotten Cellar. At each step both seats' state must say which doors are
 * unlocked.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/rooms \
 *   pnpm exec vitest run apps/server/src/play/rooms.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, keyOf, type WireObj } from './visibility.js';

const title = available.ok
	? 'rooms: which of a Room’s doors are unlocked reaches both seats, against real Forge'
	: `rooms: which of a Room’s doors are unlocked reaches both seats, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Forests', ['40 Forest']), deck('Forests B', ['40 Forest'])];

/** `CardStateName` ordinals (`forge-core/.../card/CardStateName.java`). */
const ORIGINAL = 0;
const LEFT = 5;
const RIGHT = 6;
const EMPTY_ROOM = 9;

function tag(o: WireObj | undefined, k: string): unknown {
	const v = o?.[k] as { v?: unknown } | undefined;
	return v?.v;
}

/** What seat `seat` holds for the room `id`: its Room flag, current state and each state's name. */
function doors(s: Scenario, seat: number, id: number): Record<string, unknown> {
	const state = s.state(seat);
	const view = state.get(keyOf(TYPE.card, id));
	const face = (k: string): string | null => {
		const ord = tag(view, k);
		if (typeof ord !== 'number') return null;
		const name = tag(state.get(keyOf(TYPE.cardState, id * 16 + ord)), 'Name');
		return `${ord}:${typeof name === 'string' ? name : '?'}`;
	};
	const whole = tag(state.get(keyOf(TYPE.cardState, id * 16 + ORIGINAL)), 'Name');
	return { room: tag(view, 'Room'), current: face('CurrentState'), left: face('LeftSplitState'), right: face('RightSplitState'), whole: typeof whole === 'string' ? whole : null };
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'cast Walk-In Closet: its door alone is current on both seats; unlock Forgotten Cellar: both are; a never-cast Room offers each door by name',
		async () => {
			if (!available.ok) return;
			const offers: { label?: string; face?: string }[][] = [];
			const pick = 'Walk-In Closet';
			const s = await startScenario(available.config, {
				seed: 19,
				decks: DECKS,
				scenario: scenarioText('rooms'),
				reply: (f) => {
					if (f.method !== 'getAbilityToPlay') return undefined;
					const offered = f.abilities as { label?: string; face?: string }[];
					offers.push(offered);
					return offered.find((a) => a.face === pick) ?? offered[0] ?? null;
				},
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').length >= 1; }, 'alice’s main phase with the Room in hand', 30_000, s);
				const room = s.zone(0, 'Hand').find((c) => /Walk-In Closet/.test(c.name));
				expect(room, 'the Room is in alice’s hand').toBeDefined();
				const id = room!.id;
				const lockedRoom = s.zone(0, 'Battlefield').find((c) => !c.land);
				expect(lockedRoom, 'a Room on alice’s battlefield').toBeDefined();
				const locked = lockedRoom!.id;
				const start = { hand: doors(s, 0, id), lockedA: doors(s, 0, locked), lockedB: doors(s, 1, locked) };
				console.log(`[rooms.jvm] start ${JSON.stringify(start)}`);
				expect(start.lockedA.current).toMatch(new RegExp(`^${EMPTY_ROOM}:`));
				expect(start.lockedB.current).toMatch(new RegExp(`^${EMPTY_ROOM}:`));

				// The Room that was never cast, first, while both doors are affordable — Forge offers only
				// what can be paid: both unlocks, one offer, each named by its door.
				const before = offers.length;
				const first = landPayer(s, 0);
				s.select(0, locked);
				await waitUntil(() => {
					s.answerAsks();
					first();
					return doors(s, 0, locked).current === `${LEFT}:Walk-In Closet` && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, 'the never-cast Room’s Walk-In Closet to unlock', 40_000, s);
				const picked = { offers: offers.slice(before), a: doors(s, 0, locked), b: doors(s, 1, locked) };
				console.log(`[rooms.jvm] picked ${JSON.stringify(picked)}`);
				expect(picked.offers[0]?.map((a) => a.face)).toEqual(['Walk-In Closet', 'Forgotten Cellar']);
				expect(picked.b.current).toBe(`${LEFT}:Walk-In Closet`);

				const pay = landPayer(s, 0);
				s.select(0, id);
				await waitUntil(() => {
					s.answerAsks();
					pay();
					return s.zone(0, 'Battlefield').some((c) => c.id === id) && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, 'Walk-In Closet to resolve', 40_000, s);
				const cast = { a: doors(s, 0, id), b: doors(s, 1, id) };
				console.log(`[rooms.jvm] cast ${JSON.stringify({ offers: offers.slice(1), ...cast })}`);
				expect(cast.a.room).toBe(true);
				expect(cast.a.current).toBe(`${LEFT}:Walk-In Closet`);
				expect(cast.b.current).toBe(`${LEFT}:Walk-In Closet`);
				expect(cast.a.right).toBe(`${RIGHT}:Forgotten Cellar`);

				const unlock = landPayer(s, 0);
				const mark = s.sent.length;
				s.select(0, id);
				await waitUntil(() => {
					s.answerAsks();
					unlock();
					return doors(s, 0, id).current === `${ORIGINAL}:Walk-In Closet // Forgotten Cellar` && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, 'Forgotten Cellar to unlock', 40_000, s);
				const asked = s.sent
					.slice(mark)
					.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'ask')
					.map((x) => x.envelope.frame.method);
				const both = { a: doors(s, 0, id), b: doors(s, 1, id) };
				console.log(`[rooms.jvm] unlocked ${JSON.stringify({ asked, offers: offers.slice(2), ...both })}`);
				expect(both.b.current).toBe(`${ORIGINAL}:Walk-In Closet // Forgotten Cellar`);

			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});
