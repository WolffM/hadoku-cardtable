/**
 * The host agent: the one process cardtable runs on a hosting claw.
 *
 * It takes artifacts it can verify, launches `--host` bridge JVMs in leaf
 * cgroups of its slice, and relays each JVM's line protocol to the coordinator
 * (hokon's server) over one signed stream. It decides nothing about placement
 * or failover: those are the coordinator's. What it does decide alone is
 * fencing: an agent that has not heard from the coordinator for the fencing
 * window kills every JVM it runs, because a coordinator that has failed this
 * claw over must never meet a second copy of a match (forge-hosting-plan §5).
 *
 * The wire, its signing and every message are in
 * `apps/server/src/play/remote/wire.ts`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes, type KeyObject } from 'node:crypto';
import { join } from 'node:path';

import {
	ARTIFACT_KINDS,
	EMPTY_SHA,
	AGENT_RESERVE_MB,
	FENCE_MS,
	HEARTBEAT_MS,
	HOLD_MAX_MS,
	HOST_ID,
	JVM_OVERHEAD_MB,
	RELAY_PROTOCOL,
	ReplayGuard,
	checkRequest,
	openFrame,
	sha256Hex,
	sliceNeedMb,
	type ArtifactKind,
	type FromAgent,
	type LaunchSpec,
	type ToAgent,
} from '../../server/src/play/remote/wire.ts';
import { Cgroups } from './cgroups.ts';
import { Jvm, type Installed, type Log } from './jvm.ts';
import { Store } from './store.ts';

/** A coordinator frame longer than this ends the session. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface AgentOptions {
	home: string;
	port: number;
	/** Where to listen; every interface by default (fleet-manager's firewall admits only hokon). */
	host?: string;
	publicKey: KeyObject;
	version: string;
	fenceMs?: number;
	heartbeatMs?: number;
	/** The cgroup mount, or null to run without delegation (a dev box). */
	cgroupRoot: string | null;
	ownCgroupFile?: string;
	/** The memory bound when there is no slice to read it from (dev box). */
	memoryMaxMb?: number | null;
	now?: () => number;
	log?: Log;
}

interface Session {
	socket: Duplex;
	nonce: string;
	nextSeq: number;
}

export class Agent {
	readonly store: Store;
	readonly cgroups: Cgroups;
	readonly jvms = new Map<string, Jvm>();
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly guard: ReplayGuard;
	private readonly now: () => number;
	private readonly log: Log;
	private readonly fenceMs: number;
	private readonly jvmDir: string;
	private session: Session | null = null;
	private lastHeard: number;
	private readonly heardFile: string;
	private heardWritten = 0;
	/** Until when a restarting coordinator asked us not to fence (`{op:'hold'}`); 0 when none. */
	private holdUntil: number;
	private readonly holdFile: string;
	private fenced = false;
	private server: Server | null = null;
	private timers: NodeJS.Timeout[] = [];
	private readonly started: number;

