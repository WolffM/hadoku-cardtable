/**
 * What a game supplies to the match host (platform phase 5, L3): the Forge-specific half of
 * `play/match.ts`'s `class Match`, generalised to a shape any engine's own bridge protocol can
 * satisfy. Every member here stands for something `class Match` does today for Forge alone —
 * each doc comment cites the `match.ts` line(s) it generalises. w102
 * (`docs/planning/w102-match-split-map.md`) is where `class Match` is actually cut along this
 * seam into a shell and a Forge `GameSession`; this file states the seam's shape only — it adds
 * no behaviour and today has exactly one caller, a toy adapter in `game-adapter.test.ts` that
 * proves a non-Forge game's lines fit through it.
 *
 * Five type parameters, one per thing a game owns the shape of, plus a sixth for what a
 * mid-game save looks like:
 *  - `Spec`   — how a match is configured (Forge's `MatchSpec`).
 *  - `Line`   — what the engine's bridge sends up, one line at a time (Forge's `BridgeLine`).
 *  - `Cmd`    — what the host sends down to the engine (Forge's `BridgeCommand`).
 *  - `Frame`  — what a seat or a watcher is shown (Forge's `ServerFrame`).
 *  - `Input`  — what a seat sends in, raw off its socket (Forge's `ClientFrame`).
 *  - `Checkpoint` — an opaque mid-game save a match can be restored from (Forge's
 *    `TurnSnapshot`). w103's parking is the first real consumer; nothing calls this generically
 *    yet, so it defaults to `unknown`.
 */
export interface GameAdapter<Spec, Line, Cmd, Frame, Input, Checkpoint = unknown> {
	/**
	 * The seats a spec wants, in order. `class Match`'s constructor reads exactly this off
	 * `spec.seats` (`match.ts:1113-1120`): `ai`, and the `name`/`displayName` pair
	 * `SeatSpecWithIdentity` widens Forge's `SeatSpec` with (`match.ts:235-245`).
	 */
	seats(spec: Spec): { ai: boolean; name: string }[];

	/**
	 * What one line from the engine's bridge means, generically. `Match.onLine`
	 * (`match.ts:2616-2744`) is this switch for Forge today — its cases collapse onto this union
	 * one for one:
	 *  - `'ready'`      ← Forge's `'ready'` (`:2618`): the bridge has a game; record each seat's deck.
	 *  - `'seat'`       ← Forge's `'frame'` (`:2630`): a line addressed to one seat's game, forwarded
	 *    to {@link GameSession.ingest}.
	 *  - `'over'`       ← Forge's `'gameover'` (`:2679`): the game ended; `placements` is Forge's own
	 *    `winnerSeatFromLosers` (`play/match/outcome.ts`) read back as a ranking.
	 *  - `'checkpoint'` ← Forge's `'snapshot'` (`:2712`): a mid-game save, kept as `latestSnapshot`
	 *    for a later restart (`MatchRegistry.restore`, `match.ts`'s own, since the http-owned
	 *    `MatchRegistry`/`createMatchRegistry` could not move this wave — see `match.ts`'s header
	 *    comment above them).
	 *  - `'fatal'`      ← Forge's `'fatal'` (`:2706`): the bridge or the JVM died; `Match.fail`
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
	 * `Match.command` (`match.ts:1421`, the `Cmd` sink: `out.command`), `Match.send`/`Match.emit`
	 * (`match.ts:2366`, `:2380`, the per-seat `Frame` sink: `out.toSeat`), and
	 * `Match.tellWatchers`/`Match.sendWatcher` (`match.ts:2586`, `:2564`, the watcher `Frame` sink:
	 * `out.toWatchers`). w102 is where this becomes a real method on a real `ForgeSession` rather
	 * than a description of one.
	 */
	session(out: { toSeat(seat: number, f: Frame): void; toWatchers(f: Frame): void; command(c: Cmd): void }): GameSession<Input>;

	/**
	 * A spec that resumes from a checkpoint rather than starting fresh — Forge's own
	 * `restoredSpec` (`play/match/registry.ts:31`, moved there this wave from `match.ts`): drop
	 * the chooser, open on the checkpoint's state, skip the opening hand.
	 */
	restoreSpec(spec: Spec, cp: Checkpoint): Spec;

	/**
	 * The command that ends this seat's game as a loss — Forge's
	 * `{ t: 'act', seat, frame: { kind: 'act', method: 'concede' } }` (`match.ts:1373`, repeated at
	 * `:1391` until the engine answers it).
	 */
	concede(seat: number): Cmd;

	/**
	 * A frame that tells a seat something in words, with no game state behind it — Forge's
	 * `endNotice` (`match.ts:4564-4578`: `showErrorDialog`, `MATCH_ENDED_TITLE`).
	 */
	notice(text: string): Frame;
}

/** What {@link GameAdapter.classify} reads one engine line as. */
export type ClassifiedLine<Checkpoint> =
	| { t: 'ready' }
	| { t: 'seat'; seat: number; raw: unknown }
	| { t: 'over'; placements: number[] }
	| { t: 'checkpoint'; cp: Checkpoint }
	| { t: 'fatal'; why: string }
	| { t: 'info' };

/**
 * What a game's own engine session does with a seat's raw input, generically. Forge's
 * `Match.onFrame` (`match.ts:2746-3025`) is this for one seat today. `class Match` is not split
 * along this seam yet (w102's work), so there is no second implementation to check this shape
 * against beyond the toy adapter in `game-adapter.test.ts` — it is the plan's starting point,
 * not a settled API. Only `Input` is a type parameter: today's one member needs nothing of `Cmd`
 * or `Frame`; w102 adds them back the moment a second member does.
 */
export interface GameSession<Input> {
	/** A seat's raw act, off its socket — Forge's `Match.onFrame(seat, raw)` (`match.ts:2746`). */
	ingest(seat: number, raw: Input): void;
}
