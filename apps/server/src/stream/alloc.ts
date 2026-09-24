/*
 * Containers a ROOM owns — allocation, and getting them back.
 *
 * ## What this is
 *
 * `index.ts`'s static half (`/stream/<n>/`) is a fixed bench an operator
 * starts by hand. This is the other half: a room created in `streamed` mode
 * gets **one container per seat** (operator, 2026-09-22 — a 2-player streamed
 * room is 2 containers, ~2.5 GiB; a shared screen is cheaper and is not a
 * game), each with its own host port, recorded against the room key.
 *
 * ## Nothing here talks to docker
 *
 * Every container this module creates, destroys or counts goes through
 * `scripts/stream/container.sh`. That script refuses the bench's names and
 * ports, and has a dry-run mode — which is why this allocator is testable end
 * to end on a machine with no docker, and why an auditor reads one file to
 * know every container the product can make.
 *
 * ## Reclaim, because a container is 1.3 GiB
 *
 * Two ways an allocation goes away, both driven by `sweep()`:
 *
 * - **The room is gone.** `roomExists` is the server's own lookup (lobby
 *   rooms and draft pods). A room nobody can join keeps nothing running.
 * - **Nobody is watching.** No websocket attached for `idleMs`
 *   (default 30 minutes) → the containers are destroyed.
 *
 * 30 minutes, and not 5: destroying a streamed container destroys the *match
 * inside it* — the game state lives in that Forge process, not in our server
 * — and a cold container is ~18 s from `docker run` to a usable window
 * (`docs/spikes/streaming.md`). Reclaiming at coffee-break scale would delete
 * real games; 30 minutes is past any break and far short of leaving a GiB
 * burning overnight.
 *
 * A reclaimed room is remembered as **dead**, with the reason. That is the
 * difference between a link that says "these streams were reclaimed" and one
 * that 502s forever looking alive — see `statusOf`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same rule as `lobby.ts`'s `ROOM_ID_RE`. A stream key IS a room id. */
export const ROOM_KEY_RE = /^[a-z0-9-]{1,40}$/;

/**
 * The first host port a room's seat may take.
 *
 * Deliberately clear of everything else on this host: 6080–6081 are the static
 * bench, 19008/19028/19108/19128 are the e2e harness. `container.sh` refuses
 * anything below 6100 a second time, in case this constant is ever loosened.
 */
export const ROOM_STREAM_BASE_PORT = Number(process.env.CARDTABLE_ROOM_STREAM_PORT ?? 6100);

/**
 * How many streamed seats may exist on this host AT ONCE, across all rooms.
 *
 * The real cap is memory, not ports: 1.3 GiB per desktop measured, ~22 GiB
 * free on this box with production up (`docs/spikes/streaming.md` §host). Eight
 * is ~10.4 GiB — four 2-player rooms, or one pod — and leaves the JVM pool and
 * 24 PM2 services their room. Raising it is a memory decision, not a port one.
 */
export const ROOM_STREAM_POOL = 8;

/** Seats in one room. A pod is 8; a constructed table is 2. */
export const MAX_ROOM_SEATS = 8;

/** No websocket attached for this long → the containers go. See the header. */
export const IDLE_RECLAIM_MS = 30 * 60_000;

/**
 * Container names: `<prefix>-<roomKey>-<seat>`. `container.sh` enforces it.
 *
 * **Env-settable because the prefix is this server's OWNERSHIP claim, and a
 * host can run more than one cardtable.** `sweepOrphans()` destroys every
 * container matching the prefix that this process's `live` map does not own —
 * which is right for reclaiming what a restart of THIS server left behind, and
 * catastrophic across two servers sharing one name. A `pnpm e2e` run boots a
 * second server on the machine that runs production: with one prefix its boot
 * sweep would delete a real player's containers mid-match. The e2e harness
 * therefore sets its own prefix, and `container.sh` already reads the same
 * variable, so the script and the server can never disagree about what this
 * server may touch.
 */
export const CONTAINER_NAME_PREFIX = process.env.CARDTABLE_STREAM_NAME_PREFIX ?? 'cardtable-room';

export interface RoomStreamSeat {
	seat: number;
	/** The host port websockify is published on, 127.0.0.1 only. */
	port: number;
	container: string;
}

