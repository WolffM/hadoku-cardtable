/**
 * The coordinator's end of one host agent (`apps/agent`): signed requests, the
 * signed relay, heartbeats both ways, and the link's own failover clock.
 *
 * The link is lost for good when no heartbeat has arrived for the failover
 * window (`FENCE_MS`): every JVM on the claw is then gone as far as this
 * coordinator is concerned. A drop shorter than the window is repaired
 * underneath: the relay reconnects, every transport re-attaches from the last
 * line it took, and messages sent in the gap go out in order once it is back.
 * A silence every claw of its `LinkGroup` shares is this host's, not the
 * claws' (`SHARED_HOLD_MS`): it is waited out the same way, since the agents
 * keep their JVMs for `AGENT_FENCE_MS`.
 */

import { createReadStream } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { KeyObject } from 'node:crypto';

import { EMPTY_SHA, FENCE_MS, HEARTBEAT_MS, RELAY_PROTOCOL, SHARED_HOLD_MS, SHARED_SILENT_MS, sha256Hex, signFrame, signRequest, type DraftbotHealth, type FromAgent, type JvmHealth, type SliceHealth, type ToAgent } from '@hadoku/host-wire';

export interface AgentClientOptions {
	/** `http://<claw>:7621` */
	url: string;
	key: KeyObject;
	fenceMs?: number;
	heartbeatMs?: number;
	now?: () => number;
	log?: (entry: Record<string, unknown>) => void;
	/** This coordinator's other links, for a silence they all share. */
	group?: LinkGroup;
}

/** A stall of this host, as its links saw it: its own loop (`loop`), or every claw silent at once (`network`). */
export interface HostStall {
	kind: 'loop' | 'network';
	phase: 'began' | 'ended';
	/** Live links when it was seen. */
	claws: number;
	/** The loop's gap; a network stall's silence so far (began) or in all (ended). */
	silentMs: number;
}

type Member = Pick<AgentClient, 'lost' | 'silentMs'>;

/** The links of one coordinator, so each can ask whether its claw's silence is everyone's. */
export class LinkGroup {
	private readonly links = new Set<Member>();
	/** The links holding a shared silence now. */
	private readonly held = new Set<Member>();
	/** The most links that held this episode's silence at once. */
	private peak = 0;
	/** When the first of them went quiet. */
	private quietSince = Infinity;
	private lastLoopStall = -Infinity;

	/** `onStall` hears each stall once, however many links saw it. */
	constructor(private readonly onStall: (s: HostStall) => void = () => {}) {}

	add(link: Member): void {
		this.links.add(link);
	}

	private live(): number {
		return [...this.links].filter((l) => l.lost === null).length;
	}

	/** `link` saw this process stall for `gapMs` at `t`. */
	loopStalled(t: number, gapMs: number): void {
		if (t - this.lastLoopStall < WATCH_STALL_MS) return;
		this.lastLoopStall = t;
		this.onStall({ kind: 'loop', phase: 'began', claws: this.live(), silentMs: gapMs });
	}

	/** `link`, quiet since `since`, holds a silence the others share. */
	hold(link: Member, since: number, t: number): void {
		if (this.held.size === 0) this.onStall({ kind: 'network', phase: 'began', claws: this.live(), silentMs: t - since });
		this.held.add(link);
		this.peak = Math.max(this.peak, this.held.size);
		this.quietSince = Math.min(this.quietSince, since);
	}

	/** `link` was heard, or lost: once no link holds the silence, it is over. */
	release(link: Member, t: number): void {
		if (!this.held.has(link)) return;
		this.held.delete(link);
		if (this.held.size > 0) return;
		this.onStall({ kind: 'network', phase: 'ended', claws: this.peak, silentMs: t - this.quietSince });
		this.peak = 0;
		this.quietSince = Infinity;
	}

	/** Whether every other live link has missed two heartbeats too. With no other link, nobody shares it. */
	shares(link: Pick<AgentClient, 'lost' | 'silentMs'>): boolean {
		return allSilent([...this.links].filter((l) => l !== link && l.lost === null).map((l) => l.silentMs()));
	}
}

