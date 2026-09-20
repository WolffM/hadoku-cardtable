/**
 * RFC 6455, server side, for exactly one caller: a browser that is not running
 * our React app.
 *
 * ## Why this is hand-written and not `ws`
 *
 * The CheerpJ client (Wave 15 lane A) binds a **browser `WebSocket`** into
 * Forge's `IToServer` through a JS native. It cannot speak socket.io — that
 * would mean shipping the socket.io client into the CheerpJ page and calling it
 * from Java — so the server end has to terminate a plain WebSocket.
 *
 * `ws` is in the workspace store (engine.io depends on it) but is **not** a
 * dependency of `@hadoku/server`, and pnpm's strict layout will not resolve a
 * transitive package from here. Adding it is a manifest change plus an install,
 * which this lane could not verify. So: ~200 lines of frame codec against the
 * spec, exercised in `browser.test.ts` by Node's own built-in `WebSocket`
 * client — the same implementation a browser ships, not a mock of one.
 *
 * ## What is implemented, and what is deliberately refused
 *
 * Implemented: the version-13 handshake, text frames, continuation frames,
 * ping/pong, close with a code, and a hard message ceiling.
 *
 * Refused, each with the close code the spec names:
 *
 * - `RSV` bits set → **1002**. We never negotiate an extension (the handshake
 *   echoes no `Sec-WebSocket-Extensions`), so a compressed frame is a client
 *   that ignored the negotiation, not something to guess at.
 * - an unmasked client frame → **1002**. Masking is mandatory client→server.
 * - a binary frame → **1003**. This protocol is JSON text; a binary frame here
 *   is a client talking to the wrong endpoint.
 * - a message over `maxMessageBytes` → **1009**, counted across fragments so a
 *   sender cannot get around it by chopping the payload up.
 *
 * Server→client frames are never masked (the spec forbids it) and never
 * fragmented: one JSON message is one text frame.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** RFC 6455 §1.3. Fixed by the spec; never a config value. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** §5.5: a control frame carries at most 125 bytes and is never fragmented. */
const MAX_CONTROL_BYTES = 125;

/** One JSON message. A projected `setGameView` for a 60-card deck is ~100 KB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface WsCloseInfo {
	code: number;
	reason: string;
}

export interface BrowserSocket {
	/** True until a close frame has been written or the socket has ended. */
	readonly open: boolean;
	/** One text frame. A write after close is dropped, not thrown. */
	send(text: string): void;
	/** Write a close frame and end the socket. Idempotent. */
	close(code?: number, reason?: string): void;
	onMessage(handler: (text: string) => void): void;
	onClose(handler: (info: WsCloseInfo) => void): void;
}

export interface AcceptOptions {
	maxMessageBytes?: number;
}

/** A GET with the version-13 WebSocket handshake headers, and nothing else. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
	const upgrade = req.headers.upgrade;
	if (req.method !== 'GET' || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return false;
	const version = req.headers['sec-websocket-version'];
	if (version !== '13') return false;
	return typeof req.headers['sec-websocket-key'] === 'string';
}

/**
 * Refuse before the upgrade: a plain HTTP response on the raw socket, because
 * there is no `ServerResponse` on the `upgrade` event.
 */
export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
	const body = Buffer.from(message, 'utf8');
	const text = status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Error';
	socket.on('error', () => {});
	socket.end(
		`HTTP/1.1 ${status} ${text}\r\n` +
			'Connection: close\r\n' +
			'Content-Type: text/plain; charset=utf-8\r\n' +
			`Content-Length: ${body.length}\r\n\r\n` +
			body.toString('utf8'),
	);
}

function acceptKey(key: string): string {
	return createHash('sha1').update(key + WS_GUID, 'utf8').digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = length;
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = 0x80 | opcode; // FIN, no RSV
	return Buffer.concat([header, payload]);
}

function closePayload(code: number, reason: string): Buffer {
	const text = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_BYTES - 2);
	const out = Buffer.alloc(2 + text.length);
	out.writeUInt16BE(code, 0);
	text.copy(out, 2);
	return out;
}

/**
 * Complete the handshake and return the connection, or write a refusal and
 * return null. `head` is whatever the client sent with the upgrade request;
 * a browser sends nothing, but it is fed to the parser rather than dropped.
 */
