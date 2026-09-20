# `apps/server/src/play/browser` — the server end of the CheerpJ bridge

Wave 15, lane C. A **second client type** for the existing match server: a
plain WebSocket endpoint a browser client that is not our React app can join.
It adds no play stack, no registry, no projection and no tier — everything it
serves comes out of `../match.ts`, already projected for one named seat.

```
CheerpJ page ──browser WebSocket──►  index.ts
                                       │  gate:     sanitizeHeaders + the tier floor
                                       │  identity: identityFromHeaders
                                       ▼
                                     ws.ts ──text──► session.ts ──► ../match.ts ──► ../host.ts ──► the JVM
                                       ▲                             (per-seat projector)
                                       └──── fanout.ts ◄── Match's emit
```

| file | what |
| --- | --- |
| `index.ts` | `attachBrowserBridge(server, deps)`: the `upgrade` handler, the gate, identity, and this directory's exports |
| `ws.ts` | RFC 6455, server side — handshake, text frames, fragments, ping/pong, close |
| `protocol.ts` | the `t`/`rid` wrapper, and nothing else: the payloads are `../transport.ts`'s |
| `session.ts` | one connection, socket-free: join / resync / c2s / disconnect against a `Match` |
| `fanout.ts` | the live connections, and the one call `../socket.ts` has to make |
| `browser.test.ts` | end to end against the recorded real transcript. Runs in CI |
| `mounted.test.ts` | the bridge **as `src/index.ts` mounts it** — `src/index.ts` spawned as a real process, a real upgrade driven at it. Runs in CI |
| `browser-jvm.test.ts` | the same against a real Forge in a child JVM. Skips without one |

## Mounted — and the one line that is still missing

`src/index.ts` **calls `attachBrowserBridge`** (Wave 16, lane C), next to
`attachPlay`, on the same `httpServer` engine.io uses, behind the same
`CONFIG.minTier` floor and with `matches` read lazily. `mounted.test.ts` proves
it by spawning `src/index.ts` as a real process and driving a real browser
`WebSocket` upgrade at it — remove the call and that suite goes red, which is
the check the previous wave did not have.

What is **still** missing is the other half, and it is not this directory's
file. `Match` hands each projected envelope to the `emit` that
`createMatchRegistry` was built with, and there is no later seam, so a second
client type has to be reached from inside that same closure. Until this lands,
a mounted browser joins, is seated, is answered and its acts reach Forge — but
no LIVE frame is pushed to it, and it has to `resync` to see the board move:

```ts
// apps/server/src/play/socket.ts, in the createMatchRegistry({ … }) call
emit: (match, seat, envelope) => {
    browserFanout.deliver(match.id, seat, envelope);   // ← this
    emitPerRecipient<PlayApp, PlayClient, typeof envelope>(…);
},
```

with `import { browserFanout } from './browser/index.js';` at the top.
`../socket.ts` was not lane C's file in Wave 15 and was not in Wave 16 either.

## The wire

`GET /play/ws` (root path — the edge strips `/cardtable`). One JSON object per
text frame.

```
browser → server  { t: 'join'  , rid?, matchId }
browser → server  { t: 'resync', rid?, matchId }
browser → server  { t: 'c2s'   , matchId, frame: ClientFrame }
server → browser  { t: 'hello' , protocol }
server → browser  { t: 'snapshot', rid, ...MatchSnapshot }
server → browser  { t: 'error' , rid, error }
server → browser  { t: 's2c'   , ...ServerEnvelope }
```

`rid` replaces socket.io's ack callback and is echoed on the answer only. `t`
replaces the event name. Everything inside is parsed by `../transport.ts`'s
existing parsers, so this is not a second validation surface — a frame refused
on the socket.io path is refused identically here, with the same wording.

There is **no seat field on this wire**, by construction. The seat a message
acts on is always the one `Match.claim` bound to the connection's derived
participant, permanently for the match.

## Where a browser's seat identity comes from — and where it does NOT

**Not from Forge.** Lane A measured (Wave 15) that the CheerpJ branch never
sends `LoginEvent` or `HeartbeatEvent`: both are emitted from
`GameClientHandler.channelActive`, a netty pipeline callback that does not
exist once the transport is a browser `WebSocket` — `refusedOut=0`, so it was
never even asked for. A browser client therefore arrives here with **no Forge
lobby handshake and no Forge-assigned client id**, and nothing in this
directory waits for one.

