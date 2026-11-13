/**
 * One channel's state history — what {@link Match.snapshot} and {@link Match.watcherSnapshot} send
 * a page that joins, reconnects or resyncs — and the board those frames fold to.
 *
 * ## Why it is compacted
 *
 * A page folds a snapshot's frames into one board and keeps none of them
 * (`games/magic/ui/src/play/live/match.ts`'s `adoptSnapshot` → `foldFrames`): what it reads is where the
 * sequence ends, never the sequence. Kept whole, the history was every state frame of the game —
 * 2.08 MB at the end of a 26-minute game, sent again on every join, reconnect and resync, for a
 * board that is 167 KB folded. So at the start of each turn ({@link StateHistory.push}) the history
 * is replaced by what a page holds once it has folded it ({@link StateHistory.compact}), and grows
 * from there: a page is sent this turn's base and this turn's frames, and the server keeps no more.
 *
 * ## What the base carries: everything the page's fold keeps
 *
 * - **The `openView`**, first, as it was: the page checks the players it names.
 * - **One `setGameView`**: the folded board (`visibility.ts`'s {@link foldFrame}, the page's own
 *   rules), the sequence number of the last state frame (the page's `forgeSeq`), and every state
 *   fact the bridge sends beside a packet (`StateSiblings`: `stackTargetSpells`, `pendingTriggers`,
 *   … — `games/magic/ui/src/play/fold.ts`'s `FoldResult`) at its current value. A fact is current from
 *   the last frame that named it since the last `setGameView`, which resets them all: the page
 *   folds them the same way. One the stream has not named since is left out, and the page's
 *   default is the empty value a frame naming it as empty would give.
 * - **The deaths and the countered stack items so far**, in one `applyDelta` with an empty packet.
 *   A page notes every `deaths` and `counteredStackItems` in a snapshot, history or not, keeping the
 *   most recent of each (`noteDeaths`, `noteCountered`); the base `setGameView` does not carry them. They are
 *   kept here in the order the page keeps them (a death moves its card to the end; a counter does
 *   not move one already noted) and left to the page to trim, so the base gives every page — a fresh
 *   one, or a mounted board that still holds older ones — what the whole history would have. (The
 *   page trims its counters by insertion, which only a stack item countered twice could tell apart
 *   from this; a stack item's id leaves the stack once.)
 *   Damage is not carried: a snapshot's damage is "not news", and the page draws none of it.
 * - **The frames that are not state** (the watcher's `finishGame` and match-ended notice), after the
 *   base, in their order. A page's fold passes over them.
 *
 * An object every property of which was deleted (`visibility.ts`'s `wipeFace` empties a face that
 * way) is still an object the page holds: later deltas fold into it. A table entry must carry a
 * property (forge-wire's `TrackedObjectSchema`, which the page's `MatchSnapshotSchema` applies), so
 * it goes into the base as `wipeFace` sends it: one `null` property, which every fold drops.
 */

import {
	DELTA_TYPE,
	deltaKey,
	intOf,
	StateSiblingsSchema,
	type DeathCause,
	type ServerFrame,
	type StateSiblings,
} from '@hadoku/forge-wire';

import { foldFrame, type ObjTable, type StateFrame, type WireObj } from './visibility.js';

/** The state facts beside a packet, by name: the bridge's `StateSiblings`, each replaced when a frame names it. */
const SIBLINGS = Object.keys(StateSiblingsSchema.shape) as (keyof StateSiblings)[];

const GAME_KEY = deltaKey(DELTA_TYPE.game, 1);

export interface StateHistory {
	/**
	 * Keep one frame the channel was sent, and fold it into {@link StateHistory.board}. A state frame
	 * that starts a new turn compacts the history once it is folded.
	 */
	push(frame: ServerFrame): void;
	/** Replace the history with its base: the frames a page folds to exactly what the whole history gives it. */
	compact(): void;
	/** The frames a snapshot carries, as a new array: the base, then every frame kept since. */
	frames(): ServerFrame[];
	/** How many frames a snapshot would carry; 0 before the first. */
	readonly length: number;
	/** The board the frames fold to. It moves on with the next frame, so read it at once. */
	readonly board: ReadonlyMap<string, WireObj>;
}

export function createStateHistory(): StateHistory {
	let frames: ServerFrame[] = [];
	const board = new Map<string, WireObj>();
	let openView: ServerFrame | null = null;
	/** The page's state facts since the last `setGameView`, each as the last frame that named it sent it. */
	let siblings: StateSiblings = {};
	/** The last state frame's sequence number; null until a `setGameView` gives the board a baseline. */
	let seq: number | null = null;
	/** Every death so far, each card once, in the order the page keeps them. */
	const deaths = new Map<number, DeathCause>();
	/** Every countered stack item so far, in the order the page keeps them. */
	const countered = new Set<number>();
	/** The turn the history was last compacted in, or first given a baseline in. */
	let turn: number | null = null;

	const named = (payload: StateSiblings): StateSiblings => {
		const out: Record<string, unknown> = {};
		for (const key of SIBLINGS) if (payload[key] !== undefined) out[key] = payload[key];
		return out as StateSiblings;
	};

	const history: StateHistory = {
		push(frame) {
			frames.push(frame);
			const state = frame as unknown as StateFrame;
			if (state.method === 'openView') {
				openView = frame;
				return;
			}
			if (state.method !== 'setGameView' && state.method !== 'applyDelta') return;
			// Both state frames carry what happened since the last one: a `setGameView` mid-game does too.
			const { deaths: died, counteredStackItems } = state.payload;
			for (const [cardId, cause] of died ?? []) {
				deaths.delete(cardId);
				deaths.set(cardId, cause);
			}
			for (const id of counteredStackItems ?? []) countered.add(id);
			if (state.method === 'setGameView') {
				siblings = named(state.payload);
				seq = state.payload.sequenceNumber;
			} else {
				siblings = { ...siblings, ...named(state.payload) };
				if (seq !== null) seq = state.payload.packet.seq;
			}
			foldFrame(board, state);
			if (seq === null) return;
			const now = intOf(board.get(GAME_KEY), 'Turn') ?? 0;
			if (turn !== null && now !== turn) history.compact();
			turn = now;
		},
		compact() {
			if (seq === null) return;
			const gameView: ObjTable = {};
			for (const [key, obj] of board) gameView[key] = Object.keys(obj).length > 2 ? obj : { ...obj, Name: null };
			const base = { kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: seq, ...siblings } } as unknown as ServerFrame;
			const recent =
				deaths.size === 0 && countered.size === 0
					? []
					: [
							{
								kind: 'notify',
								method: 'applyDelta',
								payload: {
									packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] },
									...(deaths.size === 0 ? {} : { deaths: [...deaths] }),
									...(countered.size === 0 ? {} : { counteredStackItems: [...countered] }),
								},
							} as unknown as ServerFrame,
						];
			const rest = frames.filter((f) => f.method !== 'openView' && f.method !== 'setGameView' && f.method !== 'applyDelta');
			frames = [...(openView === null ? [] : [openView]), base, ...recent, ...rest];
		},
		frames: () => [...frames],
		get length() {
			return frames.length;
		},
		board,
	};
	return history;
}
