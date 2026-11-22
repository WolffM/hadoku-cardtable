/**
 * The four fields `host.ts`'s `MatchSpec<G>`/`SeatSpec` carried before w120 §K even though only
 * Forge ever set or read them — `.dck` text, puzzle scenarios, and coin-toss rigging — moved here,
 * off the platform's generic base (C's w119 remainder: "a fuller split … would need edits to files
 * outside this lane's ownership", `host.ts`'s own history has the deferral). `host.ts` and
 * `play/placement/coordinator.ts` now carry only the generic shape (`seats.length`,
 * `headless`'s presence) — neither ever read any of these four, so nothing there changes
 * behaviourally; what changes is that a Magic match's real spec TYPE now says so, instead of
 * leaning on fields the base type happened to declare.
 *
 * Every Magic reader of a real match's spec (not a toy/relay one) imports {@link ForgeMatchSpec}/
 * {@link ForgeSeatSpec} from here instead of the bare `MatchSpec`/`SeatSpec`: `match.ts`
 * (`SeatSpecWithIdentity`/`MatchSpecWithIdentity` build on these), `botgames.ts`, `parked.ts`,
 * `deck-colors.ts`, `table-game.ts`, `art.ts`, `recording/{recorder,rebuild}.ts`,
 * `match/{registry,forge-session}.ts`, `socket.ts`, `http/routes.ts`.
 */

import type { MatchSpec, SeatSpec } from '@hadoku/game-server/play/host';

/** `host.ts`'s `SeatSpec`, with the one field only Forge ever sets or reads. */
export interface ForgeSeatSpec extends SeatSpec {
	/** `.dck` text, or null for a random Forge precon. */
	deck: string | null;
}

/**
 * The fields of `host.ts`'s old `MatchSpec` that were Forge-specific in principle AND in practice
 * — nothing outside this package ever set or read one. Used as `MatchSpec`'s own `G` parameter
 * (see {@link ForgeMatchSpec}), so `bridgeConfig`'s `...spec` spread onto `config.json` still
 * carries every one of these, byte-identical to before this file existed.
 */
export interface ForgeSpecFields {
	/**
	 * Wave 33 §S — a TEST-only starting position: the text of a Forge puzzle file's
	 * `[state]` section (`humanlife=`, `humanhand=`, `humanbattlefield=`,
	 * `activephase=`, … — `GameState.parseLine` in the deploy tree's forge-build
	 * cache has the full key list), with `human…` keys applying to seat 0 and
	 * `ai…` keys to seat 1. `bridgeConfig` spreads it onto `config.json` like every
	 * other field; `PlayBridge.java`'s `configFrom` reads it and
	 * `BridgeGui.hostMatch` applies it from `HostedMatch`'s own start-game hook —
	 * see that method's doc. Omitted in play: `socket.ts`'s `parseStartBody`
	 * accepts this key only behind `CARDTABLE_PLAY_PROBE=1` and refuses it
	 * otherwise, so production never sends one.
	 */
	scenario?: string;
	/**
	 * Start on {@link scenario}'s board with no coin toss and no mulligan — Forge's
	 * own Puzzle game type, which skips both (`GameAction.startGame`). Set only by
	 * `socket.ts` for a board-state room's own scenario; a test's scenario keeps the
	 * ordinary opening its drivers click through.
	 */
	skipOpening?: boolean;
	/**
	 * {@link scenario} is this match's own turn-start snapshot (`restoredSpec`): its board goes back
	 * as it was, running no replacement effect ("enters tapped", "you may pay 2 life"), where a
	 * board room's scenario plays each permanent's entry. Implies {@link skipOpening}.
	 */
	restore?: boolean;
	/**
	 * With {@link restore}: the snapshot's `rng`, the state of the match's random as its turn began. The bridge
	 * puts it back at the restored game's first upkeep, so the turn shuffles and rolls as it did the first time.
	 */
	rng?: number;
	/**
	 * Wave 71 §E — names the seat Forge asks to choose play or draw. Every game we
	 * host is a fresh Forge `Match`, so Forge always treats it as the FIRST game of
	 * that match and tosses a coin (`GameAction.determineFirstTurnPlayer`,
	 * `forge/forge-game/src/main/java/forge/game/GameAction.java:2364-2416`) rather
	 * than asking the previous loser — this field is how the room still names that
	 * player. `PlayBridge.java`'s `startMatch` rigs the coin toss so the named seat
	 * is the one Forge asks (`SeatGui`'s `updateButtons` with `label1:'Play',
	 * label2:'Draw'`), which makes the published `coinToss.winner` (`match.ts:1055`)
	 * that seat too — the client's existing flip/notice needs no change. Omitted:
	 * byte-identical to today, an unrigged coin toss. Never set alongside a change
	 * to `forge/` — a fork change is a jar switch, and that switch is the operator's.
	 */
	chooser?: 0 | 1;
}

/** `MatchSpec`, with Forge's own fields back and `seats` widened to {@link ForgeSeatSpec}[]. Every real Magic match's spec is this type. */
export type ForgeMatchSpec = Omit<MatchSpec<ForgeSpecFields>, 'seats'> & { seats: ForgeSeatSpec[] };
