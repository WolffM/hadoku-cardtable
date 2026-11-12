/**
 * `HostedMatch`: the shell lifecycle ({@link MatchShell}) plus the host lifecycle every engine
 * needs the same way — start, resume-after-a-restart, the replay gag's `replayed` hook, and the
 * sweep at stop/fail/exit (`GameSession.ended`). Nothing here is Forge-specific:
 * `play/match.ts`'s `Match` is `HostedMatch<BridgeLine, BridgeCommand>` with a `ForgeSession`;
 * `fixtures/toy-game/match.ts`'s `ToyMatch` is `HostedMatch<ToyLine, ToyCmd>` with the toy's;
 * `runtimes/relay-match.ts`'s `RelayMatch` is `HostedMatch<RelayLine, RelayCommand>` with a
 * `RelaySession`. What stays abstract here (`seats`, `onLine`, `concedeCommand`, `forceConcede`)
 * is exactly what only the game itself can answer.
 *
 * Moved out of `play/match.ts` (a pure move — no behaviour changed, every importer
 * rewritten, no shim): `match.ts` keeps `Match`, Forge's own `HostedMatch`.
 */

import type { HostEvents, MatchHost, MatchHostFactory, MatchSpec, TurnSnapshot } from '../host.js';
import type { StartEvents } from '../start-queue.js';
import { MatchShell, type ShellDeps } from './shell.js';

/** What any `HostedMatch` needs beyond {@link ShellDeps}: a factory for the host its own engine runs on. */
export interface HostedMatchDeps<Line extends { t: string }, Cmd extends { t: string }> extends ShellDeps {
	host: MatchHostFactory<Line, Cmd>;
	/**
	 * `GameAdapter.restoreSpec`, generically: a match restored from a checkpoint
	 * (`restore.checkpoint`, below) opens on it rather than fresh. Absent: a restore with a
	 * checkpoint keeps the spec it was given. Forge's own is `match/registry.ts`'s `restoredSpec`,
	 * wired in once by `createMatchRegistry` (never caller-settable — `RegistryDeps` omits this
	 * field). Forge's checkpoint IS its `TurnSnapshot`, the same value `latestSnapshot`/
	 * `MatchRecord.snapshot` already carry, so `match/registry.ts`'s `create`/`restore` pass it
	 * through as `restore.checkpoint` and let this constructor transform the spec, rather than
	 * calling `restoredSpec` themselves before `new Match(...)` — one path, not two.
	 */
	restoreSpec?(spec: MatchSpec, cp: unknown): MatchSpec;
}

export abstract class HostedMatch<Line extends { t: string }, Cmd extends { t: string }> extends MatchShell<Line, Cmd> {
	declare protected readonly deps: HostedMatchDeps<Line, Cmd>;

	/**
	 * `spec` is transformed through {@link HostedMatchDeps.restoreSpec} right here, before
	 * `MatchShell`'s own constructor ever sees it, when this match is being restored from a
	 * checkpoint. `Match`'s own restore carries one too now — `match/registry.ts`'s `create`/
	 * `restore` pass its `TurnSnapshot` through as `restore.checkpoint`, and `createMatchRegistry`
	 * wires `restoredSpec` in as `deps.restoreSpec` — so Forge resumes through the exact same hook
	 * the toy game does. A subclass with no checkpoint, or no `restoreSpec` of its own, passes
	 * `spec` through unchanged, exactly as before this constructor existed.
	 */
	constructor(
		id: string,
		spec: MatchSpec,
		deps: HostedMatchDeps<Line, Cmd>,
		restore?: { epoch: string | null; startedAt: number; snapshot?: TurnSnapshot | null; checkpoint?: unknown; clockMs?: [number, number] },
	) {
		super(id, restore?.checkpoint !== undefined && deps.restoreSpec !== undefined ? deps.restoreSpec(spec, restore.checkpoint) : spec, deps, restore);
	}

