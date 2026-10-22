/**
 * `GET /play/ws` — the endpoint a browser client that is not our React app
 * joins, and the only thing in this directory `src/index.ts` needs to call.
 *
 * ```
 * CheerpJ page ──browser WebSocket──►  index.ts (this file)
 *                                        │  gate: sanitizeHeaders + tier floor
 *                                        │  identity: identityFromHeaders
 *                                        ▼
 *                                      ws.ts ──text──► session.ts ──► match.ts ──► host.ts ──► the JVM
 *                                        ▲                              (per-seat projector)
 *                                        └──── fanout.ts ◄── Match's emit
 * ```
 *
 * ## The gate is the draft's gate and play's gate, re-applied a third time
 *
 * An `upgrade` event never runs express middleware — `app.use(edgeProvenance)`
 * and `app.use(requireMinTier)` in `src/index.ts` are both on the request path,
 * and an upgrade is not a request. That is exactly why `play/socket.ts` and
 * `room/socket.ts` re-apply the same two steps to the socket.io handshake, and
 * the same reasoning applies here with nothing changed:
 *
 *   1. `sanitizeHeaders` over the handshake headers, so a direct hit on the
 *      tunnel hostname cannot forge `x-hadoku-tier` / `x-user-id` / `x-user-key`.
 *   2. rank against the tier floor, and **404** — not 403 — below it, so this
 *      endpoint does not confirm its own existence to a scanner.
 *
 * Both are idempotent, so running them again costs one header read. The friend
 * gate is therefore unchanged by this lane: a new transport that re-applies the
 * existing floor, with no new tier, no anonymous path and no token of its own.
 *
 * ## Identity is derived, never accepted
 *
 * `identityFromHeaders` over the SANITIZED headers, as both existing sockets
 * do. The dev hatch is `socket.ts`'s, spelled for a URL because a browser
 * cannot set a header on a WebSocket handshake either: `?devUser=<name>` is
 * honoured only when `CARDTABLE_INSECURE_NO_EDGE_AUTH=1` and no
 * `EDGE_AUTH_SECRET` — checked here against `CONFIG`, not against the caller's
 * flag, because with a real edge in front it would be identity by assertion.
 *
 * ## Living next to engine.io on one HTTP server
 *
 * socket.io attaches its own `upgrade` listener. For a path that is not
 * `/socket.io/` it does nothing for `destroyUpgradeTimeout` (1 s) and then ends
 * the socket **only if `socket.bytesWritten <= 0`** (engine.io `server.js`,
 * `attach`). This handler writes its 101 synchronously, so by that check the
 * connection has bytes written and is left alone. Order of listener
 * registration does not matter; both are called.
 */

import type { Request } from 'express';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { CONFIG } from '../../config.js';
import { rankOf, sanitizeHeaders, tierOf } from '../../edge-auth.js';
import { jsonLogger } from '../../log.js';
import { identityFromHeaders } from '../../room/identity.js';
import type { MatchRegistry } from '../match.js';
import type { PlayLog } from '../socket.js';
import { BrowserFanout, browserFanout } from './fanout.js';
import { BROWSER_PROTOCOL_VERSION, BROWSER_WS_PATH, encodeBrowserMessage } from './protocol.js';
import { BrowserSession } from './session.js';
import { acceptUpgrade, isWebSocketUpgrade, refuseUpgrade, type BrowserSocket } from './ws.js';

export { BrowserFanout, browserFanout, type SeatBound } from './fanout.js';
export { BROWSER_PROTOCOL_VERSION, BROWSER_WS_PATH, parseBrowserRequest, type BrowserMessage, type BrowserRequest } from './protocol.js';
export { BrowserSession, type BrowserSessionDeps } from './session.js';
export { acceptUpgrade, isWebSocketUpgrade, refuseUpgrade, type BrowserSocket } from './ws.js';

const DEV_USER = /^[a-z0-9-]{1,32}$/;

