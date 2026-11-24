/**
 * The relay runtime's socket route. Thin by design — the logic lives in
 * `play/relay-socket.ts`, which this file only wires to the running
 * server's own `io`. `rosterOf` reads `runtimes/relay-match.ts`'s one
 * shared registry; `ctx.state.lobby.onRelayRoomOpened` is wired HERE, at
 * boot, to put a `RelayMatch` into it the moment a `runtime: 'relay'` room
 * is created — `room/lobby.ts` calls the hook but never imports this
 * module (or `relay-match.ts`) itself, which would close an import cycle
 * back to `match.ts`'s `HostedMatch` (see `Lobby.onRelayRoomOpened`'s own
 * doc for the full cycle). `roomsPlugin` (which builds `state.lobby`) runs
 * well before this plugin in the site's `PLUGINS` order (`apps/server/src/plugins/index.ts`), so
 * the hook is always set before any room can be created.
 *
 * Also registers a TEST-ONLY game type, `relay-test` — two seats,
 * `runtime: 'relay'`, no `GameCodec` (it quarantines on a restart, same as
 * any unpersisted type) — but only `CARDTABLE_PLAY_PROBE=1`'s own posture:
 * the `e2e/play/harness.ts` stack sets it unconditionally, the plain
 * `e2e/harness.ts` stack never does, and production never does either. So
 * `relay-test` is never in production's registry, reachable only from the
 * one e2e stack that opts into dev diagnostics —
 * the same gate `MatchSpec.scenario` already uses for the same reason
 * (`host.ts`'s own doc on that field).
 *
 * A relay match the leader ends (`{ t: 'over', winners }`) is reported to the game-stats store under
 * the ROOM's game type (Bomberman's rooms post as `bomberman`, an outside game's as its own id), with
 * this server's service key and each seat's key from the stats key book (`relayOutcomeReport`). A
 * testing room's match, a match every seat walked out of, and a lone player's are not reported.
 */
import { randomUUID } from 'node:crypto';
import { gameTypeSpec, registerGameType } from '@hadoku/shared';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '@hadoku/game-server/config';
import { gateSocketIo } from '@hadoku/game-server/gate';
import { attachRelay } from '@hadoku/game-server/play/relay-socket';
import { relayMatches } from '@hadoku/game-server/play/runtimes/relay-match';
import { roomAdmits } from '@hadoku/game-server/room/tier-floor';
import { relayOutcomeReport } from '@hadoku/game-server/stats/relay-results';
import { createStatsReporter, type StatsReporter } from '@hadoku/game-server/stats/reporter';
import { MAGIC_CONFIG } from '../config.js';
import type { CardtablePlugin } from './state.js';

/** The e2e fixture's own game type — see this file's own header. Exported only for its test. */
export const RELAY_TEST_GAME_TYPE = 'relay-test';

export const relayPlugin: CardtablePlugin = {
	name: 'relay',
	phase: 'sockets',
	setup(ctx) {
		if (MAGIC_CONFIG.playProbe) {
			registerGameType({
				id: RELAY_TEST_GAME_TYPE,
				runtime: 'relay',
				seats: { min: 2, max: 2 },
				ready: false,
				series: { length: 1 },
				canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
			});
		}
		const log = (entry: Record<string, unknown>): void => ctx.state.roomsLog(entry);
		// The game type's own rejoin grace reaches the match here: a seat that drops is held that
		// long (bomberman's is its own server's seat hold), then leaves the match.
		// Each socket is seated where the room seats its owner (`Lobby.gameSeatOf`), and only the
		// seat the room's leader holds ends a match.
		const { lobby } = ctx.state;
		lobby.onRelayRoomOpened((roomId, seatCount, gameType) => {
			const seatRejoinGraceMs = gameTypeSpec(gameType)?.seatRejoinGraceMs;
			relayMatches.register(roomId, seatCount, {
				log,
				roomSeatOf: (participantId) => lobby.gameSeatOf(roomId, participantId),
				leaderSeat: () => {
					const leader = lobby.get(roomId)?.leader;
					return leader === undefined ? null : lobby.gameSeatOf(roomId, leader);
				},
				...(seatRejoinGraceMs === undefined ? {} : { seatRejoinGraceMs }),
			});
		});
		// `gate` passed explicitly, not left to `attachRelay`'s own default
		// (`docs/planning/s3-2026-11-17.md` §G.3): that default is now a generic, safe-by-default
		// one (never reads any ONE app's env var, bomberman's included), so cardtable's own
		// bare-local hatch (`CARDTABLE_INSECURE_NO_EDGE_AUTH`) needs this app's OWN gate — the
		// same binding (`../gate.ts`) every other socket on this server already uses.
		const statsLog = jsonLogger('cardtable-relay-stats');
		const reporters = new Map<string, StatsReporter>();
		const reporterFor = (gameId: string): StatsReporter => {
			let reporter = reporters.get(gameId);
			if (reporter === undefined) {
				reporter = createStatsReporter({ gameId, serviceKey: CONFIG.serviceKey, serviceKeyEnvVar: 'CARDTABLE_SERVICE_KEY', baseUrl: CONFIG.statsBaseUrl, log: statsLog });
				reporters.set(gameId, reporter);
			}
			return reporter;
		};
		const { statsKeys } = ctx.state;
		const relay = attachRelay(ctx.io, {
			minTier: CONFIG.minTier,
			rosterOf: (matchId) => relayMatches.get(matchId),
			admits: (matchId, participantId, tier) => roomAdmits(lobby.get(matchId), lobby.isMember(matchId, participantId), tier),
			onEnded: (roomId, outcome) => {
				const room = lobby.get(roomId);
				if (outcome === null || room === undefined || room.testing) return;
				const report = relayOutcomeReport({
					room,
					userKeys: { get: (participantId) => statsKeys.keyOf(participantId) ?? undefined },
					winners: outcome.winners,
					// The relay match lives under the room's id, round after round: each report needs its own.
					matchId: randomUUID(),
					roomId,
					endedAt: Date.now(),
				});
				if (report === null) {
					statsLog({ evt: 'stats-skipped', roomId, gameType: room.gameType, reason: 'fewer-than-two-seated' });
					return;
				}
				reporterFor(room.gameType).report(report);
			},
			log,
			gate: { gateSocketIo },
		});
		return {
			shutdown: () => {
				relay.close();
				for (const reporter of reporters.values()) void reporter.idle();
			},
		};
	},
};
