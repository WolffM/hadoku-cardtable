/*
 * Dev harness for the LIVE board: one match, over a real socket.
 *
 * Open under `pnpm --filter @hadoku/ui dev`:
 *
 *   /cardtable/src/play/live/harness.html?match=<matchId>&server=http://localhost:9008
 *
 * - `match`  — required; the id `POST /api/play/matches` returned.
 * - `server` — the match server's origin. Given: a cross-origin WEBSOCKET at
 *              `<server>/socket.io/` (a websocket is not subject to CORS; the
 *              polling handshake would be). Omitted: same origin, at the
 *              bundle's `/cardtable/socket.io/`, which is production's shape.
 * - `path`   — overrides the socket.io path either way.
 *
 * The server must let a header-less local browser in — for a bare local run,
 * `CARDTABLE_INSECURE_NO_EDGE_AUTH=1` with `EDGE_AUTH_SECRET` unset, which
 * grants the dev tier (`apps/server/src/edge-auth.ts`).
 *
 * The fixture harness (`../harness.html`) is untouched and still renders the
 * committed game with no server at all.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../../styles.css';
import { LiveBoard } from './LiveBoard.tsx';
import { socketIoMatchTransport, startMatch, type SocketIoMatchOptions } from './match.ts';

const root = document.getElementById('root');
if (!root) throw new Error('harness.html is missing #root');

const params = new URLSearchParams(window.location.search);
const matchId = params.get('match');
const server = params.get('server');
const path = params.get('path');

if (matchId === null || matchId === '') {
  root.textContent = 'Add ?match=<matchId> (and &server=http://host:port for a cross-origin dev server).';
} else {
  const options: SocketIoMatchOptions =
    server === null
      ? {}
      : { url: server, path: '/socket.io/', transports: ['websocket'] };
  if (path !== null) options.path = path;
  const match = startMatch({ matchId, transport: socketIoMatchTransport(options) });
  createRoot(root).render(
    <StrictMode>
      <LiveBoard match={match} />
    </StrictMode>,
  );
}
