/**
 * The host agent's wire: what the coordinator (this server) and the agent on a
 * hosting claw (`apps/agent`) say to each other, and how every word from the
 * coordinator is signed. Both sides import this one file; it uses node
 * builtins only, because the agent bundles it for node 22.
 *
 * ## Requests
 *
 * Plain HTTP on the agent's port (`CARDTABLE_AGENT_PORT`, 7621 on a claw).
 * Every request carries
 *
 *   x-agent-ts      unix ms, within `SKEW_MS` of the agent's clock
 *   x-agent-body    sha256 hex of the body (of the empty string when there is none)
 *   x-agent-sig     base64 Ed25519 over "<METHOD>\n<path>\n<ts>\n<body sha>"
 *
 * The coordinator holds the private key; the agent build embeds the public
 * half. A signature is accepted once (`ReplayGuard`) and only while its
 * timestamp is fresh, so a captured request can be neither replayed nor saved
 * for later. The body is hashed as it arrives and refused on a mismatch.
 * Loopback is not trusted: CI on the same claw reaches it.
 *
 * ## The relay
 *
 * `GET /relay` with `Upgrade: cardtable-relay`, signed as above, turns the
 * connection into one long-lived stream of newline-delimited JSON frames. The
 * agent answers `101` with `x-agent-nonce`, a fresh random session id. Every
 * coordinator frame is `{seq, m, sig}`: `seq` counts up from 1 in this session
 * and `sig` signs "relay\n<nonce>\n<seq>\n<JSON of m>", so a frame captured
 * from one session is refused in every other, and a frame dropped, replayed or
 * reordered inside one is refused too. A refused frame ends the session.
 * Agent frames are plain JSON (`FromAgent`); the agent holds no key.
 *
 * A newer session replaces the older one: one coordinator at a time.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/** The agent's port on a claw (fleet-manager's `CARDTABLE_AGENT_PORT`). */
export const AGENT_PORT = 7621;
/** A request's timestamp must be within this of the agent's clock. */
export const SKEW_MS = 30_000;
/** The agent heartbeats this often; the coordinator pings back as often. */
export const HEARTBEAT_MS = 2000;
/**
 * The fencing window: an agent that has heard nothing from the coordinator for
 * this long kills every JVM it runs, and a coordinator that has heard no
 * heartbeat for this long fails the claw over. Five missed heartbeats, from the
 * 48 h link probe (`docs/planning/forge-hosting-plan.md` §4.1).
 */
export const FENCE_MS = 10_000;
/** What a JVM costs beyond its heap (H8: RSS 1.24–1.27 GB at `-Xmx1000m`). */
export const JVM_OVERHEAD_MB = 400;
/** A heap past this share of `-Xmx` after GC is reported as `recycleWanted`. */
export const RECYCLE_HEAP_SHARE = 0.85;
export const RELAY_PROTOCOL = 'cardtable-relay';

export const SHA256 = /^[0-9a-f]{64}$/;
/** A JVM's host id: also a directory and a cgroup name on the claw. */
export const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const sha256Hex = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const EMPTY_SHA = sha256Hex('');

/* ── Keys ────────────────────────────────────────────────────────────── */

/**
 * The coordinator's Ed25519 private key, as a PEM or as base64 PKCS#8 DER (one
 * line, which survives an environment variable and a vault item unchanged).
 */
export function privateKeyFrom(text: string): KeyObject {
	const t = text.trim();
	if (t.startsWith('-----BEGIN')) return createPrivateKey(t);
	return createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' });
}

