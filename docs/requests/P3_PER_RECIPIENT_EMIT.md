# P3 — per-recipient emit: proposed surface

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Re:** `ROOM_MODULE_RESPONSE.md` §3.5, phase P3
**Status:** proposal — awaiting ratification of the public surface
**Date:** 2026-09-11

You fixed the shape in §3.5 and asked us to bring the requirements rather than
the signatures. This starts from your three methods verbatim and asks for three
refinements, each of which comes from a property a card game has and a watch
party does not.

The signature we start from, quoted from your §3.5:

```ts
room.emit.perParticipant(event, (p: Participant) => Payload | typeof SKIP)
room.emit.toRole(role, event, payload)
room.emit.all(event, payload)
```

with, also yours: *"Every envelope carries `seq`. The client detects gaps and
requests `resync`."*

We accept all of that. Everything below is refinement inside it.

---

## 1. The requirement in our words

A room broadcast is a single payload every participant receives. For a card
game that is not a performance concern, it is a correctness and secrecy
concern: **most of the game state is secret from most of the room, and the
secrecy is asymmetric per participant.** In a four-player pod every player has
a hand and a library that three other people and every spectator must never
see, and each of those four views is different.

The line we hold is stronger than "the client doesn't render it":

> A spectator must never **receive** a payload containing another player's
> hidden zone — not filtered at render time, not present in a field the UI
> ignores, not present anywhere in the bytes on that socket.

Two reasons it has to be that strong. First, a client is a browser and the
payload is readable in devtools by anyone who wants to look, so "we don't render
it" is not secrecy at all. Second, the engine already computes the correct
per-consumer view for us and we would have to actively destroy that work to
flatten it into a broadcast.

That is not aspirational — the rules engine we are wrapping does it today.
`TrackableSerializer.replace()` gates every property on
`trackable.hasConsumer(consumerId)`, and `DeltaSyncManager` (626 lines) tracks,
per connected client, which objects that client has been told about. An
opponent's hand is never placed in your delta in the first place. Our job in
this room layer is to preserve that property across the transport, not to
re-derive it.

The same requirement shows up in drafting before it shows up in a match: while
a pack is in front of you, its contents are yours alone, and the pool you have
picked so far is yours alone until the draft ends.

You have the same class of requirement already and solved it the same way — the
`opaqueVoterId` helper you cite in §3.3, whose test (`never puts the friend key
on the wire`, both names greppable in your tree) asserts against
`JSON.stringify` of the whole payload rather than against a named field. §4's
headline test is that test, generalised.

## 2. What we are asking for on top of §3.5

### 2.1 `seq` must be per participant, not room-global

This is the one that matters and the only place we are asking you to change
something already written down.

Your core `RoomState` carries `seq: number` — *"monotonic; stamped on every
outbound envelope"* — and the client detects gaps in it and asks for a resync.
With a room-global counter and `SKIP`, that produces a resync on nearly every
event: in a pod, a hand update is `SKIP` for three of four players, so three
clients see the counter jump and three clients ask for a full resync. Hidden
information is the common case for us, not the exception, so this is not a rare
storm — it is the steady state.

So we ask that the number the **client** gap-detects on is a per-participant
outbound counter:

```ts
interface Participant {
  // ...as in your §3.2
  outboundSeq: number;      // incremented once per envelope actually sent to
                            // THIS participant, across every emit method
}
```

and the envelope carries both:

```ts
interface Envelope<P> {
  event: string;
  seq: number;              // this participant's outboundSeq — what gaps mean
  stateSeq: number;         // RoomState.seq — how current the room state is
  payload: P;
}
```

`stateSeq` is what makes the split cheap: a client can still tell it is behind
the room without inferring it from a counter that skips. A `SKIP` then means
exactly "nothing happened on your channel", which is true, and costs nothing.

The alternative, if you would rather keep one counter, is that the emitter sends
skipped participants an explicit no-op tick so the sequence stays contiguous.
That works and we would accept it; it costs three extra envelopes per event in
a four-player pod, on the events that fire most often. We prefer the
per-participant counter, but we care much more that one of the two exists than
which.

`seq` is per **participant**, not per socket — a participant holding two sockets
during a refresh (your §3.2) gets the same envelope with the same `seq` on both,
so the surviving tab does not see a phantom gap.

