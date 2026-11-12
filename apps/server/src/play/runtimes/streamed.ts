/**
 * The streamed desktop (Forge's own GUI, in a container — `../../stream/**`), described in the same
 * vocabulary every other engine this host runs is: an `EngineRuntime` (`../engine-runtime.ts`), and
 * the "start it, track it, a failed start is the match's fatal, tear it down" shape any engine's
 * host needs. `stream/alloc.ts` already provisions and reclaims a room's containers; this file is
 * what turns that into the same start/track/stop vocabulary, and `plugins/stream.ts` (the one
 * caller, in `ensureRoomStreams`) is wired through it rather than calling `RoomStreams.allocate`
 * directly.
 *
 * ## The Magic config
 *
 * `scripts/stream/container.sh` mounts one Forge jar and one `res/` into every container it
 * starts; which jar and which res were, until now, resolved by the SCRIPT's own bash defaulting
 * (`CARDTABLE_STREAM_FORGE_JAR`, falling back through `CARDTABLE_FORGE_RES`) — a Magic-specific
 * concern baked into the one script every container goes through, and invisible to anything that
 * does not read the script. {@link streamedEngineConfig} resolves and validates the same two paths
 * in TypeScript instead, mirroring `local-jvm.ts`'s `jvmHostConfig`; `plugins/stream.ts` hands the
 * result to `scriptRunner` as explicit `env`, so the jar/res a log line can name is what every `up`
 * call actually mounts, never a different one the script's own bash default happened to find.
 * `stream/alloc.ts` and `stream/index.ts` — the platform allocator — import neither this file's
 * env names nor any Forge path; only this file and `plugins/stream.ts` (the composition point) do.
 *
 * ## Not a `child_process.spawn`
 *
 * A streamed desktop's "process" is a docker container `scripts/stream/container.sh` starts; this
 * server never forks it directly, so {@link streamedEngineRuntime}'s `argv` returns nothing and it
 * leaves `spawn` unset — `EngineRuntime.spawn` is optional for exactly this case (see
 * `engine-runtime.ts`'s own doc). `perProcess` is 1: one container is one seat, with none of the
 * Forge JVM pool's sharing (a streamed room gets one container per seat; a shared screen is
 * cheaper and is not a game).
 *
 * ## Tracked, not pooled through `host.ts`
 *
 * `host.ts`/`match.ts` still place every Forge match through `localJvmLauncher`'s `JvmLauncher`;
 * a streamed desktop has no bridge-line protocol for that coordinator to speak to in the first
 * place (the player's input goes straight to Forge over noVNC, not through this server), so
 * {@link streamedHost} is tracked by `plugins/stream.ts` itself (`state.streamedHosts`) rather than
 * through `host.ts`'s match pool. `stream/alloc.ts`'s own `destroy()` — the one place a room's
 * containers actually come down, whether asked for or reclaimed idle — reports back through
 * `RoomStreamsOptions.onEnded`, which `plugins/stream.ts` wires to the matching host's `settled()`,
 * so every ending reaches this file's vocabulary, not only an explicit `stop()`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EngineRuntime } from '../engine-runtime.js';
import type { RoomStreams } from '../../stream/alloc.js';

/** Measured 2026-09-19, `docs/spikes/streaming.md`, "the host" section: "Budget 1.3 GiB per streamed desktop." */
export const STREAMED_CONTAINER_MB = 1331;

/** The two Magic-specific paths a streamed desktop's container mounts. See the module header. */
export interface StreamedMagicConfig {
	forgeJar: string;
	forgeRes: string;
}

export type StreamedAvailability = { ok: true; config: StreamedMagicConfig } | { ok: false; reason: string };

/**
 * Resolve the streamed desktop's Magic config from the environment, validated the way
 * `jvmHostConfig` (`../local-jvm.ts`) validates the JVM pool's: a missing or malformed jar/res is a
 * reason, not a guess. `CARDTABLE_STREAM_FORGE_JAR`/`_RES` name the container's own copy, falling
 * back to the pool's `CARDTABLE_FORGE_JAR`/`_RES` when the container has none of its own — exactly
 * the fallback chain `scripts/stream/container.sh`'s bash already encodes, so this and the script
 * can never resolve a different jar from the same environment.
 */
export function streamedEngineConfig(env: NodeJS.ProcessEnv = process.env): StreamedAvailability {
	const jar = env.CARDTABLE_STREAM_FORGE_JAR ?? env.CARDTABLE_FORGE_JAR ?? '';
	const res = env.CARDTABLE_STREAM_FORGE_RES ?? env.CARDTABLE_FORGE_RES ?? '';
	if (jar === '') return { ok: false, reason: 'neither CARDTABLE_STREAM_FORGE_JAR nor CARDTABLE_FORGE_JAR is set' };
	if (!existsSync(jar)) return { ok: false, reason: `no Forge jar for the streamed desktop at ${jar}` };
	if (res === '') return { ok: false, reason: 'neither CARDTABLE_STREAM_FORGE_RES nor CARDTABLE_FORGE_RES is set' };
	if (!existsSync(resolve(res, 'cardsfolder'))) {
		return { ok: false, reason: `CARDTABLE_STREAM_FORGE_RES/CARDTABLE_FORGE_RES is not Forge's res/ (no cardsfolder): ${res}` };
	}
	return { ok: true, config: { forgeJar: resolve(jar), forgeRes: resolve(res) } };
}

