/**
 * A stand-in for hadoku's edge-router, just enough of it for one test run.
 *
 * What the real edge does for `/cardtable/*`, and this does too:
 *   1. routes only paths under the prefix, and strips it (`stripPrefix`);
 *   2. resolves the caller from their session, and stamps `X-Edge-Auth`,
 *      `X-Hadoku-Tier`, `X-User-Id`, `X-User-Key` on the proxied request;
 *   3. does both for the websocket upgrade as well as for plain HTTP;
 *   4. gives every page the import map for hadoku.me's shared react and @wolffm
 *      packages, which the built UI leaves external, and serves those files at
 *      /mf/vendor/* (`@wolffm/shared-vendor/harness`, built from apps/ui's own
 *      node_modules, placing the map exactly as the real edge does).
 *
 * Anything identity-shaped the BROWSER sent is deleted first, so a context
 * cannot talk its way in by setting a header; only the session cookie counts,
 * and only for a name in `FRIENDS` (or a guest the wall made, below). A caller
 * with no session gets no stamp at all, and the server's own floor is what
 * refuses it — that is the second seal `edge-auth.ts` is written about, and the
 * spec checks it bites.
 *
 * A browser that carries `EDGE_GATE_COOKIE` gets the real edge's own gate
 * instead (`edgeGate`): with no session, 401 for a request or a socket under the
 * prefix, and for a page load the sign-in wall, which signs a visitor up as a
 * new guest and sends them on. `POST /__e2e/drop-gated-sockets` ends every
 * socket such a browser has open, as a deploy's restart does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { standInVendor } from '@wolffm/shared-vendor/harness';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import type { PrefsRowsStandIn } from '../games/magic/server/src/http/prefsRowsStandIn.ts';
import { EDGE_GATE_COOKIE, FRIENDS, PREFIX, SESSION_COOKIE, type Friend } from './identities.ts';

/** Where `embed-host.html` is served: a watchparty-shaped path, outside `/cardtable/`. */
export const EMBED_HOST_PATH = '/watchparty/embed-host.html';
const EMBED_HOST_PAGE = new URL('./embed-host.html', import.meta.url);

export interface EdgeOptions {
  port: number;
  upstreamPort: number;
  secret: string;
  /** prefs-api's `_service/cardtable/rows`, served at `/prefs/api/v1/_service/…` for the server's own calls. */
  prefs?: PrefsRowsStandIn;
  /** Where the shared vendor files are built: a run directory of this stack's own, never another's. */
  vendorDir: string;
}

/** The UI package, whose node_modules hold the react and @wolffm packages the page loads. */
const UI_DIR = fileURLToPath(new URL('../apps/ui', import.meta.url));

/** Where the stand-in prefs-api is mounted: the server's `CARDTABLE_PREFS_BASE_URL` is the edge plus this. */
export const PREFS_MOUNT = '/prefs';

const STRIPPED = /^(x-edge-auth|x-hadoku-.*|x-user-.*)$/i;

function cookieOf(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function sessionOf(headers: IncomingHttpHeaders): string | null {
  return cookieOf(headers, SESSION_COOKIE);
}

/** The guests the sign-in wall has made this run, by session. */
const guests = new Map<string, Friend>();

/** Who a session is: a named identity, or a guest the wall made. */
function identityOf(headers: IncomingHttpHeaders): Friend | undefined {
  const session = sessionOf(headers) ?? '';
  return FRIENDS[session] ?? guests.get(session);
}

/** The real edge's answer for a caller behind its gate with no session, or null to pass it on. */
export type GateAnswer = { kind: 'wall'; session: string } | { kind: 'refused' };

/** Ungated under the prefix, as on the real edge: a room's link preview. */
const PUBLIC_PATH = /^\/preview\//;

/**
 * What the real edge does with a caller it has no session for (hadoku_site's `authGate.ts`): a page
 * load (`Accept: text/html`, not an `/api/` path) is the sign-in wall, which makes the visitor a guest
 * ("Player NNNNN") and sends them on; anything else is a 401. Only for a browser carrying
 * `EDGE_GATE_COOKIE`; null for everyone else, and for anyone with a session.
 */
export function edgeGate(headers: IncomingHttpHeaders, path: string): GateAnswer | null {
  if (cookieOf(headers, EDGE_GATE_COOKIE) === null || identityOf(headers) !== undefined || PUBLIC_PATH.test(path)) return null;
  const isApi = /(?:^|\/)api(?:\/|$)/.test(path);
  const accept = headers.accept ?? '';
  if (isApi || !accept.includes('text/html')) return { kind: 'refused' };
  const n = 10_000 + guests.size;
  const session = `guest-${n}`;
  guests.set(session, { key: `e2e-guest-key-${n}`, userId: `e2e-guest-${n}-id`, name: `Player ${n}` });
  return { kind: 'wall', session };
}

/** Every socket open for a browser behind the gate, for `/__e2e/drop-gated-sockets`. */
const gatedSockets = new Set<Duplex>();
const DROP_GATED_SOCKETS = '/__e2e/drop-gated-sockets';

/** The headers the app server will see. */
export function edgeHeaders(
  inbound: IncomingHttpHeaders,
  secret: string,
  upstreamPort: number,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (!STRIPPED.test(k)) out[k] = v;
  }
  out.host = `127.0.0.1:${upstreamPort}`;
  const friend = identityOf(inbound);
  if (friend !== undefined) {
    out['x-edge-auth'] = secret;
    // A player is a guest, as every visitor's account on hadoku.me is; an identity names a higher tier itself.
    out['x-hadoku-tier'] = friend.tier ?? 'guest';
    out['x-user-id'] = friend.userId;
    out['x-user-name'] = friend.name;
    out['x-user-key'] = friend.key;
    // The real edge still sends X-Hadoku-Verified for member and up until every repo stops reading
    // it; cardtable reads the tier alone, and stamping it here keeps that proven.
    if (out['x-hadoku-tier'] !== 'guest') out['x-hadoku-verified'] = '1';
  }
  return out;
}

