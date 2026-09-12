# P6 — pluggable room persistence: proposed surface

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Re:** `ROOM_MODULE_RESPONSE.md` phase P6 and §6, our `WATCHPARTY_ROOM_MODULE.md` §4.2
**Status:** proposal — awaiting ratification of the public surface
**Date:** 2026-09-11

You put this last in the phase table and named the problem yourself in §6:

> P6 fixes something we live with today: our rooms are `const rooms = new Map()`
> and a deploy destroys […] state for everyone connected.

Verified in your tree: `apps/server/src/rooms/store.ts:87` is exactly
`const rooms = new Map<string, RoomState>();`, and
`apps/server/src/rooms/gc.ts:14` reaps a room once
`room.clients.size === 0` has held for `emptyGraceMs`.

There is no signature in your response for this one, so this is the most
open-ended of our three proposals — and correspondingly the one where we have
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
  even one tick — your §3.2 point, and the reason a participant holds a Set of
  sockets. Persistence has to preserve that property across the restart too,
  which means a seat has to be restorable while its holder has zero live
  sockets.
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

Which path a cube draft takes depends on an open question of ours (`O2` in
`docs/planning/workstreams.md`): if the draft engine runs in the room server's
own process, the draft is `app` and goes through the codec here; if it runs in
the same process that runs matches, it is a service and goes through P5. The
surface below has to work for both, which is why `app` is opaque and why the
codec is the host's.

## 3. Proposed surface

```ts
/** Wire form. Maps and Sets are not JSON; the snapshot is the flattened form. */
interface RoomSnapshot {
  storeVersion: number;             // bumped when THIS shape changes
  roomId: string;
  roomKey: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
  participants: SerializedParticipant[];
  seats: SerializedSeatTable;
  app: unknown;                     // opaque to the store; see appCodec
  appVersion?: number;              // the host's own schema version, echoed back
}

interface SerializedParticipant {
  id: ParticipantId;                // 'fk:' or 'dev:' only — see §4.2
  role: Role;
  seat: SeatId | null;
  displayName?: string;
  avatarId?: string;
  joinedAt: number;
  lastSeenAt: number;
  // NOTE: `sockets` is deliberately absent. Transports do not survive a restart.
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

> `fk:` and `dev:` participants are written to the snapshot and restored with
> their seats. `eph:` participants are **not** written. Their ids are transport
> identifiers; restoring one would hold a seat that no future connection can
> ever claim.

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
outage is instantly reap-eligible on today's rule
(`emptyDuration = now - room.updatedAt`, `gc.ts:19`). The restore should stamp
a fresh emptiness clock rather than inherit one.

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
3. **The reaper still deletes the room out from under us.** `gc.ts:16` is
   `room.clients.size === 0`. Our store surviving does not stop the room
   object from being destroyed mid-draft during a brief all-disconnected
   moment, and rebuilding a room around recovered state is not something the
   package currently lets a consumer do.

**If the interface lands but the host codec does not** — i.e. `app` must be
plain JSON — we serialise our own state to JSON before it ever reaches
`RoomState.app`, and give up `Map`/`Set` in the app slice. Mildly annoying,
entirely survivable, and probably what we would do first anyway.

**If §4.1's atomic load-or-create is refused:** we cannot use the store safely,
because the overwrite it prevents is silent and total. We would rather have no
persistence in the package than persistence with that race in it.
