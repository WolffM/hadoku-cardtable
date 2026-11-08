/**
 * `createGameServer`: the one boot sequence every game's server runs, so a game is its config
 * and a list of plugins.
 *
 * ## What the kernel owns
 *
 * The express app and its `/api` router, the HTTP server and the socket.io server; edge
 * provenance and the tier floor (the app's `EdgeAuth` and `Gate`, `../auth` and `../http`);
 * `/health` and the local-only busy probe; the telemetry sink and the capacity sampler; the
 * account-erase route and its registry; the origin stamp; `listen`; and SIGTERM/SIGINT with
 * the restart notice, the connection grace and the shutdown deadline.
 *
 * ## The order a request meets
 *
 *   provenance → capacity → access log → /health, /health/busy, the erase route, the sealed routes
 *   → the tier floor → first-seen → /api (JSON body, then the plugins' routes)
 *   → the bundle's static files → the plugins' own app routes, in registration order
 *
 * Everything above the floor is public on purpose; a plugin registers nothing above it except on
 * `sealed`, which answers only a request carrying the edge's seal and passes every other one on to
 * the floor. The edge seals each request it proxies whatever the caller's tier, so a route there is
 * reachable through hadoku.me by anyone the edge itself lets through (a link-preview crawler, say),
 * and never by a direct hit on the tunnel.
 *
 * ## Boot phases
 *
 * `config → bundle → stores → routes → sockets → listen → warm`, each plugin's `setup` in
 * array order within its phase. The kernel checks the bundle at the start of `bundle` and
 * installs telemetry at its end, builds first-seen at the end of `config` (so a state-dir move in `config`
 * happens before it reads its file), and starts listening between `sockets` and `listen`:
 * `listen` and `warm` run once the server answers, `warm` last. The boot clock stamps each phase as it ends, unless the
 * config turns that off to keep a game's own names (`stampPhases: false`, `ctx.bootPhase`).
 *
 * ## Going down
 *
 * The first SIGTERM or SIGINT logs `shutdown-begin`, emits `shutdown` on the bus, runs every
 * plugin's `shutdown` in REVERSE setup order (the last thing built goes first), then tells
 * every socket the game's restart event, closes socket.io and the HTTP server, and lets
 * in-flight requests finish within `requestGraceMs`. It exits on the close or at
 * `deadlineMs`, whichever comes first, logging `shutdown-done` with the fields the plugins'
 * shutdowns returned.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express, type Request, type Response, type Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { callerIdOf, tierOf, userIdOf, type EdgeAuth } from '../auth/index.ts';
import { capacitySampler } from '../capacity/index.ts';
import { createAccountErase, ERASE_PATH, type EraseStep } from '../erase/index.ts';
import { healthResponse, readCommit, serviceIdOf } from '../health/index.ts';
import { checkBundle, isEmbedEntry, stampOrigin, type BasePathVerdict, type Gate } from '../http/index.ts';
import { bootClock, busyHandler, closeConnections, sendThenFlush, type BusyRun } from '../lifecycle/index.ts';
import type { JsonLog } from '../log/index.ts';
import { firstSeen, installTelemetry, type Report } from '../telemetry/index.ts';
import { createBus, type Bus, type EventMap, type KernelEvents } from './bus.ts';

export const PHASES = ['config', 'bundle', 'stores', 'routes', 'sockets', 'listen', 'warm'] as const;
export type Phase = (typeof PHASES)[number];

export interface GameServerConfig {
	host: string;
	port: number;
	/** The service's own lines: the boot clock, `shutdown-*`, and the erase route's. */
	log: JsonLog;
	/** The app's edge-auth binding: provenance on every request, the seal on the erase route. */
	edgeAuth: EdgeAuth;
	/** The app's gate: its `requireMinTier` is the HTTP floor. */
	gate: Gate;
	/** The prefix the edge serves this app under (`/<game>`); names `/health`'s service. */
	basePrefix: string;
	/** The built bundle: its index page, the directory served beside it, and the entry files that keep their names. */
	bundle: { indexHtml: string; webDir: string; embedEntries: readonly string[] };
	/** This instance's checkout, for `/health`'s commit. */
	repoRoot: string;
	/** The socket event that tells every client the server is restarting. */
	restartEvent: string;
	/** Built and installed after the `bundle` phase, before any plugin's route. Absent: events go nowhere. */
	telemetry?: () => Report;
	/** The accounts this server has admitted, kept across restarts (`caller-first-seen`). */
	firstSeen: { file: string; log: JsonLog };
	/** The app's own derived id for an erased account (`personOf`). */
	erase: { deriveParticipantId: (userId: string) => string };
	/** A request path counted on its own, never timed nor logged a line each, and its capacity field. */
	uncounted?: { path: (path: string) => boolean; field: string };
	/** `X-Hadoku-Origin`; defaults to the game's id. */
	origin?: string;
	/** Stamp each kernel phase on the boot clock (default true). */
	stampPhases?: boolean;
	shutdown?: { deadlineMs?: number; requestGraceMs?: number; restartFlushMs?: number };
	/** Install SIGTERM/SIGINT handlers (default true). */
	signals?: boolean;
	/** Ends the process once shut down; `process.exit` unless a test passes its own. */
	exit?: (code: number) => void;
}

