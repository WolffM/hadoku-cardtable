/**
 * GameTypeSpec — what a room needs to know about the game it plays, as data
 * rather than a closed enum. A game that registers a spec can open a room
 * and seat players through the same lobby mechanics Magic already uses,
 * with no change to the lobby itself.
 *
 * Holds the facts true of a game type on its own, with no server instance
 * or runtime service standing behind them: how many seats, whether there is
 * a ready step, how long a new series runs by default, whether it fills
 * open seats with a bot, whether enough seats are filled to start, and — for
 * a game this server persists — its saved `game` blob's own fields. A
 * game's DEEPER rules (deck legality, a draft's own completion, a
 * tournament's locked decks, who may seat a bot mid-round, …) stay that
 * game's own business: Magic's are `GameHooks`
 * (`apps/server/src/room/lobby.ts`, wired in per game type through
 * `Lobby.useGameType`), because they need a running server's
 * `draftRooms`/gate to answer — this file never reaches for them.
 *
 * **Platform (MIT).** Imports nothing from Magic, and registers nothing
 * itself — a package that imports only this file pulls in no Magic code and
 * no GPL header. Magic registers its own two game types from a Magic file
 * (`magic-room.ts`); a test registers its own (`game-type-spec.test.ts`).
 */

export interface SeatRange {
  /** Fewest seats this game ever plays with. */
  min: number;
  /** Most seats a ROOM of this type ever grows to — one meaning across every registered type. */
  max: number;
}

export interface Verdict {
  ok: boolean;
  reason?: string;
}

/** Fills every open seat (`null`) with this game's own bot marker, up to `seats.max`; a seat already taken is left exactly as it was. */
export interface BotFill {
  fill(seats: readonly (string | null)[]): (string | null)[];
}

/**
 * A saved room's `game` blob for this type (the room's app codec): the
 * fields it keeps nested under `game`, and how to read them back. Absent
 * for a type this server never persists (a test's own, say) — such a type
 * may still be opened, seated and started in memory; it just quarantines on
 * a restart, exactly as an unregistered type always has.
 */
export interface GameCodec {
  /** Every field this game type keeps nested under a saved room's `game` key. */
  storedKeys: readonly string[];
  /** Reads an already-shaped `game` object back; throws to quarantine, exactly as the room codec's other fields do. */
  decode(raw: Record<string, unknown>): unknown;
}

export interface GameTypeSpec {
  id: string;
  seats: SeatRange;
  /**
   * A room plays in tables of this many seats; absent means the whole room
   * is one table of `seats.max` (Magic's own two types each name 2 here,
   * win or lose, however many sit in the room — a `draft` pod of 30 still
   * plays its rounds two at a table).
   */
  table?: { seats: number };
  /**
   * This game type's match runs on the relay runtime — the host has no engine of its own for it,
   * only seats, watchers and a channel each seat's bundle speaks over
   * (`apps/server/src/play/runtimes/relay.ts`'s `RelaySession`, `apps/ui/src/rooms/relay-channel.ts`
   * on the client). Absent is a game with an engine or server of its own: no channel.
   */
  runtime?: 'relay';
  /**
   * A relay match's seat that drops is held this long for its player to come back; past it the
   * seat leaves the match (`runtimes/relay-match.ts`'s `seatRejoinGraceMs`). Absent or 0: a seat
   * that drops is held for as long as the match lasts. Read only for `runtime: 'relay'`.
   */
  seatRejoinGraceMs?: number;
  /** Whether the room waits on a ready step before it may start (a countdown with none, say). */
  ready: boolean;
  bots?: BotFill;
  /** How many games a NEW series of this room plays, absent any mode of its own that says otherwise (Magic's Gauntlet, say — `room/series.ts` keeps that one exception). */
  series: { length: 1 | 3 };
  /** Whether `seated` players are enough to start, by seat count alone — a game's own deeper rules are its own business, not this one's. */
  canStart(seated: number): Verdict;
  gameCodec?: GameCodec;
}

const registry = new Map<string, GameTypeSpec>();

/** Registers (or replaces) a game type's spec. Idempotent: the same id registered twice keeps the latest registration. */
export function registerGameType(spec: GameTypeSpec): void {
  registry.set(spec.id, spec);
}

/** The registered spec for `id`, or `undefined` for a game type this process does not know. */
export function gameTypeSpec(id: string): GameTypeSpec | undefined {
  return registry.get(id);
}

/** Whether `id` is a game type this process knows how to play at all — the open replacement for the old closed `GAME_TYPES` union. */
export function isRegisteredGameType(id: string): boolean {
  return registry.has(id);
}