/** `/cardtable/x` → `/x`; anything not under the prefix → null. */
export function stripPrefix(url: string): string | null {
  if (url === PREFIX) return '/';
  if (!url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) return null;
  const rest = url.slice(PREFIX.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

export async function startEdge(opts: EdgeOptions): Promise<Server> {
  const vendor = await standInVendor({ root: UI_DIR, outDir: opts.vendorDir });
  const server = createServer((req, res) => {
    if (vendor.handle(req, res)) return;
    // The one page that is not cardtable's: a stand-in for a watchparty room,
    // on the same origin and outside the prefix, that mounts the embed (D21).
    if (new URL(req.url ?? '/', 'http://edge').pathname === EMBED_HOST_PATH) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(EMBED_HOST_PAGE));
      return;
    }
    const prefsPath = (req.url ?? '/').startsWith(`${PREFS_MOUNT}/`) ? (req.url ?? '/').slice(PREFS_MOUNT.length) : null;
    if (prefsPath !== null && opts.prefs !== undefined) {
      const prefs = opts.prefs;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('error', () => res.destroy());
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = raw === '' ? null : (JSON.parse(raw) as unknown);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Bad Request' }));
          return;
        }
        // A server-to-server caller (`resolveAvatars`'s service key, `dress()`'s `_stand-in` PUT) sets
        // `X-User-Key` itself; a BROWSER never does (`credentials: 'include'` sends only its cookie), so
        // its own GET /api/v1/_avatar (the room chrome's own read of the viewer's character) is resolved the
        // same way `edgeHeaders` resolves `/cardtable/*`'s caller — from the session cookie, never trusted
        // off an inbound header a page could set, since this mount (unlike `/cardtable/*`) never strips one.
        const inboundKey = typeof req.headers['x-user-key'] === 'string' ? req.headers['x-user-key'] : null;
        const key = inboundKey ?? identityOf(req.headers)?.key ?? null;
        const out = prefs.handle(req.method ?? 'GET', prefsPath, { key }, body) ?? { status: 404, json: { error: 'Not Found' } };
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
      });
      return;
    }
    if (req.method === 'POST' && req.url === DROP_GATED_SOCKETS) {
      const dropped = gatedSockets.size;
      for (const s of gatedSockets) s.destroy();
      gatedSockets.clear();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dropped }));
      return;
    }
    const path = stripPrefix(req.url ?? '/');
    if (path === null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not an edge route');
      return;
    }
    const gate = edgeGate(req.headers, path);
    if (gate?.kind === 'refused') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', required: 'guest' }));
      return;
    }
    if (gate?.kind === 'wall') {
      res.writeHead(302, { location: req.url ?? `${PREFIX}/`, 'set-cookie': `${SESSION_COOKIE}=${gate.session}; Path=/; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store' }).end();
      return;
    }
    const upstream = request(
      {
        host: '127.0.0.1',
        port: opts.upstreamPort,
        method: req.method,
        path,
        headers: edgeHeaders(req.headers, opts.secret, opts.upstreamPort),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on('error', () => res.destroy());
      },
    );
    // This runs inside the Playwright worker: an `error` nobody listens for is thrown there, and fails
    // whatever test is running with no stack (waiting.spec, run 39766532205, "read ECONNRESET"). A reset
    // on either side ends the other, as the real edge would.
    upstream.on('error', (err) => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { 'content-type': 'text/plain' }).end(`edge: upstream error ${err.message}`);
    });
    req.on('error', () => upstream.destroy());
    res.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    // An upgraded socket is the handler's alone: the server's own error listener is gone from it.
    socket.on('error', () => socket.destroy());
    const path = stripPrefix(req.url ?? '/');
    if (path === null) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (edgeGate(req.headers, path) !== null) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (cookieOf(req.headers, EDGE_GATE_COOKIE) !== null) {
      gatedSockets.add(socket);
      socket.on('close', () => gatedSockets.delete(socket));
    }
    const headers = edgeHeaders(req.headers, opts.secret, opts.upstreamPort);
    const up = connect(opts.upstreamPort, '127.0.0.1', () => {
      const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolveListen(server));
  });
}
