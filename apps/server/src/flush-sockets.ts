/**
 * Let what was just emitted reach the wire before the sockets are closed.
 *
 * `io.close()` closes every engine.io connection with `close(true)`, which
 * DISCARDS its write buffer. A packet sits in that buffer whenever the
 * connection's transport is not writable at the moment of the emit: a
 * websocket still waiting on its previous send's callback, or a polling client
 * between two GETs. On a loaded host that is most of them, so the restart
 * notice emitted just before the close was thrown away and the screen read
 * "Reconnecting…" after all.
 *
 * A connection whose transport is writable flushed the emit synchronously
 * (engine.io `Socket.sendPacket` → `flush`). One that is not flushes when the
 * transport drains, which engine.io announces with the socket's `drain` event.
 */

/** The part of an engine.io `Socket` (a socket.io socket's `conn`) this needs. */
export interface Flushable {
	readonly transport: { readonly writable: boolean };
	once(event: 'drain' | 'close', listener: () => void): unknown;
}

/** Resolves once every connection has handed its buffer to the transport, or after `ms`. */
export function flushed(conns: Iterable<Flushable>, ms: number): Promise<void> {
	const waits = [...conns]
		.filter((conn) => !conn.transport.writable)
		.map(
			(conn) =>
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