export interface GameContext<E extends EventMap, S> {
	readonly id: string;
	readonly app: Express;
	/** Mounted at `/api`, below the floor, after the JSON body parser. */
	readonly api: Router;
	/** Above the floor, behind the edge's seal and no tier: what the edge itself serves publicly. */
	readonly sealed: Router;
	readonly httpServer: Server;
	readonly io: SocketIOServer;
	readonly bus: Bus<KernelEvents & E>;
	/** The bundle check's verdict, from the `bundle` phase on. */
	readonly bundle: BasePathVerdict;
	/** The game's own state, shared between its plugins. */
	readonly state: S;
	/** Stamp a named step on the boot clock. */
	bootPhase(name: string): void;
	/** Add a gauge to the capacity sample, read each sample. */
	gauge(name: string, read: () => number): void;
	/** Add counts to each capacity post, read once as it goes out. */
	counts(read: () => Record<string, unknown>): void;
	/** Add runs to the busy probe's answer. */
	busy(read: () => BusyRun[]): void;
}

export interface PluginHooks {
	/** Runs at shutdown, in reverse setup order; what it returns is added to `shutdown-done`. */
	shutdown?: () => Record<string, unknown> | void;
	/** Registered on the erase route in setup order. */
	erase?: EraseStep[];
	/** Runs once the server listens, in setup order, before the `listen` phase. */
	onListen?: () => void;
}

export interface GamePlugin<E extends EventMap, S> {
	name: string;
	phase: Phase;
	setup(ctx: GameContext<E, S>): PluginHooks | void | Promise<PluginHooks | void>;
}

export interface GameServer<E extends EventMap, S> {
	readonly app: Express;
	readonly httpServer: Server;
	readonly io: SocketIOServer;
	readonly bus: Bus<KernelEvents & E>;
	readonly state: S;
	/** Shut down as a signal would; resolves with why it finished (`closed` or `deadline`). */
	shutdown(signal: string): Promise<string>;
}

export interface GameServerOptions<E extends EventMap, S> {
	id: string;
	config: GameServerConfig;
	state: S;
	plugins: readonly GamePlugin<E, S>[];
}

const DEFAULT_SHUTDOWN = { deadlineMs: 1_300, requestGraceMs: 300, restartFlushMs: 500 };

