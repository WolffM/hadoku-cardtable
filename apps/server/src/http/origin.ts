/**
 * Every response this server sends carries `X-Hadoku-Origin: cardtable` —
 * cardtable's binding of the platform kernel (`@hadoku/service-kernel/http`).
 *
 * The edge holds a request through a deploy's restart (hadoku_site's `proxy.ts`,
 * `holdThroughRestart`). While nothing listens on our port, cloudflared answers 502 for us,
 * and that 502 is the one worth holding for. A 502 of our own (Rally, the sound store, a stream
 * container) is an answer and must reach the browser at once. This header is how the edge tells
 * the two apart, so it goes on at the socket level and covers express, socket.io's polling and
 * every error path alike.
 */
import type { Server } from 'node:http';
import { ORIGIN_HEADER, stampOrigin as kernelStampOrigin } from '@hadoku/service-kernel/http';

export { ORIGIN_HEADER };
export const ORIGIN_VALUE = 'cardtable';

export function stampOrigin(server: Server): void {
	kernelStampOrigin(server, ORIGIN_VALUE);
}
