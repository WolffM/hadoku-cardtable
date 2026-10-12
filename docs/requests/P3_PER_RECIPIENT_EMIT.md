# P3 — per-recipient emit: what we still need

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Re:** `ROOM_MODULE_RESPONSE.md` §3.5, phase P3
**Status:** request — revised against shipped code
**Date:** 2026-09-14 (first written 2026-09-11)
**Read against:** `@wolffm/rooms-protocol@0.38.109`, `@wolffm/rooms-server@0.38.109`,
read from source in your repo. Every `file:line` below is yours.

---

## 0. This is a third of the document it was

It was written on 2026-09-11 against your response, before there was code. You
shipped `0.38.109` on 2026-09-14 and **a good part of what it asked for is
already in it**. Delivering the original would have asked you to build things
you had built, which is the fastest way to teach someone to stop reading our
requests.

So, deleted rather than delivered:

| Old ask | Why it's gone |
| --- | --- |
| "don't hardcode the priority lists" | `EmitPolicy.highPriority` / `.lowPriorityOrder` are host-supplied — `emit.ts:18,20` |
| "unlisted events must never be shed" | shipped, and documented in the same words — `emit.ts:19`, implemented `emit.ts:53-57` |
| "bound the queue so a slow socket can't consume the server" | `EmitPolicy.thresholdBytes` **is** that bound — `emit.ts:16` |
| `export const SKIP: unique symbol` | shipped — `emit.ts:72` |
| a §6 fallback asking for "our events addable to the never-drop tier" | that tier is now the default for anything we don't classify |

The one line that did it, verbatim:

> `packages/rooms-server/src/emit.ts:19`
> ```ts
>   /** Droppable, EARLIEST FIRST. An event in neither list is never dropped. */
> ```

That is our D11 correction, in your code, as a documented guarantee. Thank you —
and see §7, which is the only reason D11 gets a mention at all.

