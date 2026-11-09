/**
 * A stand-in for hadoku's edge-router, just enough of it for one test run.
 *
 * What the real edge does for `/cardtable/*`, and this does too:
 *   1. routes only paths under the prefix, and strips it (`stripPrefix`);
 *   2. resolves the caller from their session, and stamps `X-Edge-Auth`,
 *      `X-Hadoku-Tier`, `X-User-Id`, `X-User-Key` on the proxied request;
 *   3. does both for the websocket upgrade as well as for plain HTTP.
 *
 * Anything identity-shaped the BROWSER sent is deleted first, so a context
 * cannot talk its way in by setting a header; only the session cookie counts,
 * and only for a name in `FRIENDS`. A caller with no session gets no stamp at
 * all, and the server's own floor is what refuses it — that is the second seal
 * `edge-auth.ts` is written about, and the spec checks it bites.
 */

import { readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';

import type { PrefsRowsStandIn } from '../apps/server/src/http/prefsRowsStandIn.ts';
import { FRIENDS, PREFIX, SESSION_COOKIE } from './identities.ts';

/** Where `embed-host.html` is served: a watchparty-shaped path, outside `/cardtable/`. */
export const EMBED_HOST_PATH = '/watchparty/embed-host.html';
const EMBED_HOST_PAGE = new URL('./embed-host.html', import.meta.url);

export interface EdgeOptions {
  port: number;
  upstreamPort: number;
  secret: string;
  /** prefs-api's `_service/cardtable/rows`, served at `/prefs/api/v1/_service/…` for the server's own calls. */
  prefs?: PrefsRowsStandIn;
}

/** Where the stand-in prefs-api is mounted: the server's `CARDTABLE_PREFS_BASE_URL` is the edge plus this. */
export const PREFS_MOUNT = '/prefs';

const STRIPPED = /^(x-edge-auth|x-hadoku-.*|x-user-.*)$/i;

function sessionOf(headers: IncomingHttpHeaders): string | null {
  const raw = headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=');
  }
  return null;
}

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
  const friend = FRIENDS[sessionOf(inbound) ?? ''];
  if (friend !== undefined) {
    out['x-edge-auth'] = secret;
    // A player is a member, as on hadoku.me since D24; an identity names a higher tier itself.
    out['x-hadoku-tier'] = friend.tier ?? 'member';
    out['x-user-id'] = friend.userId;
    out['x-user-name'] = friend.name;
    out['x-user-key'] = friend.key;
    // The real edge's `isVerified`: every tier above member, and a member with the registry's flag.
    if (out['x-hadoku-tier'] !== 'member' || friend.verified === true) out['x-hadoku-verified'] = '1';
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

export function startEdge(opts: EdgeOptions): Promise<Server> {
  const server = createServer((req, res) => {
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
        const key = inboundKey ?? FRIENDS[sessionOf(req.headers) ?? '']?.key ?? null;
        const out = prefs.handle(req.method ?? 'GET', prefsPath, { key }, body) ?? { status: 404, json: { error: 'Not Found' } };
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
      });
      return;
    }
    const path = stripPrefix(req.url ?? '/');
    if (path === null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not an edge route');
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
