/**
 * A restart (or a failover) restores the match from its turn's snapshot on a new game, where Forge gives
 * every card a new id (`restore.jvm.test.ts` measures it). What a seat was shown in a hidden zone is the
 * seat projector's memory (`visibility.ts`, "What a seat was shown, it keeps"), and the restored match
 * starts with new projectors. The operator, 2026-11-11: *"restart turn removes information like revealed
 * cards."* Here the registry's restore is driven over replayed bridge lines: seat 0 is shown a card in
 * seat 1's hand during turn 3, the turn restarts, and the restored game holds the same hand under new ids.
 */
import { describe, expect, it } from 'vitest';
import { DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';
import type { ServerEnvelope } from '@hadoku/shared';

import type { BridgeLine } from './bridge-protocol.js';
import { loadTranscript, replayFactory, type ReplayHost } from './fixtures/transcript.js';
import { createMatchRegistry } from './match.js';
import type { Restored } from './match/registry.js';
import { foldFrames, type StateFrame, type WireObj } from './visibility.js';

const ALICE = 'fk:aaaaaaaaaaaaaaaa';
const BOB = 'fk:bbbbbbbbbbbbbbbb';
const SEATS = [
	{ name: 'Seat 1', ai: false, deck: null },
	{ name: 'Seat 2', ai: false, deck: null },
] as const;
const READY = loadTranscript()[0] as BridgeLine;
const NAMES = ['Goblin Guide', 'Lightning Bolt', 'Mountain', 'Shock', 'Grizzly Bears'];

const int = (v: number) => ({ t: 'int', v });
const list = (ids: readonly number[]) => ({ t: 'list', v: ids.map(int) });

/**
 * One game's state as Forge sends it: turn 3, seat 1's hand the first two names and its library the
 * rest, seat 0's library one card. `base` is where this game's card ids start.
 */
function game(base: number, look: Record<number, number[]> = {}): Record<string, WireObj> {
	const id = (i: number) => base + i;
	const card = (i: number, owner: number): WireObj => ({
		_type: DELTA_TYPE.card,
		_id: id(i),
		Owner: int(owner),
		Controller: int(owner),
		Name: { t: 'str', v: NAMES[i] },
		...(look[i] === undefined ? {} : { PlayerMayLook: list(look[i]) }),
	});
	const player = (p: number, hand: number[], library: number[]): WireObj => ({
		_type: DELTA_TYPE.player,
		_id: p,
		Hand: list(hand.map(id)),
		Library: list(library.map(id)),
		Graveyard: list([]),
		Battlefield: list([]),
		Exile: list([]),
	});
	const objs: WireObj[] = [
		{ _type: DELTA_TYPE.game, _id: 1, Players: list([0, 1]), Turn: int(3), PlayerTurn: int(0), Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: 'UPKEEP' } },
		player(0, [], [4]),
		player(1, [0, 1], [2, 3]),
		card(0, 1),
		card(1, 1),
		card(2, 1),
		card(3, 1),
		card(4, 0),
	];
	return Object.fromEntries(objs.map((o) => [deltaKey(o._type, o._id), o]));
}

let seq = 0;
const view = (seat: number, gameView: Record<string, WireObj>): BridgeLine =>
	({ t: 'frame', seat, frame: { kind: 'notify', method: 'setGameView', payload: { sequenceNumber: ++seq, gameView } } }) as unknown as BridgeLine;
const open = (seat: number): BridgeLine => ({ t: 'frame', seat, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [seat] } } }) as unknown as BridgeLine;

/** The game's opening, both seats: the views, then each seat's own player. */
function opening(host: ReplayHost, base: number): void {
	host.push(READY, view(0, game(base)), view(1, game(base)), open(0), open(1), view(0, game(base)), view(1, game(base)));
}

/** Seat 0's client state from the frames it was sent on `epoch`. */
function clientState(sent: readonly { seat: number; envelope: ServerEnvelope }[], seat: number, epoch: string): Map<string, WireObj> {
	const frames = sent
		.filter((s) => s.seat === seat && s.envelope.cursor.epoch === epoch)
		.map((s) => s.envelope.frame as unknown as StateFrame)
		.filter((f) => f.kind === 'notify' && (f.method === 'setGameView' || f.method === 'applyDelta'));
	return foldFrames(frames);
}

const nameOf = (state: ReadonlyMap<string, WireObj>, id: number): unknown => (state.get(deltaKey(DELTA_TYPE.card, id))?.Name as { v?: unknown } | undefined)?.v;

describe('a turn restarted from its snapshot', () => {
	it("keeps what each seat was shown in another's hand, under the restored game's ids, and nothing more", () => {
		const { factory, hosts } = replayFactory();
		const sent: { seat: number; envelope: ServerEnvelope }[] = [];
		const registry = createMatchRegistry({ host: factory, log: () => undefined, overGraceMs: 60_000, emit: (_m, seat, envelope) => sent.push({ seat, envelope }) });
		const match = registry.create({ seats: [{ ...SEATS[0] }, { ...SEATS[1] }], seed: 7 });
		match.claim(ALICE);
		match.claim(BOB);
		const first = hosts[0] as ReplayHost;
		opening(first, 100);
		first.push({ t: 'snapshot', turn: 3, state: 'turn=3\nactiveplayer=p0\nactivephase=UNTAP\nactivephaseadvance=UPKEEP\n', ms: 2 } as BridgeLine);
		// Turn 3: Forge lets seat 0 look at seat 1's Goblin Guide (a Thoughtseize), then takes the look back.
		first.push(view(0, game(100, { 0: [0] })), view(0, game(100)));
		expect(nameOf(clientState(sent, 0, match.epoch), 100), 'shown before the restart').toBe('Goblin Guide');

		const restored = (registry.restore(match.id) as Restored).match;
		opening(hosts[1] as ReplayHost, 500);
		const after = clientState(sent, 0, restored.epoch);
		expect(nameOf(after, 500), 'the Goblin Guide seat 0 was shown, under its new id').toBe('Goblin Guide');
		expect(nameOf(after, 501), 'the card it was never shown').toBeUndefined();
		expect(nameOf(after, 502), 'seat 1 library').toBeUndefined();
	});
});
