/**
 * A relay game's whole server: `startRelayGame({...})`, and the game is its config.
 *
 * A relay game runs its match in one browser, its host's, and the relay carries it to the others
 * (`play/relay-socket.ts`): the server keeps no game state, only the rooms around it. Every such
 * game needs the same server, so it is here, once — bomberman's `index.ts` and the game
 * template's plugins each built it by hand before.
 *
 *   the kernel     `@hadoku/service-kernel/server`'s `createGameServer`: express, socket.io,
 *                  provenance and the tier floor, `/health`, telemetry, account erase, listen, the
 *                  deploy handover and shutdown
 *   config + auth  `createConfig` under the game's env prefix and defaults; `createGameAuth`
 *   lobby          the rooms, restored from disk (`plainRoomType`: marked seats, one kept open,
 *                  a persona per bot), swept when idle, and each one's relay match
 *   people         every member named and dressed from their account (`attachPeople`)
 *   rooms          `/api/rooms*` (room-core, with its seat routes) and `/:id/start`, the
 *                  countdown every page counts to (`room/starts.ts`)
 *   page           the game's own static directories, then index.html for every client route
 *   /room          chat, roster and presence (`room/serve.ts`)
 *   relay + feed   the match socket, and the room list pushed to the front page
 *
 * A game adds only what is its own, as more kernel plugins (bomberman's round results), reading
 * the shared parts from `ctx.state`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import { PresenceTracker } from '@wolffm/rooms-server';
import { FileRoomStore } from '@wolffm/rooms-server/store';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { diagnosticPage, sendIndex } from '@hadoku/service-kernel/http';
import { createGameServer, type GamePlugin, type GameServer, type GameServerConfig as KernelConfig } from '@hadoku/service-kernel/server';
import { monitoringSink, siteOf } from '@hadoku/service-kernel/telemetry';
import type { HealthExtra } from '@hadoku/service-kernel/health';

import { createGameAuth, type GameAuth } from './auth.js';
import { createConfig, type GameServerConfig } from './config.js';
import { fkOf } from './erase/index.js';
import { roomsEraseSteps } from './erase/rooms.js';
import { attachRoomCore, badRequest, noMatch } from './http/room-core.js';
import { callerOf } from './http/request.js';
import { attachPeople, createPeople, type People } from './people.js';
import { attachRelay } from './play/relay-socket.js';
import { roomAdmits } from './room/tier-floor.js';
import { relayMatches } from './play/runtimes/relay-match.js';
import { configureParticipantIdDomain, identityFromHeaders } from './room/identity.js';
import { RoomLobby, plainRoomType, type PlainRoomSize, type PlainRoomView, type PlatformRoomView, type RoomCreateInput, type RoomTypeHooks } from './room/lobby.js';
import { attachServedRoom } from './room/serve.js';
import { COUNTDOWN_MS, createStarts, type Starts } from './room/starts.js';
import { attachRoomFeed } from './room/watching.js';
import { createStatsReporter } from './stats/reporter.js';
import { attachResultRoute, type ReportOutcome, type RoundContext } from './stats/relay-results.js';

/** A relay room: the platform's view, its bots and, while one is pending, its start. */
export type RelayRoomView = PlatformRoomView & PlainRoomView & { start: ReturnType<Starts['view']> };

/** The lobby a relay game's rooms live in: a room IS its match, and there is one game type. */
export class RelayLobby extends RoomLobby<RelayRoomView, RoomCreateInput> {
	readonly #gameType: string;

	constructor(deps: ConstructorParameters<typeof RoomLobby<RelayRoomView, RoomCreateInput>>[0], gameType: string) {
		super(deps);
		this.#gameType = gameType;
	}

	/** A relay room's match id is its room id. */
	roomOfMatch(matchId: string): RelayRoomView | undefined {
		return this.get(matchId);
	}

	setGameType(roomId: string, _callerId: string, gameType: string): { ok: true; room: RelayRoomView } | { ok: false; reason: string } {
		const room = this.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		return gameType === this.#gameType ? { ok: true, room } : { ok: false, reason: 'mode-locked' };
	}
}

