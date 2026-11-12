import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { RestartState, SeatIdentity, ServerEnvelope, StopPhase } from '@hadoku/shared';

import type { HostEvents, MatchHost, MatchRecord, MatchSpec, TurnSnapshot } from '../host.js';
import type { BridgeCommand, BridgeLine } from '../bridge-protocol.js';
import type { Match, MatchDeps } from '../match.js';
import type { SeatState } from './forge-session.js';

/**
 * The spec that starts a match again from a turn-start snapshot: the same seats, decks and room
 * settings, opening on the snapshot's board with no coin toss and no mulligan (`skipOpening`).
 * `chooser` goes: it rigs the coin toss, which a restore never makes, and an unspent rig would
 * answer the next random choice between two players instead.
 *
 * What the restored game does not have, read from `GameState` (`initFromGame`, `applyToGame`) on
 * pin 5eff8436 — everything from the snapshot's upkeep on is played again, and of the turn before
 * it, only what the board shows survives:
 * - effects that last until end of turn or longer and are not a card's own (`DetachedCardEffect`s
 *   are skipped: a stolen creature goes back under its owner's control unless an Aura or other
 *   permanent still says otherwise), emblems and other command-zone effects with no card;
 * - delayed triggers ("at the beginning of the next upkeep…") and anything that waited for them;
 * - what a card remembers that is not a card, and a player's history: spells cast, life gained or
 *   lost and creatures died last turn, monarch and initiative, day/night, turns taken (Forge's
 *   per-player turn count);
 * - phased-out permanents' phasing timestamps and every control and layer timestamp, so effects
 *   that apply in timestamp order are re-applied in the order the cards come back;
 * - triggers waiting to go on the stack as the upkeep begins (an untap step's "whenever … untaps");
 * - a seat's open asks, and its remembered trigger choices, which Forge holds by ability (its
 *   stops, auto-yields and full control come across);
 * - random-number state: the restored game draws fresh randomness from its new JVM.
 * Card ids change: every seat resyncs onto the new epoch.
 *
 * Forge's own `GameAdapter.restoreSpec` (`match/hosted.ts`'s `HostedMatchDeps.restoreSpec`,
 * `Checkpoint` = `TurnSnapshot`): `createMatchRegistry` wires this in as `deps.restoreSpec` once,
 * and `HostedMatch`'s own constructor is the only caller — `create`/`restore`, below, pass the
 * snapshot through as `restore.checkpoint` rather than calling this themselves.
 */
export function restoredSpec(spec: MatchSpec, snapshot: TurnSnapshot): MatchSpec {
	const { chooser: _chooser, ...rest } = spec;
	return { ...rest, scenario: snapshot.state, skipOpening: true, restore: true };
}

/** A resumed game's start: who holds each seat, the turn-start snapshot it opens on, and each seat's clock. */
export interface ResumeFrom {
	owners: readonly (string | null)[];
	snapshot: TurnSnapshot;
	clockMs?: [number, number];
}

/** How many {@link EndedMatch}es the registry keeps, newest first. Each is a spec and a few fields. */
export const ENDED_KEPT = 256;

/**
 * What the registry keeps of a match once it has let go of it: what its readers still ask after the
 * game — `GET /play/matches/:id`, a seat's own deck list, the table card's decks, a refused join's
 * words — and nothing of its play. The histories, projectors, asks and frame ring a long game held
 * (megabytes a seat) go with the match.
 */
export class EndedMatch {
	readonly id: string;
	readonly status: 'stopped' | 'failed';
	readonly failure: string | null;
	readonly winner: string | null;
	/** The match's spec without a scenario: a resumed game's opening board is the parked record's to keep. */
	readonly spec: MatchSpec;
	readonly seats: readonly Pick<SeatState, 'seat' | 'ai' | 'owner' | 'playerId' | 'deck'>[];

	constructor(match: Match) {
		const { scenario: _scenario, ...spec } = match.spec;
		this.id = match.id;
		this.status = match.status === 'failed' ? 'failed' : 'stopped';
		this.failure = match.failure;
		this.winner = match.winner;
		this.spec = spec;
		this.seats = match.seats.map(({ seat, ai, owner, playerId, deck }) => ({ seat, ai, owner, playerId, deck }));
	}

	seatOf(participantId: ParticipantId): number | null {
		return this.seats.find((s) => s.owner === participantId)?.seat ?? null;
	}

	/** Nothing is under way. */
	live(): null {
		return null;
	}
}

/** What {@link MatchRegistry.restore} did: back to the start of turn `turn`, or a fresh game from the match's spec. */
export type Restored = { match: Match; from: 'snapshot'; turn: number } | { match: Match; from: 'spec' };

export type RegistryDeps = Omit<
	MatchDeps,
	// `restoreSpec` is Forge's own (`restoredSpec`, above): the registry wires it in itself, on
	// every match, so it is never a caller's to set.
	'emit' | 'seatsChanged' | 'phaseStopChanged' | 'restartChanged' | 'restartTurn' | 'onGameOver' | 'liveChanged' | 'abandoned' | 'ended' | 'restoreSpec'
> & {
	/** The ceiling a bot game counts against (`MatchRegistry.botGame`). Default `MAX_CONCURRENT_MATCHES`. */
	maxMatches?: number;
	emit(match: Match, seat: number, envelope: ServerEnvelope): void;
	/** See {@link MatchDeps.seatsChanged}. */
	seatsChanged?(match: Match, seats: SeatIdentity[]): void;
	/** See {@link MatchDeps.phaseStopChanged}. */
	phaseStopChanged?(match: Match, seat: number, phase: StopPhase | null): void;
	/** See {@link MatchDeps.restartChanged}. */
	restartChanged?(match: Match, state: RestartState): void;
	/** See {@link MatchDeps.onGameOver}. */
	onGameOver?(match: Match): void;
	liveChanged?(match: Match): void;
	/** See {@link MatchDeps.abandoned}: the match can be parked (`parked.ts`). */
	abandoned?(match: Match): void;
	/** The registry let go of `match` ({@link MatchRegistry.find}): whatever was kept for it elsewhere can go too. */
	freed?(match: Match): void;
	/** The re-attach half of the host. Absent on a host whose JVMs die with us. */
	attach?(record: MatchRecord, events: HostEvents<BridgeLine, BridgeCommand>): MatchHost<BridgeCommand>;
};