/** The public half as a PEM, which is what an agent build embeds. */
export function publicPemOf(key: KeyObject): string {
	return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

/* ── Requests ────────────────────────────────────────────────────────── */

export interface SignedHeaders {
	'x-agent-ts': string;
	'x-agent-body': string;
	'x-agent-sig': string;
}

const requestText = (method: string, path: string, ts: number, bodySha: string): Buffer =>
	Buffer.from(`${method}\n${path}\n${ts}\n${bodySha}`);

export function signRequest(key: KeyObject, method: string, path: string, bodySha: string, now = Date.now()): SignedHeaders {
	return {
		'x-agent-ts': String(now),
		'x-agent-body': bodySha,
		'x-agent-sig': sign(null, requestText(method, path, now, bodySha), key).toString('base64'),
	};
}

/** A malformed signature is a bad one, not an error. */
function verified(key: KeyObject, text: Buffer, sig: string): boolean {
	try {
		return verify(null, text, key, Buffer.from(sig, 'base64'));
	} catch {
		return false;
	}
}

/** Each accepted signature, kept until it could no longer pass the skew check anyway. */
export class ReplayGuard {
	private readonly seen = new Map<string, number>();
	private readonly now: () => number;
	// No parameter property: `deploy.sh` runs this file under node's type stripping.
	constructor(now: () => number = Date.now) {
		this.now = now;
	}
	/** True the first time `sig` is offered; false after. */
	first(sig: string): boolean {
		const now = this.now();
		for (const [s, at] of this.seen) if (now - at > 2 * SKEW_MS) this.seen.delete(s);
		if (this.seen.has(sig)) return false;
		this.seen.set(sig, now);
		return true;
	}
}

/** Null when the request is the coordinator's, fresh and first; otherwise why not. */
export function checkRequest(
	key: KeyObject,
	guard: ReplayGuard,
	req: { method: string; path: string; headers: Record<string, string | string[] | undefined> },
	now = Date.now(),
): string | null {
	const header = (name: string): string => {
		const v = req.headers[name];
		return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
	};
	const ts = Number(header('x-agent-ts'));
	const body = header('x-agent-body');
	const sig = header('x-agent-sig');
	if (!Number.isFinite(ts) || ts <= 0 || Math.abs(now - ts) > SKEW_MS) return 'stale or missing x-agent-ts';
	if (!SHA256.test(body)) return 'missing x-agent-body';
	if (sig === '') return 'unsigned';
	if (!verified(key, requestText(req.method, req.path, ts, body), sig)) return 'bad signature';
	if (!guard.first(sig)) return 'replayed signature';
	return null;
}

/* ── Relay frames ────────────────────────────────────────────────────── */

export interface SignedFrame {
	seq: number;
	m: ToAgent;
	sig: string;
}

const frameText = (nonce: string, seq: number, body: string): Buffer => Buffer.from(`relay\n${nonce}\n${seq}\n${body}`);

/** One coordinator frame, as the line that goes on the wire (no newline). */
export function signFrame(key: KeyObject, nonce: string, seq: number, m: ToAgent): string {
	const body = JSON.stringify(m);
	return `{"seq":${seq},"sig":"${sign(null, frameText(nonce, seq, body), key).toString('base64')}","m":${body}}`;
}

/**
 * The message, when `line` is the next signed frame of session `nonce`;
 * otherwise why not. The signature covers `m` exactly as it was sent: the
 * frame is cut at `"m":`, never re-serialised.
 */
export function openFrame(key: KeyObject, nonce: string, expectSeq: number, line: string): { m: ToAgent } | { error: string } {
	const at = line.indexOf(',"m":');
	const head = /^\{"seq":(\d+),"sig":"([A-Za-z0-9+/=]+)"$/.exec(line.slice(0, at));
	if (at < 0 || head === null || !line.endsWith('}')) return { error: 'malformed frame' };
	const seq = Number(head[1]);
	if (seq !== expectSeq) return { error: `frame ${seq}, expected ${expectSeq}` };
	const body = line.slice(at + 5, -1);
	if (!verified(key, frameText(nonce, seq, body), head[2] as string)) return { error: 'bad frame signature' };
	try {
		return { m: JSON.parse(body) as ToAgent };
	} catch {
		return { error: 'frame body is not JSON' };
	}
}

/* ── Messages ────────────────────────────────────────────────────────── */

/** The artifacts one JVM runs on, each a sha256 the agent has installed. */
export interface ArtifactSet {
	jdk: string;
	jar: string;
	res: string;
	bridge: string;
}
export type ArtifactKind = keyof ArtifactSet;
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['jdk', 'jar', 'res', 'bridge'];

export interface LaunchSpec {
	hostId: string;
	xmxMb: number;
	artifacts: ArtifactSet;
	/** The bridge's main class inside the `bridge` artifact. */
	main: string;
	/** `BRIDGE_JVM_FLAGS` from `host.ts`: the coordinator's, so the agent never keeps a copy. */
	jvmFlags: string[];
	/** Written to `user/preferences/forge.preferences` (`host.ts` `FORGE_PREFERENCES`). */
	forgePreferences: Record<string, string>;
}

export type ToAgent =
	| ({ op: 'launch' } & LaunchSpec)
	| { op: 'line'; h: string; line: string }
	| { op: 'kill'; h: string }
	/** Stop relaying `h`; its lines from byte `off` on wait on the claw's disk. */
	| { op: 'release'; h: string; off: number }
	/** Relay `h` again, from byte `from` (default: the last acknowledged byte). */
	| { op: 'attach'; h: string; from?: number }
	/** `h`'s exit was received: its run directory may go. */
	| { op: 'forget'; h: string }
	| { op: 'running'; req: number }
	/** The coordinator's heartbeat, with how far it has taken each JVM's lines. */
	| { op: 'ping'; acks: Record<string, number> };

export interface JvmHealth {
	hostId: string;
	pid: number;
	xmxMb: number;
	rssMb: number | null;
	/** From the JVM's own GC log: the heap after the last collection. */
	heapUsedMb: number | null;
	heapMaxMb: number | null;
	/** Share of wall time in GC pauses over the last heartbeat window, 0–1. */
	gcShare: number | null;
	/** The heap after GC is past `RECYCLE_HEAP_SHARE` of `-Xmx`; the coordinator decides. */
	recycleWanted: boolean;
	attached: boolean;
}

export interface SliceHealth {
	cgroup: string | null;
	delegated: boolean;
	memoryMaxMb: number | null;
	memoryCurrentMb: number | null;
	/** `memory.events`, every counter. `oom_kill` is the kernel's OOM kills. */
	memoryEvents: Record<string, number>;
	/** `cpu.stat`, every counter. */
	cpuStat: Record<string, number>;
	cpus: number | null;
}

export type FromAgent =
	/** The session's first frame. */
	| { t: 'hello'; agentPid: number; version: string; running: string[]; fenceMs: number }
	| { t: 'hb'; at: number; jvms: JvmHealth[]; slice: SliceHealth }
	/** One stdout line of JVM `h`; `off` is the byte offset just past it. */
	| { t: 'line'; h: string; off: number; line: string }
	| { t: 'exit'; h: string; reason: string }
	| { t: 'running'; req: number; hostIds: string[] }
	/** A frame the agent could not act on. */
	| { t: 'error'; h?: string; error: string };
