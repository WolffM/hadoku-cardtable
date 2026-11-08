/**
 * Let what was just emitted reach the wire before the sockets are closed.
 *
 * `io.close()` closes every engine.io connection with `close(true)`, which
 * DISCARDS its write buffer. A packet stays in that buffer when the
 * connection's transport is not writable at the moment of the emit: a
 * websocket still waiting on its previous send's callback, or a polling client
 * between two GETs. The restart notice emitted just before the close was then
 * thrown away and the screen read "Reconnecting…" after all.
 *
 * engine.io hands a buffer to the transport synchronously when it can
 * (`Socket.sendPacket` → `flush`, which emits `flush`), so a connection that
 * did not flush during `send` still holds the packet, and gives it up on its
 * next `drain`. Only those are waited for: a transport that is merely busy
 * after flushing (a websocket awaiting its callback, a poll just answered)
 * already has the packet, and its close comes after it.
 */

/** The part of an engine.io `Socket` (a socket.io socket's `conn`) this needs. */
export interface Flushable {
	once(event: 'drain' | 'close', listener: () => void): unknown;
	on(event: 'flush', listener: () => void): unknown;
	off(event: 'flush', listener: () => void): unknown;
}

/**
 * Run `send`, then resolve once every connection that could not write it at
 * once has written it (or closed), or after `ms`.
 */
export function sendThenFlush(conns: Iterable<Flushable>, send: () => void, ms: number): Promise<void> {
	const watched = [...conns].map((conn) => {
		const seen = { conn, flushed: false, mark: () => (seen.flushed = true) };
		conn.on('flush', seen.mark);
		return seen;
	});
	try {
		send();
	} finally {
		for (const w of watched) w.conn.off('flush', w.mark);
	}
	const waits = watched
		.filter((w) => !w.flushed)
		.map(
			({ conn }) =>
				new Promise<void>((done) => {
					conn.once('drain', done);
					conn.once('close', done);
				}),
		);
	if (waits.length === 0) return Promise.resolve();
	return new Promise<void>((done) => {
		const bound = setTimeout(done, ms);
		void Promise.all(waits).then(() => {
			clearTimeout(bound);
			done();
		});
	});
}

/** The part of a node `http.Server` {@link closeConnections} needs. */
export interface Closable {
	closeIdleConnections(): void;
	closeAllConnections(): void;
}

/**
 * Let a closing server's connections go: the idle ones at once, and every one after `graceMs`, so
 * a request already in flight is answered. `server.close` (which `io.close` calls) only stops new
 * connections and waits for the open ones, and a keep-alive connection through cloudflared that a
 * page keeps busy never goes idle: prod's 16:00Z shutdown on 2026-11-06 was still answering
 * requests a second in, and pm2 SIGKILLed it at its 1.6 s `kill_timeout` before `shutdown-done`.
 */
export function closeConnections(server: Closable, graceMs: number): void {
	server.closeIdleConnections();
	setTimeout(() => server.closeAllConnections(), graceMs).unref();
}
