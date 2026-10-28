/**
 * The coordinator's placement across hosts: claws first, hokon as the backstop.
 *
 * `CARDTABLE_PLAY_HOSTS=claws` puts this in front of `host.ts`'s JVM pools; `local` (the default)
 * leaves today's one local pool alone. It is a `MatchHostFactory` like the pool it wraps, so
 * `match.ts`, `start-queue.ts` and the recorder see no difference.
 *
 * - **Hosts.** One `jvmHostFactory` pool per claw, over that claw's agent (`remote/`), with its
 *   records and streams under `<workDir>-claws/<node>`, so the local boot sweep of `workDir` never
 *   reads them. One local pool on hokon, the backstop, with no warm JVM. The claws are the nodes
 *   fleet-manager reports with a hosting slice (`fleet.ts`), read every `FLEET_POLL_MS`.
 * - **Placement** is `rules.ts`: the six bars, spread by free room with the faster core breaking
 *   ties, and hokon only while the backstop is promoted. With nowhere to go `room()` answers `full`
 *   and the start waits in `start-queue.ts`, and the Capacity alert fires.
 * - **Slices.** Every poll that read fleet status asks fleet-manager for `demandStep`'s count of
 *   slices, with the order to end them in (`fleet.ts` `demand`); its converger declares and ends
 *   them while our registered `hosting.json` says `placement.auto`, and only plans otherwise.
 * - **Failover** (forge-hosting-plan §5; the ruling: always, with no second chance). A JVM lost
 *   on a claw, its agent's heartbeat lost for the fencing window, or a match-level `fatal` fails the
 *   CLAW: it is quarantined, every match it held is restored elsewhere (`Restorer`, called BEFORE
 *   the old match is told it ended), and whatever still runs there is killed. A match that never
 *   started is simply placed again. Lines from a moved match's old host are dropped. One alert
 *   lists every match. A quarantined claw rejoins once fleet-manager has reported it healthy since
 *   AND a canary match passes on it.
 * - **Planned moves.** A hosting end or reboot notice stops placement on the claw at once
 *   (`NOTICE_HORIZON_MS`); from `MOVE_AHEAD_MS` before the event each remaining match moves at its
 *   next turn start (the snapshot line). A JVM whose heap wants recycling takes no new match and
 *   retires once empty.
 * - **AI degraded.** Each `cutoff` a host's bridges report (`host.ts`, "AI cutoffs") fails its `ai`
 *   bar for `AI_CUTOFF_WINDOW_MS` and opens `ai:<host>` with one alert; the health tick resolves it
 *   once the window is clean. Nothing moves: the host only stops taking new matches.
 * - **Restarts.** On the way down every agent is told to hold its JVMs for `restartGraceMs` past
 *   the fencing window; the next coordinator connects, re-attaches and replays them. An unclean
 *   death sends no hold, and the agents fence at the window.
 */

import { existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
	jvmHostFactory,
	type AiCutoff,
	type BridgeLine,
	type HostEvents,
	type JvmHostConfig,
	type JvmHostFactory,
	type MatchHost,
	type MatchHostFactory,
	type MatchRecord,
	type MatchSpec,
	type ReapResult,
	MAX_CONCURRENT_MATCHES,
} from '../host.js';
import { MATCHES_PER_JVM, JVM_HEAP_MB } from '../local-jvm.js';
import type { JvmLauncher } from '../jvm-transport.js';
import type { AgentClient } from '../remote/client.js';
import { FENCE_MS, HEARTBEAT_MS, sliceNeedMb } from '../remote/wire.js';
import type { Alerts } from './alerts.js';
import type { FleetDemand, FleetNode, FleetSource } from './fleet.js';
import {
	AI_CUTOFF_WINDOW_MS,
	BACKSTOP_IDLE,
	DEMAND_IDLE,
	MOVE_AHEAD_MS,
	aiBar,
	backstopStep,
	bars,
	demandStep,
	eligible,
	jvmsThatFit,
	nextEvent,
	rankClaws,
	readForce,
	type Bar,
	type BackstopState,
	type DemandState,
} from './rules.js';

export const FLEET_POLL_MS = 60_000;
/** Agent health (heartbeat freshness, heap recycling) is read this often. */
export const HEALTH_TICK_MS = HEARTBEAT_MS;
/** A heartbeat older than this fails the agent bar (the fencing window fails the claw). */
export const HEARTBEAT_FRESH_MS = 3 * HEARTBEAT_MS;
/** How long agents hold their JVMs, past the fencing window, for the next coordinator. */
export const RESTART_GRACE_MS = 90_000;
/** A canary that failed is tried again after this. */
export const CANARY_RETRY_MS = 5 * 60_000;
export const CANARY_TIMEOUT_MS = 120_000;
/** hokon's JVMs as the backstop: an emergency, not a host. */
export const BACKSTOP_JVMS = 1;

/** What a snapshot restore cannot bring back (`match.ts` `restoredSpec` has the full list). */
const SNAPSHOT_LOSES = 'back to the start of the turn: until-end-of-turn effects, the stack and pending triggers are gone';