export interface RoomStreamAllocation {
	roomKey: string;
	network: string;
	seats: RoomStreamSeat[];
	createdAt: number;
	/** When a websocket was last attached or detached. Drives the idle window. */
	lastActiveAt: number;
	/** Websockets attached right now. Nonzero means somebody is watching. */
	attached: number;
}

export type ReclaimReason = 'room-gone' | 'idle' | 'released' | 'orphan';

/** What a client may be told about a room's streams. Never a port. */
export interface RoomStreamStatus {
	roomKey: string;
	state: 'live' | 'dead' | 'none';
	seats: number;
	reason?: ReclaimReason;
	/** ISO, when it died. */
	since?: string;
}

export type AllocateResult =
	| { ok: true; allocation: RoomStreamAllocation }
	| { ok: false; reason: 'bad-room-key' | 'bad-seat-count' | 'no-ports' | 'provision-failed'; detail: string };

/** The seam `scripts/stream/container.sh` sits behind. Injectable for tests. */
export interface ContainerScript {
	up(name: string, port: number, network: string): Promise<void>;
	down(name: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
	netDown(network: string): Promise<void>;
}

export interface RoomStreamsOptions {
	/** The server's own lookup: does this room still exist? Drives the sweep. */
	roomExists: (roomKey: string) => boolean;
	script?: ContainerScript;
	/** Injectable so the idle window is tested with a fake clock, not a wait. */
	now?: () => number;
	basePort?: number;
	poolSize?: number;
	idleMs?: number;
	namePrefix?: string;
	log?: (entry: Record<string, unknown>) => void;
}

export interface SweepReport {
	reclaimed: Array<{ roomKey: string; reason: ReclaimReason }>;
}

export interface RoomStreams {
	/** Idempotent: a second call for a live room returns what it already has. */
	allocate(roomKey: string, seatCount: number): Promise<AllocateResult>;
	find(roomKey: string): RoomStreamAllocation | undefined;
	/** The host port for one seat, or null when there is no such live seat. */
	portOf(roomKey: string, seat: number): number | null;
	statusOf(roomKey: string): RoomStreamStatus;
	list(): RoomStreamAllocation[];
	noteAttach(roomKey: string): void;
	noteDetach(roomKey: string): void;
	release(roomKey: string, reason: ReclaimReason): Promise<void>;
	/** Rooms that are gone, and rooms nobody is watching. Safe to call often. */
	sweep(): Promise<SweepReport>;
	/** Containers a previous process left behind, with no allocation for them. */
	sweepOrphans(): Promise<SweepReport>;
}

/**
 * Where `scripts/stream/container.sh` is, found by walking up from this file.
 *
 * It cannot be a fixed relative path: in tests this module is
 * `apps/server/src/stream/alloc.ts`, and in production it is bundled into
 * `apps/server/dist/index.js`. Walking until the script is actually there is
 * the one form that is right in both.
 */
export function findContainerScript(from: string = fileURLToPath(import.meta.url)): string | null {
	let dir = dirname(from);
	for (let i = 0; i < 8; i += 1) {
		const candidate = join(dir, 'scripts', 'stream', 'container.sh');
		if (existsSync(candidate)) return candidate;
		const up = resolve(dir, '..');
		if (up === dir) break;
		dir = up;
	}
	return null;
}

/** The real script, as a `ContainerScript`. `env` is merged over the process's. */
export function scriptRunner(scriptPath: string, env: Record<string, string> = {}): ContainerScript {
	const run = (args: string[]): Promise<string> =>
		new Promise((res, rej) => {
			execFile(
				'/usr/bin/env',
				['bash', scriptPath, ...args],
				{ env: { ...process.env, ...env }, timeout: 120_000 },
				(err, stdout, stderr) => {
					if (err !== null) {
						rej(new Error(`container.sh ${args[0] ?? '?'}: ${stderr.trim() || err.message}`));
						return;
					}
					res(stdout);
				},
			);
		});
	return {
		async up(name, port, network) {
			await run(['up', name, String(port), network]);
		},
		async down(name) {
			await run(['down', name]);
		},
		async list(prefix) {
			const out = await run(['list', prefix]);
			return out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
		},
		async netDown(network) {
			await run(['net-down', network]);
		},
	};
}

/**
 * A room key must not be readable as a static stream index.
 *
 * `/stream/3/` is the bench's third container; `/stream/3/0/` must never be a
 * room called `3`. Room ids are minted by the lobby and may be all digits, so
 * the two namespaces are kept disjoint HERE — at allocation — rather than by
 * hoping a parser stays ambiguous in the right direction.
 */
export function isStaticIndexLike(roomKey: string): boolean {
	return /^\d+$/.test(roomKey);
}

export function createRoomStreams(options: RoomStreamsOptions): RoomStreams {
	const now = options.now ?? Date.now;
	const basePort = options.basePort ?? ROOM_STREAM_BASE_PORT;
	const poolSize = options.poolSize ?? ROOM_STREAM_POOL;
	const idleMs = options.idleMs ?? IDLE_RECLAIM_MS;
	const prefix = options.namePrefix ?? CONTAINER_NAME_PREFIX;
	const log = options.log ?? ((): void => {});
	const script =
		options.script ??
		((): ContainerScript => {
			const found = findContainerScript();
			if (found === null) throw new Error('scripts/stream/container.sh not found — the allocator cannot run');
			return scriptRunner(found);
		})();

	const live = new Map<string, RoomStreamAllocation>();
	/** Reclaimed rooms, so a link answers honestly instead of 502ing forever. */
	const dead = new Map<string, { reason: ReclaimReason; at: number }>();
	const DEAD_MEMORY = 64;

	const takenPorts = (): Set<number> => {
		const taken = new Set<number>();
		for (const alloc of live.values()) for (const s of alloc.seats) taken.add(s.port);
		return taken;
	};

	const remember = (roomKey: string, reason: ReclaimReason): void => {
		dead.set(roomKey, { reason, at: now() });
		// Bounded: the oldest entry goes first. A Map iterates in insertion
		// order, and `set` above re-inserts, so this is a plain LRU by death.
		while (dead.size > DEAD_MEMORY) {
			const oldest = dead.keys().next();
			if (oldest.done === true) break;
			dead.delete(oldest.value);
		}
	};

	const destroy = async (alloc: RoomStreamAllocation, reason: ReclaimReason): Promise<void> => {
		for (const seat of alloc.seats) {
			try {
				await script.down(seat.container);
			} catch (err) {
				// One container that will not die must not strand the others,
				// nor abort a sweep with other rooms still to reclaim.
				log({ evt: 'stream-reclaim-failed', room: alloc.roomKey, container: seat.container, err: String(err) });
			}
		}
		try {
			await script.netDown(alloc.network);
		} catch (err) {
			log({ evt: 'stream-network-reclaim-failed', room: alloc.roomKey, err: String(err) });
		}
		live.delete(alloc.roomKey);
		remember(alloc.roomKey, reason);
		log({ evt: 'stream-reclaimed', room: alloc.roomKey, reason, seats: alloc.seats.length });
	};

	return {
		async allocate(roomKey, seatCount) {
			if (!ROOM_KEY_RE.test(roomKey)) {
				return { ok: false, reason: 'bad-room-key', detail: 'a room key is 1-40 of [a-z0-9-]' };
			}
			if (isStaticIndexLike(roomKey)) {
				return {
					ok: false,
					reason: 'bad-room-key',
					detail: `'${roomKey}' reads as a static stream index; a room key may not be all digits`,
				};
			}
			if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > MAX_ROOM_SEATS) {
				return { ok: false, reason: 'bad-seat-count', detail: `1-${String(MAX_ROOM_SEATS)} seats, got ${String(seatCount)}` };
			}

			const already = live.get(roomKey);
			if (already !== undefined) return { ok: true, allocation: already };

			const taken = takenPorts();
			const ports: number[] = [];
			for (let p = basePort; p < basePort + poolSize && ports.length < seatCount; p += 1) {
				if (!taken.has(p)) ports.push(p);
			}
			if (ports.length < seatCount) {
				return {
					ok: false,
					reason: 'no-ports',
					detail: `${String(seatCount)} seats wanted, ${String(ports.length)} free of ${String(poolSize)}`,
				};
			}

			const network = `${prefix}-${roomKey}`;
			const seats: RoomStreamSeat[] = ports.map((port, seat) => ({
				seat,
				port,
				container: `${prefix}-${roomKey}-${String(seat)}`,
			}));
			// Claim the ports before the first `up`: two concurrent allocates
			// must not be handed the same port while docker is still starting.
			const allocation: RoomStreamAllocation = {
				roomKey,
				network,
				seats,
				createdAt: now(),
				lastActiveAt: now(),
				attached: 0,
			};
			live.set(roomKey, allocation);

			const started: RoomStreamSeat[] = [];
			for (const seat of seats) {
				try {
					await script.up(seat.container, seat.port, network);
					started.push(seat);
				} catch (err) {
					// Half a room is not a room. Take back what came up, so a
					// failed allocate leaves the host exactly as it found it.
					for (const s of started) {
						try {
							await script.down(s.container);
						} catch {
							log({ evt: 'stream-rollback-failed', room: roomKey, container: s.container });
						}
					}
					try {
						await script.netDown(network);
					} catch {
						log({ evt: 'stream-rollback-failed', room: roomKey, network });
					}
					live.delete(roomKey);
					log({ evt: 'stream-provision-failed', room: roomKey, err: String(err) });
					return { ok: false, reason: 'provision-failed', detail: String(err) };
				}
			}

			dead.delete(roomKey);
			log({ evt: 'stream-allocated', room: roomKey, seats: seats.length, ports });
			return { ok: true, allocation };
		},

		find(roomKey) {
			return live.get(roomKey);
		},

		portOf(roomKey, seat) {
			return live.get(roomKey)?.seats.find((s) => s.seat === seat)?.port ?? null;
		},

		statusOf(roomKey) {
			const alloc = live.get(roomKey);
			if (alloc !== undefined) {
				return { roomKey, state: 'live', seats: alloc.seats.length };
			}
			const gone = dead.get(roomKey);
			if (gone !== undefined) {
				return { roomKey, state: 'dead', seats: 0, reason: gone.reason, since: new Date(gone.at).toISOString() };
			}
			return { roomKey, state: 'none', seats: 0 };
		},

		list() {
			return [...live.values()];
		},

		noteAttach(roomKey) {
			const alloc = live.get(roomKey);
			if (alloc === undefined) return;
			alloc.attached += 1;
			alloc.lastActiveAt = now();
		},

		noteDetach(roomKey) {
			const alloc = live.get(roomKey);
			if (alloc === undefined) return;
			alloc.attached = Math.max(0, alloc.attached - 1);
			// The idle window starts when the LAST socket leaves, which is what
			// this timestamp means — not "when something last happened".
			alloc.lastActiveAt = now();
		},

		async release(roomKey, reason) {
			const alloc = live.get(roomKey);
			if (alloc === undefined) return;
			await destroy(alloc, reason);
		},

		async sweep() {
			const reclaimed: SweepReport['reclaimed'] = [];
			const at = now();
			for (const alloc of [...live.values()]) {
				if (!options.roomExists(alloc.roomKey)) {
					await destroy(alloc, 'room-gone');
					reclaimed.push({ roomKey: alloc.roomKey, reason: 'room-gone' });
					continue;
				}
				if (alloc.attached === 0 && at - alloc.lastActiveAt >= idleMs) {
					await destroy(alloc, 'idle');
					reclaimed.push({ roomKey: alloc.roomKey, reason: 'idle' });
				}
			}
			return { reclaimed };
		},

		async sweepOrphans() {
			const reclaimed: SweepReport['reclaimed'] = [];
			let names: string[];
			try {
				names = await script.list(prefix);
			} catch (err) {
				log({ evt: 'stream-orphan-list-failed', err: String(err) });
				return { reclaimed };
			}
			const ours = new Set<string>();
			for (const alloc of live.values()) for (const s of alloc.seats) ours.add(s.container);
			for (const name of names) {
				if (ours.has(name)) continue;
				// A container with our prefix that no allocation owns is what a
				// restart leaves behind: 1.3 GiB with nothing to reach it.
				try {
					await script.down(name);
					reclaimed.push({ roomKey: name, reason: 'orphan' });
					log({ evt: 'stream-orphan-reclaimed', container: name });
				} catch (err) {
					log({ evt: 'stream-orphan-reclaim-failed', container: name, err: String(err) });
				}
			}
			return { reclaimed };
		},
	};
}