export async function createGameServer<E extends EventMap, S>({ id, config, state, plugins }: GameServerOptions<E, S>): Promise<GameServer<E, S>> {
	const { log } = config;
	const stamp = bootClock(log);
	const stampPhases = config.stampPhases ?? true;
	const timing = { ...DEFAULT_SHUTDOWN, ...config.shutdown };
	const exit = config.exit ?? ((code: number) => process.exit(code));
	const bus = createBus<KernelEvents & E>();
	// The kernel's own two events, emitted through the same bus the game's plugins share.
	const kernelBus = bus as unknown as Bus<KernelEvents>;

	const app = express();
	app.set('trust proxy', true);
	app.disable('x-powered-by');
	const httpServer = createServer(app);
	// The default path: the edge strips the base prefix before the socket's request reaches us.
	const io = new SocketIOServer(httpServer, { serveClient: false });

	const gauges: Record<string, () => number> = { sockets: () => io.engine.clientsCount };
	const countReaders: Array<() => Record<string, unknown>> = [];
	const capacity = capacitySampler({
		gauges,
		counts: () => Object.assign({}, ...countReaders.map((read) => read())),
		...(config.uncounted === undefined ? {} : { uncountedPath: config.uncounted.path, uncountedField: config.uncounted.field }),
	});
	const quiet = config.uncounted?.path ?? (() => false);

	let verdict: BasePathVerdict | undefined;
	const service = serviceIdOf(config.basePrefix, id);
	const commit = readCommit(config.repoRoot);
	const busyReaders: Array<() => BusyRun[]> = [];
	const accountErase = createAccountErase({ log, edgeSealed: config.edgeAuth.edgeSealed, deriveParticipantId: config.erase.deriveParticipantId });
	let seen: ReturnType<typeof firstSeen> | undefined;

	app.use(config.edgeAuth.edgeProvenance);
	app.use(capacity.requests);
	app.use((req, res, next) => {
		if (quiet(req.path)) {
			next();
			return;
		}
		const start = process.hrtime.bigint();
		res.on('finish', () => {
			const ms = Number(process.hrtime.bigint() - start) / 1e6;
			// The identity the handlers saw, post-sanitize: a spoofed request logs as public.
			console.log(JSON.stringify({ t: new Date().toISOString(), svc: id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), user: userIdOf(req), tier: tierOf(req) }));
		});
		next();
	});
	// Public: the monitoring probe has no key. A server up but serving a bundle nobody can load says so.
	app.get('/health', (_req: Request, res: Response) => {
		const { code, body } = healthResponse({ service, commit, bundle: verdict ?? { ok: false, reason: 'missing' } });
		res.status(code).json(body);
	});
	// Local only, and a bare 404 to anyone else: the deploy asks it before stopping us.
	app.get(
		'/health/busy',
		busyHandler(() => {
			const runs = busyReaders.flatMap((read) => read());
			return { busy: runs.length > 0, count: runs.length, runs };
		}),
	);
	// The edge's seal only, never a tier, and above first-seen so an erase does not record the person again.
	app.post(ERASE_PATH, (req: Request, res: Response) => void accountErase.handle(req, res));
	const sealed = express.Router();
	app.use((req, res, next) => (config.edgeAuth.edgeSealed(req) ? sealed(req, res, next) : next()));

	// ── The tier floor: everything below is gated ──
	app.use(config.gate.requireMinTier);
	app.use((req, res, next) => (seen === undefined ? next() : seen(req, res, next)));
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	app.use('/api', api);
	// Hashed names are immutable; index.html is never cached; the embed entries keep their names, so they revalidate.
	const statics = express.static(config.bundle.webDir, {
		index: false,
		maxAge: '1y',
		immutable: true,
		setHeaders: (res, filePath) => {
			if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
			else if (isEmbedEntry(filePath, config.bundle.embedEntries)) res.setHeader('Cache-Control', 'no-cache');
		},
	});
	app.use((req, res, next) => (verdict?.ok === true ? statics(req, res, next) : next()));

	const ctx: GameContext<E, S> = {
		id,
		app,
		api,
		sealed,
		httpServer,
		io,
		bus,
		state,
		get bundle(): BasePathVerdict {
			if (verdict === undefined) throw new Error('the bundle is checked in the bundle phase; read it from then on');
			return verdict;
		},
		bootPhase: stamp,
		gauge: (name, read) => void (gauges[name] = read),
		counts: (read) => void countReaders.push(read),
		busy: (read) => void busyReaders.push(read),
	};

	const stoppers: Array<{ name: string; stop: () => Record<string, unknown> | void }> = [];
	const listeners: Array<() => void> = [];
	const runPhase = async (phase: Phase): Promise<void> => {
		for (const plugin of plugins) {
			if (plugin.phase !== phase) continue;
			const hooks = (await plugin.setup(ctx)) ?? {};
			if (hooks.shutdown !== undefined) stoppers.push({ name: plugin.name, stop: hooks.shutdown });
			for (const step of hooks.erase ?? []) accountErase.register(step);
			if (hooks.onListen !== undefined) listeners.push(hooks.onListen);
		}
		if (stampPhases) stamp(phase);
	};

	await runPhase('config');
	seen = firstSeen({ file: config.firstSeen.file, userIdOf: callerIdOf, tierOf, log: config.firstSeen.log });
	const callersSeen = seen;
	accountErase.register({ what: 'callersSeen', erase: (p) => callersSeen.forget(p.userId) });
	verdict = await checkBundle(config.bundle.indexHtml, config.basePrefix);
	await runPhase('bundle');
	if (config.telemetry !== undefined) installTelemetry(config.telemetry());
	await runPhase('stores');
	await runPhase('routes');
	await runPhase('sockets');

	let shuttingDown: Promise<string> | undefined;
	const shutdown = (signal: string): Promise<string> => {
		// A second signal is the process manager being impatient, not a second shutdown.
		if (shuttingDown !== undefined) return shuttingDown;
		shuttingDown = new Promise<string>((done) => {
			const startedAt = Date.now();
			log({ evt: 'shutdown-begin', signal });
			kernelBus.emit('shutdown', { signal, deadlineMs: timing.deadlineMs });
			const fields: Record<string, unknown> = {};
			for (const { name, stop } of [...stoppers].reverse()) {
				try {
					Object.assign(fields, stop() ?? {});
				} catch (err) {
					// One plugin that will not let go must not stop the rest of the shutdown.
					log({ evt: 'shutdown-plugin-failed', plugin: name, error: (err as Error).message });
				}
			}
			let finished = false;
			const finish = (why: string): void => {
				if (finished) return;
				finished = true;
				log({ evt: 'shutdown-done', signal, why, ms: Date.now() - startedAt, ...fields });
				done(why);
				exit(0);
			};
			// Referenced on purpose: it holds the process up for the closes below, and ends it if one never returns.
			const deadline = setTimeout(() => finish('deadline'), timing.deadlineMs);
			// `io.close` drops whatever a connection has not written, so the notice is let out first.
			void sendThenFlush(
				[...io.sockets.sockets.values()].map((socket) => socket.conn),
				() => io.emit(config.restartEvent),
				timing.restartFlushMs,
			).then(() => {
				// Disconnects every socket and closes the HTTP server it was given.
				io.close(() => {
					clearTimeout(deadline);
					finish('closed');
				});
				closeConnections(httpServer, timing.requestGraceMs);
			});
		});
		return shuttingDown;
	};
	if (config.signals ?? true) {
		process.on('SIGTERM', () => void shutdown('SIGTERM'));
		process.on('SIGINT', () => void shutdown('SIGINT'));
	}

	// After every socket.io attach: engine.io moves itself to the front of the request listeners.
	stampOrigin(httpServer, config.origin ?? id);
	await new Promise<void>((listening, failed) => {
		httpServer.once('error', failed);
		httpServer.listen(config.port, config.host, () => {
			httpServer.off('error', failed);
			listening();
		});
	});
	capacity.start();
	const { port } = httpServer.address() as AddressInfo;
	console.log(`[${id}] listening on ${config.host}:${port}`);
	kernelBus.emit('listening', { host: config.host, port });
	for (const onListen of listeners) onListen();
	await runPhase('listen');
	await runPhase('warm');

	return { app, httpServer, io, bus, state, shutdown };
}