/** The parts of an agent link placement reads. */
export type AgentLink = Pick<AgentClient, 'lost' | 'health' | 'onLost' | 'hold' | 'close' | 'silentMs'>;

export interface ClawConnection {
	client: AgentLink;
	launcher: JvmLauncher;
}

export type RestoreOutcome = { from: 'snapshot'; turn: number } | { from: 'spec' };

/**
 * Starts a match again elsewhere, keeping its id and seats: `MatchRegistry.restore` (from its
 * latest turn-start snapshot, or from its spec before the first one). Null when it cannot. It
 * places through this factory, which no longer offers the failed host.
 */
export interface Restorer {
	restore(matchId: string): RestoreOutcome | null;
}

/** Proves a claw can host again: null when it passed, else why not. */
export type Canary = (node: string, pool: JvmHostFactory) => Promise<string | null>;

export interface PlacementOptions {
	config: JvmHostConfig;
	fleet: FleetSource;
	/** Connect to the agent on `node` and give it this server's runtime (`connectRemoteHost`). */
	connect(node: string): Promise<ClawConnection>;
	alerts: Alerts;
	/** hokon's launcher. Default: this machine's (`localJvmLauncher`, with its boot sweep). */
	backstopLauncher?: JvmLauncher;
	backstopJvms?: number;
	canary?: Canary;
	/** The operator's backstop force file (`rules.ts` `readForce`). */
	forceFile?: string;
	restartGraceMs?: number;
	pollMs?: number;
	/** False in tests: they call `poll` and `tick` themselves. */
	timers?: boolean;
	now?: () => number;
	log?: (entry: Record<string, unknown>) => void;
}

interface Host {
	readonly name: string;
	readonly kind: 'claw' | 'backstop';
	pool: JvmHostFactory | null;
	link: ClawConnection | null;
	connecting: boolean;
	agentError: string | null;
	fleet: FleetNode | null;
	maxJvms: number;
	quarantine: { cause: string; at: number; canary: string | null; nextCanary: number; canaryRunning: boolean } | null;
	/** Set while its matches are being moved off, so the kills that follow are not a second failure. */
	failing: boolean;
	/** Planned moves armed for its next event. */
	moving: string | null;
	/** When Forge cut an AI decision short on it, oldest first, within `AI_CUTOFF_WINDOW_MS`. */
	cutoffs: number[];
	/** Since when it has not been usable (`DemandClaw`); null while it is. */
	unusableSince: number | null;
}

/**
 * What `Match` holds: the host it talks to, which a start placed again (it failed before it was
 * `ready`) swaps underneath it.
 */
class Face implements MatchHost {
	private remembered: { epoch: string; owners: (string | null)[] } | null = null;
	constructor(private target: MatchHost) {}
	swap(target: MatchHost): void {
		this.target = target;
		if (this.remembered !== null) target.remember?.(this.remembered);
	}
	send(command: Parameters<MatchHost['send']>[0]): void {
		this.target.send(command);
	}
	stop(): void {
		this.target.stop();
	}
	remember(state: { epoch: string; owners: (string | null)[] }): void {
		this.remembered = state;
		this.target.remember?.(state);
	}
	handOver(): boolean {
		return this.target.handOver?.() ?? false;
	}
}

/** One match on one host, as this layer knows it. */
interface Placed {
	readonly id: string;
	readonly spec: MatchSpec;
	readonly events: HostEvents;
	readonly host: Host;
	face: Face | null;
	/** Forge said `ready`: the match has been shown to its seats, so it can only be restored. */
	ready: boolean;
	/** Moved elsewhere: everything its old host still says is dropped. */
	moved: boolean;
	moveAtTurnStart: boolean;
}

interface Moved {
	matchId: string;
	to: string | null;
	how: string;
	ms: number;
}

export interface HostView {
	name: string;
	kind: 'claw' | 'backstop';
	eligible: boolean;
	bars: Bar[];
	free: number;
	maxJvms: number;
	jvms: { hostId: string; warm: boolean; draining: boolean; matches: string[] }[];
	matches: string[];
	quarantine: { cause: string; since: string; canary: string | null } | null;
	nextEvent: { at: string; what: string } | null;
	health: AgentLink['health'];
}

export interface HostsView {
	mode: 'claws';
	fleet: { readAt: string | null; fresh: boolean };
	/** What we last asked fleet-manager for, and its converger's answer. */
	slices: { asked: number | null; releaseOrder: string[]; converger: FleetDemand | null };
	backstop: BackstopState & { forcedUntil: string | null };
	hosts: HostView[];
	alerts: { key: string; at: string; text: string }[];
}

export type Placement = MatchHostFactory &
	Omit<JvmHostFactory, 'room'> & {
	room(): 'warm' | 'booting' | 'none' | 'full';
	/** The registry's restore, once it exists (it is built after the factory). */
	restoreWith(restorer: Restorer): void;
	/** Read fleet status, connect, recover, arm planned moves, step the backstop. */
	poll(): Promise<void>;
	/** Read agent health: heartbeat freshness and heap recycling. */
	tick(): void;
	hosts(): HostsView;
	/** The first poll and its connects: what `orphans` waits for. */
	ready: Promise<void>;
};