/**
 * What `scripts/stream/container.sh` reads to find the Forge it mounts, resolved HERE rather than
 * left to its own bash fallback. `plugins/stream.ts` hands this to `scriptRunner`'s `env`, so the
 * jar/res this process validated ({@link streamedEngineConfig}) is exactly what every `up` call
 * mounts.
 */
export function streamedContainerEnv(config: StreamedMagicConfig): Record<string, string> {
	return { CARDTABLE_STREAM_FORGE_JAR: config.forgeJar, CARDTABLE_STREAM_FORGE_RES: config.forgeRes };
}

/**
 * `EngineRuntime` (`../engine-runtime.ts`) for the streamed desktop: what it costs, in the same
 * vocabulary the JVM pool's `forgeEngineRuntime` (`../local-jvm.ts`) uses, so a reader comparing
 * the two engines this host runs sees one shape, not two. `argv`/`spawn` are left as the
 * interface's own no-op/unset for an engine whose process is a container, not something this
 * server forks — see the module header, "Not a `child_process.spawn`".
 */
export function streamedEngineRuntime(config: StreamedMagicConfig): EngineRuntime {
	return {
		artifacts: { jar: config.forgeJar, res: config.forgeRes },
		// Nothing here builds a java command line: the container's own entrypoint launches Forge's
		// desktop itself from the jar/res it was handed as a mount, not an argv this process picks.
		argv: () => [],
		overheadMb: STREAMED_CONTAINER_MB,
		// One seat, one container, always — unlike the JVM pool's `MATCHES_PER_JVM`, nothing shares.
		perProcess: 1,
		// `stream/alloc.ts`'s own idle/room-gone sweep is this engine's recycle policy; a crashed
		// container looks the same as a reclaimed one to the allocator (both just stop answering
		// `portOf`), so this hook has nothing further to add.
		health: () => ({ recycle: false }),
	};
}

/**
 * What a seat's containers coming up or going down tells the host, in the same three-part
 * vocabulary `host.ts`'s `HostEvents` uses (a line, an exit, a log entry) without importing that
 * file: this lane does not own `host.ts`, and a structural match costs nothing to keep. `fatal`
 * stands in for `HostLifecycleLine`'s `{ t: 'fatal' }` case — a provisioning failure the match
 * cannot recover from, same as a JVM's own fatal line.
 */
export interface StreamedHostEvents {
	/** A provision failed: the match's fatal. */
	fatal(message: string): void;
	/** The containers are gone for good — reclaimed, or asked to stop. */
	exit(reason: string): void;
	log(entry: Record<string, unknown>): void;
}

/** One streamed match's containers, from allocation through teardown. */
export interface StreamedMatchHost {
	/** Ask every seat's container down. Idempotent, and safe even if they are already gone. */
	stop(): void;
	/**
	 * The containers went down some OTHER way — `stream/alloc.ts`'s own idle/room-gone sweep, or an
	 * orphan reclaim — so this host still reports it (`events.exit`) without releasing a second
	 * time. `plugins/stream.ts` calls this from `RoomStreamsOptions.onEnded`; idempotent with `stop`.
	 */
	settled(reason: string): void;
}

/**
 * Starts (or finds already-live) a room's seats' containers through `rooms`
 * (`../../stream/alloc.ts`'s `RoomStreams`), and reports back in {@link StreamedHostEvents}'s
 * vocabulary: a failed provision is `events.fatal`, exactly as a JVM's `{ t: 'fatal' }` line is
 * `match.fail`'s trigger today. `stop()` releases them through `rooms.release` — `stream/alloc.ts`'s
 * own teardown, never a second path that could disagree with it about what "torn down" means — and
 * {@link StreamedMatchHost.settled} covers every OTHER way those same containers can end.
 */
export function streamedHost(rooms: RoomStreams, roomKey: string, seatCount: number, events: StreamedHostEvents): StreamedMatchHost {
	let ended = false;
	let stopping = false;
	const end = (reason: string): void => {
		if (ended) return;
		ended = true;
		events.exit(reason);
	};

	void (async (): Promise<void> => {
		try {
			const result = await rooms.allocate(roomKey, seatCount);
			if (ended) return;
			if (!result.ok) {
				events.fatal(`${result.reason}: ${result.detail}`);
				end(`provisioning failed: ${result.detail}`);
				return;
			}
			events.log({ evt: 'streamed-host-up', room: roomKey, seats: result.allocation.seats.length });
		} catch (err) {
			if (ended) return;
			const message = err instanceof Error ? err.message : String(err);
			events.fatal(message);
			end(`provisioning failed: ${message}`);
		}
	})();

	return {
		stop() {
			if (ended || stopping) return;
			stopping = true;
			void rooms.release(roomKey, 'released').then(() => end('stopped'));
		},
		settled(reason) {
			end(reason);
		},
	};
}
