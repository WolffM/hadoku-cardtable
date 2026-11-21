/**
 * Runtime config for the pieces of cardtable only Magic needs (w119 §C) — the catalog, the art
 * mirror, the draft bot, tournaments, sounds, draft/Forge-hosting timing, the room-stream
 * (noVNC/Forge-desktop) envs, and {@link playWorkDir}.
 *
 * `createMagicConfig` is a factory in the same shape as `@hadoku/game-server/config`'s
 * `createConfig`: every value comes from the `env`/`envPrefix` it is called with (default
 * `process.env` / `'CARDTABLE'`), read when it RUNS, never cached at this module's import.
 * `dataDir` defaults to the platform config's own `dataDir` for the same env/prefix, so
 * `CARDTABLE_STATE_DIR` still moves every Magic-only directory along with the platform ones —
 * `config.test.ts` (platform) already proves that move for `roomsDir`; this file's own
 * `config.test.ts` proves it for `draftsDir`/`tournamentsFile`/`recordingsDir`.
 *
 * ArchiveBot (cardtable's own release-notes integration, deployment-only, not Magic-specific in
 * principle) moved out of this file (w120 §K): its two readers, `plugins/{listen,routes}.ts`, live
 * in the `magic` layer, which `scripts/layers/layers.json` forbids from importing `apps/server`
 * (the `site` layer that owns composition) — so the SETTINGS moved to `apps/server`'s own
 * `plugins/archivebot.ts`, which reads them (the site may read anything) and sets them on
 * `ctx.state.archivebot`, a field both plugins now read instead of a Magic config value. Kept
 * here only until this wave: C's w119 remainder flagged the wiring as `apps/server/src/
 * plugins/index.ts`, which was outside that lane's row and is inside this one's.
 *
 * Survey: `~/.cache/cardtable-manager/bomberman-survey-2026-11-16.md` §3 has the classification
 * with the original line numbers (cardtable's `packages/game-server/src/config.ts`, before this
 * split).
 */

import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createConfig, lazyConfig } from '@hadoku/game-server/config';

export interface CreateMagicConfigOptions {
	/** Every env var this factory reads is `<envPrefix>_<NAME>`. Default `'CARDTABLE'`. */
	envPrefix?: string;
	/** The environment to read. Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Platform data dir Magic's own directories sit under. Default: the platform config's `dataDir` for the same `env`/`envPrefix`. */
	dataDir?: string;
}

export interface MagicConfig {
	/** Every pod that played a round, kept past its room. */
	readonly tournamentsFile: string;
	/** The sound builder's uploads and assignments. */
	readonly soundsDir: string;
	/**
	 * How long a draft bot takes over a pick: every bot holding a pack takes one card per turn.
	 * Long enough that bots do not drain a pod into the slowest human's pile at once, short enough
	 * that a quick drafter rarely waits on one.
	 */
	readonly draftBotPickMs: number;
	/** A CubeCobra draftbot service for the bots' picks, and its `X-Internal-Token`. Unset: no draftbot, every bot pick is the heuristic's. */
	readonly draftbotUrl: string;
	readonly draftbotToken: string;
	/** Each draft's state, so a pod survives a restart. */
	readonly draftsDir: string;
	/** A friend's Cube Cobra imports, flat `<id>.json`. */
	readonly cubesDir: string;
	/** Every match's action log and public stream (`play/recording/`). */
	readonly recordingsDir: string;
	/** Every game both players walked away from, kept to be resumed (`play/parked.ts`). */
	readonly parkedDir: string;
	/** The card catalog the pools resolve against. */
	readonly catalogPath: string;
	/** The art mirror's log (`upload-art`): which CDN object holds each card image. Missing, every image is Scryfall's. */
	readonly artMirrorPath: string;
	/**
	 * `=newest` pins every new room to the newest Standard era instead of a random one: the e2e
	 * harnesses set it, because their specs read a fresh room's pool and a run must not depend on
	 * a draw.
	 */
	readonly newRoomFormat: string | undefined;
	/** Where Forge matches run: `local`, this machine, or `claws`, placed across the hosting claws' agents with this machine as the backstop. Anything else is `local`. */
	readonly playHosts: 'local' | 'claws';
	/** How long, past the fencing window, the claws' agents hold their JVMs for the next server on a restart. */
	readonly restartGraceMs: number;
	/** The e2e harness's dev diagnostics — the scenario routes and the frame and stop traces. Never on in production. */
	readonly playProbe: boolean;
	/**
	 * How long a match nobody is at waits before it is parked (`play/socket.ts`'s `PlayDeps.rejoinGraceMs`).
	 * Unset is play's own five minutes; a spec that parks a game sets it shorter. Never set by the deploy path.
	 */
	readonly playRejoinGraceMs: number | undefined;
	/**
	 * How long a finished match keeps its game on its JVM (`play/socket.ts`'s `PlayDeps.overGraceMs`).
	 * Unset is play's own ten minutes. The card sweep sets it short: it finishes a match every few
	 * seconds, and ten minutes of finished games filled a JVM every 25 and took the runner's memory.
	 * Never set by the deploy path.
	 */
	readonly playOverGraceMs: number | undefined;
	/**
	 * The jar-less e2e stack's own escape hatch (wave 73 §A follow-up): with it, `room/plan.ts`'s
	 * `checkCards` answers OK for a source whose cards all resolved instead of refusing with "Forge
	 * is not available". Nothing in this repo's own deploy path ever sets this.
	 */
	readonly testUncheckedPools: boolean;
	/** An e2e stack's stand-in for cubecobra.com, so a link import is tested without the network. Unset everywhere else. */
	readonly testCubeCobraOrigin: string | undefined;
	/**
	 * On by default, so production needs no cross-repo change to keep its catalog current with
	 * Scryfall's daily bulk file. Off (`'0'`) for every server that is NOT production.
	 */
	readonly catalogRefresh: boolean;
	/** Fixes Forge's shuffles, the coin toss and the precon pick for every match this server starts, or undefined (production) for an unseeded one. Read at each start, not at boot, so a test can set it. */
	readonly playSeed: number | undefined;
	/** Container n's noVNC port is this plus n (the static bench publishes 127.0.0.1:6080+n). */
	readonly streamBasePort: number;
	/** The first host port a room's seat stream may take. */
	readonly roomStreamBasePort: number;
	/** The name every room stream container this server owns starts with. */
	readonly streamNamePrefix: string;
	/**
	 * Where the static bench's `STREAMS` switch lives (`stream/index.ts`'s `streamLayout`). Keeps a
	 * second server on the same machine (`pnpm dev`) off this one's containers.
	 */
	readonly streamDir: string;
}