/** A start-to-first-frame canary: a human seat and an AI seat with random precons, stopped at once. */
export function frameCanary(timeoutMs = CANARY_TIMEOUT_MS): Canary {
	const spec: MatchSpec = { seats: [{ name: 'canary', ai: false, deck: null }, { name: 'canary-ai', ai: true, deck: null }], seed: 1 };
	return (_node, pool) =>
		new Promise((resolve) => {
			let done = false;
			let host: MatchHost | null = null;
			const finish = (why: string | null): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				host?.stop();
				resolve(why);
			};
			const timer = setTimeout(() => finish(`no frame within ${timeoutMs / 1000} s`), timeoutMs);
			timer.unref();
			try {
				host = pool(`m-canary${randomBytes(4).toString('hex')}`, spec, {
					line: (l) => {
						if (l.t === 'frame') finish(null);
						else if (l.t === 'fatal') finish(`fatal: ${l.message}`);
					},
					exit: (reason) => finish(`ended before its first frame: ${reason}`),
					log: () => {},
				});
			} catch (err) {
				finish(`could not start: ${(err as Error).message}`);
			}
		});
}

export function placement(opts: PlacementOptions): Placement {
	const now = opts.now ?? Date.now;
	const log = opts.log ?? (() => {});
	const config = opts.config;
	const perJvm = config.perJvm ?? MATCHES_PER_JVM;
	const xmxMb = config.xmxMb ?? JVM_HEAP_MB;
	const graceMs = opts.restartGraceMs ?? RESTART_GRACE_MS;
	const canary = opts.canary ?? frameCanary();
	const alerts = opts.alerts;
	const clawsDir = `${config.workDir}-claws`;

	const hosts = new Map<string, Host>();
	const placed = new Map<string, Placed>();
	const orphanHost = new Map<string, Host>();
	const roomWatchers: (() => void)[] = [];
	const fatalBefore = new Set<string>();
	let restorer: Restorer | null = null;
	let backstop: BackstopState = BACKSTOP_IDLE;
	let fleetReadAt: number | null = null;
	let fleetFresh = false;
	let closing = false;
	let polling: Promise<void> | null = null;
	let demand: DemandState = DEMAND_IDLE;
	let releaseOrder: string[] = [];
	let converger: FleetDemand | null = null;
	/** A start found no host since the last poll. */
	let short = false;
	/** Set while a restore runs: the factory never places onto the host being failed. */
	let exceptHost: Host | null = null;
	const timers: NodeJS.Timeout[] = [];

	const notifyRoom = (): void => {
		for (const l of roomWatchers) l();
	};

	function newHost(name: string, kind: Host['kind'], maxJvms: number): Host {
		const host: Host = {
			name,
			kind,
			pool: null,
			link: null,
			connecting: false,
			agentError: null,
			fleet: null,
			maxJvms,
			quarantine: null,
			failing: false,
			moving: null,
			cutoffs: [],
			unusableSince: null,
		};
		hosts.set(name, host);
		return host;
	}

	function makePool(host: Host, launcher: JvmLauncher | undefined, workDir: string, warm: boolean): JvmHostFactory {
		const pool = jvmHostFactory(
			{ ...config, workDir },
			{ ...(launcher === undefined ? {} : { launcher }), warm, maxJvms: host.maxJvms, onCutoff: (c) => aiCutoff(host, c), log: (e) => log({ ...e, host: host.name }) },
		);
		pool.watchRoom?.(notifyRoom);
		return pool;
	}

	const hokon = newHost('hokon', 'backstop', opts.backstopJvms ?? BACKSTOP_JVMS);
	hokon.pool = makePool(hokon, opts.backstopLauncher, config.workDir, false);

	const claws = (): Host[] => [...hosts.values()].filter((h) => h.kind === 'claw');

	/** Matches a host can still take: room in its JVMs, and room for JVMs it does not run yet. */
	function free(host: Host): number {
		if (host.pool === null) return 0;
		const jvms = host.pool.jvms();
		const inJvms = jvms.filter((j) => !j.draining).reduce((n, j) => n + Math.max(0, perJvm - j.matches.length), 0);
		return inJvms + Math.max(0, host.maxJvms - jvms.length) * perJvm;
	}

	/** AI cutoffs on `host` within `AI_CUTOFF_WINDOW_MS`, forgetting older ones. */
	function recentCutoffs(host: Host): number {
		const since = now() - AI_CUTOFF_WINDOW_MS;
		while (host.cutoffs.length > 0 && host.cutoffs[0]! <= since) host.cutoffs.shift();
		return host.cutoffs.length;
	}

	function barsOf(host: Host): Bar[] {
		if (host.kind === 'backstop') {
			const room = free(host);
			return [
				{ bar: 'backstop', ok: backstop.promoted, why: backstop.promoted ? '' : `the backstop is not promoted (${backstop.why})` },
				{ bar: 'room', ok: room > 0, why: room > 0 ? '' : 'full' },
				aiBar(recentCutoffs(host)),
			];
		}
		const silentMs = host.link?.client.lost === null ? host.link.client.silentMs() : null;
		return bars(
			{
				node: host.name,
				fleet: host.fleet,
				agent: { connected: host.link !== null && host.link.client.lost === null, silentMs, error: host.agentError },
				quarantine: host.quarantine === null ? null : `failed: ${host.quarantine.cause}${host.quarantine.canary === null ? '' : `; canary: ${host.quarantine.canary}`}`,
				room: { free: free(host), why: host.pool === null ? 'no JVM pool' : host.maxJvms === 0 ? 'the slice holds no JVM of this size' : null },
				aiCutoffs: recentCutoffs(host),
			},
			now(),
			HEARTBEAT_FRESH_MS,
		);
	}

	/** The best host for a new match now, never `except`. */
	function pick(except: Host | null = null): Host | null {
		const open = claws()
			.filter((h) => h !== except && eligible(barsOf(h)))
			.map((h) => ({ node: h.name, free: free(h), host: h }));
		const best = rankClaws(open)[0];
		if (best !== undefined) return best.host;
		if (hokon !== except && eligible(barsOf(hokon))) return hokon;
		return null;
	}

	function whyNone(): string {
		const parts = claws().map((h) => `${h.name}: ${barsOf(h).filter((b) => !b.ok).map((b) => `${b.bar} (${b.why})`).join(', ') || 'eligible'}`);
		const ai = aiBar(recentCutoffs(hokon));
		parts.push(`hokon: ${backstop.promoted ? (free(hokon) > 0 ? 'promoted' : 'promoted but full') : `not promoted (${backstop.why})`}${ai.ok ? '' : `, ai (${ai.why})`}`);
		return parts.join('; ');
	}

	/**
	 * Forge cut an AI decision short on `host` (forge-hosting-plan §4.2, "Live quality is watched"):
	 * it fails the `ai` bar at once, and opens `ai:<host>` with one alert. `tick` resolves it once
	 * `AI_CUTOFF_WINDOW_MS` passes without another. Live matches stay where they are.
	 */
	function aiCutoff(host: Host, cutoff: AiCutoff): void {
		host.cutoffs.push(now());
		const recent = recentCutoffs(host);
		log({ evt: 'host-ai-cutoff', host: host.name, jvm: cutoff.hostId, matchId: cutoff.matchId, where: cutoff.where, recent });
		const bar = aiBar(recent);
		if (closing || bar.ok) return;
		const key = `ai:${host.name}`;
		if (!alerts.isOpen(key)) {
			const what = `${cutoff.matchId ?? `JVM ${cutoff.hostId}`}${cutoff.where === null ? '' : `, in ${cutoff.where}`}`;
			alerts.fire(
				key,
				`⚠️ AI degraded: ${host.name} — Forge cut an AI decision short (${what}), so its AI is playing its best guess, not its best move. It takes no new match until ${AI_CUTOFF_WINDOW_MS / 60_000} min pass without one.`,
			);
		}
		if (host.kind === 'claw') stepBackstop(true, true);
		notifyRoom();
	}

	/** Close `ai:<host>` for every host whose window is clean again. */
	function aiClean(): void {
		for (const host of hosts.values()) {
			const key = `ai:${host.name}`;
			if (alerts.isOpen(key) && recentCutoffs(host) === 0) {
				alerts.resolve(key, `AI clean: ${host.name} — no AI decision cut short for ${AI_CUTOFF_WINDOW_MS / 60_000} min`);
				log({ evt: 'host-ai-clean', host: host.name });
			}
		}
	}

	function capacityShort(): void {
		short = true;
		if (alerts.isOpen('capacity') || closing) return;
		const fleet =
			converger === null
				? ''
				: ` fleet-manager has ${converger.declared.length} declared for us; ${converger.auto ? 'the next poll asks for more' : "its converger only plans (no placement.auto), so declaring another is the operator's call"}.`;
		alerts.fire('capacity', `⚠️ Capacity: a Forge match is waiting for a host. ${whyNone()}.${fleet}`);
	}

	function matchesOn(host: Host): number {
		let n = 0;
		for (const p of placed.values()) if (p.host === host) n += 1;
		return n;
	}

	/** Usable, as `DemandClaw` means it: every bar but room and AI quality holds. */
	function usable(host: Host): boolean {
		return barsOf(host).every((b) => b.ok || b.bar === 'room' || b.bar === 'ai');
	}

	/** Ask fleet-manager for this poll's count of slices. */
	async function askSlices(): Promise<void> {
		const declared = claws().filter((h) => h.fleet?.hosting != null);
		for (const h of declared) {
			if (usable(h)) h.unusableSince = null;
			else h.unusableSince ??= now();
		}
		const capacities = declared.map((h) => h.maxJvms * perJvm).filter((n) => n > 0);
		const step = demandStep(demand, {
			claws: declared.map((h) => ({ node: h.name, usable: h.unusableSince === null, unusableSince: h.unusableSince, live: matchesOn(h) })),
			live: placed.size,
			perSlice: capacities.length === 0 ? perJvm : Math.max(...capacities),
			ceiling: MAX_CONCURRENT_MATCHES,
			short,
			now: now(),
		});
		short = false;
		if (step.slices !== demand.slices || step.releaseOrder.join() !== releaseOrder.join()) {
			log({ evt: 'slice-demand', slices: step.slices, was: demand.slices, releaseOrder: step.releaseOrder, live: placed.size });
		}
		demand = step.state;
		releaseOrder = step.releaseOrder;
		const answer = await opts.fleet.demand(step.slices, step.releaseOrder).catch(() => null);
		if (answer === null) return;
		if (answer.actions.length > 0) log({ evt: 'slice-converger', auto: answer.auto, live: answer.live, actions: answer.actions, blocked: answer.blocked });
		converger = answer;
	}

	/* ── Matches ── */

	function wrap(p: Placed): HostEvents {
		return {
			line: (l: BridgeLine) => {
				if (p.moved) return;
				if (l.t === 'ready') p.ready = true;
				if (l.t === 'fatal' && p.ready && !closing) {
					matchFailed(p, `a match failed on it: ${l.message}`);
					return;
				}
				p.events.line(l);
				if ((l as { t: string }).t === 'snapshot' && p.moveAtTurnStart) plannedMove(p);
			},
			exit: (reason) => {
				if (p.moved) return;
				if (closing || reason === 'stopped') {
					if (placed.get(p.id) === p) placed.delete(p.id);
					p.events.exit(reason);
					return;
				}
				matchFailed(p, reason);
			},
			log: (e) => p.events.log(e),
			...(p.events.replayed === undefined ? {} : { replayed: p.events.replayed.bind(p.events) }),
		};
	}

	function placeOn(host: Host, matchId: string, spec: MatchSpec, events: HostEvents, face: Face | null = null): MatchHost {
		if (host.pool === null) throw new Error(`${host.name} has no JVM pool`);
		const p: Placed = { id: matchId, spec, events, host, face, ready: false, moved: false, moveAtTurnStart: false };
		const target = host.pool(matchId, spec, wrap(p));
		if (face === null) p.face = new Face(target);
		else face.swap(target);
		placed.set(matchId, p);
		events.log({ evt: 'match-host', matchId, host: host.name });
		if (alerts.isOpen('capacity')) alerts.resolve('capacity', 'Capacity: Forge matches are being placed again');
		return p.face!;
	}

	/** A match's host said it failed. On a claw that is the claw's failure; on hokon, the match's. */
	function matchFailed(p: Placed, cause: string): void {
		const fatal = cause.startsWith('a match failed on it');
		if (fatal && fatalBefore.has(p.id)) {
			// It failed the same way on the host it was moved to: the match is the common factor.
			log({ evt: 'match-fatal-again', matchId: p.id, host: p.host.name, cause });
			const lost = move(p, cause, p.host, 'it failed again after a move, so the match, not the host, is the likely fault');
			alerts.fire(`lost:${p.id}`, `🚨 Match lost: ${p.id} on ${p.host.name}: ${cause}; ${lost.how}.`);
			return;
		}
		if (fatal) fatalBefore.add(p.id);
		if (p.host.kind === 'claw') {
			failClaw(p.host, cause);
			return;
		}
		const result = move(p, cause, p.host);
		alertIncident(p.host, cause, result.to === null ? [] : [result], result.to === null ? [result] : []);
	}

	/**
	 * Restore `p` elsewhere, then fail the old match: in that order, so the seats never see the end
	 * of a match that is coming back.
	 */
	function move(p: Placed, cause: string, from: Host, refuse: string | null = null): Moved {
		p.moved = true;
		if (placed.get(p.id) === p) placed.delete(p.id);
		const t0 = now();
		let why = refuse;
		let how = '';
		if (why === null && !p.ready) {
			// Nothing of it has reached a seat yet: the same start, on another host.
			const to = pick(from);
			if (to === null) why = 'no host can take it';
			else {
				try {
					placeOn(to, p.id, p.spec, p.events, p.face);
					how = 'placed again (it had not started)';
				} catch (err) {
					why = `it could not be placed: ${(err as Error).message}`;
				}
			}
		} else if (why === null) {
			if (restorer === null) why = 'this server cannot restore a match';
			else if (pick(from) === null) why = 'no host can take it';
			else {
				exceptHost = from;
				try {
					const outcome = restorer.restore(p.id);
					if (outcome === null) why = 'it could not be restored';
					else how = outcome.from === 'snapshot' ? `restored at the start of turn ${outcome.turn}` : 'restarted from its spec: a new game, same seats';
				} catch (err) {
					why = `its restore failed: ${(err as Error).message}`;
				} finally {
					exceptHost = null;
				}
			}
		}
		const ms = now() - t0;
		const to = why === null ? (placed.get(p.id)?.host.name ?? 'the start queue') : null;
		p.events.log({ evt: why === null ? 'match-moved' : 'match-lost', matchId: p.id, from: from.name, to, cause, ...(why === null ? { how } : { why }), ms });
		// Placed again, the same `Match` goes on through its swapped face; restored, the old one ends.
		if (why !== null || p.ready) p.events.exit(why === null ? `moved to ${to}: ${cause}` : `the match was lost: ${cause}, and ${why}`);
		return { matchId: p.id, to, how: why ?? how, ms };
	}

	function failClaw(host: Host, cause: string): void {
		if (host.failing) return;
		host.failing = true;
		const t0 = now();
		quarantine(host, cause);
		// Losing the last claw promotes hokon before anything is moved, so the moves can use it.
		stepBackstop(true, true);
		const victims = [...placed.values()].filter((p) => p.host === host && !p.moved);
		const results = victims.map((p) => move(p, cause, host));
		detach(host, cause);
		const moved = results.filter((r) => r.to !== null);
		const lost = results.filter((r) => r.to === null);
		log({ evt: 'claw-failed-over', host: host.name, cause, moved, lost, ms: now() - t0 });
		alertIncident(host, cause, moved, lost);
		host.failing = false;
		notifyRoom();
	}

	function alertIncident(host: Host, cause: string, moved: Moved[], lost: Moved[]): void {
		const list = (rs: Moved[]): string => rs.map((r) => `${r.matchId} → ${r.to} (${r.how}, ${r.ms} ms)`).join('; ');
		const quarantined = host.kind === 'claw' ? ` ${host.name} is quarantined until fleet-manager reports it healthy and a canary match passes on it.` : '';
		if (moved.length > 0 || lost.length === 0) {
			const snap = moved.some((r) => r.how.startsWith('restored')) ? ` A restore is ${SNAPSHOT_LOSES}.` : '';
			alerts.fire(
				`failover:${host.name}`,
				`🚨 Failover: ${host.name} — ${cause}. Moved ${moved.length}: ${list(moved) || 'none'}.${snap}${quarantined}`,
			);
		}
		if (lost.length > 0) {
			alerts.fire(`lost:${host.name}`, `🚨 Match lost: ${lost.length} on ${host.name} — ${cause}: ${lost.map((r) => `${r.matchId} (${r.how})`).join('; ')}.${quarantined}`);
		}
	}

	function quarantine(host: Host, cause: string): void {
		if (host.kind !== 'claw') return;
		host.quarantine ??= { cause, at: now(), canary: null, nextCanary: 0, canaryRunning: false };
		log({ evt: 'claw-quarantined', host: host.name, cause });
	}

	/** Let go of everything on a failed claw: kill what still runs, keep its records out of the next pool's way. */
	function detach(host: Host, cause: string): void {
		const pool = host.pool;
		host.pool = null;
		pool?.abandon(cause);
		const dir = join(clawsDir, host.name);
		if (existsSync(dir)) {
			try {
				renameSync(dir, `${dir}.failed-${now()}`);
			} catch (err) {
				log({ evt: 'claw-records-kept', host: host.name, error: (err as Error).message });
			}
		}
		if (host.link !== null && host.link.client.lost !== null) host.link = null;
	}

	function plannedMove(p: Placed): void {
		if (p.moved || restorer === null) return;
		const from = p.host;
		if (pick(from) === null) {
			log({ evt: 'planned-move-waiting', matchId: p.id, host: from.name, why: 'no host can take it now' });
			return;
		}
		p.moved = true;
		if (placed.get(p.id) === p) placed.delete(p.id);
		exceptHost = from;
		let outcome: RestoreOutcome | null;
		try {
			outcome = restorer.restore(p.id);
		} catch (err) {
			log({ evt: 'planned-move-failed', matchId: p.id, host: from.name, error: (err as Error).message });
			outcome = null;
		} finally {
			exceptHost = null;
		}
		log({ evt: 'planned-move', matchId: p.id, from: from.name, to: placed.get(p.id)?.host.name ?? null, outcome, why: from.moving });
		if (outcome === null) {
			p.moved = false;
			placed.set(p.id, p);
		}
	}

	/* ── Hosts ── */

	function ensureClaw(node: FleetNode): Host {
		const existing = hosts.get(node.node);
		if (existing !== undefined) return existing;
		const memoryMb = node.hosting?.declared?.memoryMb ?? 0;
		return newHost(node.node, 'claw', jvmsThatFit(memoryMb, xmxMb, sliceNeedMb));
	}

	async function connectClaw(host: Host): Promise<void> {
		host.connecting = true;
		try {
			const conn = await opts.connect(host.name);
			if (closing) {
				conn.client.close();
				return;
			}
			host.link = conn;
			host.agentError = null;
			conn.client.onLost((reason) => agentLost(host, conn, reason));
			host.pool = makePool(host, conn.launcher, join(clawsDir, host.name), true);
			alerts.resolve(`pin:${host.name}`, `Pin servable on ${host.name} again`);
			log({ evt: 'claw-connected', host: host.name, maxJvms: host.maxJvms });
		} catch (err) {
			host.agentError = (err as Error).message;
			log({ evt: 'claw-connect-failed', host: host.name, error: host.agentError });
			if ((err as Error).name === 'PinNotServable') alerts.fire(`pin:${host.name}`, `⚠️ Pin not servable: ${host.agentError}`);
		} finally {
			host.connecting = false;
		}
	}

	function agentLost(host: Host, conn: ClawConnection, reason: string): void {
		if (host.link !== conn) return;
		host.link = null;
		if (closing) return;
		// Every JVM's exit came first (`AgentClient.lose`): a claw with matches has failed over already.
		const live = [...placed.values()].some((p) => p.host === host && !p.moved);
		if (live) {
			failClaw(host, reason);
			return;
		}
		const hadPool = host.pool !== null;
		quarantine(host, reason);
		detach(host, reason);
		if (hadPool) alerts.fire(`hb:${host.name}`, `⚠️ Claw heartbeat lost: ${host.name} — ${reason}. No match was on it. Quarantined until a healthy status and a canary.`);
		stepBackstop(true, true);
		notifyRoom();
	}

	async function recover(host: Host): Promise<void> {
		const q = host.quarantine;
		if (q === null || q.canaryRunning || now() < q.nextCanary) return;
		const f = host.fleet;
		// Healthy since the failure, by a status read after it.
		if (fleetReadAt === null || fleetReadAt <= q.at || f === null || !f.reachable || f.hosting?.state !== 'guaranteed') return;
		if (host.link === null || host.link.client.lost !== null) return;
		host.pool ??= makePool(host, host.link.launcher, join(clawsDir, host.name), true);
		q.canaryRunning = true;
		const why = await canary(host.name, host.pool).catch((err: unknown) => `threw: ${(err as Error).message}`);
		q.canaryRunning = false;
		if (host.quarantine !== q) return;
		if (why !== null) {
			q.canary = why;
			q.nextCanary = now() + CANARY_RETRY_MS;
			log({ evt: 'canary-failed', host: host.name, why });
			return;
		}
		host.quarantine = null;
		log({ evt: 'claw-recovered', host: host.name, after: q.cause });
		const words = `Recovered: ${host.name} passed its canary and takes matches again`;
		for (const key of [`failover:${host.name}`, `lost:${host.name}`, `hb:${host.name}`]) alerts.resolve(key, words);
		notifyRoom();
	}

	/** One backstop step. `promoteOnly` is an event between polls: it may promote, never count calm. */
	function stepBackstop(fresh: boolean, promoteOnly = false): void {
		const declared = claws().filter((h) => h.fleet?.hosting != null);
		const step = backstopStep(backstop, {
			fresh: fresh && fleetReadAt !== null,
			declared: declared.length,
			reachable: declared.filter((h) => h.fleet?.reachable === true).length,
			eligible: claws().filter((h) => eligible(barsOf(h))).length,
			forced: opts.forceFile === undefined ? false : readForce(opts.forceFile, now()) !== null,
		});
		if (promoteOnly && step.change !== 'promote') return;
		backstop = step.state;
		if (step.change === 'promote') {
			log({ evt: 'backstop-promoted', why: backstop.why });
			alerts.fire('backstop', `🔺 hokon promoted to the Forge backstop: ${backstop.why}.`);
		} else if (step.change === 'demote') {
			log({ evt: 'backstop-demoted', why: backstop.why });
			alerts.resolve('backstop', `🔻 hokon stood down as the Forge backstop: ${backstop.why}. Its live matches finish there.`, '');
		}
	}

	async function pollOnce(): Promise<void> {
		const status = await opts.fleet.status().catch(() => null);
		fleetFresh = status !== null;
		if (status !== null) {
			fleetReadAt = status.at;
			for (const node of status.nodes) {
				if (node.hosting === null && !hosts.has(node.node)) continue;
				ensureClaw(node).fleet = node;
			}
		}
		await Promise.all(
			claws()
				.filter((h) => h.link === null && !h.connecting && h.fleet?.reachable === true && h.fleet.hosting?.state === 'guaranteed')
				.map((h) => connectClaw(h)),
		);
		for (const host of claws()) {
			const event = nextEvent(host.fleet);
			if (event === null || event.at - now() > MOVE_AHEAD_MS) continue;
			host.moving = `${event.what} at ${new Date(event.at).toISOString()}`;
			for (const p of placed.values()) {
				if (p.host !== host || p.moveAtTurnStart) continue;
				p.moveAtTurnStart = true;
				p.events.log({ evt: 'planned-move-armed', matchId: p.id, host: host.name, why: host.moving });
			}
		}
		stepBackstop(fleetFresh);
		if (fleetFresh) await askSlices();
		await Promise.all(claws().map((h) => recover(h)));
		notifyRoom();
	}

	const factory = ((matchId: string, spec: MatchSpec, events: HostEvents): MatchHost => {
		const host = pick(exceptHost);
		if (host === null) {
			capacityShort();
			throw new Error(`no Forge host can take a match now (${whyNone()})`);
		}
		return placeOn(host, matchId, spec, events);
	}) as Placement;

	factory.restoreWith = (r) => {
		restorer = r;
	};

	factory.poll = () => {
		polling ??= pollOnce().finally(() => {
			polling = null;
		});
		return polling;
	};

	factory.tick = () => {
		for (const host of claws()) {
			const health = host.link?.client.health;
			if (host.pool === null || health == null) continue;
			for (const j of health.jvms) if (j.recycleWanted) host.pool.drain(j.hostId, 'its heap after GC is past the recycle share');
		}
		aiClean();
		notifyRoom();
	};

	factory.room = () => {
		const host = pick(exceptHost);
		if (host === null) {
			capacityShort();
			return 'full';
		}
		return host.pool?.room() ?? 'none';
	};
	factory.booting = () => [...hosts.values()].reduce((n, h) => n + (h.pool?.booting() ?? 0), 0);
	factory.watchRoom = (listener) => {
		roomWatchers.push(listener);
	};
	factory.jvms = () => [...hosts.values()].flatMap((h) => h.pool?.jvms() ?? []);
	factory.drain = (hostId, why) => {
		for (const h of hosts.values()) h.pool?.drain(hostId, why);
	};
	factory.abandon = (why) => {
		for (const h of hosts.values()) h.pool?.abandon(why);
	};

	factory.ready = factory.poll();

	factory.orphans = async () => {
		await factory.ready;
		const all: MatchRecord[] = [];
		for (const host of hosts.values()) {
			for (const record of (await host.pool?.orphans()) ?? []) {
				orphanHost.set(record.matchId, host);
				all.push(record);
			}
		}
		return all.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	};

	factory.attach = (record, events) => {
		const host = orphanHost.get(record.matchId);
		if (host === undefined || host.pool === null) throw new Error(`there is no orphan match ${record.matchId} to attach to`);
		orphanHost.delete(record.matchId);
		const p: Placed = { id: record.matchId, spec: record.spec, events, host, face: null, ready: true, moved: false, moveAtTurnStart: false };
		p.face = new Face(host.pool.attach(record, wrap(p)));
		placed.set(record.matchId, p);
		return p.face;
	};

	factory.handOverAll = () => [...hosts.values()].flatMap((h) => h.pool?.handOverAll() ?? []);

	factory.close = () => {
		closing = true;
		for (const t of timers.splice(0)) clearInterval(t);
		for (const h of hosts.values()) h.pool?.close();
	};

	/**
	 * Going down: every agent holds its JVMs for the next coordinator, the pools let go of what was
	 * handed over and kill the rest, and the links close (which flushes the hold).
	 */
	factory.reapOnExit = (): ReapResult => {
		factory.close();
		const result: ReapResult = { killed: [], kept: [], left: [] };
		for (const h of claws()) h.link?.client.hold(graceMs);
		for (const h of hosts.values()) {
			if (h.pool === null) continue;
			const r = h.pool.reapOnExit();
			result.killed.push(...r.killed);
			result.kept.push(...r.kept);
			result.left.push(...r.left);
		}
		for (const h of claws()) h.link?.client.close();
		log({ evt: 'placement-down', graceMs, holdUntilMs: FENCE_MS + graceMs, ...result });
		return result;
	};

	factory.hosts = (): HostsView => {
		const force = opts.forceFile === undefined ? null : readForce(opts.forceFile, now());
		return {
			mode: 'claws',
			fleet: { readAt: fleetReadAt === null ? null : new Date(fleetReadAt).toISOString(), fresh: fleetFresh },
			slices: { asked: demand.slices, releaseOrder, converger },
			backstop: { ...backstop, forcedUntil: force === null ? null : new Date(force.until).toISOString() },
			hosts: [...hosts.values()].map((h) => {
				const b = barsOf(h);
				const event = nextEvent(h.fleet);
				return {
					name: h.name,
					kind: h.kind,
					eligible: eligible(b),
					bars: b,
					free: free(h),
					maxJvms: h.maxJvms,
					jvms: h.pool?.jvms() ?? [],
					matches: [...placed.values()].filter((p) => p.host === h).map((p) => p.id),
					quarantine: h.quarantine === null ? null : { cause: h.quarantine.cause, since: new Date(h.quarantine.at).toISOString(), canary: h.quarantine.canary },
					nextEvent: event === null ? null : { at: new Date(event.at).toISOString(), what: event.what },
					health: h.link?.client.health ?? null,
				};
			}),
			alerts: alerts.open().map((a) => ({ key: a.key, at: new Date(a.at).toISOString(), text: a.text })),
		};
	};

	if (opts.timers !== false) {
		const poll = setInterval(() => void factory.poll(), opts.pollMs ?? FLEET_POLL_MS);
		const tick = setInterval(() => factory.tick(), HEALTH_TICK_MS);
		poll.unref();
		tick.unref();
		timers.push(poll, tick);
	}

	return factory;
}