export interface BrowserBridgeDeps {
	/** The tier floor. `CONFIG.minTier` in production. */
	minTier: string;
	/**
	 * The registry `attachPlay` built, read lazily — `src/index.ts` creates the
	 * bridge and play in whichever order suits it, as `attachTables` already does.
	 */
	matches: () => MatchRegistry | null;
	log?: PlayLog;
	/** Default `BROWSER_WS_PATH`. */
	path?: string;
	/** Dev-only per-handshake identity; see the module header. */
	devIdentity?: boolean;
	/** How long a join waits for a starting match. Default 8 s, as `attachPlay`. */
	joinWaitMs?: number;
	/** Default the process-wide `browserFanout`. A test passes its own. */
	fanout?: BrowserFanout;
}

export interface BrowserBridgeHandle {
	readonly path: string;
	/** Live connections. */
	connections(): number;
	/** Close every connection and stop answering upgrades. */
	close(): void;
}

/** The path, ignoring the query string. A URL that is not ours is left to other listeners. */
function pathOf(url: string | undefined): string {
	const raw = url ?? '/';
	const q = raw.indexOf('?');
	return q === -1 ? raw : raw.slice(0, q);
}

export function attachBrowserBridge(server: HttpServer, deps: BrowserBridgeDeps): BrowserBridgeHandle {
	const log = deps.log ?? jsonLogger('cardtable-play-browser');
	const path = deps.path ?? BROWSER_WS_PATH;
	const fanout = deps.fanout ?? browserFanout;
	const devIdentity = deps.devIdentity === true && CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '';
	if (deps.devIdentity === true && !devIdentity) {
		log({ evt: 'browser-dev-identity-refused', reason: 'the insecure edge hatch is not open' });
	}
	const live = new Set<BrowserSocket>();
	let open = true;
	let n = 0;

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		if (pathOf(req.url) !== path) return;
		if (!open) {
			refuseUpgrade(socket, 503, 'shutting down');
			return;
		}
		if (!isWebSocketUpgrade(req)) {
			refuseUpgrade(socket, 400, 'expected a version-13 websocket upgrade');
			return;
		}

		// ── The gate, in the same two steps and the same order as the sockets ──
		sanitizeHeaders(req.headers as Record<string, unknown>);
		const tier = tierOf({ headers: req.headers } as unknown as Request);
		if (rankOf(tier) < rankOf(deps.minTier)) {
			log({ evt: 'browser-refused', reason: 'below the tier floor', tier });
			refuseUpgrade(socket, 404, 'not found');
			return;
		}

		const connectionId = `bw-${(n += 1)}-${Date.now().toString(36)}`;
		const headers = { ...req.headers };
		if (devIdentity) {
			const url = new URL(req.url ?? '/', 'http://cardtable.invalid');
			const devUser = url.searchParams.get('devUser');
			if (devUser !== null && DEV_USER.test(devUser)) headers['x-user-id'] = `local-dev-seat-${devUser}`;
		}
		const participantId = identityFromHeaders(headers, connectionId);

		const ws = acceptUpgrade(req, socket, head);
		if (ws === null) return;
		live.add(ws);

		const session = new BrowserSession({
			matches: deps.matches,
			participantId,
			send: (message) => ws.send(encodeBrowserMessage(message)),
			log,
			fanout,
			joinWaitMs: deps.joinWaitMs,
		});
		fanout.add(session);
		log({ evt: 'browser-connected', connectionId, participantId, tier });
		ws.send(encodeBrowserMessage({ t: 'hello', protocol: BROWSER_PROTOCOL_VERSION }));

		ws.onMessage((text) => {
			void session.handle(text);
		});
		ws.onClose((info) => {
			live.delete(ws);
			session.disconnect(`${info.code}${info.reason === '' ? '' : ` ${info.reason}`}`);
			fanout.remove(session);
			log({ evt: 'browser-disconnected', connectionId, code: info.code, reason: info.reason });
		});
	};

	server.on('upgrade', onUpgrade);

	return {
		path,
		connections: () => live.size,
		close(): void {
			open = false;
			server.off('upgrade', onUpgrade);
			for (const ws of [...live]) ws.close(1001, 'server shutting down');
			live.clear();
		},
	};
}
