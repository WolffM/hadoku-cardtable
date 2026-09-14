# P6 — pluggable room persistence: what we need

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Re:** `ROOM_MODULE_RESPONSE.md` phase P6 and §6, our `WATCHPARTY_ROOM_MODULE.md` §4.2
**Status:** request — revised against shipped code
**Date:** 2026-09-14 (first written 2026-09-11)
**Read against:** `@wolffm/rooms-protocol@0.38.109`, `@wolffm/rooms-server@0.38.109`,
read from source in your repo.

You put this last in the phase table and named the problem yourself in §6:

> P6 fixes something we live with today: our rooms are `const rooms = new Map()`
> and a deploy destroys […] state for everyone connected.

**Re-verified against `0.38.109`, and half of it moved.** The module-level
`const rooms = new Map()` is gone; it is now `class RoomRegistry`
(`state.ts:86`) holding `private rooms = new Map<string, CoreRoomState<…>>()`
(`state.ts:87`). Your reasoning for making it a class is exactly right and the
note in its header says it better than we would. But **it is still purely
in-memory**: `seed` constructs a room from nothing (`state.ts:93-106`), there is
no `load`, no `save`, and no hook where one could go. And the reaper is now
`packages/rooms-server/src/gc.ts:28`, still `const empty =
room.clients.size === 0;`, destroying once that has held for `emptyGraceMs`
(`gc.ts:30-35`).

So the problem you named in §6 is intact, and it is now intact **inside a
published package** rather than inside your application — which means it is the
next consumer's problem too, not just ours.

**One thing you shipped that makes this much cheaper**, and which we want to
credit rather than re-ask for. `seats.ts:41-47`:

> *"Plain arrays and records, deliberately — NOT Map/Set. Every other collection
> on `RoomState` is a `Map` or a `Set`, which is the reason room state cannot be
> snapshotted or restored today: `JSON.stringify` renders them as `{}`. This
> table is plain JSON-safe data so that a pluggable snapshot/restore is a matter
> of writing it out, not of teaching a serializer about five container types.
> Keep it that way."*

That is P6 groundwork laid before P6 was asked for, and `SeatTable` —
`capacity`, `seats[]`, `remembered{}` (`seats.ts:66-84`) — drops into a snapshot
verbatim. It also scopes the rest of the job precisely: the three collections
that still need flattening are `clients` (`Map`), `usedAvatars` (`Set`) and
`clientNames` (`Map`), at `state.ts:63,65,70`. Nothing else on `CoreRoomState`
is a container.

There is no signature in your response for this one, so this is the most
open-ended of our four requests — and correspondingly the one where we have
tried hardest to build on a pattern that is already yours rather than invent
one. The pattern is `apps/server/src/redis/chatRepo.ts`: an interface with an
in-memory tier, a file tier and a Redis tier behind it, chosen by config, with
the memory tier as the always-present base. Your own §0 table describes it that
way and we are proposing the same shape one level up.

---

## 1. The requirement in our words

> A 45-minute cube draft must survive a server restart and a browser refresh.

That is the whole thing. It is not a nice-to-have and it is not about crash
resilience in the abstract — it is about the two events that happen most often
during a long session, one of which we cause ourselves every time we deploy.

Unpacked into what it actually demands:

- **Server restart.** The room, its seats, its roster and its app state come
  back with the same `roomId`. Clients reconnecting land in the room they were
  in, not a fresh one with the same name.
- **Browser refresh.** The refreshing participant's seat is not vacated for
  even one tick — your §3.2 point. **This half does not hold in `0.38.109`,
  independently of persistence**: `ClientMeta` carries a single `socketId` and
  `leaveRoom` unseats on the stale disconnect. That finding, with the repro, is
  in **P3 §6**; we raise it once and cross-reference it rather than repeat it in
  four documents. It matters here because persistence has to preserve the
  property across a restart *as well*, and preserving a property that isn't
  true yet is not a thing a store can do.
- **Neither event is allowed to lose picks.** A drafter who has taken 20 cards
  has 20 cards after the restart.

The 45 minutes is what makes this concrete rather than theoretical: a session
that long straddles at least one deploy of something in the stack more often
than not, and unlike a paused stream, a lost draft cannot be resumed by
starting over — the eight people are gone for the evening.

## 2. The split: what the room persists, and what it does not

