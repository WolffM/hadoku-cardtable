/**
 * The two socket surfaces and the matches: the draft socket and the room feed, where matches run
 * (this machine's pool or placement across the claws), play itself, and the room sweep.
 */
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '../config.js';
import { sweepRooms } from '../boot.js';
import { attachPlay, coldStartsFrom, jvmHostFactory, roomFormatNames, spellCopierLookup, type PlayHandle } from '../play/index.js';
import { clawPlacement, registryRestorer } from '../play/placement/index.js';
import { reportingAlerts } from '../telemetry.js';
import { httpDraftbot, type Draftbot } from '../room/draftbot.js';
import { attachRoomFeed } from '../room/watching.js';
import { attachSessions, playsIn } from '../room/session.js';
import { attachDraftSocket } from '../room/socket.js';
import type { CardtablePlugin } from './state.js';

/**
 * A room untouched for its idle window is forgotten, and a game that has run `GAME_DRAWN_AFTER_MS`
 * is called a draw (`boot.ts`'s `sweepRooms`): at boot, since this process restarts on every deploy
 * and at 08:00 UTC, and this often, so a game is drawn close to its eighth hour.
 */
const ROOM_SWEEP_MS = 5 * 60_000;
const SHUTDOWN_WORDS = 'The server is restarting for a deploy.';