/** Some links, every one past two missed heartbeats. */
export function allSilent(silentMs: number[]): boolean {
	return silentMs.length > 0 && silentMs.every((ms) => ms >= SHARED_SILENT_MS);
}

/** What receives one JVM's frames. */
export interface FrameSink {
	line(off: number, line: string): void;
	exit(reason: string): void;
	/** The relay came back: where to resume from. */
	resumeFrom(): number;
}

/** A gap between two link-clock ticks (each ≤ 1 s apart) past this is our own stall, not the claw's. */
export const WATCH_STALL_MS = 3_000;

export class AgentClient {
	readonly url: URL;
	private readonly key: KeyObject;
	private readonly fenceMs: number;
	private readonly heartbeatMs: number;
	private readonly now: () => number;
	private readonly log: (entry: Record<string, unknown>) => void;
	private socket: Socket | null = null;
	private nonce = '';
	private seq = 0;
	private queue: ToAgent[] = [];
	private lastHb: number;
	/** When `watch` last ran: a gap far past its interval means this process, not the claw, went quiet. */
	private lastWatch: number | null = null;
	private reconnecting = false;
	private readonly group: LinkGroup | null;
	/** When this link's silence was first seen shared by every other claw; null when it is not held. */
	private sharedSince: number | null = null;
	/** Held until here: one failover window past the last tick the silence was still shared. */
	private sharedUntil = 0;
	private timers: NodeJS.Timeout[] = [];
	private readonly sinks = new Map<string, FrameSink>();
	private readonly waiting = new Map<number, (hostIds: string[]) => void>();
	private nextReq = 1;
	/** Set once the link is lost for good, or closed: nothing more is sent. */
	lost: string | null = null;
	health: { at: number; jvms: JvmHealth[]; slice: SliceHealth; draftbot: DraftbotHealth | null } | null = null;
	private lostListeners: ((reason: string) => void)[] = [];

	constructor(opts: AgentClientOptions) {
		this.url = new URL(opts.url);
		this.key = opts.key;
		this.fenceMs = opts.fenceMs ?? FENCE_MS;
		this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.lastHb = this.now();
		this.group = opts.group ?? null;
		this.group?.add(this);
	}

	/* ── Requests ── */

	/** One signed JSON request; a file body (`PUT /blob/<sha>`) is streamed. `signal` abandons it. */
	async call<T>(method: string, path: string, body?: unknown | { file: string; sha: string }, signal?: AbortSignal): Promise<T> {
		const file = typeof body === 'object' && body !== null && 'file' in body ? (body as { file: string; sha: string }) : null;
		const bytes = file || body === undefined ? null : Buffer.from(JSON.stringify(body));
		const sha = file ? file.sha : bytes ? sha256Hex(bytes) : EMPTY_SHA;
		const res = await new Promise<IncomingMessage>((resolve, reject) => {
			const req = request({ host: this.url.hostname, port: this.url.port, method, path, headers: { ...signRequest(this.key, method, path, sha, this.now()) }, signal }, resolve);
			req.on('error', reject);
			if (file) createReadStream(file.file).on('error', reject).pipe(req);
			else req.end(bytes ?? undefined);
		});
		let text = '';
		for await (const c of res) text += String(c);
		const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
		if (res.statusCode !== 200) throw new Error(`agent ${method} ${path}: ${res.statusCode} ${json.error ?? text}`);
		return json;
	}

	/* ── The relay ── */

	/** Open the relay, and keep the heartbeat and the link clock running. */
	async connect(): Promise<void> {
		await this.openRelay();
		this.timers.push(
			setInterval(() => this.ping(), this.heartbeatMs),
			setInterval(() => this.watch(), Math.min(1000, this.heartbeatMs)),
		);
	}

