/**
 * External games cardtable may host as a room type — entirely as CONFIGURATION, per the
 * operator's 2026-11-16 ruling: "no bomberman code in cardtable." None of an external game's own
 * code runs here or anywhere else in this repo: its match plays on cardtable's relay runtime
 * (`packages/game-server/src/play/runtimes/relay.ts`), and its UI is one `BundleSlot` loading the
 * game's own same-origin bundle (`packages/game-ui/src/rooms/external-games.tsx` registers that
 * half).
 *
 * Each game's room type is two halves. The host's — id, relay runtime, embed path, tier floor — is
 * `EXTERNAL_GAMES` in `packages/game-ui/src/rooms/external-games-config.ts`. The game's — its name,
 * seat range and seat hold — is the `manifest.json` it publishes beside its embed entry, read here
 * through the edge with the server's service key (`@hadoku/game-server/external-game-manifests`),
 * at boot and every ten minutes after, so a game changes its own seats by releasing, not by a
 * cardtable commit. The last good manifest is kept under the data dir and stands in when the edge
 * or a release fails, since a type that does not register at boot quarantines its saved rooms.
 *
 * Gated on `CARDTABLE_EXPERIMENTAL_GAMES=1`, read here rather than `config.ts` because the whole
 * feature is itself optional configuration, not a platform setting every deployment reads: unset
 * (or anything else), nothing below registers, and cardtable plays no external game at all —
 * creating or joining one then refuses the same way any unregistered game type always has
 * (`isRegisteredGameType`).
 *
 * `e2eOnly` entries (`external-games-config.ts`'s `e2e-toy-relay`, wave 120 §F's proof fixture)
 * are filtered OUT unless `CARDTABLE_E2E_TOY_GAMES=1`, a SECOND, dedicated gate on top of
 * `CARDTABLE_EXPERIMENTAL_GAMES` — so prod never lists the toy, and only the e2e stack that
 * explicitly asks for it (by setting this var on `startPlayStack`'s own env) ever sees it. Its
 * manifest is inline in the config, since nothing publishes one.
 *
 * `GET /api/external-games` lists the registered games the caller's tier may play, by id and the
 * label their manifest gives: the create form's radio.
 */
import { join } from 'node:path';
import { externalGameSpec, registerGameType } from '@hadoku/shared';
import { edgeTierOf } from '@hadoku/game-server/edge-auth';
import { jsonLogger, type JsonLog } from '@hadoku/service-kernel/log';
import { CONFIG } from '@hadoku/game-server/config';
import { manifestReader, type ReadManifest } from '@hadoku/game-server/external-game-manifests';
import { tierAdmits } from '@hadoku/game-server/room/tier-floor';
import { reportingAlerts } from '@hadoku/game-server/telemetry';
import type { CardtablePlugin } from '@hadoku/magic-server/plugins/state';
import { EXTERNAL_GAMES, type ExternalGameConfig } from '@hadoku/game-ui/rooms/external-games-config.ts';

export { EXTERNAL_GAMES, type ExternalGameConfig } from '@hadoku/game-ui/rooms/external-games-config.ts';

const REFRESH_MS = 10 * 60_000;

export interface ExternalGamesOptions {
	games?: readonly ExternalGameConfig[];
	/** Where the embed paths are served: `CARDTABLE_EXTERNAL_GAMES_ORIGIN`, else `https://hadoku.me`. */
	origin?: string;
	/** `CARDTABLE_SERVICE_KEY` by default: the edge gates every bundle route. */
	serviceKey?: string;
	/** `<data dir>/external-games` by default. */
	cacheDir?: string;
	refreshMs?: number;
	fetch?: typeof fetch;
	/** `cardtable-external-games`, its alerts reported, by default. */
	log?: JsonLog;
}

/** One registered game, as the create form lists it. */
interface Offered {
	label: string;
	minTier?: 'friend';
}

