/**
 * The chess clock: each seat's time left for a whole series (`MATCH_CLOCK_MS`,
 * `@hadoku/shared`), spent only while the game is waiting on that seat.
 *
 * Pure arithmetic over the times it is handed — no timers and no wall clock of
 * its own — so `match.ts` decides WHEN a seat is being waited on (its
 * `waitingOnFor`, the fact the other seat's banner already reads) and this file
 * only adds up how long. Both seats can run at once: a mulligan is decided on
 * both sides together.
 *
 * What it does not see is what it does not charge: a window the server
 * auto-passes never reaches the seat as a live bar, so it never starts the
 * seat's clock, and sideboarding happens between two matches, while no clock
 * exists. The next game's clock starts from what the last one left.
 */

export type Pair<T> = [T, T];

/** One seat's clock as a screen draws it: `ms` left as of the moment it was read, and whether it is running. */
export interface ClockReading {
	ms: number;
	running: boolean;
}

export class ChessClock {
	readonly #left: Pair<number>;
	/** When each running seat last started (or was last read), null while it is stopped. */
	readonly #since: Pair<number | null> = [null, null];

	constructor(left: readonly [number, number]) {
		this.#left = [Math.max(0, left[0]), Math.max(0, left[1])];
	}

	/** Charge every running seat up to `now`. */
	#settle(now: number): void {
		for (const seat of [0, 1] as const) {
			const since = this.#since[seat];
			if (since === null) continue;
			this.#left[seat] = Math.max(0, this.#left[seat] - Math.max(0, now - since));
			this.#since[seat] = now;
		}
	}

	/** Which seats the game is waiting on from `now`. True when that changed which seats run. */
	set(running: readonly [boolean, boolean], now: number): boolean {
		this.#settle(now);
		let moved = false;
		for (const seat of [0, 1] as const) {
			const on = running[seat] && this.#left[seat] > 0;
			if (on === (this.#since[seat] !== null)) continue;
			this.#since[seat] = on ? now : null;
			moved = true;
		}
		return moved;
	}

	/** Stop both seats: the game is over, or the server is letting go of it. */
	stop(now: number): void {
		this.set([false, false], now);
	}

	/** Each seat's time left at `now`. */
	left(now: number): Pair<number> {
		this.#settle(now);
		return [this.#left[0], this.#left[1]];
	}

	reading(now: number): Pair<ClockReading> {
		const left = this.left(now);
		return [
			{ ms: left[0], running: this.#since[0] !== null },
			{ ms: left[1], running: this.#since[1] !== null },
		];
	}

	/** The running seat whose time runs out first, and in how long from `now`; null while no seat runs. */
	nextFlag(now: number): { seat: 0 | 1; inMs: number } | null {
		const left = this.left(now);
		let next: { seat: 0 | 1; inMs: number } | null = null;
		for (const seat of [0, 1] as const) {
			if (this.#since[seat] === null) continue;
			if (next === null || left[seat] < next.inMs) next = { seat, inMs: left[seat] };
		}
		return next;
	}

	/** A seat that ran out of time: running, with nothing left. */
	flagged(now: number): 0 | 1 | null {
		const left = this.left(now);
		if (this.#since[0] !== null && left[0] === 0) return 0;
		return this.#since[1] !== null && left[1] === 0 ? 1 : null;
	}
}
