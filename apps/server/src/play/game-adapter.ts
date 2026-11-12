/**
 * What a game supplies to the match host: the Forge-specific half of a match, generalised to a
 * shape any engine's own bridge protocol can satisfy. `play/match.ts`'s `Match` is a
 * `MatchShell` (`play/match/shell.ts`) running a Forge {@link GameSession}
 * (`play/match/forge-session.ts`); {@link GameAdapter} is the rest of that seam, and today has one
 * caller, a toy adapter in `game-adapter.test.ts` that proves a non-Forge game's lines fit it.
 *
 * Four type parameters, one per thing a game owns the shape of, plus a fifth for what a
 * mid-game save looks like:
 *  - `Spec`   — how a match is configured (Forge's `MatchSpec`).
 *  - `Line`   — what the engine's bridge sends up, one line at a time (Forge's `BridgeLine`).
 *  - `Cmd`    — what the host sends down to the engine (Forge's `BridgeCommand`).
 *  - `Frame`  — what a seat or a watcher is shown (Forge's `ServerFrame`).
 *  - `Checkpoint` — an opaque mid-game save a match can be restored from (Forge's
 *    `TurnSnapshot`). Nothing calls this generically yet, so it defaults to `unknown`.
 */
export interface GameAdapter<Spec, Line, Cmd, Frame, Checkpoint = unknown> {
	/**
	 * The seats a spec wants, in order. `class Match`'s constructor reads exactly this off
	 * `spec.seats`: `ai`, and the `name`/`displayName` pair
	 * `SeatSpecWithIdentity` widens Forge's `SeatSpec` with.
	 */
	seats(spec: Spec): { ai: boolean; name: string }[];

	/**
	 * What one line from the engine's bridge means, generically. `Match.onLine`
	 * is this switch for Forge today — its cases collapse onto this union
	 * one for one:
	 *  - `'ready'`      ← Forge's `'ready'`: the bridge has a game; record each seat's deck.
	 *  - `'seat'`       ← Forge's `'frame'`: a line addressed to one seat's game, forwarded
	 *    to {@link GameSession.onLine}.
	 *  - `'over'`       ← Forge's `'gameover'`: the game ended. `winners`/`losers` name SEATS, not
	 *    the engine's own ids (Forge's `winner`/`losers` read back through each seat's player id,
	 *    `play/match/outcome.ts`'s `winnerSeatFromLosers`); `drawn` is true when the rules named no
	 *    winner at all. A seat in neither array was simply not placed.
	 *  - `'checkpoint'` ← Forge's `'snapshot'`: a mid-game save, kept as `latestSnapshot`
	 *    for a later restart (`MatchRegistry.restore`).
	 *  - `'fatal'`      ← Forge's `'fatal'`: the bridge or the JVM died; `Match.fail`
	 *    follows.
	 *  - `'info'`       ← everything else Forge logs but a shell need not act on itself
	 *    (`'resent'`, `'input'`, `'probe'`, `'log'`, `'dropped'`, `'scan-overtaken'`,
	 *    `'impersonated'`, `'rejected'`, `'stale'`, `'pace'`, `'unsupported'`).
	 */
	classify(line: Line): ClassifiedLine<Checkpoint>;

	/**
	 * Builds this match's engine session: the half of `class Match` that actually talks to the
	 * engine, handed the three ways a shell may be told something (`out`). Forge has no single
	 * method shaped like this today — it is the generalisation of three separate sinks:
	 * `Match.command` (the `Cmd` sink: `out.command`), `Match.send`/`Match.emit`
	 * (the per-seat `Frame` sink: `out.toSeat`), and
	 * `Match.tellWatchers`/`Match.sendWatcher` (the watcher `Frame` sink:
	 * `out.toWatchers`). Forge's real session, `ForgeSession`, is built by `Match` itself and reaches
	 * those sinks directly; nothing builds one through here yet.
	 */
	session(out: { toSeat(seat: number, f: Frame): void; toWatchers(f: Frame): void; command(c: Cmd): void }): GameSession<Line, Cmd>;