	constructor(private readonly opts: AgentOptions) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? ((what, data = {}) => console.log(JSON.stringify({ at: new Date(this.now()).toISOString(), what, ...data })));
		this.fenceMs = opts.fenceMs ?? FENCE_MS;
		this.guard = new ReplayGuard(this.now);
		this.store = new Store(opts.home, this.now);
		this.cgroups = new Cgroups(opts.cgroupRoot, opts.ownCgroupFile, this.log);
		this.jvmDir = join(opts.home, 'jvms');
		mkdirSync(this.jvmDir, { recursive: true });
		this.started = this.now();
		this.heardFile = join(opts.home, 'coordinator-heard');
		// The fencing clock survives a restart: an agent that restarts faster than the window
		// must not keep a failed-over claw's JVMs alive by resetting it.
		this.lastHeard = Math.min(this.now(), readHeard(this.heardFile) ?? this.now());
		// So does a hold: the coordinator's restart and ours may overlap.
		this.holdFile = join(opts.home, 'coordinator-hold');
		this.holdUntil = readHeard(this.holdFile) ?? 0;
		this.adopt();
	}

	/** Every JVM an earlier agent left behind, live or ended while nobody watched. */
	private adopt(): void {
		for (const d of readdirSync(this.jvmDir)) {
			const jvm = Jvm.adopt(join(this.jvmDir, d), this.cgroups, this.log, this.now);
			if (jvm === null) continue;
			this.jvms.set(jvm.hostId, jvm);
			if (!jvm.exited) this.watchOut(jvm);
		}
		const leaves = this.cgroups.liveLeaves();
		for (const [hostId, pids] of leaves) {
			if (!this.jvms.has(hostId)) this.log('stray-cgroup', { hostId, pids, note: 'a live leaf with no run record; left alone' });
		}
		if (this.jvms.size) this.log('adopted', { hostIds: [...this.jvms.keys()], live: this.live().map((j) => j.hostId) });
	}

	private live(): Jvm[] {
		return [...this.jvms.values()].filter((j) => !j.exited);
	}

	/** Lines reach the coordinator as the JVM writes them; the timer is the fallback. */
	private watchOut(jvm: Jvm): void {
		const out = join(jvm.dir, 'out.jsonl');
		if (!existsSync(out)) return;
		this.watchers.set(
			jvm.hostId,
			watch(out, () => jvm.pump()).on('error', () => {
				// The file went with `forget`; the pump timer covers anything else.
			}),
		);
	}

	listen(): Promise<number> {
		const server = createServer((req, res) => {
			this.handle(req, res).catch((e: Error) => {
				this.log('error', { method: req.method, url: req.url, error: e.message });
				if (!res.headersSent) reply(res, 500, { error: e.message });
			});
		});
		server.on('upgrade', (req: IncomingMessage, socket: Duplex) => this.upgrade(req, socket));
		this.server = server;
		const hb = this.opts.heartbeatMs ?? HEARTBEAT_MS;
		this.timers.push(
			setInterval(() => this.heartbeat(), hb),
			setInterval(() => this.tick(), Math.min(1000, hb)),
			setInterval(() => {
				for (const j of this.jvms.values()) j.pump();
			}, 200),
		);
		return new Promise((resolve) => {
			server.listen(this.opts.port, this.opts.host, () => {
				const addr = server.address();
				const port = typeof addr === 'object' && addr !== null ? addr.port : this.opts.port;
				this.log('listening', { port, pid: process.pid, version: this.opts.version, delegated: this.cgroups.delegated, fenceMs: this.fenceMs });
				resolve(port);
			});
		});
	}

	/** Stop serving. JVMs are left running, as a restart leaves them. */
	close(): void {
		for (const t of this.timers) clearInterval(t);
		for (const w of this.watchers.values()) w.close();
		for (const jvm of this.jvms.values()) jvm.detach();
		this.session?.socket.destroy();
		this.server?.close();
		this.server?.closeAllConnections();
	}

	/**
	 * Fencing: past the window with no word from the coordinator, every JVM dies.
	 * Called every second; exported for the fake-clock test.
	 */
	tick(): void {
		const silent = this.now() - this.lastHeard;
		if (silent <= this.fenceMs || this.now() < this.holdUntil) return;
		const live = this.live();
		if (live.length === 0) return;
		const reason = `fenced: no word from the coordinator for ${Math.round(silent / 1000)} s (window ${this.fenceMs / 1000} s)`;
		this.log('fenced', {
			level: 'error',
			message: `killing ${live.length} JVM(s): the coordinator may have failed this claw over, and a second copy of a match must never run`,
			hostIds: live.map((j) => j.hostId),
			silentMs: silent,
		});
		this.fenced = true;
		for (const j of live) j.kill(reason);
	}

	/** A word from the coordinator. On disk at most once a second, for the next agent's clock. */
	private heard(): void {
		this.lastHeard = this.now();
		if (this.lastHeard - this.heardWritten < 1000) return;
		this.heardWritten = this.lastHeard;
		writeFileSync(`${this.heardFile}.tmp`, String(this.lastHeard));
		renameSync(`${this.heardFile}.tmp`, this.heardFile);
	}

	/** A restarting coordinator's hold, kept on disk like the clock it extends. 0 ends it. */
	private hold(until: number): void {
		this.holdUntil = until;
		writeFileSync(`${this.holdFile}.tmp`, String(until));
		renameSync(`${this.holdFile}.tmp`, this.holdFile);
	}

	private heartbeat(): void {
		if (this.session === null) return;
		this.emit({ t: 'hb', at: this.now(), jvms: this.live().map((j) => j.health()), slice: this.cgroups.slice() });
	}

	private emit(f: FromAgent): void {
		this.session?.socket.write(`${JSON.stringify(f)}\n`);
	}

	/* ── Requests ── */

	private refuse(req: IncomingMessage, why: string): void {
		this.log('refused', { method: req.method, url: req.url, why, from: req.socket.remoteAddress });
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const refused = checkRequest(this.opts.publicKey, this.guard, { method: req.method ?? '', path: req.url ?? '', headers: req.headers }, this.now());
		if (refused !== null) {
			this.refuse(req, refused);
			return reply(res, 401, { error: refused });
		}
		const declared = String(req.headers['x-agent-body']);
		const blob = /^\/blob\/([0-9a-f]{64})$/.exec(req.url ?? '');
		if (req.method === 'PUT' && blob) {
			if (declared !== blob[1]) return reply(res, 400, { error: 'x-agent-body must be the blob sha' });
			await this.store.put(blob[1] as string, req);
			this.log('blob', { sha: blob[1], bytes: this.store.size(blob[1] as string) });
			return reply(res, 200, { sha: blob[1] });
		}
		const body = await readJson(req, declared);
		if (body === null) return reply(res, 400, { error: 'body does not hash to x-agent-body' });
		if (req.method === 'GET' && req.url === '/status') {
			return reply(res, 200, {
				pid: process.pid,
				version: this.opts.version,
				node: process.version,
				upSec: Math.round((this.now() - this.started) / 1000),
				fenceMs: this.fenceMs,
				fenced: this.fenced,
				coordinator: this.session !== null,
				artifacts: this.store.list(),
				slice: this.cgroups.slice(),
				jvms: this.live().map((j) => j.health()),
				ended: [...this.jvms.values()].filter((j) => j.exited).map((j) => j.hostId),
			});
		}
		if (req.method === 'POST' && req.url === '/install') {
			const { kind, sha } = body as { kind: ArtifactKind; sha: string };
			if (!ARTIFACT_KINDS.includes(kind)) return reply(res, 400, { error: `kind: ${ARTIFACT_KINDS.join('|')}` });
			const at = await this.store.install(
				kind,
				String(sha),
				this.live().map((j) => j.artifacts),
			);
			this.log('installed', { kind, sha, at });
			return reply(res, 200, { kind, sha });
		}
		return reply(res, 404, { error: `${req.method} ${req.url}` });
	}

	/* ── The relay ── */

	private upgrade(req: IncomingMessage, socket: Duplex): void {
		const refused =
			req.url !== '/relay' || String(req.headers.upgrade) !== RELAY_PROTOCOL
				? 'not a relay upgrade'
				: (checkRequest(this.opts.publicKey, this.guard, { method: req.method ?? '', path: req.url, headers: req.headers }, this.now()) ??
					(req.headers['x-agent-body'] === EMPTY_SHA ? null : 'a relay upgrade has no body'));
		if (refused !== null) {
			this.refuse(req, refused);
			socket.end(`HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${refused}\n`);
			return;
		}
		if (this.session !== null) {
			this.log('relay-replaced', { note: 'a newer coordinator session takes over' });
			this.endSession(this.session);
		}
		const session: Session = { socket, nonce: randomBytes(24).toString('base64url'), nextSeq: 1 };
		this.session = session;
		this.heard();
		if (this.holdUntil !== 0) {
			this.log('hold-ended', { note: 'a coordinator is back', heldMs: this.holdUntil - this.now() });
			this.hold(0);
		}
		this.fenced = false;
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${RELAY_PROTOCOL}\r\nconnection: Upgrade\r\nx-agent-nonce: ${session.nonce}\r\n\r\n`);
		this.log('relay-open', { from: req.socket.remoteAddress });
		this.emit({ t: 'hello', agentPid: process.pid, version: this.opts.version, running: [...this.jvms.keys()], fenceMs: this.fenceMs });
		let buffered = '';
		socket.on('data', (chunk: Buffer) => {
			buffered += chunk.toString('utf8');
			let nl: number;
			while ((nl = buffered.indexOf('\n')) >= 0 && this.session === session) {
				const line = buffered.slice(0, nl);
				buffered = buffered.slice(nl + 1);
				this.frame(session, line);
			}
			if (buffered.length > MAX_FRAME_BYTES) this.drop(session, 'frame too long');
		});
		// `end` too: the HTTP server allows half-open sockets, and a coordinator that ends its side is gone.
		for (const evt of ['end', 'error', 'close']) socket.on(evt, () => this.endSession(session));
	}

	private drop(session: Session, why: string): void {
		this.log('relay-refused', { why });
		this.endSession(session);
	}

	private endSession(session: Session): void {
		if (this.session !== session) return;
		this.session = null;
		for (const j of this.jvms.values()) j.release();
		session.socket.destroy();
		this.log('relay-closed', {});
	}

	private frame(session: Session, line: string): void {
		const opened = openFrame(this.opts.publicKey, session.nonce, session.nextSeq, line);
		if ('error' in opened) return this.drop(session, opened.error);
		session.nextSeq += 1;
		this.heard();
		try {
			this.act(opened.m);
		} catch (e) {
			this.log('frame-error', { op: opened.m.op, error: (e as Error).message });
			this.emit({ t: 'error', error: `${opened.m.op}: ${(e as Error).message}` });
		}
	}

	private act(m: ToAgent): void {
		const sink = (f: FromAgent): void => this.emit(f);
		switch (m.op) {
			case 'ping':
				for (const [h, off] of Object.entries(m.acks)) this.jvms.get(h)?.ack(off);
				return;
			case 'launch':
				return this.launch(m, sink);
			case 'line':
				return this.jvms.get(m.h)?.write(m.line);
			case 'kill':
				return this.jvms.get(m.h)?.kill('killed by the coordinator');
			case 'release':
				return this.jvms.get(m.h)?.release(m.off);
			case 'attach': {
				const jvm = this.jvms.get(m.h);
				if (jvm === undefined) return this.emit({ t: 'exit', h: m.h, reason: 'no such JVM on this claw' });
				return jvm.attach(sink, m.from);
			}
			case 'forget': {
				const jvm = this.jvms.get(m.h);
				if (jvm === undefined || !jvm.exited) return;
				this.watchers.get(m.h)?.close();
				this.watchers.delete(m.h);
				jvm.forget();
				this.jvms.delete(m.h);
				return;
			}
			case 'running':
				return this.emit({ t: 'running', req: m.req, hostIds: [...this.jvms.keys()] });
			case 'hold': {
				const ms = Math.min(Math.max(0, Number(m.ms) || 0), HOLD_MAX_MS);
				this.log('hold', { ms, note: 'the coordinator is restarting: no fencing until the window plus this' });
				return this.hold(this.now() + this.fenceMs + ms);
			}
		}
	}

	/** Why a launch cannot happen, or null. */
	private launchRefusal(spec: LaunchSpec): string | null {
		if (!HOST_ID.test(spec.hostId)) return 'bad host id';
		if (this.jvms.has(spec.hostId)) return `host id ${spec.hostId} is already on this claw`;
		if (!Number.isInteger(spec.xmxMb) || spec.xmxMb < 256) return 'xmxMb: an integer ≥ 256';
		if (!Array.isArray(spec.jvmFlags) || spec.jvmFlags.some((f) => typeof f !== 'string' || !f.startsWith('-'))) return 'jvmFlags: flags only';
		const max = this.cgroups.slice().memoryMaxMb ?? this.opts.memoryMaxMb ?? null;
		if (max !== null) {
			const need = sliceNeedMb([...this.live().map((j) => j.xmxMb), spec.xmxMb]);
			if (need > max) return `does not fit: ${need} MB needed (each JVM -Xmx + ${JVM_OVERHEAD_MB} MB, agent ${AGENT_RESERVE_MB} MB) in a ${max} MB slice`;
		}
		return null;
	}

	private launch(spec: LaunchSpec, sink: (f: FromAgent) => void): void {
		const refusal = this.launchRefusal(spec);
		if (refusal !== null) {
			this.log('launch-refused', { hostId: spec.hostId, why: refusal });
			return sink({ t: 'exit', h: spec.hostId, reason: `refused: ${refusal}` });
		}
		const paths: Partial<Record<ArtifactKind, string>> = {};
		for (const kind of ARTIFACT_KINDS) {
			const at = this.store.installed(kind, spec.artifacts[kind]);
			if (at === null) return sink({ t: 'exit', h: spec.hostId, reason: `refused: ${kind} ${spec.artifacts[kind]} is not installed` });
			paths[kind] = at;
		}
		const installed: Installed = { java: join(paths.jdk as string, 'bin', 'java'), jar: paths.jar as string, res: paths.res as string, bridge: paths.bridge as string };
		const jvm = Jvm.launch(join(this.jvmDir, spec.hostId), spec, installed, this.cgroups, this.log, this.now);
		this.jvms.set(spec.hostId, jvm);
		this.watchOut(jvm);
		jvm.attach(sink, 0);
	}
}

function readHeard(file: string): number | null {
	try {
		const t = Number(readFileSync(file, 'utf8'));
		return Number.isFinite(t) && t > 0 ? t : null;
	} catch {
		return null; // never heard from one
	}
}

function reply(res: ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(`${JSON.stringify(body)}\n`);
}

/** A small JSON body; null when it does not hash to what was signed. */
function readJson(req: IncomingMessage, declared: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > 1024 * 1024) req.destroy(new Error('JSON body too large'));
			else chunks.push(c);
		});
		req.on('error', reject);
		req.on('end', () => {
			const bytes = Buffer.concat(chunks);
			if (sha256Hex(bytes) !== declared) return resolve(null);
			resolve(bytes.length ? JSON.parse(bytes.toString('utf8')) : {});
		});
	});
}
