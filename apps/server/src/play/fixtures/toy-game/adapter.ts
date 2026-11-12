/**
 * The `GameAdapter` that fits `rules.ts`'s toy game to `play/game-adapter.ts`'s seam — the same
 * seam `ForgeSession`/`ForgeSession`'s own `GameAdapter`-shaped half fits Forge to. Nothing here
 * runs the game (that is `rules.ts`'s `playToy`, through `runtimes/in-process.ts`): this is only
 * the translation `classify`/`session` need to let a `HostedMatch` run it.
 */

import type { ClassifiedLine, GameAdapter, GameSession } from '../../game-adapter.js';
import type { MatchSpec } from '../../host.js';
import { type ToyCheckpoint, type ToyCmd, type ToyLine } from './rules.js';

/** What a seat or a watcher is shown. The toy game's whole vocabulary: a score moved, or a line of text. */
export type ToyFrame =
	| { kind: 'score'; score: [number, number] }
	| { kind: 'notify'; text: string };

export const toyAdapter: GameAdapter<MatchSpec, ToyLine, ToyCmd, ToyFrame, ToyCheckpoint> = {
	// `ai`/`name` only: `deck` (and everything else `MatchSpec.seats` carries for Forge) goes unread.
	seats: (spec) => spec.seats.map((s) => ({ ai: s.ai, name: s.name })),

	classify: (line): ClassifiedLine<ToyCheckpoint> => {
		switch (line.t) {
			case 'ready':
				return { t: 'ready' };
			case 'scored':
				// Addressed to no seat in particular — both read the same running score — but `seat`
				// still names who scored, for the host's own log.
				return { t: 'seat', seat: line.seat, raw: line };
			case 'checkpoint':
				return { t: 'checkpoint', cp: { score: line.score } };
			case 'over': {
				const loser = line.winner === 0 ? 1 : 0;
				return { t: 'over', winners: [line.winner], losers: [loser], drawn: false };
			}
		}
	},

	session: (out): GameSession<ToyLine, ToyCmd> => ({
		onLine(line) {
			// The shell keeps 'ready'/'over'/'checkpoint' for itself (see `classify`, above); only
			// 'scored' is ever handed to a session, but the full union is what the interface promises.
			if (line.t !== 'scored') return;
			const frame: ToyFrame = { kind: 'score', score: line.score };
			out.toSeat(0, frame);
			out.toSeat(1, frame);
			out.toWatchers(frame);
		},
		command: (c) => out.command(c),
		// Either seat may score at any moment: there is no turn to wait on, so both seats' chess
		// clocks run the whole game through, like a race's.
		waitedOn: () => true,
		// The toy game carries no identity of its own — the shell's own roster (seat holders, the
		// clock) goes out through its own channel regardless of what this does.
		tellRoster: () => {},
		// No turn structure: nothing here is "the Nth turn" of anything.
		turn: () => null,
		activeSeat: () => null,
		// No ask is ever open.
		openAsks: () => 0,
		// No ask to close on a replay: implemented anyway, to prove the hook fits a game with none.
		replayed: () => {},
		// Nothing per-seat to sweep at the end: implemented anyway, for the same reason.
		ended: () => {},
	}),

	// Parking/restoring a toy match from a checkpoint is not yet wired up (`rules.ts`'s header);
	// these rules always start fresh, so there is nothing yet for a restored spec to carry.
	restoreSpec: (spec) => spec,
	// `GameAdapter.concede`'s `seat` is a plain `number` (any game's shell may have more than two
	// seats); `seats()` above always answers exactly two, so the shell never calls this with
	// anything but 0 or 1.
	concede: (seat) => ({ t: 'concede', seat: seat as 0 | 1 }),
	notice: (text) => ({ kind: 'notify', text }),
};