The most important design point, and it is what keeps this small.

**The room persists room mechanics plus an opaque blob the host gives it.** It
does not persist, and must not try to persist, state that lives in a service
participant (P5). A running engine holds shuffled libraries and RNG state that
the room could not serialise even if it wanted to; the room does not know the
shape and, in the branch where the engine is a separate process, the room
restarting does not kill it anyway.

So there are two recovery paths and they compose:

| What | Survives a room restart via |
| --- | --- |
| `roomId`, `roomKey`, seats, roster, `seq`, timestamps | this document — the snapshot |
| host app state held in `RoomState.app` | this document — via the host's codec |
| state held by an attached service process | P5 re-attach and its snapshot |

Which path a cube draft takes used to depend on an open question of ours. **It
is now settled** (`O2`, resolved 2026-09-14): the
draft engine is TypeScript running in the room server's own process, so **a
draft is `app` and goes through the codec here**, not through P5. That makes P6
the load-bearing one of our four for the thing we ship first, and it removes the
"either branch" hedge the original carried. Matches still take the P5 path. The
surface below is unchanged, because `app` being opaque was right for both.

### The one field that cannot go in the snapshot

`CoreRoomState.leaderId` is `string | null`, documented as *"The room's
authority, **by clientId**, or null"* (`state.ts:56-57`) — and `clientId` is the
ephemeral per-connection id (`state.ts:15`). A persisted `leaderId` names a
socket that certainly does not exist after a restart, so writing it out would
restore a room whose authority is a ghost.

We have deliberately left it out of `RoomSnapshot` above. Three ways to go and
it is your call, not ours:

- **(a)** re-key `leaderId` to `ParticipantId` — which is what P0 did to every
  other identity in the system, and this looks like the one that got missed
- **(b)** persist nothing and let leadership be re-established on the first
  qualifying join after restore, which is roughly what happens today anyway
  (`apps/server/src/ws/presence.ts:175` nulls it on leader disconnect)
- **(c)** declare it app state and move it into `TApp`

We mildly prefer (a), on the grounds that "the room's authority" is a room
concept and the whole of P0 was about not keying durable things on transport
ids. But watchparty's leader-takeover ordering is precisely the production
invariant you said you were not having re-derived from outside, so we are
raising it, not proposing it.

## 3. Proposed surface

Named against the shipped `CoreRoomState` (`state.ts:52-75`) field for field, so
the mapping is checkable rather than aspirational.

```ts
/** Wire form. Maps and Sets are not JSON; the snapshot is the flattened form. */
interface RoomSnapshot {
  storeVersion: number;             // bumped when THIS shape changes
  roomId: string;
  roomKey: string;
  lastEventSeq: number;             // state.ts:59, verbatim
  createdAt: number;
  updatedAt: number;

  members: SerializedMember[];      // flattens `clients`     (Map,  state.ts:63)
  usedAvatars: string[];            // flattens `usedAvatars` (Set,  state.ts:65)
  clientNames: Record<ParticipantId, string>;
                                    // flattens `clientNames` (Map,  state.ts:70)
  seats: SeatTable;                 // state.ts:72 — already JSON-safe, seats.ts:41-47

  app: unknown;                     // opaque to the store; see appCodec
  appVersion?: number;              // the host's own schema version, echoed back
}

interface SerializedMember {
  participantId: ParticipantId;     // durable tiers only — see §4.2
  joinedAt: number;
  lastSeen: number;
  name?: string;
  avatarId?: string;
  app: unknown;                     // ClientMeta<TClient>.app, via the host codec
  // NOTE: `clientId` and `socketId` are deliberately absent. Both are transport
  // identifiers (state.ts:15-16) and neither survives a restart. The stable
  // identity IS `participantId`, which is the whole point of P0.
  // NOTE: `friendKey` is deliberately absent. `ClientMeta.friendKey` is auth
  // material and its own doc comment (state.ts:34-38) says it must never reach
  // a payload — a snapshot on disk is a payload.
}

interface RoomStore {
  load(roomId: string): Promise<RoomSnapshot | null>;
  save(snapshot: RoomSnapshot): Promise<void>;
  remove(roomId: string): Promise<void>;
  list(): Promise<string[]>;        // room ids known to the store, for boot
}

createRoomServer({
  /** Default: an in-memory store. Nothing changes for an app that omits it. */
  store?: RoomStore,

  /** Required whenever `store` is set and TApp is not plain JSON. */
  appCodec?: {
    version: number;
    serialize(app: TApp): unknown;
    deserialize(raw: unknown, version: number): TApp;
  },

  persist?: {
    debounceMs: number;             // coalesce bursts of mutations
    maxIntervalMs: number;          // ...but never go longer than this unsaved
    flushOnSignal: boolean;         // default true — see §4.4
  },
});
```

