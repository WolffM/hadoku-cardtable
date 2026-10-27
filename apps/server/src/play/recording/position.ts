/**
 * A seat's position: the folded board it is looking at, and the last thing it
 * was told, over its own raw bridge lines so far. `replay-determinism.jvm.test.ts`
 * proved these two — the recorded log's `board` and `prompt` fields are them —
 * and this is where they moved to, so the recorder and the test share one copy.
 *
 * ## Why a digest, not the board itself
 *
 * The recorded `board` field is a sha-256 of the normalised, default-stripped,
 * sorted fold (`normalisedBoard`) — not the fold itself. A real match's board
 * is a few hundred objects; hashing it keeps every `cmd` line a fixed, small
 * size no matter how big the game gets, and two positions are still "the same"
 * exactly when their digests match (sha-256, not a guess).
 *
 * ## Why `createSeatPosition` exists
 *
 * `boardDigest`/`normalisedBoard` fold a seat's WHOLE history every time they
 * are called — fine for the proof above (a few hundred commands, read once
 * each) but wrong for the recorder: a long human game is thousands of lines,
 * and refolding all of them for every command sent would make the recorder
 * `O(lines²)`. `createSeatPosition` instead keeps one running fold per seat and
 * applies each new line to it, in `O(board size)` rather than `O(lines so
 * far)` — the recorder's own, incremental use of exactly the same rule
 * `boardDigest` proves: {@link foldFrames}'s `setGameView` branch replaces the
 * whole table, so re-presenting the CURRENT fold as a synthetic `setGameView`
 * and folding the new line on top of it is the same fold `boardDigest` would
 * compute over the whole history, without visiting any line twice. This reuses
 * `visibility.ts`'s own exported fold rather than a second copy of it — lane C
 * does not own `visibility.ts` and must not fork its merge rules.
 */

import { createHash } from 'node:crypto';

import type { BridgeLine } from '../host.js';
import { foldFrames, type ObjTable, type StateFrame, type WireObj } from '../visibility.js';

/** The three state-carrying bridge methods a seat's board folds from. */
export const STATE_METHODS: ReadonlySet<string> = new Set(['setGameView', 'applyDelta', 'openView']);

/** Is this line one of the three state-carrying frames (for the given seat, if named)? */
export function isStateLine(line: BridgeLine, seat?: number): boolean {
	return line.t === 'frame' && (seat === undefined || line.seat === seat) && STATE_METHODS.has((line.frame as { method?: string }).method ?? '');
}

/**
 * A property at its default may be sent or omitted depending on how Forge
 * batched the packet (`Mana: []`, `Loyalty: "0"`) — not the game, so it is
 * dropped before anything is compared or hashed. `replay-determinism.jvm.test.ts`'s own finding.
 */
function isDefault(x: unknown): boolean {
	if (typeof x !== 'object' || x === null || !('t' in x)) return false;
	const v = (x as { v?: unknown }).v;
	return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && v.length === 0);
}

/** `state`, with every default-valued property dropped and both levels sorted — a stable string for the same board. */
function normalise(state: ReadonlyMap<string, WireObj>): string {
	const normal = [...state.entries()].map(
		([k, o]) => [k, Object.fromEntries(Object.entries(o).filter(([, x]) => !isDefault(x)).sort(([a], [b]) => a.localeCompare(b)))] as const,
	);
	return JSON.stringify(normal.sort(([a], [b]) => a.localeCompare(b)));
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** The seat's board as a sorted, default-stripped string — for diagnostics (the digest is what is recorded/compared). */
export function normalisedBoard(lines: readonly BridgeLine[], seat: number): string {
	const frames = lines.filter((l): l is BridgeLine & { t: 'frame' } => isStateLine(l, seat)).map((l) => l.frame as StateFrame);
	return normalise(foldFrames(frames));
}

/** The seat's board, folded from scratch over every line so far, as a sha-256. See the module header for why this is a hash. */
export function boardDigest(lines: readonly BridgeLine[], seat: number): string {
	return sha256(normalisedBoard(lines, seat));
}

/** The last `showPromptMessage` text the seat was sent, or `''` before its first. */
export function lastPrompt(lines: readonly BridgeLine[], seat: number): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!;
		if (l.t === 'frame' && l.seat === seat && (l.frame as { method?: string }).method === 'showPromptMessage') {
			return (l.frame as { message: string }).message;
		}
	}
	return '';
}

/** One seat's running position, updated one line at a time. See the module header. */
export interface SeatPosition {
	/** Feed the next line from the bridge. A no-op for a line that is not this seat's, or carries no state/prompt. */
	push(line: BridgeLine): void;
	/** The current board's digest — {@link boardDigest} over every line pushed so far, without refolding them. */
	digest(): string;
	/** The current `lastPrompt`. */
	prompt(): string;
}

/** A synthetic `setGameView` that re-presents `state` whole, so folding it is folding the CURRENT board, not the history. */
function asGameView(state: ReadonlyMap<string, WireObj>): StateFrame {
	const gameView: ObjTable = {};
	for (const [key, obj] of state) gameView[key] = obj;
	return { kind: 'notify', method: 'setGameView', payload: { gameView, sequenceNumber: 0 } } as unknown as StateFrame;
}

export function createSeatPosition(seat: number): SeatPosition {
	let state = new Map<string, WireObj>();
	let prompt = '';
	return {
		push(line) {
			if (line.t !== 'frame' || line.seat !== seat) return;
			const frame = line.frame as { method?: string; message?: string };
			if (frame.method === 'showPromptMessage' && typeof frame.message === 'string') {
				prompt = frame.message;
				return;
			}
			if (!STATE_METHODS.has(frame.method ?? '')) return;
			state = frame.method === 'setGameView' ? foldFrames([line.frame as StateFrame]) : foldFrames([asGameView(state), line.frame as StateFrame]);
		},
		digest: () => sha256(normalise(state)),
		prompt: () => prompt,
	};
}