	private openRelay(): Promise<void> {
		const path = '/relay';
		return new Promise((resolve, reject) => {
			const req = request({
				host: this.url.hostname,
				port: this.url.port,
				method: 'GET',
				path,
				headers: { connection: 'Upgrade', upgrade: RELAY_PROTOCOL, ...signRequest(this.key, 'GET', path, EMPTY_SHA, this.now()) },
			});
			req.on('upgrade', (res, socket) => {
				this.socket = socket;
				this.nonce = String(res.headers['x-agent-nonce']);
				this.seq = 0;
				this.lastHb = this.now();
				let buffered = '';
				socket.on('data', (chunk: Buffer) => {
					buffered += chunk.toString('utf8');
					let nl: number;
					while ((nl = buffered.indexOf('\n')) >= 0) {
						const line = buffered.slice(0, nl);
						buffered = buffered.slice(nl + 1);
						this.receive(JSON.parse(line) as FromAgent);
					}
				});
				socket.on('close', () => this.dropped(socket));
				socket.on('error', () => this.dropped(socket));
				// Everything sent while the relay was down, in order, behind every re-attach.
				for (const [h, sink] of this.sinks) this.write({ op: 'attach', h, from: sink.resumeFrom() });
				const queued = this.queue;
				this.queue = [];
				for (const m of queued) this.write(m);
				resolve();
			});
			req.on('response', (res) => {
				let text = '';
				res.on('data', (c) => (text += String(c)));
				res.on('end', () => reject(new Error(`agent refused the relay: ${res.statusCode} ${text.trim()}`)));
			});
			req.on('error', reject);
			req.end();
		});
	}

	private dropped(socket: Socket): void {
		if (this.socket !== socket) return;
		this.socket = null;
		if (this.lost !== null) return;
		this.log({ evt: 'agent-relay-dropped', agent: this.url.host });
		void this.reconnect();
	}