Three implementations we would expect to exist, mirroring `chatRepo`'s tiers:
`MemoryRoomStore` (default, in-package), `FileRoomStore` (ours to write if you
would rather not carry it), and whatever you want for Redis. Nothing in the
surface names a backend.

## 4. The rules that make it correct

### 4.1 Restore must beat the first join, not race it

The failure this prevents is the expensive one: the server boots, a refreshing
browser reconnects before the restore pass has read the store, the room is
created fresh and empty under the same `roomId`, and the next debounced save
overwrites a 45-minute draft with an empty room. Once, silently, unrecoverably.

> Room creation on join is `load()`-then-create as one step, and a room in a
> `restoring` state queues joins rather than creating a second room under the
> same id. A `save()` for a `roomId` whose snapshot has not yet been loaded is
> refused.

Boot-time eager restore over `list()` is fine too and probably nicer, but the
atomic load-or-create is the part that has to be guaranteed, because a room can
also be created long after boot.

### 4.2 Only durable tiers are restored

Straight out of your §3.3 tiering, and this is where encoding durability in the
id pays for itself:

> Participants for whom `isDurableParticipantId` is true — the `account` and
> `device` tiers — are written to the snapshot and restored with their seats.
> `ephemeral` participants are **not** written. An `eph:` id *is* a socket id
> (`participantId.ts:19`); restoring one would hold a seat that no future
> connection can ever claim.

`isDurableParticipantId` (`participantId.ts:118`) is the predicate, and its doc
comment already names this as its purpose — *"the check for 'may hold a seat /
may have a pending request replayed'"*. You also already apply it at exactly
this boundary: `leaveRoom` keeps a custom name across a reconnect for a durable
id and drops it for an ephemeral one, on the stated grounds that an ephemeral
id *"can never be matched again after reconnect"* (`state.ts:177-183`). A
snapshot is the same judgement over a longer gap, so this rule is not a new
policy — it is the existing one, applied once more.

Any seat held by an `eph:` participant is released as part of the restore, and
the roster comes back smaller than it went in. That is correct, not lossy: an
anonymous participant with no storage genuinely cannot be the same person after
a restart, and your own §3.3 already says a 45-minute draft seat can require
`fk:` or `dev:`.

### 4.3 A restored seat is held with zero sockets

The restored participant has no sockets at all — `sockets` is not in the
snapshot. The seat is still theirs. This is the same invariant as the refresh
case in your §3.2, just with a longer gap, and it is the one place where
persistence and seating have to agree explicitly: **seat tenure is a function
of participant identity and time, never of socket liveness.**

A reconnect window applies — a seat is not held forever — but it is measured
from `lastSeenAt` in the snapshot, so it survives the restart rather than
resetting.

### 4.4 A deploy must flush

The motivating event is a deploy, and a debounced writer loses up to
`debounceMs` of state on every one of them.

> On `SIGTERM`, the server flushes every dirty room synchronously before
> exiting, and the process does not exit until the flush completes or a bounded
> deadline passes.

Testable directly: the snapshot on disk after a `SIGTERM` carries the same
`seq` the room had in memory when the signal arrived.

### 4.5 An unreadable snapshot is quarantined, never half-applied

> A snapshot whose `storeVersion` the running server does not understand, or
> which fails the host codec's `deserialize`, is set aside intact under a
> distinct key and logged. The room boots as if it did not exist. It is never
> partially applied.

Half-restoring a room is worse than not restoring it: a draft that comes back
with seats but not picks looks fine and is unrecoverable, whereas one that does
not come back at all is obvious in the first second. The `appVersion` echo
exists so the host codec can migrate its own blob without needing the package
to bump `storeVersion`.

### 4.6 Persistence and the reaper have to agree

