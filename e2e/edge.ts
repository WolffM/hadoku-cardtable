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

import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';

import { FRIENDS, PREFIX, SESSION_COOKIE } from './identities.ts';

export interface EdgeOptions {
  port: number;
  upstreamPort: number;
  secret: string;
}

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
    // Every identity before wave 50 §U has no `tier`, so this is `'friend'`
    // for all of them, unchanged. `admin` is the one entry that opts in.
    out['x-hadoku-tier'] = friend.tier ?? 'friend';
    out['x-user-id'] = friend.userId;
    out['x-user-name'] = friend.name;
    out['x-user-key'] = friend.key;
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
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`edge: upstream error ${err.message}`);
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
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
    socket.on('error', () => up.destroy());
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolveListen(server));
  });
}