	/**
	 * The newest `{ t: 'checkpoint' }` line any `onLine` override classified, kept exactly like
	 * Forge's own `latestSnapshot` (parking and restore both go through it, via
	 * {@link MatchShell.remember} and this constructor's own `restoreSpec` call above). A game
	 * whose engine produces one calls this from its own `onLine`'s `'checkpoint'` case —
	 * `fixtures/toy-game/match.ts`'s `ToyMatch` first, then `play/match.ts`'s `Match` on Forge's
	 * own `'snapshot'` line.
	 */
	protected noteCheckpoint(cp: unknown): void {
		this.latestCheckpoint = cp;
		this.remember();
	}

	/**
	 * Start the host. Separate from the constructor so nothing can emit before the match is
	 * registered. A host that throws fails the match here, so a start never leaves one
	 * `starting` for good and never escapes the route as an exception.
	 */
	start(): void {
		if (this.host !== null) return;
		try {
			this.host = this.deps.host(this.id, this.spec, this.hostEvents());
		} catch (err) {
			this.refuseStart(err as Error);
			return;
		}
		this.remember();
	}

	/**
	 * Take over a host that is already playing this match, left running by a server that has
	 * exited (Wave 22 §E). `attach` replays that server's whole line stream into `onLine` before
	 * it returns, so by the time this call is done every seat holds the history, cursor and open
	 * asks it held — same epoch, same owners — and a client resyncs rather than starting over.
	 *
	 * Separate from `start` for the same reason `start` is separate from the constructor: nothing
	 * may emit before the match is in the registry.
	 */
	resume(attach: (events: HostEvents<Line, Cmd>) => MatchHost<Cmd>): void {
		if (this.host !== null) return;
		this.replaying = true;
		try {
			this.host = attach(this.hostEvents());
		} finally {
			this.replaying = false;
		}
		this.syncClock();
		this.remember();
		this.deps.log({
			evt: 'match-resumed',
			matchId: this.id,
			status: this.status,
			epoch: this.epoch,
			seats: this.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, asks: this.game.openAsks(s.seat) })),
		});
		this.armRejoinGrace();
	}

	protected hostEvents(): StartEvents<Line, Cmd> {
		return {
			line: (line) => this.onLine(line),
			exit: (reason) => this.onExit(reason),
			log: (entry) => this.deps.log(entry),
			replayed: (command) => this.game.replayed(command),
			queued: (place) => {
				this.queuePlace = place;
			},
			booting: () => {
				this.queuePlace = null;
				for (const arm of this.bootWaiters.splice(0)) arm();
			},
			unstartable: (err) => this.refuseStart(err),
		};
	}

	/** Stop on purpose. The host's exit that follows is then not a failure. */
	stop(): void {
		if (this.status !== 'starting' && this.status !== 'running' && this.status !== 'over') return;
		this.status = 'stopped';
		this.stopClock();
		this.closeRestartAsk();
		this.game.ended(null);
		for (const done of this.runningWaiters.splice(0)) done({ ok: false, error: 'stopped' });
		this.host?.stop();
		this.tellEnded();
	}

	/**
	 * `frames`: where the engine threw (Forge's bridge `fatal` line) — the log row names the
	 * iteration a bare message cannot.
	 */
	fail(reason: string, frames?: string[]): void {
		if (this.status === 'failed' || this.status === 'stopped') return;
		this.status = 'failed';
		this.failure = reason;
		this.stopClock();
		this.deps.log({ evt: 'match-failed', matchId: this.id, reason, ...(frames === undefined ? {} : { frames }) });
		this.game.ended(reason);
		for (const done of this.runningWaiters.splice(0)) done({ ok: false, error: reason });
		this.host?.stop();
		this.tellEnded();
	}

	private onExit(reason: string): void {
		if (this.overTimer !== null) clearTimeout(this.overTimer);
		this.stopClock();
		const dying = this.status === 'starting' || this.status === 'running';
		// A game that already ended naturally (`status === 'over'`) is not told "cannot continue" —
		// its seats already have their result; `ended(null)` still sweeps asks/probes/frames.
		this.game.ended(dying ? reason : null);
		if (dying) {
			this.fail(reason);
			return;
		}
		if (this.status !== 'over') return;
		this.status = 'stopped';
		this.tellEnded();
	}
}
