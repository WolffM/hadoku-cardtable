/**
 * `HostedMatch<ToyLine, ToyCmd>` with `toyAdapter` wired in — the composing class the whole-match
 * test (`whole-match.test.ts`) drives, proving `HostedMatch` + the in-process runtime play a
 * non-Forge game to an end exactly the way `Match` (`play/match.ts`) plays Forge's.
 * `park-restore.test.ts` drives the same class through a checkpoint instead: parking and
 * restarting a non-Forge game, generically, the way `parked.ts` parks Forge's.
 */

import { type ParticipantId } from '@wolffm/rooms-protocol';

import type { MatchSpec } from '../../host.js';
import { HostedMatch, type HostedMatchDeps } from '../../match/hosted.js';
import type { ShellSeat } from '../../match/shell.js';
import { toyAdapter, type ToyFrame } from './adapter.js';
import type { ToyCmd, ToyLine } from './rules.js';

export interface ToyMatchDeps extends HostedMatchDeps<ToyLine, ToyCmd> {
	emit(seat: number, frame: ToyFrame): void;
	emitWatchers?(frame: ToyFrame): void;
	/** {@link Match.deps.overGraceMs}'s toy-sized twin: how long a finished match keeps its host before stopping. Absent is at once. */
	overGraceMs?: number;
}

export class ToyMatch extends HostedMatch<ToyLine, ToyCmd> {
	readonly seats: ShellSeat[];
	/** Set once the game ends ({@link GameAdapter.classify}'s `'over'`): the seats this game names a winner, a loser, or neither. */
	winners: number[] | null = null;
	losers: number[] | null = null;
	drawn: boolean | null = null;
	/** When the game ended; null until then. */
	endedAt: number | null = null;
	declare protected readonly deps: ToyMatchDeps;

	constructor(
		id: string,
		spec: MatchSpec,
		deps: ToyMatchDeps,
		restore?: { epoch: string | null; owners: (string | null)[]; startedAt: number; checkpoint?: unknown; clockMs?: [number, number] },
	) {
		super(id, spec, deps, restore);
		this.seats = toyAdapter.seats(spec).map((s, seat) => ({ seat, ai: s.ai, owner: null, playerId: seat, departure: null, here: false, away: false }));
		for (const [seat, owner] of (restore?.owners ?? []).entries()) {
			const s = this.seats[seat];
			if (s !== undefined && owner !== null) s.owner = owner as ParticipantId;
		}
		this.game = toyAdapter.session({
			toSeat: (seat, frame) => deps.emit(seat, frame),
			toWatchers: (frame) => deps.emitWatchers?.(frame),
			command: (cmd) => this.host?.send(cmd),
		});
	}

	/** Send the toy game a command directly: there is no client-wire layer for this toy, only `HostedMatch`'s own seam. */
	act(cmd: ToyCmd): void {
		this.game.command(cmd);
	}

	protected onLine(line: ToyLine): void {
		const c = toyAdapter.classify(line);
		switch (c.t) {
			case 'ready':
				// The toy game has no per-seat "deal" to wait on (Forge's own `openView`, one per
				// human seat) — the engine's one `ready` is the whole signal that it has a game.
				if (this.status === 'starting') {
					this.status = 'running';
					for (const done of this.runningWaiters.splice(0)) done({ ok: true });
					this.armRejoinGrace();
				}
				return;
			case 'seat':
				this.game.onLine(line);
				return;
			case 'checkpoint':
				// Hoisted into `HostedMatch.noteCheckpoint`: this toy never actually parks to
				// disk (`ParkedStore` is Forge's), but a restart that builds a fresh `ToyMatch` with
				// this as its `restore.checkpoint` — and `deps.restoreSpec: toyAdapter.restoreSpec` —
				// resumes from it, through `HostedMatch`'s own constructor.
				this.noteCheckpoint(c.cp);
				return;
			case 'fatal':
				this.fail(c.why);
				return;
			case 'over':
				this.applyOver(c);
				return;
			case 'info':
				return;
		}
	}

	/** The generic half of a game's natural end — `classify`'s `'over'` shape applied directly, with no engine-specific name mapping to do. */
	private applyOver(outcome: { winners: number[]; losers: number[]; drawn: boolean }): void {
		if (this.status !== 'running') return;
		this.status = 'over';
		this.winners = outcome.winners;
		this.losers = outcome.losers;
		this.drawn = outcome.drawn;
		this.endedAt = this.now();
		this.syncClock();
		this.game.tellRoster();
		this.overTimer = setTimeout(() => this.host?.stop(), this.deps.overGraceMs ?? 0);
		this.overTimer.unref();
	}

	protected concedeCommand(seat: number): ToyCmd {
		return toyAdapter.concede(seat);
	}

	/** {@link MatchShell.forceConcede}: the generic ending, `seat` the loser — no literal line to fabricate, unlike Forge's. */
	protected forceConcede(seat: number): void {
		const other = seat === 0 ? 1 : 0;
		this.applyOver({ winners: [other], losers: [seat], drawn: false });
	}
}