/** The two plugins (`config`: read and register; `routes`: the list) and a refresh a test can await. */
export function externalGames(opts: ExternalGamesOptions = {}): { configPlugin: CardtablePlugin; routesPlugin: CardtablePlugin; refresh: () => Promise<void> } {
	const offered = new Map<string, Offered>();
	const current = new Map<string, string>();
	let hosted: readonly ExternalGameConfig[] = [];
	let read: ((game: ExternalGameConfig) => Promise<ReadManifest | null>) | null = null;
	let refreshing: Promise<void> | null = null;
	const log = opts.log ?? reportingAlerts(jsonLogger('cardtable-external-games'));

	const register = (game: ExternalGameConfig, got: ReadManifest): void => {
		registerGameType(externalGameSpec(game, got.manifest));
		offered.set(game.id, { label: got.manifest.label, ...(game.minTier === undefined ? {} : { minTier: game.minTier }) });
		current.set(game.id, JSON.stringify(got.manifest));
		log({ evt: 'external-game-registered', gameType: game.id, source: got.source, label: got.manifest.label, seats: got.manifest.seats, seatRejoinGraceMs: got.manifest.seatRejoinGraceMs });
	};

	const refresh = (): Promise<void> => {
		const reader = read;
		if (reader === null) return Promise.resolve();
		const due = hosted.filter((game) => game.manifest === undefined);
		refreshing ??= Promise.all(due.map((game) => reader(game))).then(
			(gots) => {
				refreshing = null;
				// Read together, registered in the configured order: the create form lists them in it.
				due.forEach((game, i) => {
					const got = gots[i]!;
					if (got !== null && current.get(game.id) !== JSON.stringify(got.manifest)) register(game, got);
				});
			},
			(err: unknown) => {
				refreshing = null;
				log({ evt: 'alert', key: 'external-game-refresh-failed', text: `external game manifests could not be refreshed: ${err instanceof Error ? err.message : String(err)}` });
			},
		);
		return refreshing;
	};

	const configPlugin: CardtablePlugin = {
		name: 'external-games',
		phase: 'config',
		async setup() {
			if (process.env.CARDTABLE_EXPERIMENTAL_GAMES !== '1') return;
			const e2eToyGames = process.env.CARDTABLE_E2E_TOY_GAMES === '1';
			hosted = (opts.games ?? EXTERNAL_GAMES).filter((game) => game.e2eOnly !== true || e2eToyGames);
			const serviceKey = opts.serviceKey ?? process.env.CARDTABLE_SERVICE_KEY;
			read = manifestReader({
				origin: opts.origin ?? process.env.CARDTABLE_EXTERNAL_GAMES_ORIGIN ?? 'https://hadoku.me',
				...(serviceKey === undefined ? {} : { serviceKey }),
				cacheDir: opts.cacheDir ?? join(CONFIG.dataDir, 'external-games'),
				log,
				...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
			});
			const reader = read;
			// Read together, registered in the configured order: the create form lists them in it.
			const gots = await Promise.all(hosted.map((game) => reader(game)));
			hosted.forEach((game, i) => {
				const got = gots[i]!;
				if (got !== null) register(game, got);
				else log({ evt: 'alert', key: `external-game-unavailable:${game.id}`, text: `${game.id} has no manifest and no saved copy: it is not a room type, and its saved rooms are quarantined` });
			});
			const timer = setInterval(() => void refresh(), opts.refreshMs ?? REFRESH_MS);
			timer.unref();
			return { shutdown: () => clearInterval(timer) };
		},
	};

	const routesPlugin: CardtablePlugin = {
		name: 'external-games-routes',
		phase: 'routes',
		setup({ api }) {
			api.get('/external-games', (req, res) => {
				const tier = edgeTierOf(req);
				const games = [...offered].filter(([, game]) => tierAdmits(game.minTier, tier)).map(([id, game]) => ({ id, label: game.label }));
				res.json({ games });
			});
		},
	};

	return { configPlugin, routesPlugin, refresh };
}

const hostedGames = externalGames();
export const externalGamesPlugin = hostedGames.configPlugin;
export const externalGamesRoutesPlugin = hostedGames.routesPlugin;
