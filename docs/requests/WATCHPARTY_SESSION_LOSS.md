# Request to `hadoku-watchparty`: a room socket stops when the session is gone (`@wolffm/rooms-client`)

**From:** hadoku-cardtable, 2026-11-26
**Status:** asked, not agreed. Cardtable's half has landed on its own side (below). Nothing on
watchparty's side changes until you take it.

## What happened

On 2026-11-23 at about 21:30–21:59Z one browser's hadoku session ended while it had cardtable open. From then
until it reloaded at 2026-11-24 19:44Z it sent about 2000 refused requests an hour: 31,616
`401 GET /cardtable/socket.io/` from two sockets, each reconnecting every 2–4 s, plus every REST
poller polling on its 401s, ~45k in all (monitoring-api's edge log, IP 73.83.155.*, Chrome 157 on
Windows). The page was dead to its player the whole time, and nothing on it said so.

The sockets were connecting the way `roomSocketOptions` says they should: reconnect after 250 ms, never
more than 1 s apart, forever. That setting is right for a deploy's restart (the edge holds the
handshake). It is wrong when the edge refuses the handshake because there is no session: then no retry
can succeed, and only a page load can help, because the edge answers a page load with its sign-in wall,
which makes a signed-out visitor a guest and sends them on.

Watchparty's sockets are the same: `apps/ui/src/lib/socket.ts` and `lib/chatTransport.ts` log
`connect_error` and let socket.io retry.

## What cardtable did

One watch per page, `packages/ui-shell/src/session/index.ts` in this repo (MIT, no dependencies):

- **A suspicion** is a 401 on any `fetch` under the app's base (it wraps the page's `fetch` once,
  so no client has to remember to) or a `connect_error` on any socket handed to `watchSocket(socket)`
  (socket.io never says why a handshake failed).
- **One probe** checks it: a gated GET under the base, at most once every 10 s. Only the edge's 401
  there is a lost session. A 502 during a restart, a 404, a network error, or another backend's own
  401 on some other path leave the page running.
- **A lost session** disconnects every watched socket (which ends socket.io's reconnecting), fails
  every later `fetch` under the base without sending it, and reloads the page. If a second loss comes
  within 60 s of a reload this tab already made for one, the page stays stopped instead of looping
  (`sessionStorage`).

Proven by `e2e/session-lost.spec.ts`: the cookie is dropped and the edge drops the sockets, as a
deploy does. Without the watch, the page never went 6 s without a request. With it there is one probe
~80 ms after the drop and then silence, or a reload that comes back as a new guest.

## The ask

1. **Host the watch in `@wolffm/rooms-client`**, beside `roomSocketOptions`, so every room app on
   the platform stops the same way. Cardtable would then import it from there and delete its copy
   (the module has no cardtable names in it: `scope` and `probeUrl` are parameters).
2. **Start it in watchparty**, over `/watchparty/`, and hand every socket `io()` makes to
   `watchSocket` (`lib/socket.ts`, `lib/chatTransport.ts`).

When cardtable is embedded in a watchparty room, cardtable's watch only covers `/cardtable/`, but
its reload reloads the whole watchparty page, so the host's sockets stop too in that case.