export function acceptUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	options: AcceptOptions = {},
): BrowserSocket | null {
	if (!isWebSocketUpgrade(req)) {
		refuseUpgrade(socket, 400, 'expected a version-13 websocket upgrade');
		return null;
	}
	const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

	const messageHandlers: ((text: string) => void)[] = [];
	const closeHandlers: ((info: WsCloseInfo) => void)[] = [];
	let open = true;
	let closeSent = false;
	let closed: WsCloseInfo | null = null;

	/** Unparsed bytes. Frames arrive split across TCP reads at any offset. */
	let pending: Buffer = Buffer.alloc(0);
	/** The current fragmented message: its opcode and the pieces so far. */
	let fragmentOp: number | null = null;
	let fragments: Buffer[] = [];
	let fragmentBytes = 0;

	const write = (buf: Buffer): void => {
		if (socket.writable) socket.write(buf);
	};

	const finish = (info: WsCloseInfo): void => {
		if (closed !== null) return;
		closed = info;
		open = false;
		for (const handler of closeHandlers) handler(info);
	};

	const shutdown = (code: number, reason: string): void => {
		if (!closeSent) {
			closeSent = true;
			write(encodeFrame(OP.close, closePayload(code, reason)));
		}
		open = false;
		socket.end();
		finish({ code, reason });
	};

	const deliver = (text: string): void => {
		for (const handler of messageHandlers) handler(text);
	};

	/** One pass over `pending`. Returns false when the connection is finished. */
	const consume = (): boolean => {
		for (;;) {
			if (pending.length < 2) return true;
			const first = pending[0] as number;
			const second = pending[1] as number;
			const fin = (first & 0x80) !== 0;
			const rsv = first & 0x70;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;

			if (rsv !== 0) {
				shutdown(1002, 'no extension was negotiated');
				return false;
			}
			if (length === 126) {
				if (pending.length < offset + 2) return true;
				length = pending.readUInt16BE(offset);
				offset += 2;
			} else if (length === 127) {
				if (pending.length < offset + 8) return true;
				const big = pending.readBigUInt64BE(offset);
				if (big > BigInt(maxMessageBytes)) {
					shutdown(1009, 'message too large');
					return false;
				}
				length = Number(big);
				offset += 8;
			}
			if (!masked) {
				// §5.3: a client frame is always masked. An unmasked one is either a
				// broken client or a server frame arriving on the wrong side.
				shutdown(1002, 'client frames must be masked');
				return false;
			}
			if (pending.length < offset + 4) return true;
			const mask = pending.subarray(offset, offset + 4);
			offset += 4;
			if (pending.length < offset + length) return true;

			const payload = Buffer.allocUnsafe(length);
			pending.copy(payload, 0, offset, offset + length);
			for (let i = 0; i < length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
			pending = pending.subarray(offset + length);

			const isControl = (opcode & 0x08) !== 0;
			if (isControl) {
				if (!fin || length > MAX_CONTROL_BYTES) {
					shutdown(1002, 'malformed control frame');
					return false;
				}
				if (opcode === OP.close) {
					const code = length >= 2 ? payload.readUInt16BE(0) : 1005;
					const reason = length > 2 ? payload.subarray(2).toString('utf8') : '';
					if (!closeSent) {
						closeSent = true;
						// Echo the peer's code back, as §5.5.1 asks.
						write(encodeFrame(OP.close, closePayload(code === 1005 ? 1000 : code, '')));
					}
					open = false;
					socket.end();
					finish({ code, reason });
					return false;
				}
				if (opcode === OP.ping) write(encodeFrame(OP.pong, payload));
				// A pong is a liveness answer with nothing to do. Nothing else is
				// a legal control opcode.
				else if (opcode !== OP.pong) {
					shutdown(1002, `unknown control opcode ${opcode}`);
					return false;
				}
				continue;
			}

			if (opcode === OP.binary) {
				shutdown(1003, 'this endpoint speaks JSON text');
				return false;
			}
			if (opcode === OP.text || opcode === OP.continuation) {
				if (opcode === OP.text && fragmentOp !== null) {
					shutdown(1002, 'a new message began inside a fragmented one');
					return false;
				}
				if (opcode === OP.continuation && fragmentOp === null) {
					shutdown(1002, 'continuation with nothing to continue');
					return false;
				}
				fragmentBytes += length;
				if (fragmentBytes > maxMessageBytes) {
					shutdown(1009, 'message too large');
					return false;
				}
				fragments.push(payload);
				fragmentOp = opcode === OP.text ? OP.text : fragmentOp;
				if (!fin) continue;
				const whole = fragments.length === 1 ? (fragments[0] as Buffer) : Buffer.concat(fragments);
				fragments = [];
				fragmentBytes = 0;
				fragmentOp = null;
				deliver(whole.toString('utf8'));
				continue;
			}
			shutdown(1002, `unknown opcode ${opcode}`);
			return false;
		}
	};

	// The upgrade hands us a `net.Socket`; `Duplex` is how node's types spell it.
	(socket as Duplex & Partial<Pick<Socket, 'setNoDelay'>>).setNoDelay?.(true);
	socket.on('error', () => finish({ code: 1006, reason: 'socket error' }));
	socket.on('close', () => finish({ code: 1006, reason: 'socket closed' }));
	socket.on('data', (chunk: Buffer) => {
		if (closed !== null) return;
		pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
		consume();
	});

	socket.write(
		'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'] as string)}\r\n\r\n`,
	);
	if (head.length > 0) {
		pending = head;
		consume();
	}

	return {
		get open(): boolean {
			return open;
		},
		send(text: string): void {
			if (!open) return;
			write(encodeFrame(OP.text, Buffer.from(text, 'utf8')));
		},
		close(code = 1000, reason = ''): void {
			if (closed !== null) return;
			shutdown(code, reason);
		},
		onMessage(handler): void {
			messageHandlers.push(handler);
		},
		onClose(handler): void {
			if (closed !== null) handler(closed);
			else closeHandlers.push(handler);
		},
	};
}
