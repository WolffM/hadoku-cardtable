/**
 * How far an outbound `fetch` got before it failed, read from undici's diagnostics channels
 * (Node's own fetch publishes them). A lookup that times out says only "aborted due to timeout";
 * this says whether it was still waiting for a socket, opening one, had sent its request on a new
 * or a reused socket (and how long that socket had sat idle), or had its response headers.
 *
 * Only a fetch made through `tracedFetch` is followed: its context is carried to undici's request
 * by `AsyncLocalStorage`, and every later event is tied to it through the request and its socket.
 * Every other fetch in the process costs one map lookup per event.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';

/** How far one fetch got, each step in ms since it began; a step it never reached is absent. */
export interface FetchPhases {
	/** undici took the request. */
	queuedMs?: number;
	/** The socket it was sent on: opened for it, or reused from the pool. */
	socket?: 'new' | 'reused';
	/** A new socket: how long its TCP and TLS connect took. */
	connectMs?: number;
	/** A reused socket: how long it had sat idle since its last response finished. */
	idleMs?: number;
	/** Its request headers were written. */
	sentMs?: number;
	/** Its body was written. */
	bodySentMs?: number;
	/** Its response headers arrived. */
	headersMs?: number;
	/** How long it ran before it failed. */
	failedMs?: number;
	/** Connects to the same origin still open when it failed. */
	connectsPending?: number;
}

interface Trace {
	start: number;
	origin?: string;
	phases: FetchPhases;
}

interface SocketState {
	connectMs: number;
	used: boolean;
	/** When its last response finished; undefined while one is in flight. */
	idleSince?: number;
}

interface Msg {
	request?: object & { origin?: unknown };
	socket?: object;
	connectParams?: object & { protocol?: string; hostname?: string; port?: string | number };
	error?: unknown;
}

const now = (): number => performance.now();
const context = new AsyncLocalStorage<Trace>();
const byRequest = new WeakMap<object, Trace>();
const socketOf = new WeakMap<object, object>();
const sockets = new WeakMap<object, SocketState>();
/** Connects begun and not yet done, oldest first, by origin (undici hands each end a fresh params object, so they pair in order). */
const connecting = new Map<string, number[]>();
const byError = new WeakMap<object, FetchPhases>();

const originOf = (p: Msg['connectParams']): string => `${p?.protocol ?? ''}//${p?.hostname ?? ''}${p?.port === undefined || p.port === '' ? '' : `:${String(p.port)}`}`;
const since = (t: Trace): number => Math.round(now() - t.start);

const failed = (t: Trace, err: unknown): FetchPhases => {
	if (t.phases.failedMs === undefined) {
		t.phases.failedMs = since(t);
		const origin = t.origin;
		if (origin !== undefined) t.phases.connectsPending = connecting.get(origin)?.length ?? 0;
	}
	if (typeof err === 'object' && err !== null) byError.set(err, t.phases);
	return t.phases;
};

let installed = false;
function install(): void {
	if (installed) return;
	installed = true;
	subscribe('undici:request:create', (m) => {
		const { request } = m as Msg;
		const t = context.getStore();
		if (request === undefined || t === undefined) return;
		byRequest.set(request, t);
		t.phases.queuedMs = since(t);
		if (typeof request.origin === 'string') t.origin = new URL(request.origin).origin;
	});
	subscribe('undici:client:beforeConnect', (m) => {
		const origin = originOf((m as Msg).connectParams);
		connecting.set(origin, [...(connecting.get(origin) ?? []), now()]);
	});
	const connectDone = (m: unknown): void => {
		const { connectParams, socket } = m as Msg;
		const origin = originOf(connectParams);
		const [at, ...rest] = connecting.get(origin) ?? [];
		if (rest.length === 0) connecting.delete(origin);
		else connecting.set(origin, rest);
		if (at !== undefined && socket !== undefined) sockets.set(socket, { connectMs: Math.round(now() - at), used: false });
	};
	subscribe('undici:client:connected', connectDone);
	subscribe('undici:client:connectError', connectDone);
	subscribe('undici:client:sendHeaders', (m) => {
		const { request, socket } = m as Msg;
		if (request === undefined || socket === undefined) return;
		socketOf.set(request, socket);
		const s = sockets.get(socket);
		const t = byRequest.get(request);
		if (t !== undefined) {
			t.phases.sentMs = since(t);
			t.phases.socket = s?.used === false ? 'new' : 'reused';
			if (s !== undefined && !s.used) t.phases.connectMs = s.connectMs;
			if (s?.idleSince !== undefined) t.phases.idleMs = Math.round(now() - s.idleSince);
		}
		if (s !== undefined) {
			s.used = true;
			delete s.idleSince;
		}
	});
	subscribe('undici:request:bodySent', (m) => {
		const t = byRequest.get((m as Msg).request ?? {});
		if (t !== undefined) t.phases.bodySentMs = since(t);
	});
	subscribe('undici:request:headers', (m) => {
		const t = byRequest.get((m as Msg).request ?? {});
		if (t !== undefined) t.phases.headersMs = since(t);
	});
	subscribe('undici:request:trailers', (m) => {
		const socket = socketOf.get((m as Msg).request ?? {});
		const s = socket === undefined ? undefined : sockets.get(socket);
		if (s !== undefined) s.idleSince = now();
	});
	subscribe('undici:request:error', (m) => {
		const { request, error } = m as Msg;
		const t = request === undefined ? undefined : byRequest.get(request);
		if (t !== undefined) failed(t, error);
	});
}

/** `base` (the global fetch by default), followed: a call that rejects leaves how far it got for `phasesOf`. */
export function tracedFetch(base?: typeof fetch): typeof fetch {
	install();
	return (input, init) => {
		const t: Trace = { start: now(), phases: {} };
		return context.run(t, () => (base ?? fetch)(input, init)).catch((err: unknown) => {
			failed(t, err);
			throw err;
		});
	};
}

/** How far the traced fetch that failed with `err` got, when one did. */
export function phasesOf(err: unknown): FetchPhases | undefined {
	return typeof err === 'object' && err !== null ? byError.get(err) : undefined;
}
