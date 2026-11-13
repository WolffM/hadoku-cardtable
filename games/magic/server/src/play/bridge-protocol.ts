/**
 * Forge's own bridge protocol: the lines `bridge/PlayBridge.java` writes on stdout, and the
 * commands `host.ts` writes on stdin. Moved out of `host.ts` unchanged (wave 103 §H, commit 1) so
 * the generic host (`host.ts`, platform) carries no Forge-specific type and this is the one file
 * that does: `MatchHost<C>`/`HostEvents<L>` are instantiated here as `MatchHost<BridgeCommand>`/
 * `HostEvents<BridgeLine>` by every Forge-side importer (`match.ts`, `match/*`, `socket.ts`,
 * `plugins/state.ts`, …). See `host.ts`'s own module header for the line protocol itself.
 */
import type { AbortReasonSchema, ClientAction, GameLogLine, GameLogMeta, Loss, SendYieldUpdate } from '@hadoku/forge-wire';

type AbortReason = (typeof AbortReasonSchema)['_zod']['output'];

/**
 * Node → Forge. On the wire each command also carries `match` — the JVM host adds
 * it and the bridge refuses a command without its own match id.
 */
export type BridgeCommand =
	| { t: 'reply'; seat: number; callId: string; result: unknown }
	| { t: 'abort'; seat: number; callId: string; reason: AbortReason }
	/**
	 * `input`: the id of the input the seat made this act on (the `input` its window's frame lines
	 * carried); the bridge drops an act whose input is no longer the one open when Forge applies it
	 * (`PlayBridge.java`'s `MatchContext.actInputs`). Absent: applied as Forge applies it.
	 */
	| { t: 'act'; seat: number; frame: ClientAction | SendYieldUpdate; input?: number }
	/** Re-send every ask the seat is parked on, original callIds (`match.ts`'s `armActWatch`). */
	| { t: 'resend-pending'; seat: number }
	/** Forge's Cancel on the seat's open mana payment only, never on an input opened after it (`PlayBridge.java`'s `cancelPayment`). */
	| { t: 'cancel-payment'; seat: number }
	/**
	 * Take back the seat's last action (`PlayBridge.java`'s `rewind`, Forge's `UndoManager`), if its history is
	 * still at `version` (the `undo` line's): what the opponent allowed. Answered by a `rewind` line.
	 */
	| { t: 'rewind'; seat: number; version: number }
	| { t: 'probe'; seat: number; probeId: string; message: string }
	/** End the game as a draw, Forge's `GameEndReason.Draw` (`PlayBridge.java`'s `forceDraw`; `Match.forceDraw`). */
	| { t: 'draw' }
	| { t: 'stop' };

/**
 * Forge → Node. `frame.frame` is unvalidated here; `match.ts` parses it. On the
 * wire every line also carries `match`, checked and dropped by the JVM host.
 */