export const playPlugin: CardtablePlugin = {
	name: 'play',
	phase: 'sockets',
	setup(ctx) {
		const { io, api, state } = ctx;
		const { forge, lobby, tables, recorder, parked } = state;

		// The draft bot the claws run when matches are placed on them (`play/placement/draftbot.ts`);
		// else a plain service at CARDTABLE_DRAFTBOT_URL (a dev box).
		const clawsDraftbot: Draftbot | undefined =
			CONFIG.playHosts === 'claws'
				? { batchDraft: (inputs, signal) => (state.clawHosts === null ? Promise.reject(new Error('no Forge hosts, so no claw runs the draft bot')) : state.clawHosts.draftbot.batchDraft(inputs, signal)) }
				: undefined;
		// One live tab per player per room (`room/session.ts`), over every socket of a room: the screen's
		// own claim, the pod's draft socket and the match socket. `play` is read lazily: it is attached below.
		let played: PlayHandle | null = null;
		const sessions = attachSessions(io, {
			isPlayer: (room, participantId) => {
				const view = lobby.get(room);
				if (view !== undefined) return playsIn(view, participantId);
				// A match no room holds is its own room (`App.tsx`'s `roomIdFor`).
				const match = played?.matches.get(room);
				return match !== undefined && match.seatOf(participantId) !== null;
			},
		});
		state.draftSocket = attachDraftSocket(io, {
			sessions,
			rooms: state.draftRooms,
			lobby,
			minTier: CONFIG.minTier,
			botPickMs: CONFIG.draftBotPickMs,
			draftbot: clawsDraftbot ?? (CONFIG.draftbotUrl ? httpDraftbot(CONFIG.draftbotUrl, CONFIG.draftbotToken || undefined) : undefined),
		});
		ctx.counts(() => ({ draftbotPicks: state.draftSocket.draftbotPicks() }));
		// Every room write, pushed to the screens that have the room (or the list) open, so none of
		// them reads it on a timer. Behind the gate attachDraftSocket installed.
		state.roomFeed = attachRoomFeed(io, { lobby });

		// Where matches run (`CARDTABLE_PLAY_HOSTS`): this machine's pool, or placement across the claws
		// with this machine as the backstop. Every alert placement posts is also a service event.
		const { placementLog } = state;
		state.clawHosts = forge.ok && CONFIG.playHosts === 'claws' ? clawPlacement(forge.config, { webhook: CONFIG.alertWebhook, forceFile: CONFIG.backstopForceFile, restartGraceMs: CONFIG.restartGraceMs, log: reportingAlerts(placementLog), fleet: state.primedFleet }) : null;
		state.localHost = forge.ok && state.clawHosts === null ? jvmHostFactory(forge.config) : null;
		const { clawHosts, localHost } = state;
		placementLog({ evt: 'play-hosts', mode: forge.ok ? CONFIG.playHosts : 'none', alerts: CONFIG.alertWebhook === '' ? 'logged only' : 'discord' });

		const play = attachPlay(io, api, {
			minTier: CONFIG.minTier,
			sessions: { handle: sessions, room: (matchId) => lobby.roomOfMatch(matchId)?.id ?? matchId },
			build: state.serverBuild,
			host: clawHosts !== null ? recorder.host(clawHosts) : localHost !== null ? recorder.host(localHost) : null,
			hosts: () => clawHosts?.hosts() ?? { mode: localHost === null ? 'none' : 'local', jvms: localHost?.jvms() ?? [] },
			// Match JVMs booting at once (`play/start-queue.ts`); `CARDTABLE_PLAY_COLD_STARTS`.
			coldStarts: coldStartsFrom(),
			// Diagnostics for a live check only. Never set in production (see play/socket.ts).
			probe: CONFIG.playProbe,
			...(CONFIG.testNoRateLimits ? { startRateLimit: null, restartRateLimit: null } : {}),
			devIdentity: CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '',
			// The stats report, the room's own series ledger (recorded at once rather than on the next
			// `/api/tables` read), the recorder's winner for the stream's `end` line, and the parked
			// store, for which a resumed game played to the end is finished with.
			onGameOver: (match) => {
				state.matchStats.gameOver(match);
				tables.gameOver(match);
				recorder.onGameOver(match);
				parked.finished(match.id);
			},
			onAbandoned: (match) => {
				parked.park(match);
			},
			...(CONFIG.playRejoinGraceMs === undefined ? {} : { rejoinGraceMs: CONFIG.playRejoinGraceMs }),
			// The registry's `emit`, for every seat, before it reaches a socket; the recorder keeps only the watcher's.
			onEnvelope: (matchId, seat, envelope) => recorder.onEnvelope(matchId, seat, envelope),
			onPresence: (matchId, seat, playerId, presence) => recorder.onPresence(matchId, seat, playerId, presence),
			onRelay: (matchId, event, echo) => recorder.onRelay(matchId, event, echo),
			keys: state.statsKeys,
			// A card-name ask offers the names of the default cube's pool: a static reference set for
			// autocomplete and costs across every constructed table.
			formatNames: roomFormatNames(tables.library, state.defaultCubeCards),
			// Every card a seat is sent carries its art id, decided from the catalog (`play/art-ids.ts`).
			catalog: state.catalog,
			// A seat's own spell is held while it can play a card that copies it (`play/spell-copiers.ts`).
			...(forge.ok ? { spellCopiers: spellCopierLookup(forge.config.res, jsonLogger('cardtable-play')) } : {}),
			// A seat's face is its holder's avatar in the room that started the match.
			seatAvatar: tables.seatAvatar,
			seatLook: tables.seatLook,
			// A seat's deck colours pick the match's music (`play/deck-colors.ts`).
			deckCosts: state.deckCosts,
			// A table's game moved on: its room's screens read the room again for the table card.
			liveChanged: (match) => {
				const room = lobby.roomOfMatch(match.id);
				if (room !== undefined) state.roomFeed.changed(room.id);
				state.featured.refresh();
			},
		});
		state.play = play;
		played = play;
		// Failover restores through the registry, which exists only now.
		if (clawHosts !== null) clawHosts.restoreWith(registryRestorer(play.matches));
		ctx.bootPhase('play');
		// Once play has adopted every match an earlier server left running, a room still pointing at one
		// that did not come back lets go of it. Not before: a deploy cleared a live match's table that
		// way. The server does not wait for it to listen (prod's v0.53.0 restart spent 19.7 s here with
		// the site down); play's joins and routes wait instead.
		const adoptingFrom = performance.now();
		void play.adopted.then(() => {
			tables.releaseGoneMatches();
			jsonLogger('cardtable')({ evt: 'play-adopted', ms: Math.round(performance.now() - adoptingFrom), at: Math.round(performance.now()) });
		});

		const sweepAll = (now?: number): void => sweepRooms(lobby, state.roomsLog, { matches: play.matches.active(), ...(now === undefined ? {} : { now }) });
		setInterval(() => sweepAll(), ROOM_SWEEP_MS).unref();
		// Diagnostics only, like play's own probes: the sweep run on a clock `aheadMs` from now, so a spec
		// can see a game its eight hours old end (`e2e/w82-forced-draw.spec.ts`). Never in production.
		if (CONFIG.playProbe) {
			api.post('/play/sweep', (req, res) => {
				const aheadMs = Number((req.body as { aheadMs?: unknown } | undefined)?.aheadMs ?? 0);
				if (!Number.isFinite(aheadMs)) {
					res.status(400).json({ error: 'aheadMs is a number of milliseconds' });
					return;
				}
				sweepAll(Date.now() + aheadMs);
				res.status(204).end();
			});
		}

		ctx.gauge('matches', () => play.matches.active().filter((m) => m.status === 'starting' || m.status === 'running').length);
		ctx.gauge('jvms', () => clawHosts?.hosts().hosts.reduce((n, h) => n + h.jvms.length, 0) ?? localHost?.jvms().length ?? 0);
		if (CONFIG.playHosts === 'claws') ctx.gauge('forgeFree', () => clawHosts?.hosts().hosts.filter((h) => h.eligible).reduce((n, h) => n + h.free, 0) ?? 0);

		return {
			// Start nothing new, leave every live match running for the next process to re-attach (its JVM
			// detached with its transport on disk, `host.ts`), tell the seats of any that cannot be left
			// running in words, and kill the JVM of every match not left running.
			shutdown: () => {
				const say = jsonLogger('cardtable');
				let outcome: ReturnType<PlayHandle['shutdown']> = { handed: [], ended: [], reaped: { killed: [], kept: [], left: [] } };
				try {
					outcome = play.shutdown(SHUTDOWN_WORDS);
				} catch (err) {
					// A match that will not let go must not stop the rest of the shutdown.
					say({ evt: 'shutdown-matches-failed', error: (err as Error).message });
				}
				say({ evt: 'shutdown-matches', handed: outcome.handed, ended: outcome.ended });
				// What is left of Forge: `left` would be the finished-game JVM leak coming back.
				say({ evt: 'shutdown-jvms', ...outcome.reaped });
				return { handed: outcome.handed.length, ended: outcome.ended.length };
			},
		};
	},
};