`gc.ts` destroys a room once it has been empty for `emptyGraceMs`. Destruction
must call `remove()`, or the store fills with dead rooms that the next boot
faithfully resurrects. Conversely a room that is empty only because the server
just restarted must not be reaped before anyone has had a chance to reconnect —
its `updatedAt` comes from the snapshot, so a room restored after a long
outage is instantly reap-eligible on the shipped rule — `const emptyDuration =
now - room.updatedAt;` then `if (emptyDuration >= timings.emptyGraceMs)`
(`gc.ts:33-34`). The restore should stamp a fresh emptiness clock rather than
inherit one. `evaluateRoom`'s own comment concedes the approximation
(*"`updatedAt` stands in for 'last emptied'. Coarse but conservative"*,
`gc.ts:31-32`), which is true while rooms are born empty and false the moment
one is born 45 minutes old.

## 5. The tests that prove it

**5.1 The headline: a draft survives a cold restart.** Build a four-seat room
20 picks into a draft with a `FileRoomStore`. `SIGTERM` the process. Boot a new
one against the same store directory. Reconnect each participant on a brand new
socket with the same `fk:`/`dev:` id. Assert: same `roomId`, each participant
back on the same `SeatId`, each pick list identical, no seat reallocated, and
`seq` continuous rather than restarted from zero.

**5.2 A refresh does not vacate a seat, across a restart.** Take a participant's
socket count to zero, restart the server, bring a new socket up under the same
id. The seat was never held by anyone else at any point, asserted by sampling
the seat table at each step rather than only at the end.

**5.3 `eph:` is not restored.** A room with two `fk:` and one `eph:`
participant restores with two participants and one released seat, and the
released seat is claimable.

**5.4 The restore/join race.** Fire a join for `roomId` X concurrently with the
boot restore of X. Assert exactly one room object exists for X, it is the
restored one, and no `save()` for X was issued before the load completed.

**5.5 `SIGTERM` flushes.** Mutate a room, send `SIGTERM` inside `debounceMs`,
wait for exit. The persisted snapshot's `seq` equals the in-memory `seq` at
signal time.

**5.6 A bad snapshot is quarantined.** Corrupt the `app` blob and boot. The
room does not appear, the original bytes are still present under the quarantine
key, exactly one error is logged, and the server starts normally.

**5.7 A future `storeVersion` is quarantined, not guessed at.** Same as 5.6
with `storeVersion + 1`.

**5.8 The default changes nothing.** With no `store` configured: no store
implementation is constructed, no filesystem or network call is made during a
full room lifecycle, and behaviour is identical to today. For you this is the
important one — your 446 tests are the real assertion, and they should pass
untouched.

**5.9 Destruction removes.** A room reaped by GC leaves no snapshot behind, and
the next boot does not resurrect it.

## 6. Acceptance criterion

> With a `FileRoomStore` configured, a four-seat draft 20 picks in survives
> `kill -TERM` of the server process followed by a cold boot: every `fk:` and
> `dev:` participant reconnecting on a new socket lands on the same `SeatId` it
> held with a byte-identical pick list, under the same `roomId`, with no seat
> reallocated at any point and no room created afresh. With no `store`
> configured, the same suite runs with zero store calls and zero behaviour
> change.

Both halves are the point: the first is what we need, the second is the promise
that we are not making you pay for it.

## 7. If you say no

**If persistence does not land at all:** we keep the draft's durable state in
our own store keyed by `roomId` and treat the room as disposable. What that
costs, concretely:

1. **We rebuild your seat table.** Seats, roster and stable ordering would have
   to be reconstructed from our side on every restart, which means a second
   seat allocator living in our repo and disagreeing with yours at exactly the
   moments that are hardest to reproduce.
2. **We re-open the identity-mismatch class P0 exists to delete.** Our restore
   would have to map "the person who was in seat 2" onto whatever participant
   the room hands us after the restart. That mapping is the thing your
   `fk:`/`cid:` split was a workaround for; doing it above the package puts it
   straight back.
3. **The reaper still deletes the room out from under us.**
   `packages/rooms-server/src/gc.ts:28` is `const empty =
   room.clients.size === 0;`. Our store surviving does not stop the room object
   from being destroyed mid-draft during a brief all-disconnected moment, and
   `RoomRegistry` has no reconstruct-from-state entry point — `seed` only ever
   builds a fresh room (`state.ts:93-106`) — so rebuilding a room around
   recovered state is not something the package currently lets a consumer do at
   all.