**What is left is three things**, and none of them exists in `0.38.109`:
a per-participant sequence (§2.1), a rule about what a *shed* envelope does to
it (§2.2), and fail-closed projections (§2.3). Plus §6 — the thing that has to
be true before any of it can be built.

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
on the wire`) asserts against `JSON.stringify` of the whole payload rather than
against a named field. §4's headline test is that test, generalised.

---

## 2. What we still need

### 2.1 The number a client gap-detects on must be per participant

Your §3.5 said *"Every envelope carries `seq`. The client detects gaps and
requests `resync`."* In `0.38.109` there is no envelope and nothing stamps a
seq: `CoreRoomState.lastEventSeq` exists (`state.ts:59`, initialised at
`state.ts:101`) and neither `safeEmit` nor `broadcastToRoom` reads or advances
it. So this is still a design question, not a change to working code.

With a room-global counter and `SKIP`, gap detection produces a resync on nearly
every event: in a pod a hand update is `SKIP` for three of four players, so
three clients see the counter jump and three clients ask for a full resync.
Hidden information is the common case for us, not the exception — this is the
steady state, not a storm.

So we ask that the number the **client** gap-detects on is a per-participant
outbound counter, and that the envelope carries both:

```ts
interface Envelope<P> {
  event: string;
  seq: number;              // THIS participant's outbound counter — what gaps mean
  stateSeq: number;         // CoreRoomState.lastEventSeq — how current the room is
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

**Where the counter lives is now an open question, not an assumption.** The
original text said "per participant, not per socket — a participant holding two
sockets during a refresh (your §3.2) gets the same envelope with the same `seq`
on both". §3.2's `sockets: Set<string>` **did not ship** — `ClientMeta.socketId`
is a single string (`state.ts:16`) and `clients` is keyed by the ephemeral id
(`state.ts:62-63`). See §6; the answer there decides the answer here.

### 2.2 A dropped envelope must break `seq` on purpose

This is the half of the original §2.2 that survives, and `thresholdBytes` is
what makes it matter rather than what makes it moot: now that shedding is real
and bounded, the question is what a shed envelope *tells the client*.

A delta stream has no self-healing. Silently dropping one desynchronises that
client until something else resyncs them — and nothing else will, because no
one knows it happened. What we need is not a drop policy (yours is right) but a
visibility rule on top of it:

> If the room decides not to send an envelope to a participant for any reason
> other than a projection returning `SKIP`, it MUST still consume that
> participant's outbound `seq`, so the gap is real and the client's gap detector
> requests a resync.

Then a shed envelope costs a resync instead of a silent divergence, and the drop
policy stays yours and stays tunable. `SKIP` is the only thing that does not
consume a `seq`, because `SKIP` means the participant missed nothing.

You already have the hook: `EmitPolicy.onDrop` (`emit.ts:22`) fires with
`{ event, bufferedBytes, socketId }` at exactly the moment the envelope is
dropped (`emit.ts:55`). The rule is "burn the seq there too".

**One thing we noticed while checking this.** `broadcastToRoom`'s `policy` is
optional (`emit.ts:86`), and without one it calls `socket.emit` directly
(`emit.ts:95`), bypassing backpressure entirely. That is the same hazard as the
old `useSafeEmit = false` default, carried through the carve in a new shape. For
the game channel we would want the room's emitter to always carry a policy —
not a request to change `broadcastToRoom`, which has other callers, but a
constraint on whatever P3 adds.

### 2.3 A projection that throws is fail-closed

`perParticipant` takes host code and host code has bugs. The one outcome we
cannot tolerate is a projection that fails for participant B and falls back to
some default payload, because the only payload lying around is the unprojected
one.

> A projection callback that throws for participant B sends **nothing** to B,
> counts the failure, and continues the fan-out to everyone else. It never
> substitutes another participant's payload, an unprojected payload, or a
> partial one.

A throw consumes B's `seq` (per §2.2 — B genuinely missed something), so B
resyncs and recovers if the failure was transient.

`safeEmit` already has the shape of this instinct: its outer `catch`
(`emit.ts:60-68`) retries rather than swallowing, on the stated grounds that *"a
failed measurement must not cost delivery"*. We are asking for the same
discipline one level up, with the opposite default — because a failed
*projection* must cost delivery, every time.

### 2.4 A participant with no live socket

Distinct from P4's answer to the same question, deliberately. An ask queues
because it blocks the engine and must be answered eventually. A state delta must
**not** queue — the queue is unbounded and the content is stale on arrival.

> An envelope for a participant with zero live sockets is not delivered and not
> queued. The participant is marked as needing a full snapshot, and the room
> sends one on their next socket attach.

This is the same boundary P5 draws for a service that goes away and comes back:
never apply a delta across a gap, always re-establish with a snapshot.

---

## 3. Surface

Shaped to what you actually shipped, which is free functions over a plain
`CoreRoomState` interface, not a room object with methods. We have no opinion on
which of those two it becomes — `room.emit.perParticipant(...)` from your §3.5
and `emitPerParticipant(io, room, ...)` are the same request. What follows names
the shipped types.

```ts
import type { ClientMeta, CoreRoomState, EmitPolicy } from '@wolffm/rooms-server';
import { SKIP } from '@wolffm/rooms-server';            // emit.ts:72, already exported
import type { SeatRole, SeatId } from '@wolffm/rooms-protocol';

type Projection<TClient, P> = (c: ClientMeta<TClient>) => P | typeof SKIP;

/** One payload per recipient, computed by the host. */
function emitPerParticipant<TApp, TClient, P>(
  io: SocketIOServer,
  room: CoreRoomState<TApp, TClient>,
  event: string,
  project: Projection<TClient, P>,
  policy: EmitPolicy,                                    // NOT optional — see §2.2
): EmitReport;

/** Same payload to everyone holding this seat role. */
function emitToRole<TApp, TClient, P>(
  io: SocketIOServer,
  room: CoreRoomState<TApp, TClient>,
  role: SeatRole,                                        // seats.ts:54
  event: string,
  payload: P,
  policy: EmitPolicy,
): EmitReport;

interface EmitReport {
  sent: number;             // recipients that received an envelope
  skipped: number;          // projection returned SKIP
  gapped: number;           // no live socket, or shed, or projection threw
  failed: number;           // projection threw (subset of gapped)
}
```

`emit.all` from your §3.5 is `broadcastToRoom` and already exists; we are not
asking for a third name for it.

`EmitReport` is not decoration. It is what makes §4's tests assertions rather
than inspections, and it is how we detect "the projection is throwing for
everyone" in production without reading logs.

Two notes on the types:

- **`SeatRole` is `'player' | 'spectator'`** (`seats.ts:54`), derived from the
  table, never stored — which is right and which we are not asking you to
  change. It means `emitToRole` cannot currently address a service participant;
  that is P5's problem, raised there, not here.
- **The projection receives `ClientMeta<TClient>`**, because that is what the
  room has. If §6 changes the membership model, this signature changes with it.

---

## 4. The tests that prove it

### 4.1 The one that matters — grep the whole payload

Modelled directly on your `never puts the friend key on the wire` test.

```ts
it('never puts a hidden zone on another participant\'s socket', () => {
  const room = makeRoom();                     // players A, B; spectator S
  const secretCard = 'card:__A_HAND_SENTINEL__';
  seedHand(room, A, [secretCard]);

  const received: Record<ParticipantId, unknown[]> = captureEnvelopes(room);
  emitPerParticipant(io, room, 'state_delta', (c) =>
    c.participantId === A ? deltaWithHand(A) : deltaWithoutHand(A), policy);

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

The draft-flavoured twin: with four drafters mid-pack, no drafter's envelopes
contain a card id from another drafter's current pack or pool.

### 4.2 `SKIP` produces no envelope and no gap

`SKIP` is already exported, so this test can be written today against a stub
emitter — it is the one part of §3 with no new symbol in it.

```ts
emitPerParticipant(io, room, 'e', (c) => c.participantId === A ? {} : SKIP, policy);
expect(envelopes[B]).toHaveLength(0);
expect(outboundSeq(B)).toBe(seqBefore);   // unchanged
```
Then a further `broadcastToRoom` reaches B with `seq === seqBefore + 1` and B's
gap detector does not fire.

### 4.3 A shed envelope does produce a gap

Drive B's buffer past `policy.thresholdBytes` and classify the event into
`lowPriorityOrder`, which is now the supported way to force the drop path
(`emit.ts:53-57`). Assert B's outbound `seq` advanced, that `onDrop` fired once,
and that B's next delivered envelope is non-contiguous with its last received
one — i.e. B's client requests a resync.

### 4.4 A throwing projection is contained

```ts
emitPerParticipant(io, room, 'e', (c) => {
  if (c.participantId === B) throw new Error('boom');
  return { ok: c.participantId };
}, policy);
expect(envelopes[B]).toHaveLength(0);
expect(envelopes[A]).toHaveLength(1);
expect(JSON.stringify(envelopes[A])).not.toContain('boom');
expect(report.failed).toBe(1);
```

### 4.5 Role scoping

`emitToRole('spectator', ...)` reaches every spectator and no player; the
reverse for `'player'`. With `SeatTable.capacity === null` every participant is
a player and there are no spectators (`seats.ts:194-203`) — the draft case sets
a real capacity, so this test has to set one too or it asserts nothing.

### 4.6 No socket, no queue

A participant with zero sockets receives nothing during 100 emits, is flagged
for snapshot, and on attach receives exactly one snapshot and zero replayed
deltas.

---

## 5. Acceptance criterion

> With players A and B seated and spectator S watching, `JSON.stringify` of
> every envelope delivered to B and to S across a complete turn contains no
> card id present in A's hand or library, asserted against the whole serialised
> envelope rather than any named field; and across that same turn neither B nor
> S observes a gap in its own `seq` that was caused only by a `SKIP`.

Both halves fail against `0.38.109`: the first because `broadcastToRoom` is the
only fan-out and it sends one payload to everyone (`emit.ts:81-99`), the second
because there is no per-envelope `seq` at all.

---

## 6. The thing that has to be settled first

**`ClientMeta` has one `socketId`, not a set of sockets.**

Your §3.2 was explicit, and we built three documents on it:

> *"A participant has a SET of sockets, not a socket id… Plural because the
> single-socket model is the direct cause of our worst reconnect bug… With a
> Set, takeover is a state transition instead of a race. This matters more to
> you than it looks: a mid-draft refresh must not vacate a seat for even one
> tick."*

In `0.38.109`, `ClientMeta.socketId` is a single `string` (`state.ts:16`),
`clients` is a `Map` keyed by the ephemeral `clientId` (`state.ts:62-63`), and
`clientByParticipant` returns the **first** match by iteration order
(`state.ts:199-207`). There is no `Participant` type and no `sockets` field
anywhere in either package.

We are not complaining about a missing feature — P2 shipped as core and you said
so. We are flagging it because a reachable consequence lands squarely on our P6
requirement, and because three of our documents cite §3.2 as settled.

**The sequence, on a browser refresh:**

1. The new socket's join is processed first — the common case, because engine.io
   has not yet timed out the old transport. `joinRoom` (`state.ts:146`) inserts a
   second `ClientMeta` under a new `clientId` and calls `seatParticipant`, which
   is idempotent and returns the seat they already hold (`seats.ts:142-143`).
2. The old socket's disconnect is then processed. `leaveRoom` (`state.ts:170`)
   looks up the **old** `clientId`, finds a live-looking meta, and runs
   `releaseAvatar` (`state.ts:176`) and `unseatParticipant` (`state.ts:186`).

The participant is now **unseated while holding a live socket**, and their
avatar is back in the pool. Nothing re-seats them, because `seatParticipant` is
only called from `joinRoom` and they have already joined. `roleOf` reports
`'spectator'`; `humanSeats` no longer lists them; your own
`buildPlayerRoster` skips them on the documented grounds that *"a human seat
with no live client cannot normally happen — leaveRoom unseats"*
(`apps/server/src/ws/game.ts:150-153`). The seat stays in `remembered`, so they
get it back — on their next join, which never comes.

We ran it against your source rather than reasoning about it. Importing
`seats.ts` directly, replaying the exact call order `state.ts` makes:

```
alice seat 0 · bob seat 1
rejoin seat            -> 0      (idempotent, same seat)
stale disconnect unseats -> 0
alice role now  : spectator
humanSeats now  : [{"id":1,"participantId":"fk:bbb"}]
remembered      : {"fk:aaa":0,"fk:bbb":1}
```

For watchparty this is close to harmless: `capacity` is `null`, everyone is a
player, and a re-derived roster costs a flicker. For an eight-person pod
45 minutes into a draft it is the failure we care most about, and it is the
literal text of the test you added to our list in §5 of your response — *"a seat
that survives a browser refresh."*

**We are not proposing the fix.** It is your membership model and you told us
the takeover ordering is the part you are not having re-derived by someone
reading the files cold. We only need to know **which** of these you intend, in
writing, because §2.1's per-participant counter and P4's replay-on-attach both
hang off it:

- **(a)** `ClientMeta` grows the socket set §3.2 described, and `leaveRoom`
  becomes "drop this socket; unseat only when the set empties"; or
- **(b)** the single-socket model stays and `leaveRoom` gains a guard — don't
  unseat if another live `clientId` carries the same `participantId`; or
- **(c)** it is the hosting app's job to guard the call, in which case please
  say so on `leaveRoom`'s doc comment, because nothing there says it today and
  the obvious reading is that the package handles it.

(b) is the smallest, and `clientByParticipant` is already the lookup it needs.

---

## 7. Two things about your own tree, stated factually

Neither is a request, and neither is the point of this document. They are here
because we found them while reading, and not saying so would be worse.

**7.1 `SKIP` is exported with nothing to pass it to.**
`emit.ts:71-72`:

```ts
/** Skip sentinel for `emitPerRecipient`. See that function. */
export const SKIP: unique symbol = Symbol('rooms.skip');
```

`emitPerRecipient` does not exist. `emit.ts` declares `safeEmit` and
`broadcastToRoom` and nothing else; `index.ts` re-exports `state`, `emit`, `gc`
and `rateLimiter` and adds nothing; a repo-wide grep for `emitPerRecipient`
returns exactly two hits, this comment and line 206 of
`docs/requests/ROOM_MODULE_RESPONSE.md`. **A consumer can import `SKIP` today and
has nothing to pass it to.**

Two readings and we can't tell which from outside: it was dropped in the carve,
or the sentinel shipped ahead of P3 and P3 is ours to land (which is what D10
and your §2 say). Worth confirming which, because if it's the second then
`0.38.109` has a public symbol whose contract is a document we haven't written
yet — and if it's the first, something else went with it.

While we were there: the doc comment at `emit.ts:27-34` explaining the
never-drop default is attached to `function bufferedBytes`, one declaration
below where it reads. Cosmetic, one line to move.

**7.2 The D11 correction — ours was wrong, and that is why this document
shrank.**
Your §4 said our state deltas *"get dropped as low-priority under load"*. We
wrote D11 agreeing. Reading `util/safeEmit.ts:32-48` at the time: an event in
neither list took `idx === -1`, skipped the inner block and reached
`socket.emit` at line 48. Unlisted events were **never** shed. Both your §4 and
our D11 were wrong about the same code, in the same direction.

It matters only because it changed our ask — the hazard was unbounded
buffering, not silent shedding — and `thresholdBytes` plus a host-supplied
`lowPriorityOrder` now answers the real one. The old §2.2, its matching §6
fallback and three paragraphs of §3 came out of this document as a result.
That's the whole significance; we mention it so you know why P3 is a third of
its former length and not because the correction is interesting on its own.

---

## 8. If you say no

**If per-recipient emit does not land at all:** we cannot put the game channel
on `@wolffm/rooms-server`. We would run a second socket namespace beside the
room for game traffic and keep the room for chat, presence and roster only. That
costs us your reconnect handling, your backpressure, seats and `seq` on the half
of the traffic that needs them most, and it puts two identity systems in one
page — which is the failure mode P0 exists to delete. We would rather not, and
we think you would rather we did not either, since a second consumer that only
uses half the package proves half a boundary.

**If only the per-participant `seq` is refused:** we take the explicit no-op
tick described in §2.1. Cost is three extra envelopes per hidden-zone event in a
four-player pod. Acceptable; measurably worse.

**If fail-closed projections are refused:** we wrap every projection in our own
try/catch returning `SKIP`, and accept that a bug in ours looks like a silent
stall rather than a counted failure. Acceptable, but it means the safety
property lives in the consumer instead of the package, and the next consumer has
to remember it.

**If the shed-envelope `seq` rule is refused:** we classify every game event as
high-priority via `EmitPolicy.highPriority` and take unbounded buffering on a
slow socket as the failure mode — which the package now lets us do without
asking you for anything, so this fallback is cheap in effort and expensive in
consequence. It is still the worst of the four: a desynchronised card game is
not recoverable by the player, and they will not know it happened.

**If §6 is answered with (c) — the app guards it:** we will guard it, and we
would ask only that `leaveRoom`'s doc comment say so. A package whose seat
invariant depends on every caller getting the disconnect order right will
eventually meet one that doesn't. That is your own argument, from
`seats.ts:132-134`, about bots and capacity clamping.

---

**2026-10-12, the watcher channel** (`docs/requests/WATCHPARTY_SEATS_AND_SPECTATORS.md`):
a socket whose participant holds no seat in a full match no longer gets
`match-full`. It joins as a **watcher** (`forge:role` = `watcher`; wave 31's
`spectator` keeps its meaning, a second socket on your own seat) and receives
ONE shared public projection — `createProjector(null)` in
`apps/server/src/play/visibility.ts`, where a null viewer now means the table:
public zones and face-up exile whole, a face-down permanent as its face, every
hand, library and sideboard as ids only. The channel is built once per match
off the first human seat's state stream, emitted on `WATCHER_SEAT` (`match.ts`)
and carries no prompt, bar, ask or selection. The rule above — *a spectator
must never receive a payload containing another player's hidden cards* — is
exactly what that channel enforces, and `match.test.ts` ("the watcher channel")
asserts it over the serialised payloads of both seats' secrets at once.