### 2.2 A dropped envelope must break `seq` on purpose

Backpressure and gap detection have to agree, and today they cannot, because
`broadcastToRoom` does not go through `safeEmit` unless asked
(`apps/server/src/util/safeEmit.ts:60`, `useSafeEmit` defaults to `false`).

A correction to your §4 while we are here, because it changes what we need. You
wrote that our state deltas *"get dropped as low-priority under load"*. Reading
`safeEmit.ts:32-48`: an event that is in neither `HIGH_PRIORITY` (line 15) nor
`LOW_PRIORITY_ORDER` (line 16) takes `idx === -1`, skips the inner block, falls
past both `if`s and reaches `socket.emit` at line 48. Unlisted events are
**never** shed — they are always sent. So the hazard for us is the opposite one:
under pressure our deltas would buffer without bound rather than drop.

Both behaviours are wrong for us, and for the same underlying reason: a delta
stream has no self-healing. Silently dropping one desynchronises that client
forever; never dropping one lets a slow socket consume the server. What we need
is neither policy but a rule about visibility:

> If the room decides not to send an envelope to a participant for any reason
> other than a projection returning `SKIP`, it MUST still consume that
> participant's `outboundSeq`, so the gap is real and the client's existing gap
> detector requests a resync.

Then a shed envelope costs a resync instead of a silent divergence, the drop
policy stays yours and stays tunable, and we do not need our events added to any
hardcoded priority list. `SKIP` is the only thing that does not consume a `seq`,
because `SKIP` means the participant missed nothing.

### 2.3 A projection that throws is fail-closed

`perParticipant` takes host code and host code has bugs. The one outcome we
cannot tolerate is a projection that fails for participant B and falls back to
some default payload, because the only payload lying around is the unprojected
one.

> A projection callback that throws for participant B sends **nothing** to B,
> counts the failure, and continues the fan-out to everyone else. It never
> substitutes another participant's payload, an unprojected payload, or a
> partial one.

A throw consumes B's `outboundSeq` (per §2.2 — B genuinely missed something),
so B resyncs and recovers if the failure was transient.

### 2.4 A participant with no live socket

Distinct from P4's answer to the same question, deliberately. An ask queues
because it blocks the engine and must be answered eventually. A state delta must
**not** queue — the queue is unbounded and the content is stale on arrival.

> An envelope for a participant with zero live sockets is not delivered and not
> queued. The participant is marked as needing a full snapshot, and the room
> sends one on their next socket attach.

This is the same boundary P5 draws for a service that goes away and comes back:
never apply a delta across a gap, always re-establish with a snapshot.

## 3. Full proposed surface

```ts
/** Sentinel: this participant receives nothing, and misses nothing.
 *  A symbol because `null` is a legal payload — your point, taken. */
export const SKIP: unique symbol;

type Projection<P> = (p: Participant) => P | typeof SKIP;

interface RoomEmitter {
  /** One payload per participant, computed by the host. */
  perParticipant<P>(event: string, project: Projection<P>): EmitReport;

  /** Same payload to every participant holding this role. */
  toRole<P>(role: Role, event: string, payload: P): EmitReport;

  /** Same payload to every participant in the room. */
  all<P>(event: string, payload: P): EmitReport;
}

interface EmitReport {
  sent: number;             // participants that received an envelope
  skipped: number;          // projection returned SKIP
  gapped: number;           // no live socket, or shed, or projection threw
  failed: number;           // projection threw (subset of gapped)
}

// on the room:
room.emit: RoomEmitter;
```

`EmitReport` is not decoration. It is what makes §4's tests assertions rather
than inspections, and it is how we detect "the projection is throwing for
everyone" in production without reading logs.

Nothing here needs the socket.io handle threaded through the caller — your
objection to our original `emitPerRecipient(io, room, ...)` was right and this
keeps the room owning its emitter.

## 4. The tests that prove it

### 4.1 The one that matters — grep the whole payload

Modelled directly on your `never puts the friend key on the wire` test.