/** What every plugin of a relay game reads: the shared parts, built in the kit's own phases. */
export interface RelayGameState {
	config: GameServerConfig;
	auth: GameAuth;
	/** From the `stores` phase on. */
	lobby: RelayLobby;
	people: People;
	starts: Starts;
	/** Each `/room` connection's friend key, by participant id: the key its round results are reported under. */
	userKeys: Map<string, string>;
}

export type RelayGamePlugin = GamePlugin<Record<string, never>, RelayGameState>;

/** A directory served beside the bundle (bomberman's `/game`, its WASM build). */
export interface StaticDir {
	/** The URL path it is served at, `/game`. */
	path: string;
	dir: string;
	/** Files that never change under their name (a hashed build): cached a year. Everything else revalidates. */
	immutable?: RegExp;
	/** Its index, which must exist for the directory to count as built. Default `index.html`. */
	index?: string;
	/** What a request under `path` answers while it is not built (503). */
	missing: string;
	/** A directory that is not built degrades `/health`, saying this, with `field: 'missing'`. */
	health?: { field: string; problem: string };
}

export interface RelayGameOptions {
	/** The game's id: its log services (`<id>-rooms`, …), its restart event, the `/room` app id. */
	id: string;
	/** Its name, as the page that stands in for a broken bundle says it. */
	name: string;
	/** Its env vars are `<envPrefix>_<NAME>`. */
	envPrefix: string;
	/** The server package's root: what a relative directory resolves against. */
	root: string;
	/** The checkout, for `/health`'s commit. */
	repoRoot: string;
	/** The game's own config defaults by unprefixed name (`PORT`, `BASE_PREFIX`, `ROOMS_DIR`, …). */
	defaults: Readonly<Record<string, string>>;
	/** A game the edge serves to everyone may set its floor to `public`; any other refuses it at boot. */
	allowPublic?: boolean;
	/** The participant-id domain, so ids are this game's own and never another's (`room/identity.ts`). */
	participantDomain: string;
	gameType: string;
	/** A room id as this game's wire admits it. */
	roomIdRe: RegExp;
	/** The room's seats: how many it opens with, the most it grows to, and the relay match's seat count. */
	seats: Pick<PlainRoomSize, 'seats' | 'max' | 'relaySeats'>;
	/** The bundle's fixed-name embed entries; everything else it emits is hashed. */
	embedEntries?: readonly string[];
	statics?: readonly StaticDir[];
	/** The countdown a Start counts down (ms). Default `COUNTDOWN_MS`. */
	countdownMs?: number;
	/**
	 * The game's round results, reported to the game-stats store under the game's id
	 * (`stats/relay-results.ts`): its bundle's payload as the store's report. Absent: no `/result` route.
	 */
	results?: {
		toReport(raw: unknown, ctx: RoundContext): ReportOutcome;
		/** The match roster's id for a bot in `seat`. Default `ai:<seat>`. */
		botClientId?: (seat: number) => string;
	};
	/** More of the game's own plugins, run in their phases after the kit's own of the same phase. */
	plugins?: readonly RelayGamePlugin[];
	/** Kernel config to override (a test's port, signals off). */
	kernel?: Partial<KernelConfig>;
}

