# P5 — the service participant: what we need

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Re:** `ROOM_MODULE_RESPONSE.md` §3.6, phase P5
**Status:** request — revised against shipped code
**Date:** 2026-09-14 (first written 2026-09-11)
**Read against:** `@wolffm/rooms-protocol@0.38.109`, `@wolffm/rooms-server@0.38.109`,
read from source in your repo.

Your §3.6, quoted in full because it is the whole starting point:

> The service participant is a role, not a second mechanism. `role: 'service'`
> with an attachment lifecycle the room owns: attach, detach, heartbeat, crash
> → room survives, clients are told, state resyncs on re-attach.
> Transport-agnostic — we define the lifecycle and the routing, you bring the
> socket and the Forge adapter. We are not generalising host election; you're
> right that a browser tab and a JVM are not the same kind of authority, and we
> won't pretend otherwise.

Agreed on every clause, including the last one. This document supplies the
crash semantics we need, states the lifecycle as a state machine so "crash" has
a definition rather than a vibe, and proposes the surface that follows.

---

## 0. What `0.38.109` changed here

Nothing in the shipped packages does any part of P5, so there is nothing to
trim. Four things did change what the document has to *say*:

**`'service'` has no home in the shipped type system.** Your §3.6's "a role, not
a second mechanism" needs a role enum with three members. What shipped is
`SeatRole = 'player' | 'spectator'` (`seats.ts:54`), **derived** from the seat
table and never stored (`roleOf`, `seats.ts:201`), and `SeatOccupant =
{ kind: 'human' } | { kind: 'bot' }` (`seats.ts:56-58`). A service is not a
human, not a bot, and must not hold a seat — so on the shipped model it is not
representable as a role at all. §6 below is re-shaped around that; it is the
biggest change to this document.

**The reaper hazard is real and it moved into the package.** §10.1 predicted
`room.clients.size === 0` would reap a live game. That line is now
`packages/rooms-server/src/gc.ts:28`, in the published package, still exactly
`const empty = room.clients.size === 0;`. Citations updated throughout.

**`deriveParticipantId` did not ship.** `rooms-protocol` exports the *format*
half — `participantIdTier`, `isParticipantId`, `formatParticipantId`,
`participantIdBody` and the predicates — but derivation lives in
`apps/server/src/rooms/participantId.ts`, in your app, because it needs a
synchronous crypto primitive the zero-dep package won't assume
(`participantId.ts:38-40`). This bites §7 directly: we cannot mint an id for a
service peer with what is published.

**`O2` is settled and one branch of §1 is gone.** Our draft engine is
TypeScript in the room server's process (resolved 2026-09-14 on the evidence
that `BoosterDraft.java` lives in `forge-gui` with 17 GUI call sites). So the
**draft** has no service participant — P5 applies to **matches**, where the
authority is a JVM holding the shuffled libraries. That makes P5 later than
P3/P4/P6 for us and it makes §9's acceptance criterion a match, not a draft.
`O3` — one process per match or one hosting many — is still open, and the
surface below still says nothing about it.

---

## 1. The requirement in our words

Our authority is a process, not a tab. It holds the shuffled library, the
undrafted packs, and everyone's hidden zones, and it is the only thing in the
system that knows them. Three consequences you already accepted:

- a browser cannot hold a hidden library — that is the whole game
- "host migrates" is not something you can do to a game in progress
- the authority is a separate process, reachable over a channel that never
  faces the internet

What we need to add is the failure story, because ours is not "the tab closed,
elect another tab". It is: **the process died and a new one will be started in
its place, and the room must still be there when it arrives.**

The concrete bar:

> A game in progress must survive the backend process vanishing. Nobody loses
> their seat, nobody loses their board state, nobody has to rejoin, and when a
> replacement process attaches, every participant is put back on a correct view
> without reloading the page.

A draft runs 45+ minutes across eight people; a match runs longer. Over that
window a deploy, an OOM kill or a bad card script is not an edge case, it is
Tuesday.