**If the interface lands but the host codec does not** — i.e. `app` must be
plain JSON — we serialise our own state to JSON before it ever reaches
`RoomState.app`, and give up `Map`/`Set` in the app slice. Mildly annoying,
entirely survivable, and probably what we would do first anyway.

**If §4.1's atomic load-or-create is refused:** we cannot use the store safely,
because the overwrite it prevents is silent and total. We would rather have no
persistence in the package than persistence with that race in it.

---

## 8. `@wolffm/rooms-client`: we agree with the deferral, and want one thing instead

Your §3b lists `@wolffm/rooms-client` under "P2 remaining". Deferring it is
right, and our reason is stronger than the one you gave — it is not that a
client package is low-payoff, it is that **we would not be its consumer.**

D6 puts the Forge UI inside the room's central canvas slot, which makes our
client a **cross-origin iframe**. Your own bridge comment says what that costs,
`apps/ui/src/components/GameModule.tsx:129-134`:

> *"The bridge: the cross-origin game iframe can't touch this app's Socket.io
> connection, so we relay between them with postMessage. The game posts `up`
> messages (input / state / start_request); we forward them over the existing
> authenticated, room-scoped socket. Socket game events come back as `down`
> messages into the iframe."*

That is exactly our topology. **The parent page owns the authenticated,
room-scoped socket; our payload speaks `up`/`down` across a postMessage
boundary and never holds a socket at all.** So a `rooms-client` that wraps
socket.io would have *your* app as its consumer, not ours. It is not merely
lower priority for us — it is not on our path. Ship it when watchparty wants it,
or never.

### What we do need, and it is cheaper than a package

The reconnect / resync / identity-reassert logic you are keeping inside
`apps/ui/src/lib/socket.ts` (783 lines) is **exactly what this document's
requirement rides on.** "A 45-minute draft survives a server restart and a
browser refresh" is, from the client's side, entirely a question of what happens
in those few seconds. Today that behaviour has one implementation, one consumer,
and no visibility from here — we would be reimplementing it by observation,
against a moving target, in a different repo.

So: **write the contract into `@wolffm/rooms-protocol`, even while the
implementation stays in `socket.ts`.** It is zero-dep and its header already
says anything landing there is a promise to every consumer — which is precisely
what we want this to become. Three things, and they are already decided, just
not written down:

**8.1 Seq-gap detection.** What number a client tracks, what constitutes a gap,
and what it does about one. You have the pieces in use — `server_seq` on
control broadcasts, the `client_seq → server_seq` ack map (`socket.ts:314-316`),
and a `control/stale_seq` error string (`socket.ts:584`) — but no stated rule.
For us this is the same number as P3 §2.1, which is why the two documents have
to agree.

**8.2 The resync trigger.** You already have a resync-shaped path:
`emitGameSync()` requests that the room's current state *"be replayed to me
only. Used on mount/reconnect to catch up"* (`socket.ts:515-518`). What we need
declared is **when** a client is obliged to call it, what it may assume about
what comes back, and whether a snapshot supersedes in-flight deltas or races
them.

**8.3 Identity re-assert ordering.** This is the one we would get wrong
unaided, and your code already knows the answer. `socket.ts:121-131`:

> *"Re-join on reconnect only — initial join is handled by `connectAndJoin()`…
> Wire snapshot ack BEFORE emitting join so we never miss the response. The
> server emits `snapshot` once per successful join — we use it as the join-ack.
> Re-emitting `client_ready` before snapshot arrives loses the event
> server-side because the new socket isn't yet in the room."*

That is a three-step ordering constraint with a stated failure mode for getting
it wrong, discovered the expensive way, currently living in a comment in an
application. Write it down as: what a client re-sends on reconnect, in what
order, what acknowledges each step, and what it must not send before which ack.

**What "write the contract" means, concretely.** Not an implementation. Types
plus prose in `rooms-protocol` — the event names and payload shapes for
join/snapshot/resync, the seq field and its gap rule, and the ordering stated as
a sequence. A `resync.ts` beside `seats.ts` and `participantId.ts`, of the same
character as those two: mostly a module header explaining why, with the handful
of types the header is about.

That is the thing we would actually bind to. `rooms-client` is not.