export type BridgeLine =
	/**
	 * `bootMs` is from the JVM's own start (for a spare, that includes its idle
	 * wait); `startMs` from the moment the match was handed to it (Wave 10).
	 */
	/**
	 * `removed`: the cards of the seat's deck Forge has no card for, which it drops as the game starts
	 * (`PlayBridge.java`'s `unsupportedIn`). Absent from a line an older bridge wrote.
	 */
	| { t: 'ready'; forgePort: number; bootMs: number; startMs?: number; seats: { seat: number; ai: boolean; deck: string; removed?: string[] }[] }
	/** `input`: the id of the input open on the seat when the frame was shown (`PlayBridge.java`'s `MatchContext.inputId`); absent when none is. */
	| { t: 'frame'; seat: number; frame: unknown; input?: number }
	| { t: 'probe'; probeId: string; seat: number; answer?: boolean; ms?: number; error?: string }
	/**
	 * `losers`: the player ids Forge has lost (`Player.hasLost`), the same ids the views carry.
	 * Absent from a line an older bridge wrote, which a resumed match may replay.
	 * `lost`: why each of them lost, as Forge decided it (`PlayerOutcome.lossState`); absent likewise.
	 * A bot game's (`MatchSpec.headless`) carries `seat`, the winner's (`null` for a draw), and the game's `ms` instead.
	 */
	| { t: 'gameover'; winner: string | null; losers?: number[]; lost?: Loss[]; seat?: number | null; ms?: number }
	/**
	 * One entry of Forge's own game log (`PlayBridge.GameLogForward`), worded once
	 * per player: `text` is null when the line names a card that player may not
	 * see in a way the bridge could not reword; `cards` are the ones they may.
	 * `meta` is the line's public half, the same for every player (`GameLogMeta`).
	 */
	| { t: 'log'; type: GameLogLine['type']; meta?: GameLogMeta; players: { player: number; text: string | null; cards: GameLogLine['cards'] }[] }
	| { t: 'fatal'; message: string; /** The top frames of the failure's stack (`PlayBridge` `fail`), when it had one. */ frames?: string[] }
	| { t: 'rejected'; message: string; command: string }
	| { t: 'stale'; seat: number; callId: string }
	/** The asks a `resend-pending` sent again, after their frames. */
	| { t: 'resent'; seat: number; callIds: string[] }
	| { t: 'unsupported'; seat: number; method: string }
	/**
	 * Wave 32, Q5 — the bridge switched Forge's phase-pacing sleep for a seat
	 * (`SeatGui.setPhaseDelayOff`). Informational: it exists so a log and a suite
	 * can see that the exemption is armed by an End Turn click and lifted after it.
	 */
	| { t: 'pace'; seat: number; skipPhaseDelay: boolean; at: number }
	/**
	 * Wave 78 §A — Forge actually applied this seat's act to an open input, in
	 * APPLIED order (`seq`, one counter shared by both seats of a match —
	 * `PlayBridge.java`'s `SeatController.applied`). `act` is in the same shape
	 * this file's own `BridgeCommand`'s `act` frame sent it (`kind`/`method` plus
	 * that method's own fields); `input` is the open input's simple class name,
	 * for a log a human can read. An act Forge drops (no input was open, or its
	 * hold past `ActGate`'s `BETWEEN_INPUTS_MS` timed out) is never
	 * echoed — the recorder (`recording/recorder.ts`) must log only this line,
	 * never the `act` command at send time, so a dropped act never enters the log.
	 */
	| { t: 'applied'; seat: number; seq: number; input: string; act: ClientAction }
	/**
	 * Wave 78 §A, second pass — this seat's own `InputQueue` just opened or closed an input
	 * (`PlayBridge.java`'s `SeatController.emitInputState`, a second `Observer` on that queue).
	 * `input` (the open input's simple class name) is present only when `open` is true. Exists so
	 * a rebuild can wait for "this seat HAS an open input" before ever sending an act, rather than
	 * sending into the gap and letting `ActGate`'s own `BETWEEN_INPUTS_MS` hold-or-drop decide —
	 * resending on THAT timeout, tried first, could double-apply an act onto whatever opened right
	 * after the hold gave up on it.
	 */
	| { t: 'input'; seat: number; open: boolean; input?: string }
	/**
	 * An act the bridge kept from Forge: a click sent to answer a selection that closed before Forge
	 * reached it (`MatchContext.selectionClicks`), or an act made on an input that was no longer the
	 * open one when Forge applied it (`MatchContext.actInputs`, `card` -1 for a button). Either would
	 * have landed in whatever input came next. Never applied, so never an `applied` line.
	 */
	| { t: 'dropped'; seat: number; method: string; card: number; why: string }
	/**
	 * A spell or ability went on the stack for a seat's player while its controller was not a human's:
	 * the AI made a play for the seat (`PlayBridge.java`'s `Impersonation`). Never expected.
	 */
	| { t: 'impersonated'; seat: number; card: number; ability: string; controller: string; thread: string }
	/** A seat's input finished while its offer scan held the seat's controller swapped for an AI's (`SeatController.pushActionableCards`). */
	| { t: 'scan-overtaken'; seat: number; input: string }
	/**
	 * The game as its turn's upkeep begins (`PlayBridge.TurnSnapshot`): Forge's `GameState` text, a
	 * scenario that restores the match to the start of that turn (`match.ts`'s `restoredSpec`).
	 * `ms` is how long the bridge took to write it. `lossy` names what the game held that the text
	 * cannot (`docs/planning/restart-turn-plan.md` part 2); absent or empty is the whole game.
	 */
	| { t: 'snapshot'; turn: number; state: string; ms: number; lossy?: string[] }
	/**
	 * What the seat could take back changed (`SeatController.emitUndoState`): `can`, its priority prompt is open
	 * with a step of its own to rewind to; `version`, the game's undo history count, which moves with every step
	 * and every barrier (`UndoManager.version`); `bytes`, the heap the game's whole undo history pins now
	 * (`UndoManager.retainedBytes`), for capacity.
	 */
	| { t: 'undo'; seat: number; can: boolean; version: number; bytes?: number }
	/** The answer to a `rewind` command: whether Forge took the action back, and the history it was asked to rewind. */
	| { t: 'rewind'; seat: number; ok: boolean; version: number }
	/** A rewind put the game back, and every seat has been sent the whole state again (`PlayBridge.java`'s `Rewound`). */
	| { t: 'rewound' }
	/** A rewind took back the log lines sent since: the first `keep` stay (`GameLogForward.truncated`). */
	| { t: 'log-truncated'; keep: number };