*(The original said "a cube draft", and specified against the draft because it
is the thing we ship first. `O2` settling moved the draft engine in-process, so
the draft's version of this requirement is now **P6's** — a server restart, not
a peer crash. P5 is the match case, which is the harder one and was always the
one this document's machinery was really for.)*

Two things are still open on our side and the design must not assume either
(they are `O2` and `O3` in our `docs/planning/workstreams.md`):

- ~~**`O2`**~~ — **settled 2026-09-14: the draft engine is TypeScript, in the
  room server's own process.** So the draft has no service participant and this
  document does not apply to it. It applies to **matches**, where the authority
  is a JVM. That is strictly the harder case and nothing below weakens; it does
  mean P5 lands after P3, P4 and P6 in our order.
- **`O3`** — one process per match, or one process hosting many rooms. The
  surface below deliberately says nothing about how many rooms a peer serves,
  because we do not know yet. It only says a room has at most one.

## 2. Where the room's responsibility stops

Worth stating plainly, because it is the thing that makes this cheap for you:

**The room does not know what the service is doing.** It does not model turns,
picks, priority or legality. It owns four things and nothing else:

1. the attachment lifecycle and its state machine (§3)
2. routing client actions to the attached service, and a declared behaviour
   when there is none (§4)
3. telling clients when the service comes and goes (§5)
4. keeping itself alive while a service is expected back (§6)

Everything above that is our adapter's problem, in our repo.

## 3. The lifecycle, as a state machine

Your four words — attach, detach, heartbeat, crash — become five states. The
distinction that earns its keep is `lost` versus `detached`: a clean shutdown
and a crash want different behaviour from the room, and only the room can tell
them apart, because only the room holds the heartbeat clock.

```
                 attach()                    ack
   detached  ──────────────▶  attaching  ──────────▶  attached
       ▲                          │                    │   │
       │                    reject/timeout             │   │ missed N heartbeats
       │◀─────────────────────────┘                    │   ▼
       │                                               │  lost
       │            detach('shutdown' | 'handoff')     │   │
       │◀──────────────────────────────────────────────┘   │ attach() within holdMs
       │                                                   │
       │                     holdMs elapsed                ▼
       └───────────────────────────────────────────────  attaching
```

| State | Meaning | Room behaviour |
| --- | --- | --- |
| `detached` | no service, none expected | actions rejected; room GC-eligible on the normal rules |
| `attaching` | a peer is attaching, handshake unfinished | actions rejected; room not GC-eligible |
| `attached` | a peer is live and heartbeating | actions routed |
| `lost` | heartbeats stopped; a replacement is expected | actions rejected; room **not** GC-eligible; clients told |
| — | `holdMs` elapses while `lost` | room transitions to `detached` and may be reaped |

`lost` is entered by the room's clock, not by the peer, which is the whole
point: a crashed process cannot tell you it crashed.

## 4. Routing, and what happens when there is nobody home

Your §3.6 says the service "receives client actions routed to it". The part we
need pinned down is the other branch.

> A client action whose kind is service-routed and which arrives while the
> service is not `attached` is **rejected with a typed error and changes no room
> state**. It is never silently dropped, never queued, and never applied by the
> room itself.

Rejected rather than queued because a game action is only meaningful against
the state it was composed against; a land drop replayed thirty seconds later
into a state the client can no longer see is worse than an error. Rejected
rather than dropped because a client that gets no answer will guess, and the
guess we cannot allow is optimistic local application — that is exactly the
divergence this whole design exists to prevent.

Never applied by the room because the room does not know the rules and must not
pretend it does.

## 5. Crash semantics — the part we actually need

These are the clauses we would be asking you to commit to.

**5.1 The room survives.** A service transition to `lost` does not evict
participants, does not vacate seats, does not close sockets and does not delete
room state.

This is now a statement about published code rather than about your app.
`packages/rooms-server/src/gc.ts:28` is `const empty = room.clients.size === 0;`,
and `evaluateRoom` destroys on `empty` plus `emptyGraceMs` (`gc.ts:30-35`). A
service loss must not be able to reach that condition, and a room in `lost` must
be exempt from reaping regardless of it. `GCTimings` is two numbers
(`gc.ts:15-20`) and `evaluateRoom` is pure, so the exemption has to arrive as a
third input or as a predicate — we have no preference which, only that the
decision is not "the room looked empty for a moment".

**5.2 Clients are told exactly once, with a distinct state.** Not an error
toast, not a generic disconnect: a room-level status the UI can render as "the
table is coming back" and use to disable every input. Our client must be able
to distinguish "your socket dropped" from "the table's engine dropped", because
the correct UI is different — the first is a spinner, the second is a spinner
plus a hard input lock.

**5.3 No delta may be applied across a loss boundary.** On re-attach the room
does not resume the stream. The re-attaching service pushes a full state, the
room fans it out per participant through P3's `perParticipant`, and only then
do deltas resume. A client that received delta `n` before the loss and delta
`n+1` after it would be applying a diff against a state that no longer exists.

**5.4 Pending asks issued by the service are cancelled on `lost`, not timed
out.** This is a decision we are making and we will change it if you disagree.
An ask (P4) that was in flight when the engine died has no answer anybody can
use — the thing that would consume the reply is gone. Resolving it with its
declared timeout value would feed a default into a dead engine; leaving it
pending would have it resolve into the replacement's unrelated state. So: on
the transition to `lost`, every pending ask attributed to the service is
cancelled with a distinct reason, and the replacement service is responsible
for re-issuing whatever it still needs after its re-attach snapshot. That keeps
the room dumb and puts the knowledge of what is still needed in the only place
that has it.

**5.5 Exactly one service per room.** An `attach` while a service is `attached`
is rejected. An `attach` while `lost` is accepted — that is the replacement
path. Two processes writing one game is the failure we least want to debug, and
with `O3` unresolved we would rather the room refuse than arbitrate.

**5.6 Re-attach is handed the roster, not asked to guess it.** The replacement
process starts empty. On a successful attach the room gives it the current
participant list with seats and roles, so it can rebuild its own routing table
without a side channel and without our adapter caching a roster it would then
have to keep coherent.

## 6. Proposed surface

Transport-agnostic, per your constraint: you define the lifecycle and the
routing, we bring the socket.

**First, the type that isn't there.** The original draft opened with
`type Role = 'player' | 'spectator' | 'service'` and attributed it to your §3.2
/ §3.6. No such type shipped: `SeatRole` has two members, is derived from the
seat table by `roleOf` and is never stored (`seats.ts:54,201`), and
`SeatOccupant` admits `human` and `bot` (`seats.ts:56-58`). Widening either
would be wrong — a service must **not** hold a seat (it would take a draft slot,
appear in `humanSeats`, and count against `capacity`), and `roleOf` reading the
table is a property worth keeping.

So we are **not** asking for a third `SeatRole`. We are asking for the lifecycle
to hang off the room beside the seat table rather than inside it:

```ts
/** The transport seam. We implement this; the package never sees a socket. */
interface ServicePeer {
  readonly id: string;                  // stable across restarts of the peer
  send(envelope: unknown): void;
  close(reason: string): void;
}

type ServiceStatus = 'detached' | 'attaching' | 'attached' | 'lost';

interface ServiceLifecycle {
  attach(peer: ServicePeer): Promise<ServiceSession>;   // rejects if already attached
  detach(reason: 'shutdown' | 'handoff'): Promise<void>;
  heartbeat(): void;                                    // called by the peer
  status(): ServiceStatus;
}

interface ServiceSession<TClient> {
  serviceId: ParticipantId;                       // see the open question in §7
  roster: ReadonlyArray<ClientMeta<TClient>>;     // §5.6 — the shipped membership type
  seats: SeatTable;                               // seats.ts:66, shipped as-is
  /** Push a full state; the room fans it out via P3's per-recipient emit. */
  publishSnapshot<P>(
    project: (c: ClientMeta<TClient>) => P | typeof SKIP,   // SKIP: emit.ts:72
  ): void;
}

// configured per room / per server:
createRoomServer({
  service: {
    heartbeatMs: number;      // peer sends this often
    lossAfterMs: number;      // no heartbeat for this long ⇒ 'lost'
    holdMs: number;           // stay alive in 'lost' this long before 'detached'
    routes: (kind: string) => boolean;   // which client actions go to the service
  } | undefined,              // undefined ⇒ no service role in this room at all
});

// alongside the room — a field on CoreRoomState, or a registry-level lookup
// keyed by roomId. We have no preference; `CoreRoomState` is a plain interface
// of data today (state.ts:52-75) with the behaviour in free functions, and we
// would rather match whatever you decide than argue for a shape.
room.service?: ServiceLifecycle;
```

Defaults matter for you specifically: with `service` undefined nothing exists —
no lifecycle field, no heartbeat clock, no GC exemption, no change to any room
you run. Watchparty's 461 server tests should not move by a line.

Our numbers, for calibration rather than as a proposal for yours:
`heartbeatMs` 5 s, `lossAfterMs` 15 s, `holdMs` at least one draft round —
call it 10 minutes — because a redeploy plus a cold JVM start is comfortably
inside that and a drafter staring at a pack is not going anywhere.

## 7. Two open questions we cannot answer alone

### 7.1 What is a service's `ParticipantId`?

Your §3.3 fixes three tiers and encodes durability in the prefix so code can
assert on it. **None of the three describes a process.** `account` is defined as
an authenticated person's credential and a service is not a person; `device` is
a browser; `ephemeral` dies with the transport, which is the opposite of what a
service is.

Reading `0.38.109` sharpens this from a preference into a blocker, because the
tier set is genuinely closed, not merely conventional:

```ts
// participantId.ts:102-107
export function participantIdTier(id: string): ParticipantIdTier | null {
  const m = PARSE_RE.exec(id);
  if (!m) return null;
  return TIER_BY_SCHEME[m[1]] ?? null;
}
```

A `svc:` id returns `null`, so `isParticipantId` rejects it
(`participantId.ts:109-111`), `isDurableParticipantId` is false
(`participantId.ts:118-121`), and `participantTierAtLeast` is false for every
`minTier` (`participantId.ts:133-137`). A service id invented outside the
package is not a `ParticipantId` by the package's own predicates — and
`participantIdTier`'s doc comment says returning `null` rather than defaulting is
deliberate, so there is no accidental back door either. Good design; it just
means we cannot solve this on our side.

Two options and we still do not have a strong preference:

- **(a)** add a fourth tier `svc:<digest>`, durable, never seated, never counted
  in roster size
- **(b)** reuse `account` with a service key and let policy handle the rest

We lean to (a) because the tier prefix's stated purpose is that code can assert
on durability class rather than hope, and "is this a person" is exactly the
assertion our seat allocation and our roster rendering both need to make. Under
(b) `isAuthenticatedTier` becomes true for a process, and that predicate is the
gate for *"anything that grants power — leadership, ownership, a moderation
action"* (`participantId.ts:25-34`); a service legitimately has more power than
any person in the room, but conflating the two means nothing can ever tell them
apart again.

This is a question, not a counter-proposal. The tiering is yours.

### 7.2 How does a second consumer mint an id at all?

New, and it applies beyond P5. `rooms-protocol` ships the **format** half —
`participantIdTier`, `isParticipantId`, `formatParticipantId`,
`participantIdBody`, the predicates and the length floors. It does not ship
`deriveParticipantId`; that lives in `apps/server/src/rooms/participantId.ts`,
in your application, because it needs a synchronous crypto primitive the zero-dep
package will not assume (`participantId.ts:38-40`).

That is a defensible split and we are not asking you to add a crypto dependency
to a package whose header makes a point of having none. But it leaves the
second consumer — the one whose existence proves the boundary — reimplementing
the hashing, and *"domain-separated SHA-256 digests"* is exactly the kind of
detail where two implementations silently disagree on a separator and produce
different ids for the same person.

Options, in our order of preference:

- **(a)** `@wolffm/rooms-server` exports `deriveParticipantId` — it is already a
  Node-only package in practice (`emit.ts:44` calls `Buffer.byteLength`, and it
  peer-depends on `socket.io`), so `node:crypto` costs it nothing, and
  `rooms-protocol` stays dependency-free
- **(b)** `rooms-protocol` exports the **domain-separation scheme** as data (the
  prefix strings and separator) plus a `deriveWith(hash, input)` that takes the
  hash function, so the algorithm has one definition and the primitive stays
  injected
- **(c)** it is documented as the host's job, precisely enough that two
  implementations provably agree — in which case the doc needs the exact byte
  sequence being hashed, not a description of it

Any of the three works for us. What does not work is the current state, where
the only correct implementation is in a file we cannot import.

## 8. The tests that prove it

*(Restated for a **match** rather than a draft — `O2` settled the draft engine
as in-process TypeScript, so a draft has no service peer to kill. The shape of
every test is unchanged.)*

**8.1 The room survives the peer vanishing.** Four seated players, several turns
in. Kill the peer process. Assert: the room still exists, all four participants
still hold their seats, `status() === 'lost'` within `lossAfterMs`, each of the
four clients received exactly one service-lost notice, and
`evaluateRoom(room, timings)` run at that moment returns
`shouldDestroy === false` — the direct assertion against `gc.ts:22-37`, which is
pure and therefore testable without a registry, as its own header points out.

**8.2 Re-attach restores every client without a reload.** Start a replacement
peer, attach, publish a snapshot. Assert: each client's state equals its
pre-kill state; no client applied a delta across the boundary (assert the
envelope sequence per participant shows snapshot-then-deltas, not
deltas-continuing); and — leaning on P3 — no participant's post-re-attach
snapshot serialises to a string containing another participant's pool or
current pack.

**8.3 Actions while lost are rejected, not applied.** Send a service-routed
action from a client while `status() === 'lost'`. Assert a typed error reaches
that client, no other client receives anything, and the room's `seq` is
unchanged.

**8.4 A second attach is refused.** With a service `attached`, a second
`attach()` rejects, the first peer is untouched, and `status()` stays
`attached`.

**8.5 Heartbeat hysteresis.** A peer that misses `lossAfterMs / heartbeatMs - 1`
beats and then resumes never enters `lost` and no client is notified. A peer
that stops entirely enters `lost` within `lossAfterMs`.

**8.6 Clean detach differs from a crash.** `detach('shutdown')` puts the room in
`detached` and tells clients a different thing than `lost` does; the room
becomes GC-eligible on the normal rules straight away rather than after
`holdMs`.

**8.7 Hold expiry.** With `holdMs` elapsed and no re-attach, the room
transitions to `detached` and is reaped on the normal rules.

## 9. Acceptance criterion

> With four participants seated in a **match** and several turns played,
> killing the attached service peer's process and starting a replacement that
> attaches within `holdMs` leaves every participant on the same `SeatId` with an
> identical board and hand, with no participant having reloaded the page, no
> seat reallocated, and each participant's client having received exactly one
> service-lost notice followed by exactly one snapshot before any further
> delta.

Every clause is assertable: seat identity, list equality, envelope counts and
envelope ordering per participant.

## 10. If you say no

**If the service role does not land:** we attach the engine as an ordinary
participant with a role flag of our own and rebuild the lifecycle above the
room, in our repo. The concrete costs, in order of how much they hurt:

1. **The reaper will delete live games.** `packages/rooms-server/src/gc.ts:28`
   computes `const empty = room.clients.size === 0;`. A service that is not a
   participant is not a client, so a room whose humans have all briefly dropped
   — a redeploy of our own UI, say — is empty by that definition while a
   45-minute match is still running inside it. Our workaround would be to hold a
   fake browser participant open purely to keep the reaper away, which is a lie
   in the roster that everything downstream then has to special-case. Note this
   is now a published package's behaviour rather than an application's, so the
   workaround would also be the *next* consumer's workaround.
2. **Crash detection lands in the wrong place.** The heartbeat clock has to run
   somewhere; above the room it cannot exempt the room from GC, cannot pause
   routing, and cannot tell clients in the same channel as everything else, so
   the "table is coming back" state arrives out of band and races the room's
   own presence messages.
3. **Two authorities, no arbitration.** §5.5's "exactly one" is trivial inside
   the room and genuinely hard outside it.

**If the lifecycle lands but §5.4 (cancel-on-lost) is refused:** we accept asks
resolving with their declared fallback on service loss and make our adapter
treat every post-re-attach answer as untrusted, re-asking anything it still
needs. Workable, more round trips, and it means a fallback value can be
recorded by nothing and then re-asked — confusing in logs but not incorrect.

**If §5.3 (snapshot, never delta, across a loss) is refused:** we cannot use the
room's delta path for game state at all and fall back to publishing a full
state on every change, which for a match is far too large to send per event.
This one we would push back on hard.
