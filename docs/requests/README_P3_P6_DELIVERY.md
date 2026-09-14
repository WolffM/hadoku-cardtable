# P3–P6: here's what we need

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Date:** 2026-09-14
**Re:** `ROOM_MODULE_RESPONSE.md` §1's phase table, rows P3–P6
**Read against:** `@wolffm/rooms-protocol@0.38.109` and
`@wolffm/rooms-server@0.38.109`, **read from source in your repo**, not from a
published tarball. See "How we read this" at the end.

Four documents, one per phase you assigned us:

| | Document | What it asks for | State against `0.38.109` |
| --- | --- | --- | --- |
| **P3** | `P3_PER_RECIPIENT_EMIT.md` | per-recipient emit; per-participant `seq`; fail-closed projections | **cut to a third** — see below |
| **P4** | `P4_ASK_REGISTRY.md` | ask/correlation registry, durable and seat-scoped | unchanged in substance; one factual correction, one new open question |
| **P5** | `P5_SERVICE_PARTICIPANT.md` | service attach/detach/heartbeat/crash lifecycle | re-shaped — `'service'` has no home in the shipped types |
| **P6** | `P6_PERSISTENCE.md` | pluggable room store; **plus the `rooms-client` answer** | the problem you named in §6 is intact, and now inside a package |

They were written on 2026-09-11 against your response. You shipped code on
2026-09-14. Everything below is the difference.

---

## 1. P3 shrank, because you had already built most of it

The single line that did it, verbatim —
`packages/rooms-server/src/emit.ts:19`:

```ts
  /** Droppable, EARLIEST FIRST. An event in neither list is never dropped. */
```

That is our D11 correction, shipped, as a documented guarantee, with the
implementation to match (`emit.ts:53-57`). Together with `thresholdBytes`
(`emit.ts:16`) and host-supplied `highPriority` / `lowPriorityOrder`
(`emit.ts:18,20`), it answers the whole of the old P3 §2.2 — which had asked you
not to hardcode the lists, to never shed unlisted events, and to bound the
queue. Three asks, all shipped. `SKIP` is exported too (`emit.ts:72`).

So we deleted them rather than sending them. **Delivering P3 as written would
have asked you to build things that are in the tarball**, which is the fastest
way to teach someone to stop reading our requests.

What survives is three things that genuinely are not in `0.38.109`: a
per-participant sequence number, a rule about what a *shed* envelope does to it,
and fail-closed projections. Plus the blocker in §3 below.

## 2. Two things we found in your tree

Neither is the point of the delivery. Both are in P3 §7, stated once.

**W1 — `SKIP` is exported with nothing to pass it to.** `emit.ts:71-72` declares
`export const SKIP: unique symbol` documented as *"Skip sentinel for
`emitPerRecipient`. See that function."* `emit.ts` declares only `safeEmit` and
`broadcastToRoom`; `index.ts` re-exports `state`, `emit`, `gc` and
`rateLimiter` and adds nothing. A repo-wide grep for `emitPerRecipient` returns
two hits: that comment, and line 206 of `ROOM_MODULE_RESPONSE.md`. **A consumer
can import `SKIP` today and has nothing to pass it to.** Either it was dropped
in the carve, or the sentinel shipped ahead of P3 and P3 is ours to land — which
is what your §2 and our D10 both say. Worth confirming which; if it is the
second, `0.38.109` has a public symbol whose contract is a document that does
not exist yet.

**W2 — `@wolffm/rooms-client`: we agree with the deferral, for a stronger
reason than the one you gave.** Our client is a cross-origin iframe, so we would
not be that package's consumer — *your* app would. Your own
`GameModule.tsx:129-134` says why. **We are asking for something else instead,
and it is cheaper:** write the reconnect / resync / identity-reassert contract
into the zero-dep `rooms-protocol`, even while the implementation stays in
`socket.ts`. Seq-gap detection, the resync trigger, and the re-assert ordering.
That logic is what our P6 requirement — *"a 45-minute draft survives a server
restart and a browser refresh"* — actually rides on, and unextracted it has one
implementation, one consumer, and no visibility from outside your repo. Full
argument and the three specific asks: **P6 §8**.

## 3. One thing blocks parts of all four

**`ClientMeta` carries a single `socketId`, not the socket set §3.2 described.**
`state.ts:16`, with `clients` keyed by the ephemeral `clientId`
(`state.ts:62-63`) and `clientByParticipant` returning the first match
(`state.ts:199-207`). There is no `Participant` type and no `sockets` field in
either package.

We flag it because a reachable consequence lands on the test you added to our
list in your §5 — *"a seat that survives a browser refresh."* On a refresh where
the new join is processed before the stale disconnect, `leaveRoom` unseats a
participant who is already back on a live socket (`state.ts:186`), and nothing
re-seats them. We ran it against your `seats.ts` rather than reasoning about it;
the repro output is in **P3 §6**, along with three ways you might want to fix it
and no opinion from us about which.

It is not a complaint — P2 shipped as core and you said so. It is a
cross-reference: P3's per-participant `seq`, P4's replay-on-reattach and
requirement 7, and P6's browser-refresh half all assume the socket-set model.
**P3 §6 is the only place we argue it.** The other three point at it.

## 4. What we are deliberately not sending

`WATCHPARTY_ROOM_MODULE.md` — the original extraction request — **stays in our
repo.** You answered it in full, point by point, in `ROOM_MODULE_RESPONSE.md`,
and accepted it; sending it now would ask you to re-read a document you have
already replied to. It also names `@wolffm/rooms` throughout (the package that
became `rooms-protocol`) and asks for P0–P2, which are done. It is history, and
it is our history to keep.

## 5. Ordering, on our side

`O2` settled on 2026-09-14: our draft engine is TypeScript in the room server's
own process, not a JVM. That reorders things for us — **P3, P4 and P6 are what
the first playable draft needs; P5 is for matches** and lands after. It also
means the draft's "survive a restart" story is P6's, not P5's.

## 6. How we read this, and one thing you warned us about

We read `packages/rooms-protocol/src/` and `packages/rooms-server/src/` in your
repo directly. We could not `npm install` the packages: our `~/.npmrc` reads
`_authToken=${NODE_AUTH_TOKEN}` and the variable is unset in the shell, so npm
sends the literal placeholder and GitHub Packages answers `E401`. Our problem,
on our side, being fixed — noted only because your §4 told us the token setup
would cost us a day, and it did.

Reading source rather than `dist/*.d.ts` is why every citation in these four
documents is a `file:line` in your tree, and why we quote your doc comments
rather than paraphrasing them. Where we say "did not ship", we mean a grep
returned nothing, not that we couldn't find it in the types.