/** Everything cardtable's Magic deployment needs that the platform `createConfig` does not (w119 §C). */
export function createMagicConfig(options: CreateMagicConfigOptions = {}): MagicConfig {
	const prefix = options.envPrefix ?? 'CARDTABLE';
	const env = options.env ?? process.env;
	const read = (name: string): string | undefined => env[`${prefix}_${name}`];
	const dataDir = options.dataDir ?? createConfig({ envPrefix: prefix, env }).dataDir;
	const playRejoinGraceMsRaw = read('PLAY_REJOIN_GRACE_MS');
	const playOverGraceMsRaw = read('PLAY_OVER_GRACE_MS');

	return {
		tournamentsFile: read('TOURNAMENTS_FILE') ?? join(dataDir, 'tournaments.json'),
		soundsDir: read('SOUNDS_DIR') ?? join(dataDir, 'sounds'),
		draftBotPickMs: parseInt(read('DRAFT_BOT_PICK_MS') || '1200', 10),
		draftbotUrl: read('DRAFTBOT_URL') || '',
		draftbotToken: read('DRAFTBOT_TOKEN') || '',
		draftsDir: read('DRAFTS_DIR') ?? join(dataDir, 'drafts'),
		cubesDir: read('CUBES_DIR') ?? join(dataDir, 'cubes'),
		recordingsDir: read('RECORDINGS_DIR') ?? join(dataDir, 'recordings'),
		parkedDir: read('PARKED_DIR') ?? join(dataDir, 'parked'),
		catalogPath: read('CATALOG') ?? resolve(homedir(), '.local/share/cardtable/catalog/cards.json'),
		artMirrorPath: read('ART_MIRROR') ?? resolve(homedir(), '.local/share/cardtable/art/mirror.jsonl'),
		newRoomFormat: read('NEW_ROOM_FORMAT'),
		playHosts: read('PLAY_HOSTS') === 'claws' ? 'claws' : 'local',
		restartGraceMs: parseInt(read('PLAY_RESTART_GRACE_MS') || '90000', 10),
		playProbe: read('PLAY_PROBE') === '1',
		playRejoinGraceMs: playRejoinGraceMsRaw === undefined ? undefined : parseInt(playRejoinGraceMsRaw, 10),
		playOverGraceMs: playOverGraceMsRaw === undefined ? undefined : parseInt(playOverGraceMsRaw, 10),
		testUncheckedPools: read('E2E_UNCHECKED_POOLS') === '1',
		testCubeCobraOrigin: read('E2E_CUBECOBRA_ORIGIN') || undefined,
		catalogRefresh: read('CATALOG_REFRESH') !== '0',
		get playSeed(): number | undefined {
			const raw = read('PLAY_SEED');
			const seed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
			return Number.isFinite(seed) ? seed : undefined;
		},
		streamBasePort: Number(read('STREAM_PORT') ?? 6080),
		roomStreamBasePort: Number(read('ROOM_STREAM_PORT') ?? 6100),
		streamNamePrefix: read('STREAM_NAME_PREFIX') ?? 'cardtable-room',
		streamDir: read('STREAM_DIR') ?? join(homedir(), '.local', 'share', 'cardtable', 'stream'),
	};
}

/**
 * Where a Forge match's run directories go (`CARDTABLE_PLAY_WORK_DIR`) — moved from the platform's
 * config (w120 §K: Forge/JVM-match specific, like every other setting in this file).
 * `play/local-jvm.ts`'s `jvmHostConfig` takes this as an injected `workDir`, computed by whichever
 * caller starts a JVM (every reader is this package: `plugins/library.ts`, `play/scenario.ts`,
 * `play/recording/rebuild.ts`), rather than importing it itself — the platform file knows no
 * game's own env var names and keeps its own generic fallback default for every other caller
 * (scripts, the UI's jvm harness) that passes no `workDir` of its own.
 */
export function playWorkDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.CARDTABLE_PLAY_WORK_DIR ?? join(tmpdir(), 'cardtable-play'));
}

/**
 * Cardtable's own instance — built on first property access, not at import, the same way
 * `@hadoku/game-server/config`'s `CONFIG` is ({@link lazyConfig}, w120 §K).
 */
export const MAGIC_CONFIG: MagicConfig = lazyConfig(createMagicConfig);
