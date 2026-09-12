# P5 — the service participant: proposed lifecycle and surface

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Re:** `ROOM_MODULE_RESPONSE.md` §3.6, phase P5
**Status:** proposal — awaiting ratification of the public surface
**Date:** 2026-09-11

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

> A cube draft in progress must survive the backend process vanishing. Nobody
> loses their seat, nobody loses their picks, nobody has to rejoin, and when a
> replacement process attaches, every participant is put back on a correct view
> without reloading the page.

A draft runs 45+ minutes across eight people; a match runs longer. Over that
window a deploy, an OOM kill or a bad card script is not an edge case, it is
Tuesday. The same requirement holds a fortiori for a match in progress, but the
draft is the one we will hit first, so it is the one we specify against.

Two things are still open on our side and the design must not assume either
(they are `O2` and `O3` in our `docs/planning/workstreams.md`):

- **`O2`** — whether the draft engine is TypeScript in the room server's own
  process, or the same engine that runs matches. In the first branch the draft
  has no service participant at all and this document does not apply to it; in
  the second it does. We are specifying for the second and taking the first as
  a strictly easier case.
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
room state. `apps/server/src/rooms/gc.ts:16` reaps on
`room.clients.size === 0`; a service loss must not be able to reach that
condition, and a room in `lost` must be exempt from reaping regardless.

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

```ts
type Role = 'player' | 'spectator' | 'service';       // yours, §3.2 / §3.6

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

interface ServiceSession {
  participantId: ParticipantId;         // see the open question in §7
  roster: ReadonlyArray<Participant>;   // §5.6
  seats: SeatTable;
  /** Push a full state; the room fans it out via emit.perParticipant. */
  publishSnapshot<P>(project: (p: Participant) => P | typeof SKIP): void;
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

// on the room:
room.service: ServiceLifecycle;
```

Defaults matter for you specifically: with `service` undefined the role does
not exist, no heartbeat clock runs, and nothing in your rooms changes.

Our numbers, for calibration rather than as a proposal for yours:
`heartbeatMs` 5 s, `lossAfterMs` 15 s, `holdMs` at least one draft round —
call it 10 minutes — because a redeploy plus a cold JVM start is comfortably
inside that and a drafter staring at a pack is not going anywhere.

## 7. One open question we cannot answer alone

**What is a service's `ParticipantId`?** Your §3.3 fixes three tiers, `fk:`,
`dev:` and `eph:`, and encodes durability in the prefix so code can assert on
it. None of the three describes a process. `fk:` is defined as an authenticated
person's credential and a service is not a person; `dev:` is a browser; `eph:`
dies with the transport, which is the opposite of what a service is.

Two options and we do not have a strong preference:

- **(a)** add a fourth tier `svc:<serviceId>`, durable, never seated, never
  counted in roster size
- **(b)** reuse `fk:` with a service key and let policy handle the rest

We lean to (a) because the tier prefix's stated purpose is that code can assert
on durability class rather than hope, and "is this a person" is exactly the
assertion our seat allocation and our roster rendering both need to make. But
D11 settled the tiering on your side and we are not reopening it — this is a
question, not a counter-proposal.

## 8. The tests that prove it

**8.1 The room survives the peer vanishing.** Four seated drafters, three packs
done. Kill the peer process. Assert: the room still exists, all four
participants still hold their seats, `status() === 'lost'` within `lossAfterMs`,
each of the four clients received exactly one service-lost notice, and the GC
pass run at that moment does not mark the room for destruction.

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

> With four participants seated in a draft and three packs completed, killing
> the attached service peer's process and starting a replacement that attaches
> within `holdMs` leaves every participant on the same `SeatId` with an
> identical pick list, with no participant having reloaded the page, no seat
> reallocated, and each participant's client having received exactly one
> service-lost notice followed by exactly one snapshot before any further
> delta.

Every clause is assertable: seat identity, list equality, envelope counts and
envelope ordering per participant.

## 10. If you say no

**If the service role does not land:** we attach the engine as an ordinary
participant with a role flag of our own and rebuild the lifecycle above the
room, in our repo. The concrete costs, in order of how much they hurt:

1. **The reaper will delete live games.** `gc.ts:16` computes
   `empty = room.clients.size === 0`. A service that is not a participant is
   not a client, so a room whose humans have all briefly dropped — a
   redeploy of our own UI, say — is empty by that definition while a 45-minute
   draft is still running inside it. Our workaround would be to hold a fake
   browser participant open purely to keep the reaper away, which is a lie in
   the roster that everything downstream then has to special-case.
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