/** A non-negative int setting: the env's, else the game's default, else `fallback`. */
function intSetting(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function startRelayGame(options: RelayGameOptions): Promise<GameServer<Record<string, never>, RelayGameState>> {
	// Before anything derives an id: every room, relay and HTTP surface below mints them.
	configureParticipantIdDomain(options.participantDomain);
	const { id, envPrefix } = options;
	const env = process.env;
	const config = createConfig({ envPrefix, root: options.root, defaults: options.defaults, ...(options.allowPublic === true ? { allowPublic: true } : {}) });
	const auth = createGameAuth(config, { svc: id });
	mkdirSync(config.logDir, { recursive: true });

	const setting = (name: string): string | undefined => env[`${envPrefix}_${name}`] ?? options.defaults[name];
	const seatHoldMs = intSetting(setting('SEAT_HOLD_MS'), 120_000);
	const disconnectGraceMs = intSetting(setting('DISCONNECT_GRACE_MS'), 5_000);
	// Never below the seat hold: a room whose seats are still held for returning players must
	// outlive the hold, or the sweep loses a game in progress.
	const roomIdleMs = Math.max(intSetting(setting('ROOM_IDLE_MS'), 6 * 60 * 60 * 1000), seatHoldMs + 30_000);

	const log = jsonLogger(id);
	const roomsLog = jsonLogger(`${id}-rooms`);
	const relayLog = jsonLogger(`${id}-relay`);
	const statics = (options.statics ?? []).map((s) => ({ ...s, built: existsSync(join(s.dir, s.index ?? 'index.html')) }));
	const starts = createStarts({ countdownMs: options.countdownMs ?? COUNTDOWN_MS });

	const base = plainRoomType<RoomCreateInput>({ ...options.seats, markedSeats: true, keepOneOpen: true });
	const roomType: RoomTypeHooks<Record<string, never>, RoomCreateInput> = {
		...base,
		/** A pending start rides on every room body: every page counts down to it. */
		view: (room) => ({ ...base.view(room), start: starts.view(room.id) }),
	};

	const state = { config, auth, starts, userKeys: new Map<string, string>() } as RelayGameState;

	const lobbyPlugin: RelayGamePlugin = {
		name: 'lobby',
		phase: 'stores',
		async setup(ctx) {
			const lobby = new RelayLobby(
				{
					store: new FileRoomStore(config.roomsDir),
					now: Date.now,
					log: roomsLog,
					typeOf: (gameType) => (gameType === options.gameType ? (roomType as RoomTypeHooks<unknown, RoomCreateInput>) : undefined),
					watchpartyRoom: { name: 'Room', gameType: options.gameType },
				},
				options.gameType,
			);
			const restored = await lobby.open();
			roomsLog({ evt: 'lobby-open', rooms: restored });
			ctx.state.lobby = lobby;
			ctx.gauge('rooms', () => lobby.list().length);
			lobby.onChange((roomId) => {
				if (lobby.get(roomId) === undefined) starts.forget(roomId);
			});
			// A room IS its match: one relay match per room, opened as the room is.
			lobby.onRelayRoomOpened((roomId, seatCount) => {
				relayMatches.register(roomId, seatCount, {
					log: relayLog,
					roomSeatOf: (participantId) => lobby.gameSeatOf(roomId, participantId),
					// A round's end is taken from the HOST of the room's match (whom `starts` named),
					// falling back to the leader's seat while nobody hosts or the host left theirs.
					leaderSeat: () => {
						const host = starts.hostOf(roomId);
						const hostSeat = host === null ? null : lobby.gameSeatOf(roomId, host);
						if (hostSeat !== null) return hostSeat;
						const leader = lobby.get(roomId)?.leader;
						return leader === undefined ? null : lobby.gameSeatOf(roomId, leader);
					},
					seatRejoinGraceMs: seatHoldMs,
				});
			});
			const sweep = setInterval(() => lobby.sweep(roomIdleMs), 60_000);
			sweep.unref();

			const people = createPeople({
				baseUrl: config.prefsBaseUrl,
				serviceKey: config.serviceKey,
				keyless: config.testPeopleStandIn,
				log: jsonLogger(`${id}-people`),
			});
			ctx.state.people = people;
			// Every member named and dressed from their account: as a room changes, once over the
			// restored rooms now, and fresh as each one arrives (room-core's `arrived`, below).
			const accounts = attachPeople(lobby, people);
			void accounts.sweep();
			arrived = (roomId, memberId, userId) => void accounts.arrived(roomId, memberId, userId);
			return {
				shutdown: () => {
					clearInterval(sweep);
					accounts.stop();
					void lobby.removed();
				},
				erase: roomsEraseSteps({ lobby, liveMatches: () => [], forfeit: () => {}, closed: () => {}, forfeited: () => {} }),
			};
		},
	};

	let arrived: (roomId: string, memberId: string, userId: string) => void = () => {};
	// The room feed, from the `sockets` phase on: a pending start is no lobby write, so its route
	// pings the room's watchers itself, or every page but the starter's missed the countdown.
	let feedChanged: (roomId: string) => void = () => {};
	// The chat's roster by room, once the room socket is up (`socketsPlugin`).
	let roomHere: (roomId: string) => ReadonlySet<string> = () => new Set();

	const roomsPlugin: RelayGamePlugin = {
		name: 'rooms',
		phase: 'routes',
		setup(ctx) {
			const lobby = ctx.state.lobby;
			const roomCore = attachRoomCore(ctx.api, {
				lobby,
				wire: relayWire(options.gameType, options.roomIdRe),
				seatRoutes: lobby,
				here: (roomId) => roomHere(roomId),
				arrived: (roomId, caller) => {
					if (caller.userId !== null) arrived(roomId, caller.id, caller.userId);
				},
				log: roomsLog,
			});
			// The leader's (seated or watching) or a seated player's Start: a pending start every
			// page counts down to, and its host. Answers the room, as every seat route does.
			roomCore.router.post('/:id/start', (req: Request, res: Response) => {
				if (typeof req.body !== 'object' || req.body === null || Object.keys(req.body as object).length > 0) return badRequest(res, 'expected an empty body');
				const caller = callerOf(req);
				const roomId = String(req.params.id);
				if (!options.roomIdRe.test(roomId)) return noMatch(res);
				const room = lobby.get(roomId);
				if (room === undefined || !lobby.isMember(roomId, caller.id)) return noMatch(res);
				const result = starts.request(room, caller.id);
				if (!result.ok) return badRequest(res, result.reason);
				feedChanged(roomId);
				// Read again: the view is built per read, and this one now carries the start.
				res.json(roomCore.roomBody(lobby.get(roomId) ?? room, caller.id));
			});
			const results = options.results;
			if (results !== undefined) {
				const statsLog = jsonLogger(`${id}-stats`);
				const stats = createStatsReporter({ gameId: id, serviceKey: config.serviceKey, serviceKeyEnvVar: `${envPrefix}_SERVICE_KEY`, log: statsLog });
				attachResultRoute(ctx.api, {
					lobby,
					userKeys: ctx.state.userKeys,
					stats,
					toReport: results.toReport,
					...(results.botClientId === undefined ? {} : { botClientId: results.botClientId }),
					log: statsLog,
				});
				return { shutdown: () => void stats.idle() };
			}
		},
	};

	const pagePlugin: RelayGamePlugin = {
		name: 'page',
		phase: 'routes',
		setup(ctx) {
			for (const s of statics) {
				if (s.built) {
					ctx.app.use(
						s.path,
						express.static(s.dir, {
							index: s.index ?? 'index.html',
							redirect: false,
							setHeaders: (res, filePath) => {
								res.setHeader('Cache-Control', s.immutable?.test(filePath) === true ? 'public, max-age=31536000, immutable' : 'no-cache');
							},
						}),
					);
				}
				ctx.app.use(s.path, (_req: Request, res: Response) => {
					if (s.built) res.status(404).type('text').send('Not found');
					else res.status(503).type('text').send(s.missing);
				});
			}
			// The embed's own files are the static bundle's; anything else under it is no page.
			ctx.app.use('/embed', (_req: Request, res: Response) => {
				res.status(404).type('text').send('no such embed file');
			});
			ctx.app.get(/.*/, (_req: Request, res: Response, next: NextFunction) => {
				if (!ctx.bundle.ok) {
					res.status(503).type('html').send(diagnosticPage(ctx.bundle, config.basePrefix, options.name));
					return;
				}
				sendIndex(res, join(config.webDir, 'index.html'), (err) => err && next(err));
			});
		},
	};

	const socketsPlugin: RelayGamePlugin = {
		name: 'sockets',
		phase: 'sockets',
		async setup(ctx) {
			const lobby = ctx.state.lobby;
			// The relay first: it installs the engine-wide provenance sanitizer `/room`'s admit relies on.
			const relay = attachRelay(ctx.io, {
				minTier: config.minTier,
				gate: auth.gate,
				rosterOf: (matchId) => relayMatches.get(matchId),
				admits: (matchId, participantId, tier) => roomAdmits(lobby.get(matchId), lobby.isMember(matchId, participantId), tier),
				log: relayLog,
			});
			// The room's own presence: its grace is not the relay seat's hold.
			const presence = new PresenceTracker<string>({ idleMs: 2_000_000_000, graceMs: disconnectGraceMs });
			const roomLog = jsonLogger(`${id}-room`);
			const served = await attachServedRoom(ctx.io, {
				lobby,
				presence,
				onRoster: (roomId) => feedChanged(roomId),
				people: ctx.state.people,
				isMatch: (matchId) => relayMatches.get(matchId) !== undefined,
				minTier: config.minTier,
				stateDir: () => config.roomsDir,
				appId: id,
				roomIdRe: options.roomIdRe,
				namespace: '/room',
				// Every refusal on `/room` is logged; a silent one looks like dead chat.
				onEvent: (level, event, fields) => {
					if (level !== 'debug') roomLog({ level, evt: event, ...fields });
				},
			});
			// Each connection's own friend key, from ITS handshake (sanitized by the relay's provenance
			// check above): the key its round results are reported under.
			ctx.io.of('/room').on('connection', (socket) => {
				const key = socket.request.headers['x-user-key'];
				if (typeof key !== 'string' || key === '') return;
				ctx.state.userKeys.set(identityFromHeaders(socket.request.headers, socket.id), key);
			});
			const feed = attachRoomFeed(ctx.io, { lobby, log: jsonLogger(`${id}-feed`) });
			feedChanged = (roomId) => feed.changed(roomId);
			roomHere = served.here;
			return {
				shutdown: () => {
					relay.close();
					feed.close();
				},
			};
		},
	};

	const health = (): HealthExtra => {
		const fields: Record<string, unknown> = {};
		const problems: string[] = [];
		for (const s of statics) {
			if (s.health === undefined) continue;
			fields[s.health.field] = s.built ? 'built' : 'missing';
			if (!s.built) problems.push(s.health.problem);
		}
		fields.rooms = state.lobby?.list().length ?? 0;
		return { fields, problems };
	};

	const server = await createGameServer<Record<string, never>, RelayGameState>({
		id,
		config: {
			host: config.host,
			port: config.port,
			log,
			edgeAuth: auth.edgeAuth,
			gate: auth.gate,
			basePrefix: config.basePrefix,
			bundle: { indexHtml: join(config.webDir, 'index.html'), webDir: config.webDir, embedEntries: options.embedEntries ?? [] },
			repoRoot: options.repoRoot,
			health,
			restartEvent: `${id}:restarting`,
			telemetry: () =>
				monitoringSink({
					baseUrl: config.monitoringBaseUrl,
					serviceKey: config.serviceKey,
					site: siteOf(config.basePrefix, id),
					log,
					service: id,
					serviceKeyEnvVar: `${envPrefix}_SERVICE_KEY`,
				}),
			firstSeen: { file: config.callersSeenFile, log },
			erase: { deriveParticipantId: fkOf },
			...options.kernel,
		},
		state,
		plugins: [lobbyPlugin, roomsPlugin, ...(options.plugins ?? []), pagePlugin, socketsPlugin],
	});
	return server;
}

/** The room routes' request bodies, for a game with one room type. */
function relayWire(gameType: string, roomIdRe: RegExp) {
	type Schema<T> = { safeParse(body: unknown): { success: true; data: T } | { success: false; error: { issues: { code: string; path: readonly PropertyKey[]; message: string }[] } } };
	const object = <T>(fields: Record<string, (v: unknown) => boolean>, required: readonly string[], message: string): Schema<T> => ({
		safeParse(body) {
			const ok =
				typeof body === 'object' &&
				body !== null &&
				!Array.isArray(body) &&
				Object.keys(body).every((k) => k in fields) &&
				required.every((k) => k in body) &&
				Object.entries(body).every(([k, v]) => fields[k]!(v));
			return ok ? { success: true, data: body as T } : { success: false, error: { issues: [{ code: 'invalid_type', path: [], message }] } };
		},
	});
	const text = (max: number, min = 0) => (v: unknown) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
	const optional = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v);
	return {
		roomIdRe,
		createRoomBody: object<{ name: string; gameType: string; password?: string }>(
			{ name: text(60, 1), gameType: (v) => v === gameType, password: optional(text(100)) },
			['name', 'gameType'],
			'expected { name, gameType, password? }',
		),
		joinRoomBody: object<{ password?: string }>({ password: optional(text(100)) }, [], 'expected { password? }'),
		readyBody: object<{ ready: boolean }>({ ready: (v) => typeof v === 'boolean' }, ['ready'], 'expected { ready }'),
		emptyBody: object<Record<string, never>>({}, [], 'expected an empty body'),
		watchpartyBindBody: object<{ room: string }>({ room: text(100, 1) }, ['room'], 'expected { room }'),
		patchRoomBody: object<{ gameType: string }>({ gameType: text(40, 1) }, ['gameType'], 'expected { gameType }'),
	};
}