Identity is the room layer's, end to end:

```
edge headers (x-user-key / x-user-id, post-sanitizeHeaders)
    → identityFromHeaders(…)            index.ts, at the upgrade
    → ParticipantId                     `fk:…` / `dev:…`, derived, never accepted
    → Match.claim(participantId)        session.ts, on `join`
    → seat (0 | 1)                      permanent for the match
    → Forge PlayerView id               learned from THAT seat's own openView
```

The last arrow is the only Forge-side identity in play, and it is learned from
the per-seat stream (`Match.openView`), not asserted by the browser. So the
three ids never cross: the person is named by the edge, the seat by the claim,
and the Forge player by Forge.

A consequence worth stating for lane A: the browser does not log in to Forge
and must not try. The Forge lobby handshake happens entirely inside the JVM,
before any browser connects.

## There is no client→server ask, and none should be added

`ClientFrameSchema` is a three-way union — `act`, `reply`, `abort`
(`packages/forge-wire/src/envelope.ts:201-205`) — and `Match.fromClient`
switches on exactly those three. Nothing on this wire lets a browser open an
ask against the server.

That is deliberate, not an omission. `getActivateDescription(CardView)->String`
is the only `Mode.CLIENT` method that would want one, and Forge itself already
avoids it on a net client: `VCardDisplayArea.java:217-224` guards the call with
`if (!GuiBase.isNetPlay(…))` — *"causes lag on netplay client side"* — and
`PlayArea.java:839-846` already handles a `null` answer through
`flashIncorrectAction()`. Lane A resolved it by having `sendAndWait` return
`null` immediately rather than parking a Forge thread on an untimed
`ReplyPool`. **Do not add a server-side responder for it.** A new frame kind
here forks the protocol, which §C forbids, to serve a call Forge does not make
over a network anyway.

## Hidden information

Measured, not asserted:

| run | seat | secrets | in Forge's raw stream | in what the browser received |
| --- | --- | --- | --- | --- |
| real Forge JVM | 0 | 144 | 144 | **0** |
| real Forge JVM | 1 | 142 | 142 | **0** |
| recorded transcript | 0 | 132 | 132 | **0** |
| recorded transcript | 1 | 140 | 140 | **0** |

and the negative control, which is the illegal cross-seat read spelled as data:
**18** of seat 0's secrets are present in the bytes that lawfully reached seat 1
(16 on the recorded transcript). So the zeros above are not vacuous — had seat
0's connection ever been handed seat 1's stream, the same check would have
found them.

Three guards produce that, and each is tested on its own:

1. `Match.sendState`'s per-seat projector (`../visibility.ts`) — not this lane's.
2. `BrowserFanout.deliver` gives an envelope only to connections holding that
   seat in that match.
3. `BrowserSession.push` refuses an envelope for a match the connection holds no
   seat in, and writes nothing after `disconnect`.

Guard 2 is mutation-tested in `mounted.test.ts`: with the seat filter deleted
from `deliver`, a real frame out of seat 1's own projected snapshot lands on
seat 0's WebSocket and **16 of seat 0's secrets are read off seat 0's wire** —
the suite fails on exactly that list. The tier floor is mutation-tested the
same way, against the spawned `src/index.ts`.

## Why the WebSocket is hand-written

`ws` is in the workspace store as a transitive dependency of engine.io, but not
a dependency of `@hadoku/server`, and pnpm's strict layout will not resolve it
from here. Adding it is a manifest change plus an install. The codec is ~200
lines against the spec and is exercised by Node's own built-in `WebSocket`
client — the same implementation a browser ships. Binary frames, unmasked
client frames, RSV bits and oversized messages are each refused with the close
code the spec names; see `ws.ts`'s header.

## Two things worth knowing before changing this

- **An `upgrade` event runs no express middleware.** `app.use(edgeProvenance)`
  and `app.use(requireMinTier)` are on the request path and an upgrade is not a
  request. That is why `index.ts` re-applies both — as `room/socket.ts` and
  `../socket.ts` already do for socket.io. Removing that is how the friend gate
  goes missing on one endpoint.
- **`http.Server.close(cb)` never calls back once an upgrade has been declined**
  (node v24.18.0). The detached socket is never subtracted from the server's
  connection count, and `closeAllConnections()` does not reach it. `close()`
  still releases the listening handle synchronously; only the callback hangs.
  `browser.test.ts` shuts down on that basis.
