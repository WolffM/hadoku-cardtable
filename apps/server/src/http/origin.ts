/**
 * Every response this server sends carries `X-Hadoku-Origin: cardtable`.
 *
 * The edge holds a request through a deploy's restart (hadoku_site's `proxy.ts`,
 * `holdThroughRestart`). While nothing listens on our port, cloudflared answers 502 for us,
 * and that 502 is the one worth holding for. A 502 of our own (Rally, the sound store, a stream
 * container) is an answer and must reach the browser at once. This header is how the edge tells
 * the two apart, so it goes on at the socket level and covers express, socket.io's polling and
 * every error path alike.
 */
import type { Server } from 'node:http';

export const ORIGIN_HEADER = 'X-Hadoku-Origin';
export const ORIGIN_VALUE = 'cardtable';

export function stampOrigin(server: Server): void {
	server.prependListener('request', (_req, res) => {
		res.setHeader(ORIGIN_HEADER, ORIGIN_VALUE);
	});
}
