/**
 * The coordinator's end of one host agent (`apps/agent`): signed requests, the
 * signed relay, heartbeats both ways, and the link's own failover clock.
 *
 * The link is lost for good when no heartbeat has arrived for the fencing
 * window (`FENCE_MS`, the same window the agent fences on): every JVM on the
 * claw is then gone as far as this coordinator is concerned, and the agent will
 * have killed them by the time anything could reach them again. A drop shorter
 * than the window is repaired underneath: the relay reconnects, every
 * transport re-attaches from the last line it took, and messages sent in the
 * gap go out in order once it is back.
 */

import { createReadStream } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { KeyObject } from 'node:crypto';

import { EMPTY_SHA, FENCE_MS, HEARTBEAT_MS, RELAY_PROTOCOL, sha256Hex, signFrame, signRequest, type FromAgent, type JvmHealth, type SliceHealth, type ToAgent } from './wire.js';

export interface AgentClientOptions {
	/** `http://<claw>:7621` */
	url: string;
	key: KeyObject;
	fenceMs?: number;
	heartbeatMs?: number;
	now?: () => number;
	log?: (entry: Record<string, unknown>) => void;
}

/** What receives one JVM's frames. */
export interface FrameSink {
	line(off: number, line: string): void;
	exit(reason: string): void;
	/** The relay came back: where to resume from. */
	resumeFrom(): number;
}

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
	private reconnecting = false;
	private timers: NodeJS.Timeout[] = [];
	private readonly sinks = new Map<string, FrameSink>();
	private readonly waiting = new Map<number, (hostIds: string[]) => void>();
	private nextReq = 1;
	/** Set once the link is lost for good, or closed: nothing more is sent. */
	lost: string | null = null;
	health: { at: number; jvms: JvmHealth[]; slice: SliceHealth } | null = null;
	private lostListeners: ((reason: string) => void)[] = [];

	constructor(opts: AgentClientOptions) {
		this.url = new URL(opts.url);
		this.key = opts.key;
		this.fenceMs = opts.fenceMs ?? FENCE_MS;
		this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.lastHb = this.now();
	}

	/* ── Requests ── */

	/** One signed JSON request; a file body (`PUT /blob/<sha>`) is streamed. */
	async call<T>(method: string, path: string, body?: unknown | { file: string; sha: string }): Promise<T> {
		const file = typeof body === 'object' && body !== null && 'file' in body ? (body as { file: string; sha: string }) : null;
		const bytes = file || body === undefined ? null : Buffer.from(JSON.stringify(body));
		const sha = file ? file.sha : bytes ? sha256Hex(bytes) : EMPTY_SHA;
		const res = await new Promise<IncomingMessage>((resolve, reject) => {
			const req = request({ host: this.url.hostname, port: this.url.port, method, path, headers: { ...signRequest(this.key, method, path, sha, this.now()) } }, resolve);
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

	/** The link's clock: past the fencing window with no heartbeat, the claw is gone. */
	watch(): void {
		if (this.lost !== null) return;
		const silent = this.now() - this.lastHb;
		if (silent > this.fenceMs) this.lose(`agent heartbeat lost for ${Math.round(silent / 1000)} s (window ${this.fenceMs / 1000} s)`);
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

	/** How long since the agent's last heartbeat. */
	silentMs(): number {
		return this.now() - this.lastHb;
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
				this.lastHb = this.now();
				this.health = { at: f.at, jvms: f.jvms, slice: f.slice };
				return;
			case 'hello':
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