	private async reconnect(): Promise<void> {
		if (this.reconnecting) return;
		this.reconnecting = true;
		while (this.socket === null && this.lost === null) {
			try {
				await this.openRelay();
				this.log({ evt: 'agent-relay-back', agent: this.url.host });
			} catch (e) {
				this.log({ evt: 'agent-relay-retry', agent: this.url.host, error: (e as Error).message });
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		this.reconnecting = false;
	}

	/**
	 * The link's clock: past the fencing window with no heartbeat, the claw is gone — unless this
	 * process was the one stalled. After a stall, libuv runs due timers before it reads the sockets,
	 * so this would judge the claw on heartbeats that are already in the buffer, unread. A gap since
	 * the last watch past `WATCH_STALL_MS` is that case (hokon swapping on 2026-10-31: every claw
	 * "lost" at once, all back within 150 ms): silence we could not hear is unknown, never loss, so
	 * the clock restarts and the claw gets a whole fencing window from here.
	 */
	watch(): void {
		if (this.lost !== null) return;
		const t = this.now();
		const gap = this.lastWatch === null ? 0 : t - this.lastWatch;
		this.lastWatch = t;
		if (gap > WATCH_STALL_MS) {
			this.log({ evt: 'agent-watch-stalled', agent: this.url.host, gapMs: gap, silentMs: t - this.lastHb });
			this.group?.loopStalled(t, gap);
			this.lastHb = t;
			return;
		}
		const silent = t - this.lastHb;
		if (silent <= this.fenceMs) return;
		if (silent <= SHARED_HOLD_MS) {
			if (this.group?.shares(this) === true) {
				if (this.sharedSince === null) {
					this.sharedSince = this.lastHb;
					this.log({ evt: 'agent-silence-shared', agent: this.url.host, silentMs: silent, note: 'every claw is silent: this host, not the claw; held, not failed over' });
					this.group?.hold(this, this.lastHb, t);
				}
				this.sharedUntil = t + this.fenceMs;
				return;
			}
			if (t <= this.sharedUntil) return;
		}
		const shared = this.sharedSince === null ? '' : ', shared by every claw';
		this.group?.release(this, t);
		this.lose(`agent heartbeat lost for ${Math.round(silent / 1000)} s (window ${this.fenceMs / 1000} s${shared})`);
	}

	/** A heartbeat: a held silence is over, and the matches go on where they were. */
	private heardAgain(): void {
		if (this.sharedSince !== null) {
			this.log({ evt: 'agent-silence-ended', agent: this.url.host, silentMs: this.now() - this.sharedSince });
			this.group?.release(this, this.now());
		}
		this.sharedSince = null;
		this.sharedUntil = 0;
	}

	private lose(reason: string): void {
		if (this.lost !== null) return;
		this.lost = reason;
		this.log({ evt: 'agent-lost', agent: this.url.host, reason, jvms: [...this.sinks.keys()] });
		this.stop();
		const sinks = [...this.sinks.values()];
		this.sinks.clear();
		for (const s of sinks) s.exit(reason);
		for (const l of this.lostListeners) l(reason);
	}

	/**
	 * How long the agent has been silent, counting only time this process was awake to hear it.
	 * Past `WATCH_STALL_MS` since the last tick, this process is the one that stalled and the
	 * heartbeats since are unread (`watch`): asked then, by a lost claw's handling that ran first
	 * after the resume, `now - lastHb` said "no heartbeat for 18 s" of healthy claws and promoted
	 * the backstop (2026-11-24 00:31Z).
	 */
	silentMs(): number {
		const t = this.now();
		if (this.lastWatch !== null && t - this.lastWatch > WATCH_STALL_MS) return Math.max(0, this.lastWatch - this.lastHb);
		return t - this.lastHb;
	}

	/**
	 * Going down for a restart: ask the agent to hold its JVMs `ms` past the fencing window, so the
	 * next coordinator can take them back. Send it before `close`, which flushes it.
	 */
	hold(ms: number): void {
		this.send({ op: 'hold', ms });
	}

	onLost(listener: (reason: string) => void): void {
		this.lostListeners.push(listener);
	}

	private stop(): void {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.socket?.destroy();
		this.socket = null;
	}

	/** Let go of the agent without a word to its JVMs: they stay, for a later coordinator. */
	close(): void {
		this.lost ??= 'closed';
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		// `end`, not `destroy`: a `release` just written must still reach the agent.
		this.socket?.end();
		this.socket = null;
		this.sinks.clear();
	}

	private ping(): void {
		const acks: Record<string, number> = {};
		for (const [h, s] of this.sinks) acks[h] = s.resumeFrom();
		this.send({ op: 'ping', acks });
	}

	private receive(f: FromAgent): void {
		switch (f.t) {
			case 'hb':
				this.heardAgain();
				this.lastHb = this.now();
				this.health = { at: f.at, jvms: f.jvms, slice: f.slice, draftbot: f.draftbot ?? null };
				return;
			case 'hello':
				this.heardAgain();
				this.lastHb = this.now();
				this.log({ evt: 'agent-hello', agent: this.url.host, version: f.version, pid: f.agentPid, running: f.running, fenceMs: f.fenceMs });
				return;
			case 'line':
				return this.sinks.get(f.h)?.line(f.off, f.line);
			case 'exit': {
				const sink = this.sinks.get(f.h);
				this.sinks.delete(f.h);
				this.send({ op: 'forget', h: f.h });
				return sink?.exit(f.reason);
			}
			case 'running': {
				const resolve = this.waiting.get(f.req);
				this.waiting.delete(f.req);
				return resolve?.(f.hostIds);
			}
			case 'error':
				this.log({ evt: 'agent-error', agent: this.url.host, h: f.h, error: f.error });
		}
	}

	/** One message to the agent: now, or once the relay is back. */
	send(m: ToAgent): void {
		if (this.lost !== null) return;
		if (this.socket === null) {
			if (m.op !== 'ping') this.queue.push(m);
			return;
		}
		this.write(m);
	}

	private write(m: ToAgent): void {
		this.seq += 1;
		this.socket?.write(`${signFrame(this.key, this.nonce, this.seq, m)}\n`);
	}

	register(hostId: string, sink: FrameSink): void {
		this.sinks.set(hostId, sink);
	}

	unregister(hostId: string): void {
		this.sinks.delete(hostId);
	}

	running(): Promise<string[]> {
		const req = this.nextReq++;
		return new Promise((resolve) => {
			this.waiting.set(req, resolve);
			this.send({ op: 'running', req });
		});
	}
}