	/**
	 * A spec that resumes from a checkpoint rather than starting fresh — Forge's own
	 * `restoredSpec` (`play/match/registry.ts`): drop
	 * the chooser, open on the checkpoint's state, skip the opening hand.
	 */
	restoreSpec(spec: Spec, cp: Checkpoint): Spec;

	/**
	 * The command that ends this seat's game as a loss — Forge's
	 * `{ t: 'act', seat, frame: { kind: 'act', method: 'concede' } }`, repeated until the engine answers it.
	 */
	concede(seat: number): Cmd;

	/**
	 * A frame that tells a seat something in words, with no game state behind it — Forge's
	 * `endNotice` (`showErrorDialog`, `MATCH_ENDED_TITLE`).
	 */
	notice(text: string): Frame;
}

/** What {@link GameAdapter.classify} reads one engine line as. */
export type ClassifiedLine<Checkpoint> =
	| { t: 'ready' }
	| { t: 'seat'; seat: number; raw: unknown }
	| { t: 'over'; winners: number[]; losers: number[]; drawn: boolean }
	| { t: 'checkpoint'; cp: Checkpoint }
	| { t: 'fatal'; why: string }
	| { t: 'info' };

/**
 * What the platform shell (`play/match/shell.ts`'s `MatchShell`) asks of the game it runs:
 * Forge's is `play/match/forge-session.ts`'s `ForgeSession`. The shell owns the match's lifecycle,
 * its seats' holders, its clock and its restart ask; everything it needs to know about the game
 * itself it asks through these, and nothing else of the game is reachable from it.
 */
export interface GameSession<Line, Cmd> {
	/** One engine line the shell does not read itself: everything but the game's end, a fatal line and a checkpoint. */
	onLine(line: Line): void;
	/** Send the engine one command: the concede a seat's flag or an unanswered concede sends. */
	command(command: Cmd): void;
	/** The game waits on this seat's own decision now: its chess clock runs exactly then. */
	waitedOn(seat: number): boolean;
	/** Tell every seat the roster again: a clock, a holder's presence or a face moved. */
	tellRoster(): void;
	/** The turn the game is in, or null before the engine has dealt: what a restart ask is about. */
	turn(): number | null;
	/** The seat whose turn it is, with its engine player; null when no seat's is (before the deal, an AI's turn). */
	activeSeat(): { seat: number; playerId: number } | null;
	/** How many of this seat's questions are open: logged when its holder leaves and when they come back. */
	openAsks(seat: number): number;
	/**
	 * A command the EARLIER server had already sent, met again during a replay (`MatchHost.attach`):
	 * closes whatever open ask it was answering (Forge's `reply`/`abort`; `ForgeSession.replayed`).
	 * Nothing the engine's own line stream says records that an ask was answered, so without this a
	 * seat coming back after a restart would be re-shown a modal it had already dismissed. A session
	 * with no asks of its own (the toy game's) still implements it, trivially, to prove the hook fits.
	 */
	replayed(command: Cmd): void;
	/**
	 * The match is ending for good — stopped on purpose, failed, or its host exited — and this is
	 * the session's one chance to sweep: `ForgeSession.ended` is `logFrames`/`closeAllAsks`/
	 * `tellSeatsItEnded`/`probes`. `reason` is the failure's or exit's message; null for a stop,
	 * which has none.
	 */
	ended(reason: string | null): void;
	/**
	 * The notice hook: the shell has words for a seat with no game state behind them — today
	 * only `'server-stopping'` (`Match.serverStopping`'s `message`, said as Forge's own
	 * `endNotice` always has — `ForgeSession.notice` is a one-line call to it). `RelaySession`'s
	 * tells every seat the same message as a relayed line; the toy game implements it trivially,
	 * to prove it fits a session with nothing of its own to say.
	 */
	notice(kind: 'server-stopping', message: string): void;
}