```ts
it('never puts a hidden zone on another participant\'s socket', () => {
  const room = makeRoom();                     // players A, B; spectator S
  const secretCard = 'card:__A_HAND_SENTINEL__';
  seedHand(room, A, [secretCard]);

  const received: Record<ParticipantId, unknown[]> = captureEnvelopes(room);
  room.emit.perParticipant('state_delta', (p) =>
    p.id === A ? deltaWithHand(A) : deltaWithoutHand(A));

  for (const who of [B, S]) {
    const wire = JSON.stringify(received[who]);   // whole envelopes, not a field
    expect(wire).not.toContain(secretCard);
  }
  expect(JSON.stringify(received[A])).toContain(secretCard);
});
```

The sentinel is a card id that exists nowhere else in the fixture, so a hit is
unambiguous. Serialising the whole array of envelopes, not a named field, is the
point: it catches the payload that carries the secret in a field nobody thought
to look at.

The draft-flavoured twin of the same test: with four drafters mid-pack, no
drafter's envelopes contain a card id from another drafter's current pack or
pool.

### 4.2 `SKIP` produces no envelope and no gap

```ts
room.emit.perParticipant('e', (p) => p.id === A ? {} : SKIP);
expect(envelopes[B]).toHaveLength(0);
expect(participant(B).outboundSeq).toBe(seqBefore);   // unchanged
```
Then a further `emit.all` reaches B with `seq === seqBefore + 1` and B's gap
detector does not fire.

### 4.3 A shed envelope does produce a gap

Force the drop path for B, then assert `participant(B).outboundSeq` advanced and
B's next delivered envelope is non-contiguous with its last received one — i.e.
B's client requests a resync. This is the test that would have caught the
`useSafeEmit = false` default.

### 4.4 A throwing projection is contained

```ts
room.emit.perParticipant('e', (p) => { if (p.id === B) throw new Error('boom'); return {ok:p.id}; });
expect(envelopes[B]).toHaveLength(0);
expect(envelopes[A]).toHaveLength(1);
expect(JSON.stringify(envelopes[A])).not.toContain('boom');
expect(report.failed).toBe(1);
```

### 4.5 Role scoping

`emit.toRole('spectator', ...)` reaches every spectator and no player; the
reverse for `'player'`; neither reaches an attached service participant unless
the service's role is named (P5).

### 4.6 Two sockets, one seq

A participant mid-refresh with two live sockets receives the envelope on both
with the same `seq`, and `outboundSeq` advances by exactly one.

### 4.7 No socket, no queue

A participant with zero sockets receives nothing during 100 emits, is flagged
for snapshot, and on attach receives exactly one snapshot and zero replayed
deltas.

## 5. Acceptance criterion

> With players A and B seated and spectator S watching, `JSON.stringify` of
> every envelope delivered to B and to S across a complete turn contains no
> card id present in A's hand or library, asserted against the whole serialised
> envelope rather than any named field; and across that same turn neither B nor
> S observes a gap in its own `seq` that was caused only by a `SKIP`.

Both halves fail today: the first because there is only `broadcastToRoom`, the
second because `seq` is room-global.

## 6. If you say no

**If per-recipient emit does not land at all:** we cannot put the game channel
on `@wolffm/rooms`. We would run a second socket namespace beside the room for
game traffic and keep the room for chat, presence and roster only. That costs
us your reconnect handling, your backpressure, seats and `seq` on the half of
the traffic that needs them most, and it puts two identity systems in one page —
which is the failure mode P0 exists to delete. We would rather not, and we think
you would rather we did not either, since a second consumer that only uses half
the package proves half a boundary.

**If only the per-participant `seq` is refused:** we take the explicit no-op
tick described in §2.1. Cost is three extra envelopes per hidden-zone event in a
four-player pod. Acceptable; measurably worse.

**If fail-closed projections are refused:** we wrap every projection in our own
try/catch returning `SKIP`, and accept that a bug in ours looks like a silent
stall rather than a counted failure. Acceptable, but it means the safety
property lives in the consumer instead of the package, and the next consumer has
to remember it.

**If the shed-envelope rule is refused:** we ask instead that our event names be
addable to the never-drop tier through the injected config you already plan for
P2, and we take unbounded buffering on a slow socket as the failure mode. We
consider this the worst of the three fallbacks — a desynchronised card game is
not recoverable by the player, and they will not know it happened.
