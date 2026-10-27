/**
 * The recorder (`docs/planning/wave77-2026-10-27.md` §C): wraps the host
 * factory `index.ts` passes to `attachPlay` so every match gets a seed and an
 * action log, and listens to the watcher channel's own envelopes (fed from
 * `PlayDeps.onEnvelope`, the one-line additive hook in `socket.ts` — see that
 * file's own doc on `onEnvelope`) for the public stream. It never touches
 * `match.ts`: everything here is outside the two seams named in the brief —
 * the host factory, and the registry's `emit`.
 *
 * One `Session` per live match, keyed by matchId, held only from the moment
 * its host is created until its JVM exits (`events.exit`) — a reattached
 * match (`host.attach`, an earlier server's match taken back) has no session
 * and is not recorded; that half of the contract is future work, flagged in
 * the wave report. `onEnvelope`/`onGameOver` for a matchId with no session
 * (a reattached match, or a call that raced `exit`) are quiet no-ops.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ServerEnvelope } from '@hadoku/shared';

import type { JsonLog } from '../../log.js';
import type { DeckCosts } from '../deck-colors.js';
import { seatDeckColors } from '../deck-colors.js';
import type { BridgeCommand, MatchHostFactory, MatchSpec } from '../host.js';
import type { OutcomeFacts } from '../match.js';
import { gameOutcome, WATCHER_SEAT } from '../match.js';
import { createSeatPosition, type SeatPosition } from './position.js';
import { createMatchRecordingWriter, type MatchRecordingWriter } from './writer.js';

/** The jar's own filename IS its pin (`docs/FORGE_JAR.md`, "Per-pin jars") — the full 40-char `forge` submodule sha. Null for the `forge.jar` fallback name, which names no pin. */
export function forgePin(jarPath: string): string | null {
	const name = basename(jarPath, '.jar');
	return /^[0-9a-f]{40}$/.test(name) ? name : null;
}

/** sha-256 of `PlayBridge.java`'s own text, exactly as `host.ts` reads it to compile or launch it — contract 1's `bridge` field. */
export function bridgeDigest(bridgeSourcePath: string): string {
	return createHash('sha256').update(readFileSync(bridgeSourcePath)).digest('hex');
}

/** This server's own `package.json` version, for the action log's `server` field. `'unknown'` rather than throwing — a recording is never worth failing boot over. */
export function serverVersion(pkgRoot: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version?: unknown };
		return typeof pkg.version === 'string' ? pkg.version : 'unknown';
	} catch {
		return 'unknown';
	}
}

export interface RecorderIdentity {
	pin: string | null;
	bridge: string;
	server: string;
}

export interface RecorderDeps {
	/** `CARDTABLE_RECORDINGS_DIR`, resolved. */
	dir: string;
	identity: RecorderIdentity;
	/** The room a match was started from, if any (`lobby.roomOfMatch(matchId)?.id`). */
	roomOf(matchId: string): string | null;
	/** Folds a seat's deck into its colours for the public header's `decks` (`deck-colors.ts`). */
	deckCosts: DeckCosts;
	log?: JsonLog;
	/** Overridable for a test. Default `Date.now`. */
	now?(): number;
	/** Overridable for a test. Default a real random 32-bit seed. */
	randomSeed?(): number;
}

export interface Recorder {
	/** Wrap a host factory so every match it makes is recorded. Everything else about `inner` (its `close`, `attach`, `spare`, …) passes through unchanged. */
	host(inner: MatchHostFactory): MatchHostFactory;
	/** Wire to the registry's `emit`, via `PlayDeps.onEnvelope`: every seat's envelope, every match. Only `WATCHER_SEAT` is recorded. */
	onEnvelope(matchId: string, seat: number, envelope: ServerEnvelope): void;
	/** Wire to `PlayDeps.onGameOver`: remembers the seat that won, for the public stream's `end` line. */
	onGameOver(match: OutcomeFacts & { id: string }): void;
}

interface Session {
	writer: MatchRecordingWriter;
	positions: ReadonlyMap<number, SeatPosition>;
	startedAtMs: number;
}

const randomSeed32 = (): number => Math.floor(Math.random() * 0x7fffffff);

