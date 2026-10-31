/*
 * @hadoku/draft — the pure cube-draft engine.
 *
 * Transport-free by construction: nothing here opens a socket, knows about a
 * room, or imports `@wolffm/rooms-server`. It consumes `@wolffm/rooms-protocol`
 * for seating, which is dependency-free data, and produces the `@hadoku/shared`
 * envelope. Wiring it to a transport is a later wave's work and should be
 * wiring, not a rewrite.
 *
 * The guarantee to hold on to: the same seed produces the same draft. Tests
 * lean on it, a bug report can carry it, and a restore can rebuild from it.
 */

export {
  hashSeed,
  mulberry32,
  rngFromSeed,
  shuffle,
  derive,
  type Rng,
} from './rng.ts';

export {
  createDraft,
  pick,
  waitingOn,
  packOf,
  queueDepth,
  pickNumberOf,
  podPickNumber,
  receiverOf,
  fromLockstep,
  botSeatAcross,
  directionFor,
  isBotSeat,
  botRng,
  type DraftConfig,
  type DraftState,
  type DraftStatus,
  type DraftEvent,
  type PickResult,
  type PickRejection,
  type BotSeat,
  type HumanSeat,
  type LockstepState,
} from './engine.ts';

export { deal, planPool, poolShortfall, type RealisticPacks, type SourceCards } from './deal.ts';

export {
  runBots,
  botTurn,
  botsOwe,
  choosePick,
  scoreCard,
  colourCounts,
  committedColours,
} from './bot.ts';

export { pickSeconds, pickTimeMs, timeoutPick } from './pick-timer.ts';

export { viewFor, spectatorView, watcherView, viewsForAllSeats } from './view.ts';

export {
  MAX_ROUNDS,
  pairRound,
  rankedStandings,
  rankStandings,
  roundsFor,
  standings,
  TIEBREAKS,
  type PodPlayer,
  type MatchResult,
  type PairRoundInput,
  type PairRoundResult,
  type RankedStandingsRow,
  type StandingsRow,
  type Tiebreak,
} from './pairing.ts';
