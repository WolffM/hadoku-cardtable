/**
 * A game small enough to read in one sitting: first to {@link WIN_SCORE} points. Two seats, no AI,
 * no deck, no clock of its own — the chess clock, seats and watchers are `MatchShell`'s, proven
 * generic by running THIS underneath them instead of Forge. `adapter.ts` is the `GameAdapter` that
 * fits these lines and commands to the shell's seam; this file is only the rules, run through
 * `runtimes/in-process.ts`.
 *
 * Configured with `host.ts`'s own `MatchSpec` — `.deck`/`.clockMs`/`.scenario` and the rest simply
 * go unread — rather than a toy-shaped spec of its own: a match's CONFIG is generic
 * over the engine's line/command vocabulary only, never over `Spec` itself (`MatchHostFactory<L,
 * C>`'s own pinned shape hardcodes `MatchSpec` the same way), so there is nothing a toy `Spec`
 * would buy here. Parking/restoring a toy match from a checkpoint is not yet wired up (an opaque
 * checkpoint is a later step): these rules always start a fresh game at 0–0.
 */

import type { MatchSpec } from '../../host.js';
import type { InProcessEngine } from '../../runtimes/in-process.js';

/** First to this many points wins. Three, so a whole-match test plays it out in a handful of commands. */
export const WIN_SCORE = 3;

/** What a seat may ask the game to do. */
export type ToyCmd =
	/** Score one point for `seat`. */
	| { t: 'score'; seat: 0 | 1 }
	/** `seat` gives up: the other seat wins at once, whatever the score. */
	| { t: 'concede'; seat: 0 | 1 };

/** What the game says, one line at a time — `adapter.ts`'s `classify` reads every one of these. */
export type ToyLine =
	/** The game is set up and ready to take commands. */
	| { t: 'ready' }
	/** `seat` scored; `score` is the running total, seat 0 first. */
	| { t: 'scored'; seat: 0 | 1; score: [number, number] }
	/** The game ended. */
	| { t: 'over'; winner: 0 | 1; conceded: boolean; score: [number, number] }
	/** The score at a point where the game could be restarted from — Forge's `snapshot`, toy-sized. Not yet acted on by anything. */
	| { t: 'checkpoint'; score: [number, number] };

/** A toy match's mid-game save: the running score is the whole state there is. Not yet used. */
export interface ToyCheckpoint {
	score: [number, number];
}

/** What a running toy game hands back: send it a command, or stop it outright. */
export interface ToyRun {
	send(cmd: ToyCmd): void;
	stop(): void;
}

/**
 * Runs a toy match, start to finish, from `spec.seats`' two entries (`ai`/`name`; its `deck` goes
 * unread). `line` is called once synchronously before this returns (`{ t: 'ready' }`), and once
 * more for every {@link ToyCmd} {@link ToyRun.send} is given — never out of order, and never again
 * once the game is over. Matches `runtimes/in-process.ts`'s `InProcessEngine.start` exactly, so
 * {@link toyEngine} is a one-line wrap.
 */
export function playToy(_spec: MatchSpec, line: (l: ToyLine) => void): ToyRun {
	const score: [number, number] = [0, 0];
	let over = false;
	line({ t: 'ready' });
	return {
		send(cmd) {
			if (over) return;
			if (cmd.t === 'concede') {
				const winner = cmd.seat === 0 ? 1 : 0;
				over = true;
				line({ t: 'over', winner, conceded: true, score: [...score] });
				return;
			}
			score[cmd.seat] += 1;
			line({ t: 'scored', seat: cmd.seat, score: [...score] });
			if (score[cmd.seat] >= WIN_SCORE) {
				over = true;
				line({ t: 'over', winner: cmd.seat, conceded: false, score: [...score] });
				return;
			}
			line({ t: 'checkpoint', score: [...score] });
		},
		stop() {
			over = true;
		},
	};
}

/** {@link playToy}, wrapped as `runtimes/in-process.ts`'s `InProcessEngine` — the whole-match test's host. */
export function toyEngine(): InProcessEngine<MatchSpec, ToyLine, ToyCmd> {
	return {
		start: (_matchId, spec, line) => playToy(spec, line),
	};
}