/** Recording rides a live match's own call stack: a fault in it is logged and the match goes on. */
function guarded(log: JsonLog, matchId: string, what: string, run: () => void): void {
	try {
		run();
	} catch (err) {
		log({ evt: 'recording-failed', matchId, what, error: (err as Error).message });
	}
}

export function createRecorder(deps: RecorderDeps): Recorder {
	const log = deps.log ?? (() => undefined);
	const now = deps.now ?? Date.now;
	const randomSeed = deps.randomSeed ?? randomSeed32;
	const sessions = new Map<string, Session>();

	return {
		host(inner) {
			const wrapped = ((matchId, spec, events) => {
				const seeded: MatchSpec = spec.seed === undefined ? { ...spec, seed: randomSeed() } : spec;
				const roomId = deps.roomOf(matchId);
				const startedAt = new Date(now()).toISOString();
				const writer = createMatchRecordingWriter({
					dir: deps.dir,
					matchId,
					actionsHeader: { matchId, roomId, pin: deps.identity.pin, bridge: deps.identity.bridge, server: deps.identity.server, startedAt, spec: seeded },
					publicHeader: {
						matchId,
						roomId,
						players: [seeded.seats[0].name, seeded.seats[1].name],
						ai: [seeded.seats[0].ai, seeded.seats[1].ai],
						decks: [0, 1].map((seat) => seatDeckColors(seeded, seat, deps.deckCosts)),
						startedAt,
					},
					log,
				});
				const positions = new Map<number, SeatPosition>([
					[0, createSeatPosition(0)],
					[1, createSeatPosition(1)],
				]);
				const session: Session = { writer, positions, startedAtMs: now() };
				// Every ask's callId per seat, in the order Forge sent them: a reply's `ask` number.
				const asks = new Map<number, string[]>();
				sessions.set(matchId, session);

				const host = inner(matchId, seeded, {
					...events,
					line: (line) => {
						if (line.t === 'frame') {
							guarded(log, matchId, 'position', () => {
								positions.get(line.seat)?.push(line);
								const frame = line.frame as { kind?: string; callId?: unknown };
								if (frame.kind !== 'ask' || typeof frame.callId !== 'string') return;
								const seen = asks.get(line.seat) ?? [];
								seen.push(frame.callId);
								asks.set(line.seat, seen);
							});
						}
						events.line(line);
					},
					// A match that ends without a game over (stopped, crashed) is finished here, winnerless.
					exit: (reason) => {
						if (sessions.get(matchId) === session) {
							sessions.delete(matchId);
							const endedAt = new Date(now()).toISOString();
							void writer.finish({ endedAt, reason }, { endedAt, winner: null });
						}
						events.exit(reason);
					},
				});

				return {
					...host,
					send(command: BridgeCommand) {
						guarded(log, matchId, 'command', () => {
							const seat = 'seat' in command ? command.seat : null;
							const position = seat === null ? undefined : positions.get(seat);
							const ask = command.t === 'reply' || command.t === 'abort' ? asks.get(command.seat)?.indexOf(command.callId) ?? -1 : -1;
							writer.actionCmd({ seat, board: position?.digest() ?? '', prompt: position?.prompt() ?? '', ...(ask >= 0 ? { ask } : {}), cmd: command });
						});
						host.send(command);
					},
				};
			}) as MatchHostFactory;
			// `close`, `orphans`, `attach`, `handOverAll`, `reapOnExit`, `spare`, `watchSpare`: passed through as-is.
			// A reattached match (`attach`) gets no session and is not recorded — see the module header.
			Object.assign(wrapped, inner);
			return wrapped;
		},

		onEnvelope(matchId, seat, envelope) {
			if (seat !== WATCHER_SEAT) return;
			const session = sessions.get(matchId);
			if (session === undefined) return;
			guarded(log, matchId, 'envelope', () => session.writer.publicEnv({ at: now() - session.startedAtMs, env: envelope }));
		},

		// The recording is finished when the game is, not when its JVM goes: a finished match keeps
		// its JVM through the over-grace, and its replay should not wait for that.
		onGameOver(match) {
			const session = sessions.get(match.id);
			if (session === undefined) return;
			const outcome = gameOutcome(match);
			sessions.delete(match.id);
			const endedAt = new Date(now()).toISOString();
			void session.writer.finish({ endedAt, reason: 'game-over' }, { endedAt, winner: outcome?.kind === 'won' ? outcome.winner : null });
		},
	};
}
